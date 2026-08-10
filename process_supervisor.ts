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
const MIN_RAW_LOG_BYTES = 8 * 1024 * 1024;
const MAX_RAW_LOG_BYTES = 32 * 1024 * 1024;
const REDACTION_MARKER = "[REDACTED]";
const EXIT_DATA_DRAIN_MS = 100;
const EMPTY_RESULT_EXIT_DATA_DRAIN_MS = 1_000;
const RAW_LOG_CLOSE_TIMEOUT_MS = 5_000;

async function openRawLogStream(filePath: string): Promise<fs.WriteStream> {
  const descriptor = await new Promise<number>((resolve, reject) => {
    fs.open(filePath, "a", 0o600, (err, fd) => {
      if (err) reject(err);
      else resolve(fd);
    });
  });
  try {
    const stat = await new Promise<fs.Stats>((resolve, reject) => {
      fs.fstat(descriptor, (err, value) => {
        if (err) reject(err);
        else resolve(value);
      });
    });
    if (!stat.isFile()) {
      const error = new Error(`Raw log path is not a regular file: ${filePath}`) as NodeJS.ErrnoException;
      error.code = "EISDIR";
      throw error;
    }
    // `mode` on fs.open only applies when the file is newly created. Tighten an
    // existing attempt log through the already-validated descriptor as well.
    await new Promise<void>((resolve, reject) => {
      fs.fchmod(descriptor, 0o600, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    return fs.createWriteStream(filePath, {
      fd: descriptor,
      autoClose: true,
      encoding: "utf8",
    });
  } catch (err) {
    try { fs.closeSync(descriptor); } catch { /* already closed */ }
    throw err;
  }
}

function errorDescription(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    return code && !err.message.includes(code) ? `${code}: ${err.message}` : err.message;
  }
  return String(err);
}

function fixedLengthRedaction(length: number): string {
  if (length <= REDACTION_MARKER.length) return REDACTION_MARKER.slice(0, length);
  return REDACTION_MARKER + "*".repeat(length - REDACTION_MARKER.length);
}

class StreamingRedactor {
  private carry = "";
  private readonly patterns: string[];
  private readonly maximumPatternLength: number;

  constructor(sensitiveValues: readonly string[]) {
    const patterns = new Set<string>();
    for (const secret of sensitiveValues.filter(Boolean)) {
      patterns.add(secret);
      const jsonEscaped = JSON.stringify(secret).slice(1, -1);
      if (jsonEscaped !== secret) patterns.add(jsonEscaped);
    }
    this.patterns = [...patterns].sort((left, right) => right.length - left.length);
    this.maximumPatternLength = this.patterns[0]?.length ?? 0;
  }

  push(chunk: string): string {
    if (this.patterns.length === 0) return chunk;
    const combined = this.carry + chunk;
    const safeBoundary = Math.max(0, combined.length - (this.maximumPatternLength - 1));
    return this.consume(combined, safeBoundary);
  }

  flush(): string {
    if (this.patterns.length === 0) return "";
    const combined = this.carry;
    return this.consume(combined, combined.length);
  }

  private consume(combined: string, safeBoundary: number): string {
    let index = 0;
    let output = "";
    while (index < safeBoundary) {
      const match = this.patterns.find((pattern) => combined.startsWith(pattern, index));
      if (match) {
        output += fixedLengthRedaction(match.length);
        index += match.length;
      } else {
        output += combined[index];
        index += 1;
      }
    }
    this.carry = combined.slice(index);
    return output;
  }
}

function utf8Prefix(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maximumBytes) return value;
  return bytes.subarray(0, Math.max(0, maximumBytes)).toString("utf8").replace(/\uFFFD$/, "");
}

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
  /** In-memory credentials that must never reach attempt logs or completion text. */
  sensitiveValues?: string[];
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

export function isInteractiveAccessPrompt(value: string): boolean {
  const normalized = stripTerminalControlSequences(value).replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  return (
    /(?:allow|grant)\b.{0,120}(?:\[y\/n\]|\(y\/n\)|yes\/no)/i.test(normalized) ||
    /(?:permission|access)\s+(?:is\s+)?(?:required|requested|needed)/i.test(normalized) ||
    /do you want to allow\b/i.test(normalized)
  );
}

export function isInteractiveConfirmationPrompt(value: string): boolean {
  const normalized = stripTerminalControlSequences(value).replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  return (
    /(?:\[|\()(?:y\s*\/\s*n|yes\s*\/\s*no)(?:\]|\))/i.test(normalized) ||
    /\b(?:continue|proceed|confirm|apply|overwrite|execute|run command|allow)\b.{0,80}(?:\(y\)|\[y\]|type y|enter y)/i.test(normalized)
  );
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

export function extractAssistantText(event: AnyObj): string | null {
  const eventType = typeof event.type === "string" ? event.type : "";
  if (eventType === "text") {
    const part = event.part as Record<string, unknown> | undefined;
    if (part && typeof part.text === "string") return part.text;
    for (const key of ["text", "content", "message"]) {
      if (typeof event[key] === "string") return event[key] as string;
    }
  }

  // Codex CLI JSONL: only completed agent_message items count as assistant text.
  if (eventType === "item.completed") {
    const item = event.item as Record<string, unknown> | undefined;
    if (item?.type === "agent_message" && typeof item.text === "string") return item.text;
  }

  // Claude Code stream-json: assistant.message.content contains typed blocks.
  if (eventType === "assistant") {
    const message = event.message as Record<string, unknown> | undefined;
    const content = Array.isArray(message?.content) ? message.content : [];
    const textBlocks = content
      .filter((block): block is Record<string, unknown> => Boolean(block) && typeof block === "object")
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => String(block.text));
    return textBlocks.length > 0 ? textBlocks.join("\n") : null;
  }
  // Some Claude versions omit an assistant event in print mode. The result is a
  // legitimate final assistant field, unlike prompt/tool payloads.
  if (eventType === "result" && typeof event.result === "string") return event.result;
  return null;
}

export function findSessionId(value: unknown, depth = 0): string | null {
  if (!value || typeof value !== "object" || depth > 4) return null;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (
      ["sessionID", "sessionId", "session_id", "thread_id"].includes(key) &&
      typeof child === "string" &&
      child.length > 0
    ) {
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
  if (type === "item.started" || type === "item.completed") {
    const item = event.item as Record<string, unknown> | undefined;
    const itemType = typeof item?.type === "string" ? item.type : "";
    const isTool = ["command_execution", "file_change", "mcp_tool_call", "web_search"].includes(itemType);
    return type === "item.started" && isTool ? "tool_execution" : "model_generation";
  }
  if (type === "assistant") {
    const message = event.message as Record<string, unknown> | undefined;
    const content = Array.isArray(message?.content) ? message.content : [];
    return content.some(
      (block) => Boolean(block) && typeof block === "object" && (block as AnyObj).type === "tool_use"
    ) ? "tool_execution" : "model_generation";
  }
  if (["user", "result", "thread.started", "turn.started", "turn.completed"].includes(type)) {
    return "model_generation";
  }
  return null;
}

function progressIdentity(event: AnyObj, assistantText: string | null): string | null {
  const type = typeof event.type === "string" ? event.type : "";
  const recognized = [
    "text", "tool_use", "tool_result", "step_start", "step_finish",
    "item.started", "item.completed", "assistant", "user", "result",
    "thread.started", "turn.started", "turn.completed",
  ];
  if (!recognized.includes(type)) return null;
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
  const item = event.item as Record<string, unknown> | undefined;
  if (item && typeof item.id === "string") {
    const status = typeof item.status === "string" ? item.status : "";
    return `${type}:${item.id}:${status}`;
  }
  const message = event.message as Record<string, unknown> | undefined;
  if (message && typeof message.id === "string") return `${type}:${message.id}`;
  if (assistantText) {
    const normalized = assistantText.replace(/\s+/g, " ").trim();
    if (normalized.length > 0) return `${type}:${normalized.slice(-500)}`;
  }
  if (["tool_use", "step_start", "step_finish", "item.started", "item.completed", "result"].includes(type)) {
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
    const preSpawnLogFailure = (err: unknown): SupervisorResult => ({
      pid: -1,
      outcome: "spawn_error",
      // Reuse the existing non-retryable permission classification: loss of
      // orchestration evidence requires local storage repair/user action, not
      // repeated provider attempts. No persisted state enum is added.
      failureKind: "permission",
      failureMessage: `Raw log could not be opened: ${errorDescription(err)}`,
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
    });
    let rawLog: fs.WriteStream;
    try {
      await fsp.mkdir(path.dirname(options.rawLogPath), { recursive: true });
      // Supplying an already-open descriptor prevents createWriteStream's
      // asynchronous open errors from becoming an unhandled EventEmitter error.
      // A bad path therefore fails before the provider process is spawned.
      rawLog = await openRawLogStream(options.rawLogPath);
    } catch (err) {
      return preSpawnLogFailure(err);
    }
    let rawLogFailure: unknown = null;
    let onRawLogFailure: ((err: unknown) => void) | null = null;
    const recordRawLogFailure = (err: unknown): void => {
      if (rawLogFailure === null) rawLogFailure = err;
      onRawLogFailure?.(err);
    };
    // Keep this listener installed for the entire stream lifetime, including
    // final close, so no filesystem error can surface as an uncaught event.
    rawLog.on("error", recordRawLogFailure);
    const finalizeRawLog = (baseResult: SupervisorResult): Promise<SupervisorResult> =>
      new Promise((resolve) => {
        let settled = false;
        let closeTimer: NodeJS.Timeout | null = null;
        const settle = (closeFailure?: unknown): void => {
          if (settled) return;
          settled = true;
          if (closeTimer) clearTimeout(closeTimer);
          if (closeFailure !== undefined && rawLogFailure === null) {
            rawLogFailure = closeFailure;
          }
          if (rawLogFailure !== null) {
            const logMessage = `Raw log I/O failure: ${errorDescription(rawLogFailure)}`;
            if (baseResult.failureKind === "orphaned_process") {
              resolve({
                ...baseResult,
                failureMessage: `${baseResult.failureMessage ?? "Provider process could not be terminated"}; ${logMessage}`,
              });
            } else {
              resolve({
                ...baseResult,
                outcome: "spawn_error",
                failureKind: "permission",
                failureMessage: logMessage,
                exitCode: -1,
                timedOut: false,
                cancelled: false,
                controlRequest: null,
              });
            }
            return;
          }
          resolve(baseResult);
        };
        rawLog.once("close", () => settle());
        closeTimer = setTimeout(() => {
          const timeoutError = new Error(
            `Raw log did not close within ${RAW_LOG_CLOSE_TIMEOUT_MS}ms`
          );
          recordRawLogFailure(timeoutError);
          rawLog.destroy();
          settle(timeoutError);
        }, RAW_LOG_CLOSE_TIMEOUT_MS);
        if (rawLog.destroyed) {
          settle(rawLogFailure ?? new Error("Raw log stream closed unexpectedly"));
          return;
        }
        try {
          rawLog.end();
        } catch (err) {
          recordRawLogFailure(err);
          rawLog.destroy();
          settle(err);
        }
      });
    const sensitiveValues = [...new Set((options.sensitiveValues ?? []).filter(Boolean))]
      .sort((left, right) => right.length - left.length);
    const redactor = new StreamingRedactor(sensitiveValues);
    const maximumRawLogBytes = Math.max(
      MIN_RAW_LOG_BYTES,
      Math.min(MAX_RAW_LOG_BYTES, options.maxInMemoryOutputBytes * 16)
    );
    let rawLogBytesWritten = 0;
    let rawLogTruncated = false;
    const writeRawLog = (value: string): void => {
      if (!value || rawLogTruncated || rawLogFailure !== null) return;
      const remaining = maximumRawLogBytes - rawLogBytesWritten;
      const prefix = utf8Prefix(value, remaining);
      if (prefix) {
        try {
          rawLog.write(prefix);
          rawLogBytesWritten += Buffer.byteLength(prefix, "utf8");
        } catch (err) {
          recordRawLogFailure(err);
          return;
        }
      }
      if (Buffer.byteLength(value, "utf8") > remaining) {
        try {
          rawLog.write("\n[AGENT_LOOP_LOG_TRUNCATED]\n");
        } catch (err) {
          recordRawLogFailure(err);
          return;
        }
        rawLogTruncated = true;
      }
    };

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
      const message = err instanceof Error ? err.message : String(err);
      return finalizeRawLog({
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
      });
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
    let exitDrainTimer: NodeJS.Timeout | null = null;
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
      if (exitDrainTimer) clearTimeout(exitDrainTimer);
      transportTimer = null;
      activityTimer = null;
      phaseTimer = null;
      controlTimer = null;
      exitDrainTimer = null;
    };

    let resolveResult: ((result: SupervisorResult) => void) | null = null;
    const resultPromise = new Promise<SupervisorResult>((resolve) => {
      resolveResult = resolve;
    });

    const exitDataDrainMs = (): number =>
      events.length === 0 && assistantParts.length === 0 && cliSessionId === null
        ? EMPTY_RESULT_EXIT_DATA_DRAIN_MS
        : EXIT_DATA_DRAIN_MS;

    const finish = (
      outcome: AttemptStatus,
      failureKind: FailureKind | null,
      failureMessage: string | null,
      cancelled: boolean
    ): void => {
      if (resolved) return;
      resolved = true;
      clearRuntimeTimers();
      const finalSafeData = redactor.flush();
      if (finalSafeData) handleSafeData(finalSafeData);
      const remainder = lineBuffer.flush();
      if (remainder) processLine(remainder);
      const finalResult: SupervisorResult = {
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
      void finalizeRawLog(finalResult).then((result) => resolveResult!(result));
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
      // Some PTY implementations report exit before dispatching their final
      // data callback. Termination paths need the same bounded drain as natural
      // exits so session IDs, tool events, and completion text are not dropped.
      if (exitSeen) await delay(exitDataDrainMs());
      finish(intendedOutcome, intendedFailure, message, cancelled);
    };

    onRawLogFailure = (err) => {
      if (resolved || terminating) return;
      void terminate(
        "spawn_error",
        "spawn_error",
        `Raw log I/O failure stopped provider execution: ${errorDescription(err)}`,
        false
      );
    };
    if (rawLogFailure !== null) onRawLogFailure(rawLogFailure);

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
        if (!assistantParts.includes(text)) assistantParts.push(text);
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
      if (isInteractiveAccessPrompt(trimmed)) {
        void terminate(
          "process_exit",
          "permission",
          `Provider requested interactive filesystem/tool access: ${trimmed.slice(0, 500)}`,
          false
        );
        return;
      }
      const destructive = options.destructivePrompts.some((value) =>
        lower.includes(value.toLowerCase())
      );
      const interaction = options.interactionWhitelist.find((value) =>
        lower.includes(value.toLowerCase())
      );
      if (destructive || interaction || isInteractiveConfirmationPrompt(trimmed)) {
        // Text emitted by a provider is not an authorization channel. Safe
        // non-interactive behavior must be selected through structured adapter
        // flags; unknown confirmation prompts are denied rather than answered.
        void terminate(
          "process_exit",
          "permission",
          `Provider requested interactive confirmation; automatic approval is disabled: ${trimmed.slice(0, 500)}`,
          false
        );
      }
    }

    const handleSafeData = (safeData: string): void => {
      writeRawLog(safeData);
      outputTail = appendRing(outputTail, safeData, options.maxInMemoryOutputBytes);
      lastOutputAt = new Date().toISOString();
      const cleanedData = stripTerminalControlSequences(safeData);
      if (cleanedData.trim().length > 0) establishTransport();
      for (const line of lineBuffer.push(cleanedData)) {
        processLine(line);
      }
      notifyProgress();
    };

    child.onData((data) => {
      if (resolved) return;
      // Normalize terminal control sequences before streaming redaction. Some PTY
      // implementations inject cursor-control bytes between writes; redacting the
      // normalized stream prevents a split credential from being reconstructed by
      // the assistant-event parser even when those bytes bisect the secret.
      const safeData = redactor.push(stripTerminalControlSequences(data));
      if (safeData) handleSafeData(safeData);
    });

    child.onExit((event) => {
      if (exitSeen) return;
      exitSeen = true;
      actualExitCode = event.exitCode;
      resolveExit?.();
      if (terminating || resolved) return;
      // node-pty can deliver onExit before the final onData callback. Keep data
      // acceptance open for one short bounded drain window so the last assistant
      // event (and any split streaming-redactor carry) is not discarded.
      clearRuntimeTimers();
      exitDrainTimer = setTimeout(() => {
        exitDrainTimer = null;
        finish(
          event.exitCode === 0 ? "succeeded" : "process_exit",
          event.exitCode === 0 ? null : "process_exit",
          event.exitCode === 0 ? null : `Process exited with code ${event.exitCode}`,
          false
        );
      }, exitDataDrainMs());
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
          .catch((err: unknown) => {
            if (terminating || resolved) return;
            const reason = err instanceof Error ? err.message : String(err);
            void terminate(
              "process_exit",
              "permission",
              `Control queue polling failed; provider execution was stopped: ${reason.slice(0, 500)}`,
              false
            );
          })
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
