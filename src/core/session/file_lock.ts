import * as fsp from "node:fs/promises";
import * as path from "node:path";

import {
  checkProcessLiveness,
  createId,
  delay,
  readJsonFile,
} from "./resilience";

export interface LockRecord {
  ownerId: string;
  ownerPid: number;
  createdAt: string;
}

export interface ShortFileLock {
  ownerId: string;
  release(): Promise<void>;
}

async function tryReclaimShortLock(
  lockPath: string,
  staleMs: number,
): Promise<void> {
  const record = await readJsonFile<LockRecord>(lockPath);
  if (!record) {
    const stat = await fsp.stat(lockPath).catch(() => null);
    if (!stat || Date.now() - stat.mtimeMs < staleMs) return;
  } else {
    const liveness = checkProcessLiveness(record.ownerPid);
    if (liveness !== "dead") return;
  }
  // Serialize reclaimers and re-read after acquiring the guard so a second
  // contender cannot rename a healthy lock created by the first takeover.
  const guardPath = `${lockPath}.reclaim`;
  let guard: fsp.FileHandle;
  try {
    guard = await fsp.open(guardPath, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const previous = await readJsonFile<LockRecord>(guardPath),
      stat = await fsp.stat(guardPath).catch(() => null);
    if (
      stat &&
      Date.now() - stat.mtimeMs >= staleMs &&
      (!previous || checkProcessLiveness(previous.ownerPid) === "dead")
    )
      await fsp.rm(guardPath, { force: true }).catch(() => {});
    return;
  }
  try {
    await guard.writeFile(
      JSON.stringify({
        ownerId: createId("reclaimer"),
        ownerPid: process.pid,
        createdAt: new Date().toISOString(),
      }),
    );
    const current = await readJsonFile<LockRecord>(lockPath);
    if (
      record
        ? current?.ownerId !== record.ownerId ||
          current?.ownerPid !== record.ownerPid
        : current !== null
    )
      return;
    if (!record) {
      const stat = await fsp.stat(lockPath).catch(() => null);
      if (!stat || Date.now() - stat.mtimeMs < staleMs) return;
    }
    const stalePath = `${lockPath}.stale.${createId("lock")}`;
    await fsp.rename(lockPath, stalePath).catch(() => {});
    await fsp.rm(stalePath, { force: true }).catch(() => {});
  } finally {
    await guard.close();
    await fsp.rm(guardPath, { force: true }).catch(() => {});
  }
}

export async function acquireShortFileLock(
  lockPath: string,
  timeoutMs = 5_000,
  staleMs = 30_000,
): Promise<ShortFileLock> {
  await fsp.mkdir(path.dirname(lockPath), { recursive: true });
  const ownerId = createId("owner");
  const deadline = Date.now() + timeoutMs;

  while (true) {
    let handle: fsp.FileHandle | null = null;
    try {
      handle = await fsp.open(lockPath, "wx");
      const record: LockRecord = {
        ownerId,
        ownerPid: process.pid,
        createdAt: new Date().toISOString(),
      };
      await handle.writeFile(JSON.stringify(record, null, 2), "utf8");
      await handle.close();
      handle = null;
      return {
        ownerId,
        release: async () => {
          const current = await readJsonFile<LockRecord>(lockPath);
          if (current?.ownerId === ownerId) {
            await fsp.rm(lockPath, { force: true }).catch(() => {});
          }
        },
      };
    } catch (err) {
      if (handle) await handle.close().catch(() => {});
      const code = (err as NodeJS.ErrnoException).code;
      const transientWindowsContention =
        process.platform === "win32" &&
        (code === "EPERM" || code === "EBUSY" || code === "EACCES");
      if (code !== "EEXIST" && !transientWindowsContention) throw err;
      if (code === "EEXIST") await tryReclaimShortLock(lockPath, staleMs);
      if (Date.now() >= deadline) {
        throw new Error(`Timed out acquiring lock: ${lockPath}`);
      }
      await delay(40 + Math.floor(Math.random() * 40));
    }
  }
}

export async function withShortFileLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
  timeoutMs = 5_000,
): Promise<T> {
  const lock = await acquireShortFileLock(lockPath, timeoutMs);
  try {
    return await operation();
  } finally {
    await lock.release();
  }
}
