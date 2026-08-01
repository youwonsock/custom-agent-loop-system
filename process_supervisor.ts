import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as pty from "node-pty";
import {
  AttemptStatus,
  ClaimedControlRequest,
  FailureKind,
  ProcessLiveness,
  checkProcessLiveness,
  delay,
} from "./resilience";

type AnyObj = Record<string, unknown>;

export interface SupervisorProgress {
  childPid: number;
  lastOutputAt: string;
  lastProgressAt: string;
  cliSessionId: string | null;
  activity: "initial_transport" | "model_generation" | "tool_execution";
  deadlineAt: string;
}

export interface ProcessSupervisorOptions {
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
  pollControl?: () => Promise<ClaimedControlRequest | null>;
  onProgress?: (progress: SupervisorProgress) => Promise<void> | void;
}

export interface SupervisorResult {
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

class LineBuffer {
  private buffer = "";

  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines: string[] = [];
    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf("\n")) >= 0) {
      lines.push(this.buffer.slice(0, newlineIndex).replace(/\r$/, ""));
      this.buffer = this.buffer.slice(newlineIndex + 1);
    }
    if (this.buffer.length > 1024 * 1024) {
      lines.push(this.buffer);
      this.buffer = "";
    }
    return lines;
  }

  flush(): string | null {
    if (this.buffer.length === 0) return null;
    const value = this.buffer;
    this.buffer = "";
    return value;
  }
}

export function stripTerminalControlSequences(value: string): string {
  return value
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, "")
    .replace(/\x1b[()][AB012]/g, "")
    .replace(/\x1b[=>]/g, "")
    .replace(/[\x00-\x08\x0e-\x1f\x7f]/g, "");
}

function appendRing(current: string, chunk: string, maxBytes: number): string {
  const combined = current + chunk;
  if (Buffer.byteLength(combined, "utf8") <= maxBytes) return combined;
  const buffer = Buffer.from(combined, "utf8");
  return buffer.subarray(Math.max(0, buffer.length - maxBytes)).toString("utf8");
}

function isStructurallyCompleteJson(value: string): boolean {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const char of value) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{" || char === "[") {
      depth++;
    } else if (char === "}" || char === "]") {
      depth--;
      if (depth < 0) return true;
    }
  }
  return !inString && depth === 0;
}

function extractAssistantText(event: AnyObj): string | null {
  if (event.type !== "text") return null;
  const part = event.part as Record<string, unknown> | undefined;
  if (part && typeof part.text === "string") return part.text;
  for (const key of ["text", "content", "message"]) {
    if (typeof event[key] === "string") return event[key] as string;
  }
  return null;
}

function findSessionId(value: unknown, depth = 0): string | null {
  if (!value || typeof value !== "object" || depth > 4) return null;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if ((key === "sessionID" || key === "sessionId") && typeof child === "string" && child.length > 0) {
      return child;
    }
    const nested = findSessionId(child, depth + 1);
    if (nested) return nested;
  }
  return null;
}

function toolEventStatus(event: AnyObj): string | null {
  const part = event.part as Record<string, unknown> | undefined;
  const state = part?.state as Record<string, unknown> | undefined;
  return typeof state?.status === "string" ? state.status.toLowerCase() : null;
}

function activityForEvent(
  event: AnyObj
): SupervisorProgress["activity"] | null {
  const type = typeof event.type === "string" ? event.type : "";
  if (type === "tool_use") {
    const status = toolEventStatus(event);
    return status && ["completed", "failed", "error", "cancelled"].includes(status)
      ? "model_generation"
      : "tool_execution";
  }
  if (["text", "tool_result", "step_start", "step_finish"].includes(type)) {
    return "model_generation";
  }
  return null;
}

function progressIdentity(event: AnyObj, assistantText: string | null): string | null {
  const type = typeof event.type === "string" ? event.type : "";
  if (!["text", "tool_use", "tool_result", "step_start", "step_finish"].includes(type)) return null;
  if (type === "tool_use") {
    const part = event.part as Record<string, unknown> | undefined;
    const id = [event.id, event.callID, part?.id, part?.callID]
      .find((value) => typeof value === "string") as string | undefined;
    const timestamp = typeof event.timestamp === "number" || typeof event.timestamp === "string"
      ? String(event.timestamp)
      : "";
    const status = toolEventStatus(event) ?? "unknown";
    return `tool_use:${id ?? "anonymous"}:${status}:${timestamp || JSON.stringify(event).slice(-200)}`;
  }
  for (const key of ["id", "messageID", "callID"]) {
    if (typeof event[key] === "string") return `${type}:${event[key] as string}`;
  }
  const part = event.part as Record<string, unknown> | undefined;
  if (part && typeof part.id === "string") return `${type}:${part.id}`;
  if (assistantText) {
    const normalized = assistantText.replace(/\s+/g, " ").trim();
    if (normalized.length > 0) return `${type}:${normalized.slice(-500)}`;
  }
  if (type === "tool_use" || type === "step_start" || type === "step_finish") {
    return `${type}:${JSON.stringify(event).slice(0, 500)}`;
  }
  return null;
}

