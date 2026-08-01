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
  | "cancelled"
  | "orphaned_process"
  | "unknown";

export interface AttemptFailure {
  kind: FailureKind;
  message: string;
  retryable: boolean;
  occurredAt: string;
  attemptId: string | null;
  role: string | null;
  phase: string | null;
  exitCode: number | null;
  cliSessionId: string | null;
}

export interface AgentAttemptState {
  attemptId: string;
  role: string;
  phase: string;
  status: AttemptStatus;
  ownerPid: number;
  childPid: number | null;
  cliSessionId: string | null;
  attemptNumber: number;
  maxAttempts: number;
  reconnectUsed: boolean;
  cycleStartedAt: string;
  startedAt: string;
  lastOutputAt: string | null;
  lastProgressAt: string | null;
  deadlineAt: string;
  nextRetryAt: string | null;
  endedAt: string | null;
  exitCode: number | null;
  failureKind: FailureKind | null;
  failureMessage: string | null;
  outputLogPath: string | null;
  activity: "initial_transport" | "model_generation" | "tool_execution";
  mode: "standard" | "completion_recovery";
  completionRecoveryNumber: number;
}

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
}

export type ProcessLiveness = "alive" | "dead" | "unknown";

export function createId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(6).toString("hex")}`;
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

export async function atomicWriteJsonFile(filePath: string, data: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString("hex")}`;
  await fsp.writeFile(tmpPath, JSON.stringify(data, null, 2), "utf8");
  try {
    await renameWithRetry(tmpPath, filePath);
  } catch (err) {
    await fsp.rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
}

export async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8")) as T;
  } catch {
    return null;
  }
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

export interface ShortFileLock {
  ownerId: string;
  release(): Promise<void>;
}

async function tryReclaimShortLock(lockPath: string, staleMs: number): Promise<void> {
  const record = await readJsonFile<LockRecord>(lockPath);
  if (!record) {
    const stat = await fsp.stat(lockPath).catch(() => null);
    if (!stat || Date.now() - stat.mtimeMs < staleMs) return;
  } else {
    const createdAt = Date.parse(record.createdAt);
    if (Number.isFinite(createdAt) && Date.now() - createdAt < staleMs) return;
    const liveness = checkProcessLiveness(record.ownerPid);
    if (liveness !== "dead") return;
  }

  const stalePath = `${lockPath}.stale.${createId("lock")}`;
  await fsp.rename(lockPath, stalePath).catch(() => {});
  await fsp.rm(stalePath, { force: true }).catch(() => {});
}

