import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as pty from "node-pty";
import {
  OutputStream,
  SupervisedChild,
  spawnPipeChild,
} from "./process_transport";
import { CommandTracker } from "./verification_evidence";
import {
  EventEvidence,
  emptyEvidence,
  MutationTracker,
  completedSearch,
  claudeCompletedSearch,
  observeTokens,
  observeModel,
} from "./event_evidence";
import {
  AttemptStatus,
  ClaimedControlRequest,
  FailureKind,
  checkProcessLiveness,
  delay,
} from "./resilience";
import {
  CliDiagnostics,
  CliDiagnosticCollector,
  emptyCliDiagnostics,
} from "./cli_diagnostics";

import {
  StreamingRedactor,
  LineBuffer,
  appendRing,
  utf8Prefix,
  stripTerminalControlSequences,
  isInteractiveAccessPrompt,
  isStructurallyCompleteJson,
} from "./process_output";
import { normalizeProviderEvent } from "./provider_events";
import { ToolFailureTracker } from "./tool_failures";
import { InspectionTracker } from "./inspection_evidence";
import { terminateProcessTreeBounded } from "./process_lifecycle";
import type { Activity } from "../shared/execution_types";
// Preserve imports used by existing integrations.
export { extractAssistantText, findSessionId } from "./provider_events";
export {
  stripTerminalControlSequences,
  isInteractiveAccessPrompt,
} from "./process_output";
export { terminateProcessTreeBounded } from "./process_lifecycle";

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
  pollPolicy?: () => Promise<string|null>;
  eventPolicy?: (event:AnyObj,evidence:EventEvidence) => string|null;
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