async function execFileBounded(
  file: string,
  args: string[],
  timeoutMs: number
): Promise<void> {
  await new Promise<void>((resolve) => {
    const child = execFile(file, args, { timeout: timeoutMs, windowsHide: true }, () => resolve());
    child.on("error", () => resolve());
  });
}

export async function terminateProcessTreeBounded(
  pid: number,
  timeoutMs: number
): Promise<ProcessLiveness> {
  if (pid <= 0) return "dead";
  if (process.platform === "win32") {
    await execFileBounded("taskkill", ["/T", "/F", "/PID", String(pid)], timeoutMs);
  } else {
    await execFileBounded("pkill", ["-TERM", "-P", String(pid)], Math.max(500, timeoutMs / 2));
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // It may already have exited.
    }
    await delay(Math.min(500, timeoutMs));
    if (checkProcessLiveness(pid) === "alive") {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // It may already have exited.
      }
    }
  }
  return checkProcessLiveness(pid);
}

export class ProcessSupervisor {
  async run(options: ProcessSupervisorOptions): Promise<SupervisorResult> {
    const startedAt = new Date().toISOString();
    await fsp.mkdir(path.dirname(options.rawLogPath), { recursive: true });
    const rawLog = fs.createWriteStream(options.rawLogPath, { flags: "a", encoding: "utf8" });

    let child: pty.IPty;
    try {
      child = pty.spawn(options.binary, options.args, {
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
    const lineBuffer = new LineBuffer();
    const events: AnyObj[] = [];
    const eventByteSizes: number[] = [];
    let eventBytes = 0;
    const assistantParts: string[] = [];
    const autoInjected: { prompt: string; response: string; timestamp: string }[] = [];
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
    let jsonReassemblyBuffer = "";
    let transportTimer: NodeJS.Timeout | null = null;
    let activityTimer: NodeJS.Timeout | null = null;
    let phaseTimer: NodeJS.Timeout | null = null;
    let controlTimer: NodeJS.Timeout | null = null;
    let controlPollRunning = false;
    const absoluteDeadlineAtMs = Math.max(
      Date.now() + 1,
      options.absoluteDeadlineAtMs ?? Date.now() + options.phaseTimeoutMs
    );
    let currentPhaseDeadlineAtMs = Math.min(
      Date.now() + options.phaseTimeoutMs,
      absoluteDeadlineAtMs
    );
    let resolveExit: (() => void) | null = null;
    const exitPromise = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });

    const notifyProgress = (): void => {
      if (!options.onProgress) return;
      Promise.resolve(
        options.onProgress({
          childPid: pid,
          lastOutputAt,
          lastProgressAt,
          cliSessionId,
          activity,
          deadlineAt: new Date(currentPhaseDeadlineAtMs).toISOString(),
        })
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
      cancelled: boolean
    ): void => {
      if (resolved) return;
      resolved = true;
      clearRuntimeTimers();
      const remainder = lineBuffer.flush();
      if (remainder) processLine(remainder);
      rawLog.end();
      resolveResult!({
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
      });
    };

    const terminate = async (
      intendedOutcome: AttemptStatus,
      intendedFailure: FailureKind,
      message: string,
      cancelled: boolean
    ): Promise<void> => {
      if (terminating || resolved) return;
      terminating = true;
      clearRuntimeTimers();
      try {
        child.kill();
      } catch {
        // Already exited.
      }
      await Promise.race([exitPromise, delay(options.terminationGraceMs)]);
      let liveness = checkProcessLiveness(pid);
      if (liveness === "alive" || liveness === "unknown") {
        liveness = await terminateProcessTreeBounded(pid, options.killTimeoutMs);
        await Promise.race([exitPromise, delay(options.killTimeoutMs)]);
        liveness = checkProcessLiveness(pid);
      }
      if (liveness !== "dead") {
        finish(
          "orphaned_process",
          "orphaned_process",
          `Unable to confirm termination of child pid ${pid} after: ${message}`,
          cancelled
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
          `No initial PTY transport output for ${options.transportTimeoutMs}ms`,
          false
        );
      }, options.transportTimeoutMs);
    };

    const resetActivityTimer = (): void => {
      if (resolved || !transportEstablished || activity === "initial_transport") return;
      if (activityTimer) clearTimeout(activityTimer);
      const isToolExecution = activity === "tool_execution";
      const timeoutMs = isToolExecution ? options.toolTimeoutMs : options.idleTimeoutMs;
      activityTimer = setTimeout(() => {
        void terminate(
          isToolExecution ? "tool_timeout" : "idle_timeout",
          isToolExecution ? "tool_timeout" : "idle_timeout",
          isToolExecution
            ? `Tool execution produced no progress event for ${timeoutMs}ms`
            : `Model generation produced no meaningful progress for ${timeoutMs}ms`,
          false
        );
      }, timeoutMs);
    };

    const armProgressWindowTimer = (): void => {
      if (resolved || terminating) return;
      if (phaseTimer) clearTimeout(phaseTimer);
      const now = Date.now();
      currentPhaseDeadlineAtMs = Math.min(
        now + options.phaseTimeoutMs,
        absoluteDeadlineAtMs
      );
      const remainingMs = Math.max(1, currentPhaseDeadlineAtMs - now);
      const reachesAbsoluteDeadline = currentPhaseDeadlineAtMs >= absoluteDeadlineAtMs;
      phaseTimer = setTimeout(() => {
        void terminate(
          "phase_timeout",
          "phase_timeout",
          reachesAbsoluteDeadline
            ? "Role recovery budget deadline reached while the attempt was still incomplete"
            : `Attempt exceeded the ${options.phaseTimeoutMs}ms progress-renewable phase window`,
          false
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
      nextActivity: SupervisorProgress["activity"]
    ): void => {
      if (seenProgress.has(identity)) return;
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
    };

    const processEvent = (event: AnyObj): void => {
      const eventBytesForEntry = Buffer.byteLength(JSON.stringify(event), "utf8");
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
      const foundSessionId = findSessionId(event);
      if (foundSessionId) cliSessionId = foundSessionId;
      const text = extractAssistantText(event);
      if (text && text.trim().length > 0) {
        assistantParts.push(text);
        while (Buffer.byteLength(assistantParts.join("\n"), "utf8") > options.maxInMemoryOutputBytes) {
          assistantParts.shift();
        }
      }
      const identity = progressIdentity(event, text);
      const nextActivity = activityForEvent(event);
      if (identity && nextActivity) markMeaningfulProgress(identity, nextActivity);
      notifyProgress();
    };

    function processLine(line: string): void {
      const trimmed = stripTerminalControlSequences(line).trim();
      if (trimmed.length === 0) return;

      const candidate = jsonReassemblyBuffer
        ? `${jsonReassemblyBuffer}${trimmed}`
        : trimmed;
      if (jsonReassemblyBuffer || trimmed.startsWith("{")) {
        const complete = isStructurallyCompleteJson(candidate);
        if (!complete && Buffer.byteLength(candidate, "utf8") <= options.maxInMemoryOutputBytes) {
          jsonReassemblyBuffer = candidate;
          return;
        }
        jsonReassemblyBuffer = "";
        try {
          processEvent(JSON.parse(candidate) as AnyObj);
          return;
        } catch {
          // Invalid JSON is retained in the raw log but cannot satisfy progress/completion.
        }
      }

      const lower = trimmed.toLowerCase();
      const destructive = options.destructivePrompts.some((value) =>
        lower.includes(value.toLowerCase())
      );
      const interaction = options.interactionWhitelist.find((value) =>
        lower.includes(value.toLowerCase())
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

    child.onData((data) => {
      if (resolved) return;
      rawLog.write(data);
      outputTail = appendRing(outputTail, data, options.maxInMemoryOutputBytes);
      lastOutputAt = new Date().toISOString();
      const cleanedData = stripTerminalControlSequences(data);
      if (cleanedData.trim().length > 0) establishTransport();
      for (const line of lineBuffer.push(cleanedData)) {
        processLine(line);
      }
      notifyProgress();
    });

    child.onExit((event) => {
      exitSeen = true;
      actualExitCode = event.exitCode;
      resolveExit?.();
      if (terminating || resolved) return;
      finish(
        event.exitCode === 0 ? "succeeded" : "process_exit",
        event.exitCode === 0 ? null : "process_exit",
        event.exitCode === 0 ? null : `Process exited with code ${event.exitCode}`,
        false
      );
    });

    armInitialTransportTimer();
    armProgressWindowTimer();

    if (options.pollControl) {
      controlTimer = setInterval(() => {
        if (controlPollRunning || terminating || resolved) return;
        controlPollRunning = true;
        options
          .pollControl!()
          .then((claimed) => {
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
        failureMessage: "PTY completed without an exit event",
        exitCode: -1,
      };
    }
    return result;
  }
}
