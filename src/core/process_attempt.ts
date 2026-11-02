import * as path from "node:path";
import { OutputStream, SupervisedChild } from "./process_transport";
import { CommandTracker } from "./verification_evidence";
import {
  emptyEvidence,
  MutationTracker,
  completedSearch,
  claudeCompletedSearch,
  observeTokens,
  observeCost,
  observeModel,
} from "./event_evidence";
import {
  AttemptStatus,
  FailureKind,
  checkProcessLiveness,
  delay,
} from "./resilience";
import { ClaimedControlRequest } from "./control_queue";
import { CliDiagnosticCollector } from "./cli_diagnostics";

import {
  StreamingRedactor,
  LineBuffer,
  appendRing,
  stripTerminalControlSequences,
  isInteractiveAccessPrompt,
  isStructurallyCompleteJson,
} from "./process_output";
import { normalizeProviderEvent } from "./provider_events";
import { ToolFailureTracker } from "./tool_failures";
import { InspectionTracker } from "./inspection_evidence";
import { NativeScopeTracker, SCOPE_VIOLATION } from "./native_scope";
import type { ProgramIoTracker } from "./program_io_tracker";
import { terminateProcessTreeBounded } from "./process_lifecycle";
import type {
  ProcessSupervisorOptions,
  SupervisorProgress,
  SupervisorResult,
} from "./process_supervisor";
import { BoundedRawLog } from "./process_supervisor";

type AnyObj = Record<string, unknown>;

/** One running child: its output parsing, evidence, timers and how it ended. */
export class SupervisedAttempt {
  private readonly pid: number;
  private readonly redactors: Record<OutputStream, StreamingRedactor>;
  private readonly recordRedactor: StreamingRedactor;
  private readonly lineBuffers = {
    stdout: new LineBuffer(),
    stderr: new LineBuffer(),
  };
  private readonly jsonReassembly = { stdout: "", stderr: "" };
  private readonly events: AnyObj[] = [];
  private readonly eventByteSizes: number[] = [];
  private eventBytes = 0;
  private readonly assistantParts: string[] = [];
  private readonly evidence = emptyEvidence();
  private readonly mutations = new MutationTracker();
  private readonly diagnosticCollector = new CliDiagnosticCollector();
  private readonly toolFailures = new ToolFailureTracker();
  private readonly commands: CommandTracker;
  private readonly inspections: InspectionTracker;
  private readonly searchIds = new Set<string>();
  private readonly pendingClaudeSearches = new Set<string>();
  private readonly autoInjected: SupervisorResult["autoInjected"] = [];
  private readonly seenProgress = new Set<string>();
  private readonly seenProgressOrder: string[] = [];
  private readonly backgroundTasks = new Set<string>();
  private outputTail = "";
  private cliSessionId: string | null = null;
  private lastOutputAt: string;
  private lastProgressAt: string;
  private activity: SupervisorProgress["activity"] = "initial_transport";
  private transportEstablished = false;
  private resolved = false;
  private terminating = false;
  private exitSeen = false;
  private actualExitCode = -1;
  private controlRequest: ClaimedControlRequest | null = null;
  private transportTimer: NodeJS.Timeout | null = null;
  private activityTimer: NodeJS.Timeout | null = null;
  private phaseTimer: NodeJS.Timeout | null = null;
  private controlTimer: NodeJS.Timeout | null = null;
  private controlPollRunning = false;
  private readonly absoluteDeadlineAtMs: number;
  private currentPhaseDeadlineAtMs: number;
  private resolveExit: (() => void) | null = null;
  private readonly exitPromise = new Promise<void>((resolve) => {
    this.resolveExit = resolve;
  });
  private resolveResult: ((result: SupervisorResult) => void) | null = null;
  private readonly resultPromise = new Promise<SupervisorResult>((resolve) => {
    this.resolveResult = resolve;
  });