export class ProcessSupervisor {
  async run(options: ProcessSupervisorOptions): Promise<SupervisorResult> {
    const startedAt = new Date().toISOString();
    await fsp.mkdir(path.dirname(options.rawLogPath), { recursive: true });
    const rawLog = fs.createWriteStream(options.rawLogPath, {
      flags: "a",
      encoding: "utf8",
    });
    const sensitiveValues = [
      ...new Set((options.sensitiveValues ?? []).filter(Boolean)),
    ].sort((left, right) => right.length - left.length);
    const redactors = {
      stdout: new StreamingRedactor(sensitiveValues),
      stderr: new StreamingRedactor(sensitiveValues),
    };
    const recordRedactor = new StreamingRedactor(sensitiveValues);
    const maximumRawLogBytes = Math.max(
      MIN_RAW_LOG_BYTES,
      Math.min(MAX_RAW_LOG_BYTES, options.maxInMemoryOutputBytes * 16),
    );
    let rawLogBytesWritten = 0;
    let rawLogTruncated = false;
    const writeRawLog = (value: string): void => {
      if (!value || rawLogTruncated) return;
      const remaining = maximumRawLogBytes - rawLogBytesWritten;
      const prefix = utf8Prefix(value, remaining);
      if (prefix) {
        rawLog.write(prefix);
        rawLogBytesWritten += Buffer.byteLength(prefix, "utf8");
      }
      if (Buffer.byteLength(value, "utf8") > remaining) {
        rawLog.write("\n[AGENT_LOOP_LOG_TRUNCATED]\n");
        rawLogTruncated = true;
      }
    };

    let child: SupervisedChild;
    try {
      child =
        options.transport === "pipe"
          ? spawnPipeChild(
              options.binary,
              options.args,
              options.cwd,
              options.env,
            )
          : pty.spawn(options.binary, options.args, {
              name: "xterm-256color",
              cols: options.cols,
              rows: options.rows,
              cwd: options.cwd,
              env: options.env,
              useConpty: options.useConpty,
            });
    } catch (err) {
      rawLog.end();
      const message = err instanceof Error ? err.message : String(err);
      return {
        evidence: emptyEvidence(),
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

    const pid = child.pid;
    const lineBuffers = { stdout: new LineBuffer(), stderr: new LineBuffer() };
    const events: AnyObj[] = [];
    const eventByteSizes: number[] = [];
    let eventBytes = 0;
    const assistantParts: string[] = [];
    const evidence = emptyEvidence();
    const mutations = new MutationTracker();
    const diagnosticCollector = new CliDiagnosticCollector();
    const toolFailures = new ToolFailureTracker();
    const searchIds = new Set<string>();
    const pendingClaudeSearches = new Set<string>();
    const autoInjected: {
      prompt: string;
      response: string;
      timestamp: string;
    }[] = [];
    const seenProgress = new Set<string>();
    const seenProgressOrder: string[] = [];
    let outputTail = "";
    let cliSessionId: string | null = null;
    let lastOutputAt = startedAt;
    let lastProgressAt = startedAt;
    let activity: SupervisorProgress["activity"] = "initial_transport";
    let transportEstablished = false;
    let resolved = false;
    let terminating = false;
    let exitSeen = false;
    let actualExitCode = -1;
    let controlRequest: ClaimedControlRequest | null = null;
    const jsonReassembly = { stdout: "", stderr: "" };
    let transportTimer: NodeJS.Timeout | null = null;
    let activityTimer: NodeJS.Timeout | null = null;
    let phaseTimer: NodeJS.Timeout | null = null;
    let controlTimer: NodeJS.Timeout | null = null;
    let controlPollRunning = false;
    const absoluteDeadlineAtMs = Math.max(
      Date.now() + 1,
      options.absoluteDeadlineAtMs ?? Date.now() + options.phaseTimeoutMs,
    );
    let currentPhaseDeadlineAtMs = Math.min(
      Date.now() + options.phaseTimeoutMs,
      absoluteDeadlineAtMs,
    );
    let resolveExit: (() => void) | null = null;
    const exitPromise = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });

    const notifyProgress = (): void => {
      if (!options.onProgress) return;
      Promise.resolve(
        options.onProgress({
          assistantTextBytes: evidence.assistantTextBytes,
          maxTokens: evidence.maxTokens,
          childPid: pid,
          lastOutputAt,
          lastProgressAt,
          cliSessionId,
          activity,
          deadlineAt: new Date(currentPhaseDeadlineAtMs).toISOString(),
        }),
      ).catch(() => {});
    };

    const clearRuntimeTimers = (): void => {
      if (transportTimer) clearTimeout(transportTimer);
      if (activityTimer) clearTimeout(activityTimer);
      if (phaseTimer) clearTimeout(phaseTimer);
      if (controlTimer) clearInterval(controlTimer);
      transportTimer = null;
      activityTimer = null;
      phaseTimer = null;
      controlTimer = null;
    };

    let resolveResult: ((result: SupervisorResult) => void) | null = null;
    const resultPromise = new Promise<SupervisorResult>((resolve) => {
      resolveResult = resolve;
    });

    const finish = (
      outcome: AttemptStatus,
      failureKind: FailureKind | null,
      failureMessage: string | null,
      cancelled: boolean,
    ): void => {
      if (resolved) return;
      resolved = true;
      clearRuntimeTimers();
      for (const stream of ["stdout", "stderr"] as const) {
        const finalSafeData = redactors[stream].flush();
        if (finalSafeData) handleSafeData(finalSafeData, stream);
        const remainder = lineBuffers[stream].flush();
        if (remainder) processLine(remainder, stream);
      }
      evidence.fileMutation ||= mutations.finish();
      if (mutations.changedFiles.length)
        evidence.changedFiles = mutations.changedFiles.map((file) =>
          path.relative(options.cwd, path.resolve(options.cwd, file)),
        );
      const terminal = diagnosticCollector.diagnostics.terminalError;
      if (
        terminal &&
        (outcome === "succeeded" ||
          (outcome === "process_exit" && failureKind === "process_exit"))
      ) {
        outcome = "process_exit";
        failureKind = terminal.kind;
        failureMessage = terminal.message;
      }
      const finalResult: SupervisorResult = {
        evidence,
        diagnostics: diagnosticCollector.diagnostics,
        pid,
        outcome,
        failureKind,
        failureMessage,
        exitCode: actualExitCode,
        output: outputTail,
        assistantText: assistantParts.join("\n"),
        events,
        cliSessionId,
        startedAt,
        endedAt: new Date().toISOString(),
        timedOut:
          outcome === "transport_timeout" ||
          outcome === "idle_timeout" ||
          outcome === "tool_timeout" ||
          outcome === "phase_timeout",
        cancelled,
        rawLogPath: options.rawLogPath,
        controlRequest,
        autoInjected,
      };
      // Do not publish the attempt result until the log stream has flushed. This
      // keeps archive byte counts and immediate post-attempt diagnostics reliable.
      rawLog.end(() => resolveResult!(finalResult));
    };

    const finishExit = (): void => {
      finish(
        actualExitCode === 0 ? "succeeded" : "process_exit",
        actualExitCode === 0 ? null : "process_exit",
        actualExitCode === 0
          ? null
          : `Process exited with code ${actualExitCode}`,
        false,
      );
    };

    const terminate = async (
      intendedOutcome: AttemptStatus,
      intendedFailure: FailureKind,
      message: string,
      cancelled: boolean,
    ): Promise<void> => {
      if (terminating || resolved) return;
      terminating = true;
      clearRuntimeTimers();
      if (!cancelled && checkProcessLiveness(pid) === "dead") {
        // ConPTY drains output before emitting onExit, even after the PID dies.
        // Preserve the real exit result instead of timing out during that drain.
        let drainTimer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            exitPromise,
            new Promise<void>((resolve) => {
              drainTimer = setTimeout(resolve, options.killTimeoutMs);
            }),
          ]);
        } finally {
          clearTimeout(drainTimer);
        }
        if (exitSeen) {
          finishExit();
          return;
        }
      }
      try {
        child.kill();
      } catch {
        // Already exited.
      }
      await Promise.race([exitPromise, delay(options.terminationGraceMs)]);
      let liveness = checkProcessLiveness(pid);
      if (liveness === "alive" || liveness === "unknown") {
        liveness = await terminateProcessTreeBounded(
          pid,
          options.killTimeoutMs,
        );
        await Promise.race([exitPromise, delay(options.killTimeoutMs)]);
        liveness = checkProcessLiveness(pid);
      }
      if (liveness !== "dead") {
        finish(
          "orphaned_process",
          "orphaned_process",
          `Unable to confirm termination of child pid ${pid} after: ${message}`,
          cancelled,
        );
        return;
      }
      finish(intendedOutcome, intendedFailure, message, cancelled);
    };

    const armInitialTransportTimer = (): void => {
      if (transportTimer) clearTimeout(transportTimer);
      transportTimer = setTimeout(() => {
        void terminate(
          "transport_timeout",
          "transport_timeout",
          `No initial CLI transport output for ${options.transportTimeoutMs}ms`,
          false,
        );
      }, options.transportTimeoutMs);
    };

    const resetActivityTimer = (): void => {
      if (
        resolved ||
        terminating ||
        !transportEstablished ||
        activity === "initial_transport"
      )
        return;
      if (activityTimer) clearTimeout(activityTimer);
      const isToolExecution = activity === "tool_execution";
      const timeoutMs = isToolExecution
        ? options.toolTimeoutMs
        : options.idleTimeoutMs;
      activityTimer = setTimeout(() => {
        void terminate(
          isToolExecution ? "tool_timeout" : "idle_timeout",
          isToolExecution ? "tool_timeout" : "idle_timeout",
          isToolExecution
            ? `Tool execution produced no progress event for ${timeoutMs}ms`
            : `Model generation produced no meaningful progress for ${timeoutMs}ms`,
          false,
        );
      }, timeoutMs);
    };

    const armProgressWindowTimer = (): void => {
      if (resolved || terminating) return;
      if (phaseTimer) clearTimeout(phaseTimer);
      const now = Date.now();
      currentPhaseDeadlineAtMs = Math.min(
        now + options.phaseTimeoutMs,
        absoluteDeadlineAtMs,
      );
      const remainingMs = Math.max(1, currentPhaseDeadlineAtMs - now);
      const reachesAbsoluteDeadline =
        currentPhaseDeadlineAtMs >= absoluteDeadlineAtMs;
      phaseTimer = setTimeout(() => {
        void terminate(
          "phase_timeout",
          "phase_timeout",
          reachesAbsoluteDeadline
            ? "Role recovery budget deadline reached while the attempt was still incomplete"
            : `Attempt exceeded the ${options.phaseTimeoutMs}ms progress-renewable phase window`,
          false,
        );
      }, remainingMs);
    };

    const establishTransport = (): void => {
      if (transportEstablished) return;
      transportEstablished = true;
      if (transportTimer) clearTimeout(transportTimer);
      transportTimer = null;
      activity = "model_generation";
      resetActivityTimer();
      notifyProgress();
    };

    const markMeaningfulProgress = (
      identity: string,
      nextActivity: SupervisorProgress["activity"],
    ): boolean => {
      if (seenProgress.has(identity)) return false;
      seenProgress.add(identity);
      seenProgressOrder.push(identity);
      if (seenProgressOrder.length > 512) {
        const removed = seenProgressOrder.shift();
        if (removed) seenProgress.delete(removed);
      }
      lastProgressAt = new Date().toISOString();
      activity = nextActivity;
      resetActivityTimer();
      armProgressWindowTimer();
      notifyProgress();
      return true;
    };

    const commands = new CommandTracker(options.cwd,options.sourcesGuarded);
    const inspections = new InspectionTracker(options.cwd);
    const processEvent = (event: AnyObj): void => {
      commands.observe(event);
      inspections.observe(event);
      evidence.readFiles=inspections.files;
      evidence.commands = commands.receipts;
      mutations.observe(event);
      evidence.fileMutation ||= mutations.hasMutation;
      const policyReason=options.eventPolicy?.(event,evidence);
      if(policyReason)void terminate("process_exit",policyReason.includes("[AGENT_GRAPH_UNSCOPED_TERMINATION]")?"tool_arguments":policyReason.startsWith("[AGENT_GRAPH_TEST_FAILED]")?"process_exit":"role_violation",policyReason,false);
      diagnosticCollector.observeEvent(event);
      const search =
        completedSearch(event) ??
        claudeCompletedSearch(event, pendingClaudeSearches);
      if (search && !searchIds.has(search)) {
        searchIds.add(search);
        evidence.completedSearches++;
      }
      evidence.maxTokens = Math.max(evidence.maxTokens, observeTokens(event));
      const reportedModel = observeModel(event);
      if (reportedModel) evidence.actualModelId = reportedModel;
      const eventBytesForEntry = Buffer.byteLength(
        JSON.stringify(event),
        "utf8",
      );
      if (eventBytesForEntry <= options.maxInMemoryOutputBytes) {
        events.push(event);
        eventByteSizes.push(eventBytesForEntry);
        eventBytes += eventBytesForEntry;
        while (
          eventBytes > options.maxInMemoryOutputBytes &&
          events.length > 0
        ) {
          events.shift();
          eventBytes -= eventByteSizes.shift() ?? 0;
        }
      }
      const normalized = normalizeProviderEvent(event);
      if (normalized.sessionId) cliSessionId = normalized.sessionId;
      const text = normalized.assistantText;
      if (text && text.trim().length > 0) {
        evidence.assistantTextBytes += Buffer.byteLength(text, "utf8");
        if (!assistantParts.includes(text)) assistantParts.push(text);
        while (
          Buffer.byteLength(assistantParts.join("\n"), "utf8") >
          options.maxInMemoryOutputBytes
        ) {
          assistantParts.shift();
        }
      }
      const identity = normalized.progressId;
      const nextActivity = normalized.activity;
      if (identity && nextActivity && markMeaningfulProgress(identity, nextActivity)) {
        diagnosticCollector.resetRetryFailures();
      }
      const toolFailure = toolFailures.observe(event);
      if (toolFailure) void terminate("process_exit", "tool_arguments", toolFailure, false);
      notifyProgress();
    };

    function processLine(line: string, stream: OutputStream = "stdout"): void {
      const trimmed = stripTerminalControlSequences(line).trim();
      if (trimmed.length === 0) return;

      const candidate = jsonReassembly[stream]
        ? `${jsonReassembly[stream]}${trimmed}`
        : trimmed;
      if (jsonReassembly[stream] || trimmed.startsWith("{")) {
        const complete = isStructurallyCompleteJson(candidate);
        if (
          !complete &&
          Buffer.byteLength(candidate, "utf8") <= options.maxInMemoryOutputBytes
        ) {
          jsonReassembly[stream] = candidate;
          return;
        }
        jsonReassembly[stream] = "";
        try {
          // PTY wrapping can separate a secret with physical newlines. Reapply
          // redaction after joining the record, before any event is retained.
          const safeRecord = recordRedactor.push(candidate) + recordRedactor.flush();
          processEvent(JSON.parse(safeRecord) as AnyObj);
          return;
        } catch {
          // Invalid JSON is retained in the raw log but cannot satisfy progress/completion.
        }
      }

      const lower = trimmed.toLowerCase();
      diagnosticCollector.observeLine(trimmed);
      const retryFailure = diagnosticCollector.retryFailure;
      if (retryFailure)
        void terminate("process_exit", retryFailure.kind, `Stopped after 3 repeated provider failures without useful progress: ${retryFailure.message}`, false);
      if (/^timestamp=\S+ level=(?:INFO|WARN|ERROR)\b/.test(trimmed)) {
        const session = trimmed.match(/\bsession\.id=(ses_[A-Za-z0-9]+)/);
        if (session) cliSessionId = session[1]!;
        // Operational logs establish transport, but never renew the model's
        // progress deadline or act as an interactive approval prompt.
        return;
      }
      if (isInteractiveAccessPrompt(trimmed)) {
        void terminate(
          "process_exit",
          "permission",
          `Provider requested interactive filesystem/tool access: ${trimmed.slice(0, 500)}`,
          false,
        );
        return;
      }
      const destructive = options.destructivePrompts.some((value) =>
        lower.includes(value.toLowerCase()),
      );
      const interaction = options.interactionWhitelist.find((value) =>
        lower.includes(value.toLowerCase()),
      );
      if (interaction && !destructive) {
        try {
          child.write("y\n");
          autoInjected.push({
            prompt: trimmed,
            response: "y",
            timestamp: new Date().toISOString(),
          });
        } catch {
          // The process may have exited between output and response.
        }
      }
    }

    const handleSafeData = (
      safeData: string,
      stream: OutputStream = "stdout",
    ): void => {
      options.onOutput?.(safeData);
      writeRawLog(safeData);
      outputTail = appendRing(
        outputTail,
        safeData,
        options.maxInMemoryOutputBytes,
      );
      lastOutputAt = new Date().toISOString();
      const cleanedData = stripTerminalControlSequences(safeData);
      if (cleanedData.trim().length > 0) establishTransport();
      for (const line of lineBuffers[stream].push(cleanedData)) {
        processLine(line, stream);
      }
      notifyProgress();
    };

    child.onData((data, stream = "stdout") => {
      if (resolved) return;
      // Normalize terminal control sequences before streaming redaction. Some PTY
      // implementations inject cursor-control bytes between writes; redacting the
      // normalized stream prevents a split credential from being reconstructed by
      // the assistant-event parser even when those bytes bisect the secret.
      const safeData = redactors[stream].push(
        stripTerminalControlSequences(data),
      );
      if (safeData) handleSafeData(safeData, stream);
    });
    child.onError?.((error) => {
      actualExitCode = -1;
      finish("spawn_error", "spawn_error", error.message, false);
    });

    child.onExit((event) => {
      exitSeen = true;
      actualExitCode = event.exitCode;
      resolveExit?.();
      if (terminating || resolved) return;
      finishExit();
    });

    armInitialTransportTimer();
    armProgressWindowTimer();

    if (options.pollControl || options.pollPolicy) {
      controlTimer = setInterval(() => {
        if (controlPollRunning || terminating || resolved) return;
        controlPollRunning = true;
        (options.pollControl?.()??Promise.resolve(null))
          .then(async (claimed) => {
            if(!claimed&&!terminating&&!resolved){const reason=await options.pollPolicy?.();if(reason&&!terminating&&!resolved)void terminate("process_exit","role_violation",reason,false);}
            if (!claimed || terminating || resolved) return;
            controlRequest = claimed;
            const message =
              claimed.request.type === "STOP"
                ? "User requested stop"
                : `User requested interrupt: ${claimed.request.message ?? ""}`;
            void terminate("cancelled", "cancelled", message, true);
          })
          .catch(() => {})
          .finally(() => {
            controlPollRunning = false;
          });
      }, 250);
    }

    notifyProgress();
    const result = await resultPromise;
    if (!exitSeen && result.outcome === "succeeded") {
      return {
        ...result,
        outcome: "process_exit",
        failureKind: "process_exit",
        failureMessage: "CLI transport completed without an exit event",
        exitCode: -1,
      };
    }
    return result;
  }
}
