import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { atomicWriteJsonFile } from "../../resilience";
import type { ProjectLease, ProjectLeasePort } from "../application/ports/project-lease-port";

interface LeaseRecord {
  leaseId: string;
  ownerId: string;
  pid: number;
  roots: string[];
  expiresAt: number;
  /** Changes whenever a lease record is replaced by a new owner. */
  generation: string;
  /** Last heartbeat written by the owner of this generation. */
  updatedAt: number;
}

function parseLease(value: unknown, filePath: string): LeaseRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Project lease record is invalid: ${filePath}`);
  }
  const record = value as Partial<LeaseRecord>;
  if (
    typeof record.leaseId !== "string" || !record.leaseId ||
    typeof record.ownerId !== "string" || !record.ownerId ||
    !Number.isSafeInteger(record.pid) || Number(record.pid) <= 0 ||
    !Array.isArray(record.roots) || record.roots.length === 0 ||
    record.roots.some((root) => typeof root !== "string" || !path.isAbsolute(root)) ||
    !Number.isFinite(record.expiresAt) ||
    typeof record.generation !== "string" || !record.generation ||
    !Number.isFinite(record.updatedAt) || Number(record.updatedAt) < 0
  ) throw new Error(`Project lease record is invalid: ${filePath}`);
  return {
    leaseId: record.leaseId,
    ownerId: record.ownerId,
    pid: Number(record.pid),
    roots: record.roots.map((root) => normalized(root)),
    expiresAt: Number(record.expiresAt),
    generation: record.generation,
    updatedAt: Number(record.updatedAt),
  };
}

function normalized(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function canonicalLeaseRoot(value: string): Promise<string> {
  const resolved = path.resolve(value);
  try {
    return normalized(await fsp.realpath(resolved));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // A project may be created by a command after the lease is acquired.  Use
    // its normalized absolute path now and let the verification preflight
    // reject an unavailable root later.
    return normalized(resolved);
  }
}

function overlaps(left: string, right: string): boolean {
  const a = normalized(left);
  const b = normalized(right);
  return a === b || a.startsWith(`${b}${path.sep}`) || b.startsWith(`${a}${path.sep}`);
}

function alive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // EPERM/EACCES means the process exists but this user cannot signal it.
    // Treat every non-ESRCH result conservatively so a live owner is never
    // mistaken for a dead one during lease recovery.
    return code !== "ESRCH";
  }
}

interface RegistryLockRecord {
  ownerId: string;
  pid: number;
  createdAt: string;
}

function parseRegistryLock(value: unknown, filePath: string): RegistryLockRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Project lease registry lock is invalid: ${filePath}`);
  }
  const record = value as Partial<RegistryLockRecord>;
  if (
    typeof record.ownerId !== "string" || !record.ownerId ||
    !Number.isSafeInteger(record.pid) || Number(record.pid) <= 0 ||
    typeof record.createdAt !== "string" || !Number.isFinite(Date.parse(record.createdAt))
  ) throw new Error(`Project lease registry lock is invalid: ${filePath}`);
  return { ownerId: record.ownerId, pid: Number(record.pid), createdAt: record.createdAt };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export interface FileProjectLeaseOptions {
  directory?: string;
}

export class FileProjectLease implements ProjectLeasePort {
  private readonly directory: string;

  constructor(options: FileProjectLeaseOptions = {}) {
    // An explicit directory is already the lease registry location.  The
    // default keeps the registry in a user-scoped sibling that is independent
    // from any session -- and therefore from --data-root.
    this.directory = path.resolve(
      options.directory ?? path.join(
        process.env.LOCALAPPDATA ?? path.join(os.homedir(), ".agent-loop"),
        "project-leases"
      )
    );
  }