  constructor(
    private readonly options: ProcessSupervisorOptions,
    private readonly child: SupervisedChild,
    private readonly rawLog: BoundedRawLog,
    private readonly scopeTracker: NativeScopeTracker | null,
    private readonly ioTracker: ProgramIoTracker | null,
    private readonly startedAt: string,
  ) {
    this.pid = child.pid;
    const sensitiveValues = [
      ...new Set((options.sensitiveValues ?? []).filter(Boolean)),
    ].sort((left, right) => right.length - left.length);
    this.redactors = {
      stdout: new StreamingRedactor(sensitiveValues),
      stderr: new StreamingRedactor(sensitiveValues),
    };
    this.recordRedactor = new StreamingRedactor(sensitiveValues);
    if (scopeTracker) this.evidence.scopeAudit = scopeTracker.audit;
    this.commands = new CommandTracker(options.cwd, options.sourcesGuarded);
    this.inspections = new InspectionTracker(options.cwd);
    this.lastOutputAt = startedAt;
    this.lastProgressAt = startedAt;
    this.absoluteDeadlineAtMs = Math.max(
      Date.now() + 1,
      options.absoluteDeadlineAtMs ?? Date.now() + options.phaseTimeoutMs,
    );
    this.currentPhaseDeadlineAtMs = Math.min(
      Date.now() + options.phaseTimeoutMs,
      this.absoluteDeadlineAtMs,
    );
  }

