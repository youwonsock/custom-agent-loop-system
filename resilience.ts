import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

export type AttemptStatus =
  | "starting"
  | "running"
  | "retry_wait"
  | "succeeded"
  | "transport_timeout"
  | "idle_timeout"
  | "tool_timeout"
  | "phase_timeout"
  | "spawn_error"
  | "process_exit"
  | "incomplete_response"
  | "cancelled"
  | "unknown_outcome"
  | "orphaned_process";

export type FailureKind =
  | "transport_timeout"
  | "idle_timeout"
  | "tool_timeout"
  | "phase_timeout"
  | "spawn_error"
  | "process_exit"
  | "incomplete_response"
  | "network"
  | "rate_limited"
  | "auth"
  | "model_unavailable"
  | "permission"
  | "role_violation"
  | "cancelled"
  | "orphaned_process"
  | "unknown";

export interface SessionLease {
  ownerId: string;
  ownerPid: number;
  childPid: number | null;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
}

export interface ControlRequest {
  requestId: string;
  type: "STOP" | "INTERRUPT";
  createdAt: string;
  message: string | null;
}

export interface ControlAck {
  requestId: string;
  type: ControlRequest["type"];
  acceptedAt: string;
  completedAt: string | null;
  result: "accepted" | "completed" | "cancelled" | "failed";
  message: string | null;
}

export interface ControlQueuePaths {
  root: string;
  requests: string;
  processing: string;
  acks: string;
  quarantine: string;
}

const CONTROL_REQUEST_ID_PATTERN = /^control_[a-z0-9]{1,16}_[a-f0-9]{12}$/;
const MAX_CONTROL_MESSAGE_LENGTH = 16 * 1024;
const CONTROL_ATOMIC_TEMP_PATTERN = /^control_[a-z0-9]{1,16}_[a-f0-9]{12}\.json\.tmp\.\d+\.\d+\.[a-f0-9]{8}$/;

export type ProcessLiveness = "alive" | "dead" | "unknown";

export function createId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(6).toString("hex")}`;
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

export async function atomicWriteJsonFile(filePath: string, data: unknown): Promise<void> {
  await requireParentDirectory(filePath);
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString("hex")}`;
  try {
    await fsp.writeFile(tmpPath, JSON.stringify(data, null, 2), "utf8");
  } catch (error) {
    try { await fsp.rm(tmpPath, { force: true }); }
    catch (releaseError) {
      throw new AggregateError([error, releaseError], `Atomic write and temporary-file cleanup failed for ${filePath}.`);
    }
    throw error;
  }
  try {
    await renameWithRetry(tmpPath, filePath);
  } catch (err) {
    try {
      await fsp.rm(tmpPath, { force: true });
    } catch (releaseError) {
      throw new AggregateError([err, releaseError], `Atomic write failed for ${filePath}; temporary-file cleanup also failed.`);
    }
    throw err;
  }
}

export async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof SyntaxError) throw new Error(`Malformed JSON: ${filePath}`);
    throw error;
  }
}

async function requireParentDirectory(filePath: string): Promise<void> {
  const directory = path.dirname(filePath);
  let stat: fs.Stats;
  try {
    stat = await fsp.stat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Parent directory is not initialized: ${directory}`);
    }
    throw error;
  }
  if (!stat.isDirectory()) throw new Error(`Parent path is not a directory: ${directory}`);
}

export async function renameWithRetry(
  sourcePath: string,
  destinationPath: string,
  maxRetries = 5
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      await fsp.rename(sourcePath, destinationPath);
      return;
    } catch (err) {
      lastError = err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") {
        throw err;
      }
      await delay(50 * 2 ** attempt);
    }
  }
  throw lastError;
}

export function checkProcessLiveness(pid: number | null | undefined): ProcessLiveness {
  if (!pid || pid <= 0) return "dead";
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "dead";
    if (code === "EPERM" || code === "EACCES") return "unknown";
    return process.platform === "win32" ? "dead" : "unknown";
  }
}

export function assertSafeSessionId(sessionId: string): void {
  if (
    sessionId.length === 0 ||
    sessionId === "." ||
    sessionId === ".." ||
    sessionId.includes("/") ||
    sessionId.includes("\\") ||
    sessionId.includes("\0")
  ) {
    throw new Error(`Unsafe session ID: ${JSON.stringify(sessionId)}`);
  }
}

export function resolveContainedSessionPath(sessionsRoot: string, sessionId: string): string {
  assertSafeSessionId(sessionId);
  const root = path.resolve(sessionsRoot);
  const resolved = path.resolve(root, sessionId);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative) || relative.length === 0) {
    throw new Error(`Session path escapes sessions root: ${sessionId}`);
  }
  return resolved;
}

export function collectRecoveredChildPids(
  previousLease: SessionLease | null,
  activeAttemptChildPid: number | null | undefined
): number[] {
  return Array.from(
    new Set(
      [previousLease?.childPid ?? null, activeAttemptChildPid ?? null].filter(
        (pid): pid is number => typeof pid === "number" && pid > 0
      )
    )
  );
}

export interface LockRecord {
  ownerId: string;
  ownerPid: number;
  createdAt: string;
}

function validateLockRecord(value: unknown, filePath: string): LockRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Lock owner record is invalid: ${filePath}`);
  }
  const record = value as Partial<LockRecord>;
  if (
    typeof record.ownerId !== "string" || !record.ownerId ||
    !Number.isSafeInteger(record.ownerPid) || Number(record.ownerPid) <= 0 ||
    typeof record.createdAt !== "string" || !Number.isFinite(Date.parse(record.createdAt))
  ) {
    throw new Error(`Lock owner record is invalid: ${filePath}`);
  }
  return record as LockRecord;
}

