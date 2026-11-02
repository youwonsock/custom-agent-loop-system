import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as pty from "node-pty";
import { SupervisedChild, spawnPipeChild } from "./process_transport";
import { EventEvidence, emptyEvidence } from "./event_evidence";
import { AttemptStatus, FailureKind } from "./resilience";
import { ClaimedControlRequest } from "./control_queue";
import { CliDiagnostics, emptyCliDiagnostics } from "./cli_diagnostics";

import { utf8Prefix } from "./process_output";
import { NativeScopeTracker } from "./native_scope";
import type { ProgramIoPolicy } from "./program_io";
import { ProgramIoTracker } from "./program_io_tracker";
import { DescendantWatch } from "./descendant_watch";
import type { Activity } from "../shared/execution_types";
// Preserve imports used by existing integrations.
export { extractAssistantText, findSessionId } from "./provider_events";
export {
  stripTerminalControlSequences,
  isInteractiveAccessPrompt,
} from "./process_output";
export { terminateProcessTreeBounded } from "./process_lifecycle";
import { SupervisedAttempt } from "./process_attempt";

type AnyObj = Record<string, unknown>;
const MIN_RAW_LOG_BYTES = 8 * 1024 * 1024;
const MAX_RAW_LOG_BYTES = 32 * 1024 * 1024;
export interface SupervisorProgress {
  assistantTextBytes: number;
  maxTokens: number;
  childPid: number;
  lastOutputAt: string;
  lastProgressAt: string;
  cliSessionId: string | null;
  activity: Activity;
  deadlineAt: string;
}

export interface ProcessSupervisorOptions {
  transport?: "pty" | "pipe";
  binary: string;
  args: string[];
  cwd: string;
  env: { [key: string]: string };
  cols: number;
  rows: number;
  useConpty: boolean;
  transportTimeoutMs: number;
  idleTimeoutMs: number;
  toolTimeoutMs: number;
  phaseTimeoutMs: number;
  absoluteDeadlineAtMs?: number;
  terminationGraceMs: number;
  killTimeoutMs: number;
  maxInMemoryOutputBytes: number;
  rawLogPath: string;
  interactionWhitelist: string[];
  destructivePrompts: string[];
  /** In-memory credentials that must never reach attempt logs or completion text. */
  sensitiveValues?: string[];
  pollControl?: () => Promise<ClaimedControlRequest | null>;
  onProgress?: (progress: SupervisorProgress) => Promise<void> | void;
  onOutput?: (text: string) => void;
  /** Trusted runtime policy; never inferred from ordinary model prose. */
  sourcesGuarded?: boolean;
  scopeRoots?: string[];
  programIoPolicy?: ProgramIoPolicy;
  pollPolicy?: () => Promise<string | null>;
  eventPolicy?: (event: AnyObj, evidence: EventEvidence) => string | null;
  /** End background processes the CLI leaves behind when it exits. */
  reapDescendants?: boolean;
}

export interface SupervisorResult {
  evidence: EventEvidence;
  diagnostics: CliDiagnostics;
  pid: number;
  outcome: AttemptStatus;
  failureKind: FailureKind | null;
  failureMessage: string | null;
  exitCode: number;
  output: string;
  assistantText: string;
  events: AnyObj[];
  cliSessionId: string | null;
  startedAt: string;
  endedAt: string;
  timedOut: boolean;
  cancelled: boolean;
  rawLogPath: string;
  controlRequest: ClaimedControlRequest | null;
  autoInjected: { prompt: string; response: string; timestamp: string }[];
}

/** Attempt logs keep the start of the output and say when they stopped. */
export class BoundedRawLog {
  private readonly stream: fs.WriteStream;
  private bytesWritten = 0;
  private truncated = false;
  constructor(
    file: string,
    private readonly maximumBytes: number,
  ) {
    this.stream = fs.createWriteStream(file, { flags: "a", encoding: "utf8" });
  }
  write(value: string): void {
    if (!value || this.truncated) return;
    const remaining = this.maximumBytes - this.bytesWritten;
    const prefix = utf8Prefix(value, remaining);
    if (prefix) {
      this.stream.write(prefix);
      this.bytesWritten += Buffer.byteLength(prefix, "utf8");
    }
    if (Buffer.byteLength(value, "utf8") > remaining) {
      this.stream.write("\n[AGENT_LOOP_LOG_TRUNCATED]\n");
      this.truncated = true;
    }
  }
  end(done?: () => void): void {
    this.stream.end(done);
  }
}
function spawnChild(options: ProcessSupervisorOptions): SupervisedChild {
  const pipes = () =>
    spawnPipeChild(options.binary, options.args, options.cwd, options.env);
  if (options.transport === "pipe") return pipes();
  try {
    return pty.spawn(options.binary, options.args, {
      name: "xterm-256color",
      cols: options.cols,
      rows: options.rows,
      cwd: options.cwd,
      env: options.env,
      useConpty: options.useConpty,
    });
  } catch {
    // A sandbox can refuse a terminal. The CLIs run in print mode and do not need
    // one, and a binary that is really missing fails again here with its own error.
    return pipes();
  }
}
export class ProcessSupervisor {
  async run(options: ProcessSupervisorOptions): Promise<SupervisorResult> {
    const startedAt = new Date().toISOString();
    await fsp.mkdir(path.dirname(options.rawLogPath), { recursive: true });
    const rawLog = new BoundedRawLog(
      options.rawLogPath,
      Math.max(
        MIN_RAW_LOG_BYTES,
        Math.min(MAX_RAW_LOG_BYTES, options.maxInMemoryOutputBytes * 16),
      ),
    );
    const scopeTracker = options.scopeRoots
      ? new NativeScopeTracker(options.cwd, options.scopeRoots)
      : null;
    const ioTracker = options.programIoPolicy
      ? new ProgramIoTracker(options.programIoPolicy)
      : null;
    let child: SupervisedChild;
    try {
      child = spawnChild(options);
    } catch (err) {
      rawLog.end();
      const message = err instanceof Error ? err.message : String(err);
      return {
        evidence: {
          ...emptyEvidence(),
          ...(scopeTracker ? { scopeAudit: scopeTracker.audit } : {}),
          ...(ioTracker ? { programIoAudit: ioTracker.finish() } : {}),
        },
        diagnostics: emptyCliDiagnostics(),
        pid: -1,
        outcome: "spawn_error",
        failureKind: "spawn_error",
        failureMessage: message,
        exitCode: -1,
        output: "",
        assistantText: "",
        events: [],
        cliSessionId: null,
        startedAt,
        endedAt: new Date().toISOString(),
        timedOut: false,
        cancelled: false,
        rawLogPath: options.rawLogPath,
        controlRequest: null,
        autoInjected: [],
      };
    }
    const descendants = options.reapDescendants
      ? new DescendantWatch(child.pid)
      : null;
    descendants?.start();
    const result = await new SupervisedAttempt(
      options,
      child,
      rawLog,
      scopeTracker,
      ioTracker,
      startedAt,
    ).result();
    const reaped = await descendants?.reap(options.killTimeoutMs);
    if (reaped?.length) result.evidence.reapedProcesses = reaped;
    return result;
  }
}