  async result(): Promise<SupervisorResult> {
    this.attachChild();
    this.armInitialTransportTimer();
    this.armProgressWindowTimer();
    this.startControlPolling();
    this.notifyProgress();
    const result = await this.resultPromise;
    if (!this.exitSeen && result.outcome === "succeeded") {
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

  private attachChild(): void {
    this.child.onData((data, stream = "stdout") => {
      if (this.resolved) return;
      // Normalize terminal control sequences before streaming redaction. Some PTY
      // implementations inject cursor-control bytes between writes; redacting the
      // normalized stream prevents a split credential from being reconstructed by
      // the assistant-event parser even when those bytes bisect the secret.
      const safeData = this.redactors[stream].push(
        stripTerminalControlSequences(data),
      );
      if (safeData) this.handleSafeData(safeData, stream);
    });
    this.child.onError?.((error) => {
      this.actualExitCode = -1;
      this.finish("spawn_error", "spawn_error", error.message, false);
    });
    this.child.onExit((event) => {
      this.exitSeen = true;
      this.actualExitCode = event.exitCode;
      this.resolveExit?.();
      if (this.terminating || this.resolved) return;
      this.finishExit();
    });
  }

  private startControlPolling(): void {
    const { pollControl, pollPolicy } = this.options;
    if (!pollControl && !pollPolicy) return;
    this.controlTimer = setInterval(() => {
      if (this.controlPollRunning || this.terminating || this.resolved) return;
      this.controlPollRunning = true;
      (pollControl?.() ?? Promise.resolve(null))
        .then(async (claimed) => {
          if (!claimed && !this.terminating && !this.resolved) {
            const reason = await pollPolicy?.();
            if (reason && !this.terminating && !this.resolved)
              void this.terminate(
                "process_exit",
                "role_violation",
                reason,
                false,
              );
          }
          if (!claimed || this.terminating || this.resolved) return;
          this.controlRequest = claimed;
          const message =
            claimed.request.type === "STOP"
              ? "User requested stop"
              : `User requested interrupt: ${claimed.request.message ?? ""}`;
          void this.terminate("cancelled", "cancelled", message, true);
        })
        .catch(() => {})
        .finally(() => {
          this.controlPollRunning = false;
        });
    }, 250);
  }

  private notifyProgress(): void {
    if (!this.options.onProgress) return;
    Promise.resolve(
      this.options.onProgress({
        assistantTextBytes: this.evidence.assistantTextBytes,
        maxTokens: this.evidence.maxTokens,
        childPid: this.pid,
        lastOutputAt: this.lastOutputAt,
        lastProgressAt: this.lastProgressAt,
        cliSessionId: this.cliSessionId,
        activity: this.activity,
        deadlineAt: new Date(this.currentPhaseDeadlineAtMs).toISOString(),
      }),
    ).catch(() => {});
  }

  private clearRuntimeTimers(): void {
    if (this.transportTimer) clearTimeout(this.transportTimer);
    if (this.activityTimer) clearTimeout(this.activityTimer);
    if (this.phaseTimer) clearTimeout(this.phaseTimer);
    if (this.controlTimer) clearInterval(this.controlTimer);
    this.transportTimer = null;
    this.activityTimer = null;
    this.phaseTimer = null;
    this.controlTimer = null;
  }

  private finish(
    outcome: AttemptStatus,
    failureKind: FailureKind | null,
    failureMessage: string | null,
    cancelled: boolean,
  ): void {
    if (this.resolved) return;
    this.resolved = true;
    this.clearRuntimeTimers();
    for (const stream of ["stdout", "stderr"] as const) {
      const finalSafeData = this.redactors[stream].flush();
      if (finalSafeData) this.handleSafeData(finalSafeData, stream);
      const remainder = this.lineBuffers[stream].flush();
      if (remainder) this.processLine(remainder, stream);
    }
    const { options, evidence } = this;
    this.scopeTracker?.finish();
    if (this.ioTracker)
      evidence.programIoAudit = this.ioTracker.finish(
        outcome !== "orphaned_process",
      );
    evidence.fileMutation ||= this.mutations.finish();
    // The CLI reports only finished tools, so an interrupted write has no event.
    if (
      evidence.programIoAudit?.interruptedCommands &&
      options.programIoPolicy?.vm?.mode === "implementation"
    )
      evidence.fileMutation = true;
    if (this.mutations.changedFiles.length)
      evidence.changedFiles = this.mutations.changedFiles.map((file) =>
        path.relative(options.cwd, path.resolve(options.cwd, file)),
      );
    if (this.mutations.deniedWrites.length)
      evidence.deniedWrites = [...new Set(this.mutations.deniedWrites)];
    if (this.mutations.deniedCommands.length)
      evidence.deniedCommands = [...new Set(this.mutations.deniedCommands)];
    const terminal = this.diagnosticCollector.diagnostics.terminalError;
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
      diagnostics: this.diagnosticCollector.diagnostics,
      pid: this.pid,
      outcome,
      failureKind,
      failureMessage,
      exitCode: this.actualExitCode,
      output: this.outputTail,
      assistantText: this.assistantParts.join("\n"),
      events: this.events,
      cliSessionId: this.cliSessionId,
      startedAt: this.startedAt,
      endedAt: new Date().toISOString(),
      timedOut:
        outcome === "transport_timeout" ||
        outcome === "idle_timeout" ||
        outcome === "tool_timeout" ||
        outcome === "phase_timeout",
      cancelled,
      rawLogPath: options.rawLogPath,
      controlRequest: this.controlRequest,
      autoInjected: this.autoInjected,
    };
    // Do not publish the attempt result until the log stream has flushed. This
    // keeps archive byte counts and immediate post-attempt diagnostics reliable.
    this.rawLog.end(() => this.resolveResult!(finalResult));
  }

  private finishExit(): void {
    const code = this.actualExitCode;
    this.finish(
      code === 0 ? "succeeded" : "process_exit",
      code === 0 ? null : "process_exit",
      code === 0 ? null : `Process exited with code ${code}`,
      false,
    );
  }

  private async terminate(
    intendedOutcome: AttemptStatus,
    intendedFailure: FailureKind,
    message: string,
    cancelled: boolean,
  ): Promise<void> {
    if (this.terminating || this.resolved) return;
    this.terminating = true;
    this.clearRuntimeTimers();
    const { options, pid } = this;
    if (!cancelled && checkProcessLiveness(pid) === "dead") {
      // ConPTY drains output before emitting onExit, even after the PID dies.
      // Preserve the real exit result instead of timing out during that drain.
      let drainTimer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          this.exitPromise,
          new Promise<void>((resolve) => {
            drainTimer = setTimeout(resolve, options.killTimeoutMs);
          }),
        ]);
      } finally {
        clearTimeout(drainTimer);
      }
      if (this.exitSeen) {
        this.finishExit();
        return;
      }
    }
    if (checkProcessLiveness(pid) !== "dead")
      this.ioTracker?.markPlatformStop();
    try {
      this.child.kill();
    } catch {
      // Already exited.
    }
    await Promise.race([this.exitPromise, delay(options.terminationGraceMs)]);
    let liveness = checkProcessLiveness(pid);
    if (liveness === "alive" || liveness === "unknown") {
      liveness = await terminateProcessTreeBounded(pid, options.killTimeoutMs);
      await Promise.race([this.exitPromise, delay(options.killTimeoutMs)]);
      liveness = checkProcessLiveness(pid);
    }
    if (liveness !== "dead") {
      this.finish(
        "orphaned_process",
        "orphaned_process",
        `Unable to confirm termination of child pid ${pid} after: ${message}`,
        cancelled,
      );
      return;
    }
    this.finish(intendedOutcome, intendedFailure, message, cancelled);
  }

  private armInitialTransportTimer(): void {
    if (this.transportTimer) clearTimeout(this.transportTimer);
    this.transportTimer = setTimeout(() => {
      void this.terminate(
        "transport_timeout",
        "transport_timeout",
        `No initial CLI transport output for ${this.options.transportTimeoutMs}ms`,
        false,
      );
    }, this.options.transportTimeoutMs);
  }

  private resetActivityTimer(): void {
    if (
      this.resolved ||
      this.terminating ||
      !this.transportEstablished ||
      this.activity === "initial_transport"
    )
      return;
    if (this.activityTimer) clearTimeout(this.activityTimer);
    const isToolExecution = this.activity === "tool_execution";
    const timeoutMs = isToolExecution
      ? this.options.toolTimeoutMs
      : this.options.idleTimeoutMs;
    this.activityTimer = setTimeout(() => {
      void this.terminate(
        isToolExecution ? "tool_timeout" : "idle_timeout",
        isToolExecution ? "tool_timeout" : "idle_timeout",
        isToolExecution
          ? `Tool execution produced no progress event for ${timeoutMs}ms`
          : `Model generation produced no meaningful progress for ${timeoutMs}ms`,
        false,
      );
    }, timeoutMs);
  }

  private armProgressWindowTimer(): void {
    if (this.resolved || this.terminating) return;
    if (this.phaseTimer) clearTimeout(this.phaseTimer);
    const now = Date.now();
    this.currentPhaseDeadlineAtMs = Math.min(
      now + this.options.phaseTimeoutMs,
      this.absoluteDeadlineAtMs,
    );
    const remainingMs = Math.max(1, this.currentPhaseDeadlineAtMs - now);
    const reachesAbsoluteDeadline =
      this.currentPhaseDeadlineAtMs >= this.absoluteDeadlineAtMs;
    this.phaseTimer = setTimeout(() => {
      void this.terminate(
        "phase_timeout",
        "phase_timeout",
        reachesAbsoluteDeadline
          ? "Role recovery budget deadline reached while the attempt was still incomplete"
          : `Attempt exceeded the ${this.options.phaseTimeoutMs}ms progress-renewable phase window`,
        false,
      );
    }, remainingMs);
  }

  private establishTransport(): void {
    if (this.transportEstablished) return;
    this.transportEstablished = true;
    if (this.transportTimer) clearTimeout(this.transportTimer);
    this.transportTimer = null;
    this.activity = "model_generation";
    this.resetActivityTimer();
    this.notifyProgress();
  }

  private markMeaningfulProgress(
    identity: string,
    nextActivity: SupervisorProgress["activity"],
  ): boolean {
    if (this.seenProgress.has(identity)) return false;
    this.seenProgress.add(identity);
    this.seenProgressOrder.push(identity);
    if (this.seenProgressOrder.length > 512) {
      const removed = this.seenProgressOrder.shift();
      if (removed) this.seenProgress.delete(removed);
    }
    this.lastProgressAt = new Date().toISOString();
    this.activity = this.backgroundTasks.size ? "tool_execution" : nextActivity;
    this.resetActivityTimer();
    this.armProgressWindowTimer();
    this.notifyProgress();
    return true;
  }

  /** A command the CLI moved to the background reports nothing until it ends. */
  private observeBackgroundTask(event: AnyObj): void {
    if (event.type !== "system" || typeof event.task_id !== "string") return;
    if (event.subtype === "task_started" && event.task_type === "local_bash")
      this.backgroundTasks.add(event.task_id);
    else if (
      event.subtype !== "task_notification" ||
      !this.backgroundTasks.delete(event.task_id)
    )
      return;
    this.activity = this.backgroundTasks.size
      ? "tool_execution"
      : "model_generation";
    this.resetActivityTimer();
  }

  private processEvent(raw: AnyObj): void {
    const event = this.ioTracker ? this.ioTracker.normalize(raw) : raw;
    this.observeBackgroundTask(event);
    this.applyGuards(event);
    this.diagnosticCollector.observeEvent(event);
    this.recordUsage(event);
    this.retainEvent(event);
    this.recordAssistantOutput(event);
    const toolFailure = this.toolFailures.observe(event);
    if (toolFailure)
      void this.terminate("process_exit", "tool_arguments", toolFailure, false);
    this.notifyProgress();
  }

  /** Evidence first, so a guard's stop still counts the event that caused it. */
  private applyGuards(event: AnyObj): void {
    const { evidence } = this;
    this.scopeTracker?.observe(event);
    if (this.scopeTracker?.audit.outsideCalls)
      void this.terminate(
        "process_exit",
        "role_violation",
        `${SCOPE_VIOLATION} native filesystem access escaped the approved target boundary.`,
        false,
      );
    this.commands.observe(event);
    this.inspections.observe(event);
    evidence.readFiles = this.inspections.files;
    evidence.commands = this.commands.receipts;
    this.mutations.observe(event);
    evidence.fileMutation ||= this.mutations.hasMutation;
    const policyReason = this.options.eventPolicy?.(event, evidence);
    if (policyReason)
      void this.terminate(
        "process_exit",
        policyReason.includes("[AGENT_GRAPH_UNSCOPED_TERMINATION]")
          ? "tool_arguments"
          : policyReason.startsWith("[AGENT_GRAPH_TEST_FAILED]")
            ? "process_exit"
            : "role_violation",
        policyReason,
        false,
      );
  }

  private recordUsage(event: AnyObj): void {
    const { evidence } = this;
    const search =
      completedSearch(event) ??
      claudeCompletedSearch(event, this.pendingClaudeSearches);
    if (search && !this.searchIds.has(search)) {
      this.searchIds.add(search);
      evidence.completedSearches++;
    }
    evidence.maxTokens = Math.max(evidence.maxTokens, observeTokens(event));
    evidence.costUsd = observeCost(event, evidence.costUsd);
    const reportedModel = observeModel(event);
    if (reportedModel) evidence.actualModelId = reportedModel;
  }

  private retainEvent(event: AnyObj): void {
    const size = Buffer.byteLength(JSON.stringify(event), "utf8");
    const limit = this.options.maxInMemoryOutputBytes;
    if (size > limit) return;
    this.events.push(event);
    this.eventByteSizes.push(size);
    this.eventBytes += size;
    while (this.eventBytes > limit && this.events.length > 0) {
      this.events.shift();
      this.eventBytes -= this.eventByteSizes.shift() ?? 0;
    }
  }

  private recordAssistantOutput(event: AnyObj): void {
    const normalized = normalizeProviderEvent(event);
    if (normalized.sessionId) this.cliSessionId = normalized.sessionId;
    const text = normalized.assistantText;
    if (text && text.trim().length > 0) {
      this.evidence.assistantTextBytes += Buffer.byteLength(text, "utf8");
      if (!this.assistantParts.includes(text)) this.assistantParts.push(text);
      while (
        Buffer.byteLength(this.assistantParts.join("\n"), "utf8") >
        this.options.maxInMemoryOutputBytes
      ) {
        this.assistantParts.shift();
      }
    }
    const identity = normalized.progressId;
    const nextActivity = normalized.activity;
    if (
      identity &&
      nextActivity &&
      this.markMeaningfulProgress(identity, nextActivity)
    ) {
      this.diagnosticCollector.resetRetryFailures();
    }
  }

  private processLine(line: string, stream: OutputStream = "stdout"): void {
    const trimmed = stripTerminalControlSequences(line).trim();
    if (trimmed.length === 0) return;
    if (this.consumeJsonRecord(trimmed, stream)) return;
    this.diagnosticCollector.observeLine(trimmed);
    const retryFailure = this.diagnosticCollector.retryFailure;
    if (retryFailure)
      void this.terminate(
        "process_exit",
        retryFailure.kind,
        `Stopped after 3 repeated provider failures without useful progress: ${retryFailure.message}`,
        false,
      );
    if (/^timestamp=\S+ level=(?:INFO|WARN|ERROR)\b/.test(trimmed)) {
      const session = trimmed.match(/\bsession\.id=(ses_[A-Za-z0-9]+)/);
      if (session) this.cliSessionId = session[1]!;
      // Operational logs establish transport, but never renew the model's
      // progress deadline or act as an interactive approval prompt.
      return;
    }
    if (isInteractiveAccessPrompt(trimmed)) {
      void this.terminate(
        "process_exit",
        "permission",
        `Provider requested interactive filesystem/tool access: ${trimmed.slice(0, 500)}`,
        false,
      );
      return;
    }
    this.answerAllowedPrompt(trimmed);
  }

  /** True when the line was part of a JSON record, whole or still being reassembled. */
  private consumeJsonRecord(trimmed: string, stream: OutputStream): boolean {
    const { jsonReassembly } = this;
    const candidate = jsonReassembly[stream]
      ? `${jsonReassembly[stream]}${trimmed}`
      : trimmed;
    if (!jsonReassembly[stream] && !trimmed.startsWith("{")) return false;
    const complete = isStructurallyCompleteJson(candidate);
    if (
      !complete &&
      Buffer.byteLength(candidate, "utf8") <=
        this.options.maxInMemoryOutputBytes
    ) {
      jsonReassembly[stream] = candidate;
      return true;
    }
    jsonReassembly[stream] = "";
    try {
      // PTY wrapping can separate a secret with physical newlines. Reapply
      // redaction after joining the record, before any event is retained.
      const safeRecord =
        this.recordRedactor.push(candidate) + this.recordRedactor.flush();
      this.processEvent(JSON.parse(safeRecord) as AnyObj);
      return true;
    } catch {
      // Invalid JSON is retained in the raw log but cannot satisfy progress/completion.
      return false;
    }
  }

  private answerAllowedPrompt(trimmed: string): void {
    const lower = trimmed.toLowerCase();
    const destructive = this.options.destructivePrompts.some((value) =>
      lower.includes(value.toLowerCase()),
    );
    const interaction = this.options.interactionWhitelist.find((value) =>
      lower.includes(value.toLowerCase()),
    );
    if (!interaction || destructive) return;
    try {
      this.child.write("y\n");
      this.autoInjected.push({
        prompt: trimmed,
        response: "y",
        timestamp: new Date().toISOString(),
      });
    } catch {
      // The process may have exited between output and response.
    }
  }

  private handleSafeData(
    safeData: string,
    stream: OutputStream = "stdout",
  ): void {
    this.options.onOutput?.(safeData);
    this.rawLog.write(safeData);
    this.outputTail = appendRing(
      this.outputTail,
      safeData,
      this.options.maxInMemoryOutputBytes,
    );
    this.lastOutputAt = new Date().toISOString();
    const cleanedData = stripTerminalControlSequences(safeData);
    if (cleanedData.trim().length > 0) this.establishTransport();
    for (const line of this.lineBuffers[stream].push(cleanedData)) {
      this.processLine(line, stream);
    }
    this.notifyProgress();
  }
}