export interface ShortFileLock {
  ownerId: string;
  release(): Promise<void>;
}

async function tryReclaimShortLock(lockPath: string, staleMs: number): Promise<void> {
  let record: LockRecord;
  try {
    const raw = await readJsonFile<LockRecord>(lockPath);
    if (raw === null) {
      // A missing file is a narrow create/unlink race.  A present file without
      // a valid owner record is not reclaimable: its age alone cannot prove
      // that another process has stopped writing the lock metadata.
      try { await fsp.stat(lockPath); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      throw new Error(`Lock owner record is missing: ${lockPath}`);
    }
    record = validateLockRecord(raw, lockPath);
  } catch (error) {
    // A present but malformed lock is not safe to reclaim. The owner record is
    // the authority for fencing and must be repaired by the operator.
    throw new Error(`Cannot reclaim malformed lock ${lockPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const createdAt = Date.parse(record.createdAt);
  if (!Number.isFinite(createdAt)) throw new Error(`Lock ${lockPath} has an invalid owner timestamp.`);
  if (Date.now() - createdAt < staleMs) return;
  const liveness = checkProcessLiveness(record.ownerPid);
  if (liveness !== "dead") return;

  const stalePath = `${lockPath}.stale.${createId("lock")}`;
  try {
    await fsp.rename(lockPath, stalePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EEXIST") return;
    throw error;
  }
  await fsp.rm(stalePath, { force: true });
}

export async function acquireShortFileLock(
  lockPath: string,
  timeoutMs = 5_000,
  staleMs = 30_000
): Promise<ShortFileLock> {
  await requireParentDirectory(lockPath);
  const ownerId = createId("owner");
  const deadline = Date.now() + timeoutMs;

  while (true) {
    let handle: fsp.FileHandle | null = null;
    let lockCreated = false;
    try {
      handle = await fsp.open(lockPath, "wx");
      lockCreated = true;
      const record: LockRecord = {
        ownerId,
        ownerPid: process.pid,
        createdAt: new Date().toISOString(),
      };
      await handle.writeFile(JSON.stringify(record, null, 2), "utf8");
      await handle.close();
      handle = null;
      let released = false;
      let releasePromise: Promise<void> | null = null;
      return {
        ownerId,
        release: () => {
          if (released) return Promise.resolve();
          if (releasePromise) return releasePromise;
          releasePromise = (async () => {
            const current = validateLockRecord(await readJsonFile<LockRecord>(lockPath), lockPath);
            if (current.ownerId !== ownerId) throw new Error(`Lock ownership changed before release: ${lockPath}`);
            await fsp.rm(lockPath, { force: false });
            released = true;
          })().catch((error) => {
            // A failed release is retryable. Keep the failed resource marked as
            // live while sharing the in-flight attempt with concurrent callers.
            releasePromise = null;
            throw error;
          });
          return releasePromise;
        },
      };
    } catch (err) {
      let closeError: unknown;
      if (handle) {
        try { await handle.close(); }
        catch (error) { closeError = error; }
      }
      if (closeError !== undefined) {
        const releaseFailures: unknown[] = [closeError];
        if (lockCreated) {
          try { await fsp.rm(lockPath, { force: true }); }
          catch (releaseError) { releaseFailures.push(releaseError); }
        }
        throw new AggregateError([err, ...releaseFailures], `Lock acquisition and handle release failed: ${lockPath}`);
      }
      const code = (err as NodeJS.ErrnoException).code;
      const transientWindowsContention =
        process.platform === "win32" &&
        (code === "EPERM" || code === "EBUSY" || code === "EACCES");
      if (lockCreated) {
        try { await fsp.rm(lockPath, { force: true }); }
        catch (releaseError) {
          throw new AggregateError([err, releaseError], `Lock acquisition cleanup failed: ${lockPath}`);
        }
      }
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
  timeoutMs = 5_000
): Promise<T> {
  const lock = await acquireShortFileLock(lockPath, timeoutMs);
  let value!: T;
  let operationError: unknown;
  try {
    value = await operation();
  } catch (error) {
    operationError = error;
  }
  let releaseError: unknown;
  try {
    await lock.release();
  } catch (error) {
    releaseError = error;
  }
  if (operationError !== undefined && releaseError !== undefined) {
    throw new AggregateError([operationError, releaseError], `Operation and lock release failed for ${lockPath}.`);
  }
  if (operationError !== undefined) throw operationError;
  if (releaseError !== undefined) throw releaseError;
  return value;
}

export interface SessionOwnershipOptions {
  sessionDir: string;
  ownerLockFileName: string;
  leaseFileName: string;
  heartbeatIntervalMs: number;
  leaseTtlMs: number;
}

export interface SessionOwnershipAcquireResult {
  previousLease: SessionLease | null;
  recoveredStaleOwner: boolean;
}

function validateSessionLease(value: unknown, filePath: string): SessionLease {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Session lease is invalid: ${filePath}`);
  }
  const lease = value as Partial<SessionLease>;
  if (
    typeof lease.ownerId !== "string" || !lease.ownerId ||
    !Number.isSafeInteger(lease.ownerPid) || Number(lease.ownerPid) <= 0 ||
    (lease.childPid !== null && (!Number.isSafeInteger(lease.childPid) || Number(lease.childPid) <= 0)) ||
    typeof lease.acquiredAt !== "string" || !Number.isFinite(Date.parse(lease.acquiredAt)) ||
    typeof lease.heartbeatAt !== "string" || !Number.isFinite(Date.parse(lease.heartbeatAt)) ||
    typeof lease.expiresAt !== "string" || !Number.isFinite(Date.parse(lease.expiresAt))
  ) {
    throw new Error(`Session lease is invalid: ${filePath}`);
  }
  return lease as SessionLease;
}

export class SessionOwnership {
  readonly ownerId = createId("session");
  private childPid: number | null = null;
  private acquiredAt = "";
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private heartbeatRunning = false;
  private heartbeatWrites: Promise<void> = Promise.resolve();
  private heartbeatFailure: unknown = null;
  private acquired = false;
  private lockReleased = false;
  private leaseReleased = false;
  private releasePromise: Promise<void> | null = null;

  constructor(private readonly options: SessionOwnershipOptions) {}

  get lockPath(): string {
    return path.join(this.options.sessionDir, this.options.ownerLockFileName);
  }

  get leasePath(): string {
    return path.join(this.options.sessionDir, this.options.leaseFileName);
  }

  async acquire(): Promise<SessionOwnershipAcquireResult> {
    let sessionStat: fs.Stats;
    try { sessionStat = await fsp.stat(this.options.sessionDir); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Session storage is not initialized: ${this.options.sessionDir}`);
      }
      throw error;
    }
    if (!sessionStat.isDirectory()) throw new Error(`Session storage is not a directory: ${this.options.sessionDir}`);
    let previousLease: SessionLease | null = null;
    let recoveredStaleOwner = false;

    for (let pass = 0; pass < 3; pass++) {
      let handle: fsp.FileHandle | null = null;
      let lockCreated = false;
      try {
        handle = await fsp.open(this.lockPath, "wx");
        lockCreated = true;
        this.acquiredAt = new Date().toISOString();
        await handle.writeFile(
          JSON.stringify(
            { ownerId: this.ownerId, ownerPid: process.pid, createdAt: this.acquiredAt },
            null,
            2
          ),
          "utf8"
        );
        await handle.close();
        handle = null;
        this.acquired = true;
        this.lockReleased = false;
        this.leaseReleased = false;
        this.heartbeatFailure = null;
        await this.writeHeartbeat();
        this.startHeartbeat();
        return { previousLease, recoveredStaleOwner };
      } catch (err) {
        let closeError: unknown;
        if (handle) {
          try { await handle.close(); }
          catch (error) { closeError = error; }
        }
        const releaseFailures: unknown[] = [];
        if (lockCreated) {
          try { await fsp.rm(this.lockPath, { force: true }); }
          catch (releaseError) { releaseFailures.push(releaseError); }
        }
        if (closeError !== undefined) {
          throw new AggregateError([err, closeError, ...releaseFailures], `Session owner lock and handle release failed: ${this.options.sessionDir}`);
        }
        if (releaseFailures.length > 0) {
          throw new AggregateError([err, ...releaseFailures], `Session owner lock cleanup failed: ${this.options.sessionDir}`);
        }
        const errorCode = (err as NodeJS.ErrnoException).code;
        if (errorCode !== "EEXIST") {
          // A failure between the exclusive lock create and the first lease write
          // must not leave a lock that no future owner can recover.
          if (this.acquired) {
            try { await this.release(); }
            catch (releaseError) { throw new AggregateError([err, releaseError], `Session ownership acquisition and release failed: ${this.options.sessionDir}`); }
          }
          throw err;
        }

        const previousLeaseRaw = await readJsonFile<SessionLease>(this.leasePath);
        previousLease = previousLeaseRaw === null ? null : validateSessionLease(previousLeaseRaw, this.leasePath);
        const lockRecordRaw = await readJsonFile<LockRecord>(this.lockPath);
        const lockRecord = lockRecordRaw ? validateLockRecord(lockRecordRaw, this.lockPath) : null;
        if (!previousLease) {
          if (!lockRecord) {
            throw new Error(
              `Session owner lock is unreadable; ownership cannot be verified: ${this.options.sessionDir}`
            );
          }
          const createdAt = Date.parse(lockRecord.createdAt);
          if (!Number.isFinite(createdAt) || Date.now() - createdAt < this.options.leaseTtlMs) {
            throw new Error(
              `Session is already owned and its first lease is not yet readable: ${this.options.sessionDir}`
            );
          }
          const ownerLiveness = checkProcessLiveness(lockRecord.ownerPid);
          if (ownerLiveness !== "dead") {
            throw new Error(
              ownerLiveness === "alive"
                ? `Session is already running under pid ${lockRecord.ownerPid}`
                : `Cannot verify existing session owner pid ${lockRecord.ownerPid}`
            );
          }
        } else {
          if (!lockRecord) {
            throw new Error(`Session owner lock is missing: ${this.options.sessionDir}`);
          }
          if (
            lockRecord.ownerId !== previousLease.ownerId ||
            lockRecord.ownerPid !== previousLease.ownerPid
          ) {
            throw new Error(
              `Session owner lock and lease do not identify the same owner: ${this.options.sessionDir}`
            );
          }
          const expiresAt = Date.parse(previousLease.expiresAt);
          if (!Number.isFinite(expiresAt) || expiresAt > Date.now()) {
            throw new Error(`Session is already running under owner ${previousLease.ownerId}`);
          }
          const ownerLiveness = checkProcessLiveness(previousLease.ownerPid);
          if (ownerLiveness !== "dead") {
            throw new Error(
              ownerLiveness === "alive"
                ? `Session is already running under pid ${previousLease.ownerPid}`
                : `Cannot verify existing session owner pid ${previousLease.ownerPid}`
            );
          }
        }

        const stalePath = `${this.lockPath}.stale.${this.ownerId}`;
        try {
          await fsp.rename(this.lockPath, stalePath);
          recoveredStaleOwner = true;
          await fsp.rm(stalePath, { force: true });
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "ENOENT" && code !== "EEXIST") throw error;
          await delay(50);
        }
      }
    }
    throw new Error(`Failed to acquire session ownership: ${this.options.sessionDir}`);
  }

  setChildPid(pid: number | null): void {
    this.childPid = pid;
    if (this.acquired) {
      this.scheduleHeartbeat();
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      if (this.heartbeatRunning) return;
      this.heartbeatRunning = true;
      this.scheduleHeartbeat()
        .finally(() => {
          this.heartbeatRunning = false;
        });
    }, this.options.heartbeatIntervalMs);
  }

  private scheduleHeartbeat(): Promise<void> {
    this.heartbeatWrites = this.heartbeatWrites
      .then(() => this.writeHeartbeat());
    this.heartbeatWrites = this.heartbeatWrites.catch((error) => {
      this.heartbeatFailure ??= error;
    });
    return this.heartbeatWrites;
  }

  private async writeHeartbeat(): Promise<void> {
    const now = Date.now();
    const lease: SessionLease = {
      ownerId: this.ownerId,
      ownerPid: process.pid,
      childPid: this.childPid,
      acquiredAt: this.acquiredAt || new Date(now).toISOString(),
      heartbeatAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.options.leaseTtlMs).toISOString(),
    };
    await atomicWriteJsonFile(this.leasePath, lease);
  }

  async release(): Promise<void> {
    if (this.releasePromise) return this.releasePromise;
    this.releasePromise = this.performRelease().catch((error) => {
      // A failed resource remains eligible for a subsequent retry. Clearing
      // the promise also lets concurrent callers observe the same failure
      // while a later caller retries only the resources that remain.
      this.releasePromise = null;
      throw error;
    });
    return this.releasePromise;
  }

  private async performRelease(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (!this.acquired && this.lockReleased && this.leaseReleased && !this.heartbeatFailure) return;
    if (!this.acquired) return;
    const failures: unknown[] = [];
    try { await this.heartbeatWrites; }
    catch (error) { failures.push(error); }
    if (this.heartbeatFailure) failures.push(this.heartbeatFailure);
    if (!this.lockReleased) {
      try {
        const rawRecord = await readJsonFile<LockRecord>(this.lockPath);
        if (!rawRecord) throw new Error(`Session owner lock is missing: ${this.lockPath}`);
        const record = validateLockRecord(rawRecord, this.lockPath);
        if (record.ownerId !== this.ownerId) throw new Error(`Session owner lock changed before release: ${this.lockPath}`);
        await fsp.rm(this.lockPath);
        this.lockReleased = true;
      } catch (error) {
        failures.push(error);
      }
    }
    if (!this.leaseReleased) {
      try {
        const rawLease = await readJsonFile<SessionLease>(this.leasePath);
        if (!rawLease) throw new Error(`Session lease is missing: ${this.leasePath}`);
        const lease = validateSessionLease(rawLease, this.leasePath);
        if (lease.ownerId !== this.ownerId) throw new Error(`Session lease changed before release: ${this.leasePath}`);
        await fsp.rm(this.leasePath);
        this.leaseReleased = true;
      } catch (error) {
        failures.push(error);
      }
    }
    // Once both authoritative ownership files are gone, the session is no
    // longer owned even when a final heartbeat write failed.  Keep the
    // heartbeat error in this result, but do not make the next release retry
    // already-removed resources.
    if (this.lockReleased && this.leaseReleased) this.acquired = false;
    // A heartbeat failure is a failed lease write, not a permanent ownership
    // identity. Once surfaced, clear it so a later release call retries only
    // the resources that are still present instead of replaying a stale error.
    this.heartbeatFailure = null;
    if (failures.length > 0) throw new AggregateError(failures, `Session ownership release failed: ${this.options.sessionDir}`);
  }
}

export function getControlQueuePaths(sessionDir: string, controlDirName = "control"): ControlQueuePaths {
  if (
    typeof controlDirName !== "string" ||
    !controlDirName.trim() ||
    path.isAbsolute(controlDirName) ||
    path.win32.isAbsolute(controlDirName) ||
    path.posix.isAbsolute(controlDirName) ||
    controlDirName.includes("\0") ||
    controlDirName.replace(/\\/gu, "/").split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`Control directory name must be a contained relative path: ${controlDirName}`);
  }
  const root = path.join(sessionDir, controlDirName);
  return {
    root,
    requests: path.join(root, "requests"),
    processing: path.join(root, "processing"),
    acks: path.join(root, "acks"),
    quarantine: path.join(root, "quarantine"),
  };
}

export async function initControlQueue(paths: ControlQueuePaths): Promise<void> {
  await Promise.all([
    fsp.mkdir(paths.requests, { recursive: true }),
    fsp.mkdir(paths.processing, { recursive: true }),
    fsp.mkdir(paths.acks, { recursive: true }),
    fsp.mkdir(paths.quarantine, { recursive: true }),
  ]);
}

async function requireControlQueue(paths: ControlQueuePaths): Promise<void> {
  for (const directory of [paths.requests, paths.processing, paths.acks, paths.quarantine]) {
    let stat: fs.Stats;
    try {
      stat = await fsp.stat(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Control queue is not initialized: ${paths.root}`);
      }
      throw error;
    }
    if (!stat.isDirectory()) throw new Error(`Control queue path is not a directory: ${directory}`);
  }
}

