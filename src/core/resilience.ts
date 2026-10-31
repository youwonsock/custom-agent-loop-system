import * as crypto from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

import { FailureKind } from "../shared/execution_types";
export type { AttemptStatus, FailureKind } from "../shared/execution_types";

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

export async function atomicWriteJsonFile(
  filePath: string,
  data: unknown,
): Promise<void> {
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
  maxRetries = 5,
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

export function checkProcessLiveness(
  pid: number | null | undefined,
): ProcessLiveness {
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

export function collectRecoveredChildPids(
  previousLease: SessionLease | null,
  activeAttemptChildPid: number | null | undefined,
): number[] {
  return Array.from(
    new Set(
      [previousLease?.childPid ?? null, activeAttemptChildPid ?? null].filter(
        (pid): pid is number => typeof pid === "number" && pid > 0,
      ),
    ),
  );
}
