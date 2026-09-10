import type { VerificationCommandSpec } from "../../domain/verification";

export interface VerificationExecutionRequest {
  runId: string;
  verificationId: string;
  command: VerificationCommandSpec;
  projectRoot: string;
  signal?: AbortSignal;
}

export interface VerificationExecutionResult {
  resolvedExecutable?: string;
  resolvedArgs?: string[];
  resolvedCwd?: string;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  processTreeClean: boolean;
  /** True when either output stream exceeded the bounded capture limit. */
  outputTruncated?: boolean;
  startedAt: string;
  completedAt: string;
}

export interface VerificationRuntimePort {
  execute(request: VerificationExecutionRequest): Promise<VerificationExecutionResult>;
}