export function assertSafeControlRequestId(value: unknown): string {
  if (typeof value !== "string" || !CONTROL_REQUEST_ID_PATTERN.test(value)) {
    throw new Error(`Unsafe control request id: ${JSON.stringify(value)}`);
  }
  return value;
}

function controlFilePath(directory: string, requestId: string): string {
  const safeId = assertSafeControlRequestId(requestId);
  const root = path.resolve(directory);
  const resolved = path.resolve(root, `${safeId}.json`);
  const relative = path.relative(root, resolved);
  if (
    relative !== `${safeId}.json` ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Control path escapes its queue directory: ${safeId}`);
  }
  return resolved;
}

function validControlRequest(value: unknown, fileName: string): value is ControlRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const request = value as Partial<ControlRequest>;
  if (typeof request.requestId !== "string" || !CONTROL_REQUEST_ID_PATTERN.test(request.requestId)) {
    return false;
  }
  if (fileName !== `${request.requestId}.json`) return false;
  if (request.type !== "STOP" && request.type !== "INTERRUPT") return false;
  if (
    typeof request.createdAt !== "string" ||
    !Number.isFinite(Date.parse(request.createdAt)) ||
    new Date(request.createdAt).toISOString() !== request.createdAt
  ) {
    return false;
  }
  if (
    request.message !== null &&
    (typeof request.message !== "string" || request.message.length > MAX_CONTROL_MESSAGE_LENGTH)
  ) {
    return false;
  }
  return true;
}

function validControlAck(
  value: unknown,
  expectedRequestId: string,
  expectedType?: ControlRequest["type"]
): value is ControlAck {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const ack = value as Partial<ControlAck>;
  if (ack.requestId !== expectedRequestId || !CONTROL_REQUEST_ID_PATTERN.test(ack.requestId)) return false;
  if (ack.type !== "STOP" && ack.type !== "INTERRUPT") return false;
  if (expectedType && ack.type !== expectedType) return false;
  if (
    typeof ack.acceptedAt !== "string" ||
    !Number.isFinite(Date.parse(ack.acceptedAt)) ||
    new Date(ack.acceptedAt).toISOString() !== ack.acceptedAt
  ) return false;
  if (
    ack.completedAt !== null &&
    (typeof ack.completedAt !== "string" ||
      !Number.isFinite(Date.parse(ack.completedAt)) ||
      new Date(ack.completedAt).toISOString() !== ack.completedAt)
  ) return false;
  if (!["accepted", "completed", "cancelled", "failed"].includes(String(ack.result))) return false;
  if (ack.result === "accepted" && ack.completedAt !== null) return false;
  if (ack.result !== "accepted" && ack.completedAt === null) return false;
  if (
    ack.message !== null &&
    (typeof ack.message !== "string" || ack.message.length > MAX_CONTROL_MESSAGE_LENGTH)
  ) return false;
  return true;
}

type StrictJsonRead =
  | { kind: "missing" }
  | { kind: "malformed" }
  | { kind: "value"; value: unknown };

async function readControlJsonStrict(filePath: string): Promise<StrictJsonRead> {
  let stat: fs.Stats;
  try {
    stat = await fsp.lstat(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    throw err;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) return { kind: "malformed" };
  let content: string;
  try {
    content = await fsp.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    throw err;
  }
  try {
    return { kind: "value", value: JSON.parse(content) as unknown };
  } catch (err) {
    if (err instanceof SyntaxError) return { kind: "malformed" };
    throw err;
  }
}

async function quarantineControlEntry(
  paths: ControlQueuePaths,
  sourcePath: string
): Promise<boolean> {
  const quarantinePath = path.join(
    paths.quarantine,
    `${createId("malformed")}.control`
  );
  try {
    await fsp.rename(sourcePath, quarantinePath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

export async function enqueueControlRequest(
  paths: ControlQueuePaths,
  type: ControlRequest["type"],
  message: string | null = null
): Promise<ControlRequest> {
  if (type !== "STOP" && type !== "INTERRUPT") {
    throw new Error(`Unsupported control request type: ${String(type)}`);
  }
  if (message !== null && typeof message !== "string") {
    throw new Error("Control request message must be a string or null.");
  }
  const normalizedMessage = message?.trim() || null;
  if (normalizedMessage && normalizedMessage.length > MAX_CONTROL_MESSAGE_LENGTH) {
    throw new Error(`Control request message exceeds ${MAX_CONTROL_MESSAGE_LENGTH} characters.`);
  }
  await requireControlQueue(paths);
  const request: ControlRequest = {
    requestId: createId("control"),
    type,
    createdAt: new Date().toISOString(),
    message: normalizedMessage,
  };
  assertSafeControlRequestId(request.requestId);
  await atomicWriteJsonFile(path.join(paths.requests, `${request.requestId}.json`), request);
  return request;
}

export interface ClaimedControlRequest {
  request: ControlRequest;
}

export async function claimNextControlRequest(
  paths: ControlQueuePaths
): Promise<ClaimedControlRequest | null> {
  await requireControlQueue(paths);
  const entries = await fsp.readdir(paths.requests, { withFileTypes: true });
  const candidates: Array<{ request: ControlRequest; fileName: string }> = [];
  for (const entry of entries) {
    if (CONTROL_ATOMIC_TEMP_PATTERN.test(entry.name)) continue;
    const sourcePath = path.join(paths.requests, entry.name);
    if (!entry.isFile()) {
      await quarantineControlEntry(paths, sourcePath);
      continue;
    }
    const read = await readControlJsonStrict(sourcePath);
    if (read.kind === "missing") continue;
    if (read.kind !== "value" || !validControlRequest(read.value, entry.name)) {
      await quarantineControlEntry(paths, sourcePath);
      continue;
    }
    candidates.push({ request: read.value, fileName: entry.name });
  }
  candidates.sort((a, b) => {
    if (a.request.type !== b.request.type) return a.request.type === "STOP" ? -1 : 1;
    return a.request.createdAt.localeCompare(b.request.createdAt);
  });

  for (const candidate of candidates) {
    const sourcePath = path.join(paths.requests, candidate.fileName);
    const processingPath = controlFilePath(paths.processing, candidate.request.requestId);
    try {
      await fsp.rename(sourcePath, processingPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EEXIST") continue;
      throw err;
    }
    // Re-read after the atomic claim so a pre-rename validation/swap race cannot
    // substitute a different request under the validated filename.
    const claimedRead = await readControlJsonStrict(processingPath);
    if (
      claimedRead.kind !== "value" ||
      !validControlRequest(claimedRead.value, candidate.fileName)
    ) {
      if (claimedRead.kind !== "missing") await quarantineControlEntry(paths, processingPath);
      continue;
    }
    const ack: ControlAck = {
      requestId: claimedRead.value.requestId,
      type: claimedRead.value.type,
      acceptedAt: new Date().toISOString(),
      completedAt: null,
      result: "accepted",
      message: null,
    };
    await atomicWriteJsonFile(controlFilePath(paths.acks, claimedRead.value.requestId), ack);
    return { request: claimedRead.value };
  }
  return null;
}

export async function recoverClaimedControlRequests(paths: ControlQueuePaths): Promise<void> {
  await requireControlQueue(paths);
  const entries = await fsp.readdir(paths.processing, { withFileTypes: true });
  for (const entry of entries) {
    if (CONTROL_ATOMIC_TEMP_PATTERN.test(entry.name)) continue;
    const processingPath = path.join(paths.processing, entry.name);
    if (!entry.isFile()) {
      await quarantineControlEntry(paths, processingPath);
      continue;
    }
    const requestRead = await readControlJsonStrict(processingPath);
    if (requestRead.kind === "missing") continue;
    if (requestRead.kind !== "value" || !validControlRequest(requestRead.value, entry.name)) {
      await quarantineControlEntry(paths, processingPath);
      continue;
    }
    const request = requestRead.value;
    const ackPath = controlFilePath(paths.acks, request.requestId);
    const ackRead = await readControlJsonStrict(ackPath);
    if (ackRead.kind === "malformed" || (
      ackRead.kind === "value" && !validControlAck(ackRead.value, request.requestId, request.type)
    )) {
      await quarantineControlEntry(paths, ackPath);
    }
    if (
      ackRead.kind === "value" &&
      validControlAck(ackRead.value, request.requestId, request.type) &&
      ackRead.value.completedAt
    ) {
      await fsp.rm(processingPath, { force: true });
      continue;
    }
    try {
      await fsp.rename(processingPath, controlFilePath(paths.requests, request.requestId));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "EEXIST") throw err;
    }
  }
}

export async function completeControlRequest(
  paths: ControlQueuePaths,
  claimed: ClaimedControlRequest,
  result: ControlAck["result"],
  message: string | null = null
): Promise<void> {
  if (result !== "completed" && result !== "cancelled" && result !== "failed") {
    throw new Error(`Unsupported completed control result: ${String(result)}`);
  }
  if (message !== null && typeof message !== "string") {
    throw new Error("Control ACK message must be a string or null.");
  }
  if (message !== null && message.length > MAX_CONTROL_MESSAGE_LENGTH) {
    throw new Error(`Control ACK message exceeds ${MAX_CONTROL_MESSAGE_LENGTH} characters.`);
  }
  const requestId = assertSafeControlRequestId(claimed.request.requestId);
  if (!validControlRequest(claimed.request, `${requestId}.json`)) {
    throw new Error(`Malformed claimed control request: ${requestId}`);
  }
  const expectedProcessingPath = controlFilePath(paths.processing, requestId);
  const processingRead = await readControlJsonStrict(expectedProcessingPath);
  if (
    processingRead.kind !== "value" ||
    !validControlRequest(processingRead.value, `${requestId}.json`) ||
    JSON.stringify(processingRead.value) !== JSON.stringify(claimed.request)
  ) {
    if (processingRead.kind !== "missing") {
      await quarantineControlEntry(paths, expectedProcessingPath);
    }
    throw new Error(`Claimed control request changed before completion: ${requestId}`);
  }
  const ackPath = controlFilePath(paths.acks, requestId);
  const existingRead = await readControlJsonStrict(ackPath);
  if (
    existingRead.kind === "malformed" ||
    (existingRead.kind === "value" &&
      !validControlAck(existingRead.value, requestId, claimed.request.type))
  ) {
    await quarantineControlEntry(paths, ackPath);
    throw new Error(`Malformed control ACK for request: ${requestId}`);
  }
  const existing = existingRead.kind === "value" ? existingRead.value as ControlAck : null;
  const ack: ControlAck = {
    requestId: claimed.request.requestId,
    type: claimed.request.type,
    acceptedAt: existing?.acceptedAt ?? new Date().toISOString(),
    completedAt: new Date().toISOString(),
    result,
    message,
  };
  await atomicWriteJsonFile(ackPath, ack);
  await fsp.rm(expectedProcessingPath, { force: true });
}

export async function readControlAck(
  paths: ControlQueuePaths,
  requestId: string
): Promise<ControlAck | null> {
  await requireControlQueue(paths);
  const safeId = assertSafeControlRequestId(requestId);
  const ackPath = controlFilePath(paths.acks, safeId);
  const read = await readControlJsonStrict(ackPath);
  if (read.kind === "missing") return null;
  if (read.kind !== "value" || !validControlAck(read.value, safeId)) {
    await quarantineControlEntry(paths, ackPath);
    throw new Error(`Malformed control ACK for request: ${safeId}`);
  }
  return read.value;
}

export async function importLegacyControlFiles(
  paths: ControlQueuePaths,
  stopPath: string,
  interruptPath: string
): Promise<void> {
  const importOne = async (
    filePath: string,
    type: ControlRequest["type"]
  ): Promise<void> => {
    try {
      const message = (await fsp.readFile(filePath, "utf8")).trim();
      if (message.length > 0) {
        await enqueueControlRequest(paths, type, type === "INTERRUPT" ? message : null);
      }
      await fsp.rm(filePath, { force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  };
  await importOne(stopPath, "STOP");
  await importOne(interruptPath, "INTERRUPT");
}

export async function backupFileOnce(filePath: string, suffix: string): Promise<string | null> {
  const backupPath = `${filePath}.${suffix}`;
  try {
    await fsp.access(backupPath, fs.constants.F_OK);
    return backupPath;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    await fsp.copyFile(filePath, backupPath, fs.constants.COPYFILE_EXCL);
    return backupPath;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return backupPath;
    throw err;
  }
}