export async function acquireShortFileLock(
  lockPath: string,
  timeoutMs = 5_000,
  staleMs = 30_000
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
  timeoutMs = 5_000
): Promise<T> {
  const lock = await acquireShortFileLock(lockPath, timeoutMs);
  try {
    return await operation();
  } finally {
    await lock.release();
  }
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

export class SessionOwnership {
  readonly ownerId = createId("session");
  private childPid: number | null = null;
  private acquiredAt = "";
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private heartbeatRunning = false;
  private heartbeatWrites: Promise<void> = Promise.resolve();
  private acquired = false;

  constructor(private readonly options: SessionOwnershipOptions) {}

  get lockPath(): string {
    return path.join(this.options.sessionDir, this.options.ownerLockFileName);
  }

  get leasePath(): string {
    return path.join(this.options.sessionDir, this.options.leaseFileName);
  }

  async acquire(): Promise<SessionOwnershipAcquireResult> {
    await fsp.mkdir(this.options.sessionDir, { recursive: true });
    let previousLease: SessionLease | null = null;
    let recoveredStaleOwner = false;

    for (let pass = 0; pass < 3; pass++) {
      let handle: fsp.FileHandle | null = null;
      try {
        handle = await fsp.open(this.lockPath, "wx");
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
        await this.writeHeartbeat();
        this.startHeartbeat();
        return { previousLease, recoveredStaleOwner };
      } catch (err) {
        if (handle) await handle.close().catch(() => {});
        const errorCode = (err as NodeJS.ErrnoException).code;
        if (errorCode !== "EEXIST") {
          // A failure between the exclusive lock create and the first lease write
          // must not leave a lock that no future owner can recover.
          if (this.acquired) await this.release();
          throw err;
        }

        previousLease = await readJsonFile<SessionLease>(this.leasePath);
        const lockRecord = await readJsonFile<LockRecord>(this.lockPath);
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
          if (
            !lockRecord ||
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
          await fsp.rm(stalePath, { force: true }).catch(() => {});
        } catch {
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
        .catch(() => {})
        .finally(() => {
          this.heartbeatRunning = false;
        });
    }, this.options.heartbeatIntervalMs);
  }

  private scheduleHeartbeat(): Promise<void> {
    this.heartbeatWrites = this.heartbeatWrites
      .catch(() => {})
      .then(() => this.writeHeartbeat());
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
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (!this.acquired) return;
    this.acquired = false;
    await this.heartbeatWrites.catch(() => {});
    const record = await readJsonFile<LockRecord>(this.lockPath);
    if (record?.ownerId === this.ownerId) {
      await fsp.rm(this.lockPath, { force: true }).catch(() => {});
    }
    const lease = await readJsonFile<SessionLease>(this.leasePath);
    if (lease?.ownerId === this.ownerId) {
      await fsp.rm(this.leasePath, { force: true }).catch(() => {});
    }
  }
}

export function getControlQueuePaths(sessionDir: string, controlDirName = "control"): ControlQueuePaths {
  const root = path.join(sessionDir, controlDirName);
  return {
    root,
    requests: path.join(root, "requests"),
    processing: path.join(root, "processing"),
    acks: path.join(root, "acks"),
  };
}

export async function ensureControlQueue(paths: ControlQueuePaths): Promise<void> {
  await Promise.all([
    fsp.mkdir(paths.requests, { recursive: true }),
    fsp.mkdir(paths.processing, { recursive: true }),
    fsp.mkdir(paths.acks, { recursive: true }),
  ]);
}

export async function enqueueControlRequest(
  paths: ControlQueuePaths,
  type: ControlRequest["type"],
  message: string | null = null
): Promise<ControlRequest> {
  await ensureControlQueue(paths);
  const request: ControlRequest = {
    requestId: createId("control"),
    type,
    createdAt: new Date().toISOString(),
    message: message?.trim() || null,
  };
  await atomicWriteJsonFile(path.join(paths.requests, `${request.requestId}.json`), request);
  return request;
}

export interface ClaimedControlRequest {
  request: ControlRequest;
  processingPath: string;
}

export async function claimNextControlRequest(
  paths: ControlQueuePaths
): Promise<ClaimedControlRequest | null> {
  await ensureControlQueue(paths);
  const files = (await fsp.readdir(paths.requests).catch(() => []))
    .filter((fileName) => fileName.endsWith(".json"));
  const candidates: Array<{ request: ControlRequest; fileName: string }> = [];
  for (const fileName of files) {
    const request = await readJsonFile<ControlRequest>(path.join(paths.requests, fileName));
    if (request && (request.type === "STOP" || request.type === "INTERRUPT")) {
      candidates.push({ request, fileName });
    }
  }
  candidates.sort((a, b) => {
    if (a.request.type !== b.request.type) return a.request.type === "STOP" ? -1 : 1;
    return a.request.createdAt.localeCompare(b.request.createdAt);
  });

  for (const candidate of candidates) {
    const sourcePath = path.join(paths.requests, candidate.fileName);
    const processingPath = path.join(paths.processing, candidate.fileName);
    try {
      await fsp.rename(sourcePath, processingPath);
      const ack: ControlAck = {
        requestId: candidate.request.requestId,
        type: candidate.request.type,
        acceptedAt: new Date().toISOString(),
        completedAt: null,
        result: "accepted",
        message: null,
      };
      await atomicWriteJsonFile(path.join(paths.acks, candidate.fileName), ack);
      return { request: candidate.request, processingPath };
    } catch {
      // Another process claimed it.
    }
  }
  return null;
}

export async function recoverClaimedControlRequests(paths: ControlQueuePaths): Promise<void> {
  await ensureControlQueue(paths);
  const files = (await fsp.readdir(paths.processing).catch(() => []))
    .filter((fileName) => fileName.endsWith(".json"));
  for (const fileName of files) {
    const processingPath = path.join(paths.processing, fileName);
    const request = await readJsonFile<ControlRequest>(processingPath);
    if (!request) continue;
    const ack = await readJsonFile<ControlAck>(path.join(paths.acks, fileName));
    if (ack?.completedAt) {
      await fsp.rm(processingPath, { force: true }).catch(() => {});
      continue;
    }
    await fsp.rename(processingPath, path.join(paths.requests, fileName)).catch(() => {});
  }
}

export async function completeControlRequest(
  paths: ControlQueuePaths,
  claimed: ClaimedControlRequest,
  result: ControlAck["result"],
  message: string | null = null
): Promise<void> {
  const existing = await readJsonFile<ControlAck>(
    path.join(paths.acks, `${claimed.request.requestId}.json`)
  );
  const ack: ControlAck = {
    requestId: claimed.request.requestId,
    type: claimed.request.type,
    acceptedAt: existing?.acceptedAt ?? new Date().toISOString(),
    completedAt: new Date().toISOString(),
    result,
    message,
  };
  await atomicWriteJsonFile(path.join(paths.acks, `${claimed.request.requestId}.json`), ack);
  await fsp.rm(claimed.processingPath, { force: true }).catch(() => {});
}

export async function readControlAck(
  paths: ControlQueuePaths,
  requestId: string
): Promise<ControlAck | null> {
  return readJsonFile<ControlAck>(path.join(paths.acks, `${requestId}.json`));
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
  } catch {
    // Continue.
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