  async acquire(
    projectRoots: readonly string[],
    ownerId: string,
    ttlMs: number
  ): Promise<ProjectLease> {
    if (projectRoots.length === 0) throw new Error("A project lease needs at least one root.");
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) {
      throw new Error("Project lease TTL must be a positive integer.");
    }
    if (typeof ownerId !== "string" || !ownerId.trim()) throw new Error("Project lease ownerId is required.");
    const roots = [...new Set(await Promise.all(projectRoots.map(canonicalLeaseRoot)))].sort();
    await fsp.mkdir(this.directory, { recursive: true });
    const globalLock = path.join(this.directory, ".lock");
    let lockHandle: fsp.FileHandle | null = null;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        lockHandle = await fsp.open(globalLock, "wx", 0o600);
        await lockHandle.writeFile(JSON.stringify({
          ownerId: `${ownerId}:${process.pid}:${randomBytes(4).toString("hex")}`,
          pid: process.pid,
          createdAt: new Date().toISOString(),
        }), "utf8");
        break;
      } catch (error) {
        if (lockHandle) {
          try { await lockHandle.close(); } catch { /* best effort before retry */ }
          lockHandle = null;
          try { await fsp.rm(globalLock, { force: true }); } catch { /* best effort */ }
        }
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        // The registry lock is only a short critical-section mutex.  Reclaim
        // it only after validating its owner and proving that owner is dead;
        // age alone must never steal a live lease registry operation.
        try {
          const stat = await fsp.stat(globalLock);
          const raw = await fsp.readFile(globalLock, "utf8");
          const lock = parseRegistryLock(JSON.parse(raw) as unknown, globalLock);
          const createdAt = Date.parse(lock.createdAt);
          if (Date.now() - createdAt > Math.max(1_000, ttlMs) && !alive(lock.pid)) {
            await fsp.rm(globalLock, { force: true });
            continue;
          }
          // Keep the stat read so a lock replaced between read and wait is
          // handled as ordinary contention rather than as a stale record.
          void stat;
        } catch (statError) {
          const code = (statError as NodeJS.ErrnoException).code;
          if (code === "ENOENT") continue;
          throw statError;
        }
        await sleep(20);
      }
    }
    if (!lockHandle) throw new Error("Project lease registry is busy.");
    try {
      const now = Date.now();
      const files = (await fsp.readdir(this.directory)).filter((file) => file.endsWith(".json"));
      for (const file of files) {
        const filePath = path.join(this.directory, file);
        let record: LeaseRecord;
        try {
          record = parseLease(JSON.parse(await fsp.readFile(filePath, "utf8")) as unknown, filePath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error instanceof Error ? error : new Error(String(error));
        }
        const conflicts = record.roots.some((existing) => roots.some((root) => overlaps(existing, root)));
        if (!conflicts) continue;
        if (record.expiresAt > now || alive(record.pid)) {
          throw new Error(`Project is already leased by ${record.ownerId}.`);
        }
        await fsp.rm(filePath, { force: true });
      }
      const leaseId = `lease_${process.pid}_${Date.now().toString(36)}_${randomBytes(5).toString("hex")}`;
      const leasePath = path.join(this.directory, `${leaseId}.json`);
      const record: LeaseRecord = {
        leaseId,
        ownerId,
        pid: process.pid,
        roots,
        expiresAt: now + ttlMs,
        generation: randomBytes(16).toString("hex"),
        updatedAt: now,
      };
      await fsp.writeFile(leasePath, JSON.stringify(record), { encoding: "utf8", mode: 0o600, flag: "wx" });
      let released = false;
      // Serialize heartbeats with release.  A heartbeat performs a read then
      // an atomic rename; without a queue, release could remove the lease
      // between those two operations and the in-flight rename would recreate
      // a lease file after the handle had been released.
      let heartbeatWrites: Promise<void> = Promise.resolve();
      const heartbeat = (): void => {
        heartbeatWrites = heartbeatWrites.then(async () => {
          if (released) return;
          try {
            const current = JSON.parse(await fsp.readFile(leasePath, "utf8")) as LeaseRecord;
            // A lease can be replaced after this timer read. Never extend a
            // different owner's record during that race; assertOwned will make
            // the loss visible to the caller on its next check.
            if (current.leaseId !== leaseId || current.ownerId !== ownerId ||
                current.pid !== process.pid || current.generation !== record.generation) return;
            const now = Date.now();
            current.expiresAt = now + ttlMs;
            current.updatedAt = now;
            await atomicWriteJsonFile(leasePath, current);
          } catch {
            // Release or owner loss is observed by the caller on its next
            // assertOwned call.  A failed heartbeat must never recreate the
            // lease after release.
          }
        });
      };
      const timer = setInterval(() => {
        if (!released) heartbeat();
      }, Math.max(100, Math.floor(ttlMs / 3)));
      timer.unref();
      const assertOwned = async (): Promise<void> => {
        if (released) throw new Error(`Project lease ${leaseId} has been released.`);
        let current: LeaseRecord;
        try {
          current = parseLease(JSON.parse(await fsp.readFile(leasePath, "utf8")) as unknown, leasePath);
        } catch (error) {
          throw new Error(`Project lease ${leaseId} is no longer readable: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (current.leaseId !== leaseId || current.ownerId !== ownerId ||
            current.pid !== process.pid || current.generation !== record.generation) {
          throw new Error(`Project lease ${leaseId} ownership changed.`);
        }
        if (current.expiresAt <= Date.now()) throw new Error(`Project lease ${leaseId} expired.`);
      };
      return {
        leaseId,
        generation: record.generation,
        updatedAt: record.updatedAt,
        roots,
        assertOwned,
        release: async () => {
          if (released) return;
          released = true;
          clearInterval(timer);
          // Wait for a heartbeat already queued or in flight before removing
          // the record, so its atomic rename cannot resurrect the lease.
          await heartbeatWrites;
          try {
            const current = parseLease(
              JSON.parse(await fsp.readFile(leasePath, "utf8")) as unknown,
              leasePath
            );
            // A lost lease may have been replaced by a new owner.  Never
            // remove that owner's record while cleaning up this handle.
            if (current.leaseId !== leaseId || current.ownerId !== ownerId ||
                current.pid !== process.pid || current.generation !== record.generation) return;
            await fsp.rm(leasePath, { force: false });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
            throw error;
          }
        },
      };
    } finally {
      await lockHandle.close();
      await fsp.rm(globalLock, { force: true });
    }
  }
}
