import * as path from "node:path";
import { utilityProcess } from "electron";
import type { DesktopRoots } from "./paths";

export interface CoreLogEvent {
  stream: "stdout" | "stderr";
  text: string;
}

export interface CoreCommandResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface CoreProcessHandle {
  readonly done: Promise<CoreCommandResult>;
  kill(): void;
}

interface UtilityChild {
  stdout?: NodeJS.ReadableStream | null;
  stderr?: NodeJS.ReadableStream | null;
  on(event: string, listener: (...args: unknown[]) => void): this;
  once(event: string, listener: (...args: unknown[]) => void): this;
  kill(): void;
}

function appendBounded(current: string, chunk: unknown, limit: number): string {
  const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
  const remaining = Math.max(0, limit - Buffer.byteLength(current, "utf8"));
  if (remaining === 0) return current;
  // Slice bytes rather than UTF-16 code units so a multibyte provider output
  // cannot exceed the configured bound. Buffer#toString safely drops a
  // partial trailing code point.
  return current + Buffer.from(text, "utf8").subarray(0, remaining).toString("utf8");
}

/**
 * Adapter around Electron utilityProcess. The rest of the desktop app uses
 * the same result/kill semantics for short and long core commands.
 */
export class CoreProcessRunner {
  private readonly entryPoint: string;

  constructor(private readonly roots: DesktopRoots, private readonly maxOutputBytes = 512 * 1024) {
    this.entryPoint = path.join(roots.codeRoot, "dist", "entrypoints", "loop-orchestrator.js");
  }

  run(
    command: string,
    args: string[],
    options: {
      sessionId?: string;
      secretValues?: Record<string, string>;
      timeoutMs?: number;
      onLog?: (event: CoreLogEvent) => void;
    } = {}
  ): CoreProcessHandle {
    const commandArgs = [
      command,
      ...args,
      "--code-root", this.roots.codeRoot,
      "--config-root", this.roots.configRoot,
      "--data-root", this.roots.dataRoot,
    ];
    const environment: NodeJS.ProcessEnv = { ...process.env };
    delete environment.AGENT_LOOP_SECRET_VALUES;
    // Do not let a host launch override turn a packaged utility process into
    // a plain Node inspector/runtime or inject arbitrary startup code.
    delete environment.NODE_OPTIONS;
    delete environment.ELECTRON_RUN_AS_NODE;
    environment.AGENT_LOOP_UTILITY_PROCESS = "1";
    if (options.secretValues && Object.keys(options.secretValues).length > 0) {
      environment.AGENT_LOOP_SECRET_VALUES = JSON.stringify(options.secretValues);
    }
    let child: UtilityChild;
    try {
      child = (utilityProcess as unknown as {
        fork(modulePath: string, argv: string[], options: Record<string, unknown>): UtilityChild;
      }).fork(this.entryPoint, commandArgs, {
        stdio: "pipe",
        env: environment,
        serviceName: "agent-loop-core",
      });
    } catch (error) {
      const failure: CoreCommandResult = {
        exitCode: -1,
        signal: null,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        timedOut: false,
      };
      return { done: Promise.resolve(failure), kill: () => undefined };
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    let resolveDone!: (result: CoreCommandResult) => void;
    const done = new Promise<CoreCommandResult>((resolve) => { resolveDone = resolve; });
    const finish = (exitCode: number | null, signal: string | null, timedOut = false): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolveDone({ exitCode, signal, stdout, stderr, timedOut });
    };
    child.stdout?.on("data", (chunk: unknown) => {
      stdout = appendBounded(stdout, chunk, this.maxOutputBytes);
      options.onLog?.({ stream: "stdout", text: appendBounded("", chunk, this.maxOutputBytes) });
    });
    child.stderr?.on("data", (chunk: unknown) => {
      stderr = appendBounded(stderr, chunk, this.maxOutputBytes);
      options.onLog?.({ stream: "stderr", text: appendBounded("", chunk, this.maxOutputBytes) });
    });
    child.once("error", (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      stderr = appendBounded(stderr, message, this.maxOutputBytes);
      options.onLog?.({ stream: "stderr", text: message });
      finish(-1, null, false);
    });
    child.once("exit", (code: unknown, signal: unknown) => {
      finish(typeof code === "number" ? code : null, typeof signal === "string" ? signal : null);
    });
    if (options.timeoutMs && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        try { child.kill(); }
        catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "ENOENT" && code !== "ESRCH") {
            stderr = appendBounded(stderr, error instanceof Error ? error.message : String(error), this.maxOutputBytes);
          }
        }
        finish(null, "TIMEOUT", true);
      }, options.timeoutMs);
    }
    return {
      done,
      kill: () => {
        try { child.kill(); }
        catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "ENOENT" && code !== "ESRCH") throw error;
        }
      },
    };
  }

  runShort(command: string, args: string[] = [], options: Parameters<CoreProcessRunner["run"]>[2] = {}): Promise<CoreCommandResult> {
    return this.run(command, args, options).done;
  }
}
