import * as fsp from "node:fs/promises";
import * as path from "node:path";

import {
  SessionLease,
  atomicWriteJsonFile,
  checkProcessLiveness,
  createId,
  delay,
  readJsonFile,
} from "./resilience";
import { LockRecord } from "./file_lock";

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
            {
              ownerId: this.ownerId,
              ownerPid: process.pid,
              createdAt: this.acquiredAt,
            },
            null,
            2,
          ),
          "utf8",
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
              `Session owner lock is unreadable; ownership cannot be verified: ${this.options.sessionDir}`,
            );
          }
          const createdAt = Date.parse(lockRecord.createdAt);
          if (
            !Number.isFinite(createdAt) ||
            Date.now() - createdAt < this.options.leaseTtlMs
          ) {
            throw new Error(
              `Session is already owned and its first lease is not yet readable: ${this.options.sessionDir}`,
            );
          }
          const ownerLiveness = checkProcessLiveness(lockRecord.ownerPid);
          if (ownerLiveness !== "dead") {
            throw new Error(
              ownerLiveness === "alive"
                ? `Session is already running under pid ${lockRecord.ownerPid}`
                : `Cannot verify existing session owner pid ${lockRecord.ownerPid}`,
            );
          }
        } else {
          if (
            !lockRecord ||
            lockRecord.ownerId !== previousLease.ownerId ||
            lockRecord.ownerPid !== previousLease.ownerPid
          ) {
            throw new Error(
              `Session owner lock and lease do not identify the same owner: ${this.options.sessionDir}`,
            );
          }
          const expiresAt = Date.parse(previousLease.expiresAt);
          if (!Number.isFinite(expiresAt) || expiresAt > Date.now()) {
            throw new Error(
              `Session is already running under owner ${previousLease.ownerId}`,
            );
          }
          const ownerLiveness = checkProcessLiveness(previousLease.ownerPid);
          if (ownerLiveness !== "dead") {
            throw new Error(
              ownerLiveness === "alive"
                ? `Session is already running under pid ${previousLease.ownerPid}`
                : `Cannot verify existing session owner pid ${previousLease.ownerPid}`,
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
    throw new Error(
      `Failed to acquire session ownership: ${this.options.sessionDir}`,
    );
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
