import { ExecutionBinding } from "../../shared/domain";
import { resolveExecutable } from "../runtime/catalog";
import { ProgramIoPolicy } from "../program_io/program_io";

export interface InvocationOptions {
  prompt: string;
  cwd: string;
  fullAccess: boolean;
  allowedPaths: string[];
  resumeId?: string;
  nativeApprovalReview?: boolean;
  localHttpAccess?: boolean;
  verificationCommands?: string[];
  disableWrite?: boolean;
  testSourcesReadOnly?: boolean;
  guardOwnedProcesses?: boolean;
  verificationAliases?: Record<string, string>;
  scopeRoots?: string[];
  /** An automated Claude role in ask mode: it cannot stop to ask, so grant up front. */
  claudeUnattended?: { browserVerification: boolean };
  programIoGuard?: {
    directory: string;
    protectedFiles: string[];
    expiresAt: number;
    providerHome?: string;
  };
}
export interface Invocation {
  binary: string;
  args: string[];
  env: Record<string, string>;
  transport?: "pipe";
  programIoPolicy?: ProgramIoPolicy;
}
/** What every CLI's argument builder needs for one invocation. */
export interface InvocationContext {
  binding: ExecutionBinding;
  opts: InvocationOptions;
  env: Record<string, string>;
  readonly: boolean;
  role: string;
  executable: Awaited<ReturnType<typeof resolveExecutable>>;
  programIo?: ProgramIoPolicy;
}
