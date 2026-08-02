import type { LoopStatus } from "./types";

export type ProcessLiveness = "alive" | "dead" | "unknown";
export type LeaseDisposition =
  | "missing"
  | "active"
  | "expired_owner_alive"
  | "recoverable"
  | "unverifiable";
export type RecoveryAction =
  | "ignore"
  | "follow"
  | "recover"
  | "pause_legacy";

export interface SessionLease {
  ownerId: string;
  ownerPid: number;
  childPid: number | null;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
}

export interface SessionOwnerLock {
  ownerId: string;
  ownerPid: number;
  createdAt: string;
}

export function processLiveness(pid: number | null | undefined): ProcessLiveness {
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

export function evaluateLease(
  lease: SessionLease | null,
  nowMs: number,
  ownerLiveness: ProcessLiveness
): LeaseDisposition {
  if (!lease) return "missing";
  const expiresAt = Date.parse(lease.expiresAt);
  if (!Number.isFinite(expiresAt)) return "unverifiable";
  if (expiresAt > nowMs) {
    return ownerLiveness === "dead" ? "unverifiable" : "active";
  }
  if (ownerLiveness === "dead") return "recoverable";
  if (ownerLiveness === "alive") return "expired_owner_alive";
  return "unverifiable";
}

export function evaluateOwnership(
  lease: SessionLease | null,
  ownerLock: SessionOwnerLock | null,
  nowMs: number,
  leaseTtlMs: number,
  ownerLiveness: ProcessLiveness
): LeaseDisposition {
  if (lease) {
    if (
      ownerLock &&
      (ownerLock.ownerId !== lease.ownerId ||
        ownerLock.ownerPid !== lease.ownerPid)
    ) {
      return "unverifiable";
    }
    return evaluateLease(lease, nowMs, ownerLiveness);
  }
  if (!ownerLock) return "missing";
  const createdAt = Date.parse(ownerLock.createdAt);
  if (!Number.isFinite(createdAt)) return "unverifiable";
  if (nowMs - createdAt < leaseTtlMs) {
    return ownerLiveness === "dead" ? "unverifiable" : "active";
  }
  if (ownerLiveness === "dead") return "recoverable";
  if (ownerLiveness === "alive") return "expired_owner_alive";
  return "unverifiable";
}

export function shouldAutoRecover(
  stateStatus: LoopStatus,
  disposition: LeaseDisposition,
  recoveryResumeAt?: string | null,
  nowMs = Date.now()
): boolean {
  if (stateStatus === "RECOVERING") {
    const resumeAt = recoveryResumeAt ? Date.parse(recoveryResumeAt) : Number.NaN;
    return Number.isFinite(resumeAt) && resumeAt <= nowMs;
  }
  return stateStatus === "RUNNING" && disposition === "recoverable";
}

export function decideRecoveryAction(
  stateStatus: LoopStatus,
  stateVersion: number | null | undefined,
  disposition: LeaseDisposition,
  locallyRunning: boolean,
  recoveryResumeAt?: string | null,
  nowMs = Date.now()
): RecoveryAction {
  if (locallyRunning) return "ignore";
  if (stateStatus === "RECOVERING") {
    return shouldAutoRecover(
      stateStatus,
      disposition,
      recoveryResumeAt,
      nowMs
    ) ? "recover" : "ignore";
  }
  if (stateStatus !== "RUNNING") return "ignore";
  if (disposition === "recoverable") return "recover";
  if (disposition === "missing") {
    return (stateVersion ?? 1) < 2 ? "pause_legacy" : "recover";
  }
  return "follow";
}

export function shouldGracefullyStop(stateStatus: LoopStatus): boolean {
  return stateStatus === "RUNNING" || stateStatus === "RECOVERING";
}

export function assessSessionDeletionSafety(
  stateStatus: LoopStatus | null,
  disposition: LeaseDisposition,
  childLiveness: readonly ProcessLiveness[]
): { safe: boolean; reason: string | null } {
  if (stateStatus === "RUNNING" || stateStatus === "RECOVERING") {
    return { safe: false, reason: `Session is ${stateStatus}.` };
  }
  if (["active", "expired_owner_alive", "unverifiable"].includes(disposition)) {
    return { safe: false, reason: `Session ownership is ${disposition}.` };
  }
  const unsafeChild = childLiveness.find((liveness) => liveness !== "dead");
  if (unsafeChild) {
    return { safe: false, reason: `A session child process is ${unsafeChild}.` };
  }
  return { safe: true, reason: null };
}

/** @deprecated Use shouldGracefullyStop. */
export const shouldGracefullyPause = shouldGracefullyStop;

export function elapsedSince(isoTimestamp: string | null | undefined, nowMs = Date.now()): number | null {
  if (!isoTimestamp) return null;
  const timestamp = Date.parse(isoTimestamp);
  return Number.isFinite(timestamp) ? Math.max(0, nowMs - timestamp) : null;
}
