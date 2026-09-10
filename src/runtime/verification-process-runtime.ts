import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { appendBounded, StreamingRedactor } from "./bounded-output";
import type {
  VerificationExecutionRequest,
  VerificationExecutionResult,
  VerificationRuntimePort,
} from "../application/ports/verification-runtime-port";

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
/** Reserved by native/verification-host.cpp for an unconfirmed process tree. */
export const VERIFICATION_HELPER_TREE_UNCLEAN_EXIT_CODE = 0xE0000001;

function nodeBinary(): string {
  const configured = process.env.AGENT_LOOP_NODE_BINARY;
  if (configured && fs.existsSync(configured) && !/electron(?:\.exe)?$/iu.test(path.basename(configured))) {
    return configured;
  }
  const current = process.execPath;
  if (!/electron(?:\.exe)?$/iu.test(path.basename(current))) return current;
  const pathEntries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const directory of pathEntries) {
    const candidate = path.join(directory, process.platform === "win32" ? "node.exe" : "node");
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error("A standalone Node.js executable is required for npm verification from Electron.");
}

function resolveExecutable(executable: string): { file: string; prefixArgs: string[] } {
  const pathEntries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const extensions = process.platform === "win32"
    ? ["", ...(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)]
    : [""];
  const candidates = path.isAbsolute(executable)
    ? [executable, ...extensions.filter(Boolean).map((extension) => `${executable}${extension}`)]
    : pathEntries.flatMap((directory) => extensions.map((extension) => path.join(directory, `${executable}${extension}`)));
  const resolved = candidates.find((candidate) => {
    try { return fs.statSync(candidate).isFile(); } catch { return false; }
  });
  if (!resolved) throw new Error(`Verification executable could not be resolved: ${executable}`);
  if (process.platform !== "win32") return { file: resolved, prefixArgs: [] };
  // The contract may contain an absolute npm shim path (for example
  // `C:\\Program Files\\nodejs\\npm.cmd`).  Compare the executable name
  // rather than the whole spelling so absolute and PATH-resolved forms use
  // the same direct npm-cli.js path and never fall back to a shell shim.
  const normalized = path.basename(executable).toLowerCase();
  if (normalized === "npm" || normalized === "npm.cmd") {
    const npmCli = process.env.npm_execpath;
    if (npmCli && fs.existsSync(npmCli) && !/\.(?:cmd|bat)$/iu.test(npmCli)) {
      return { file: nodeBinary(), prefixArgs: [npmCli] };
    }
    const nodeExecutable = nodeBinary();
    const nodeDirectory = path.dirname(nodeExecutable);
    for (const candidate of [
      path.join(nodeDirectory, "node_modules", "npm", "bin", "npm-cli.js"),
      path.join(nodeDirectory, "node_modules", "npm", "bin", "npm-prefix.js"),
    ]) {
      if (fs.existsSync(candidate) && candidate.endsWith("npm-cli.js")) {
        return { file: nodeExecutable, prefixArgs: [candidate] };
      }
    }
    throw new Error("Cannot resolve npm to a direct Node.js npm-cli.js invocation.");
  }
  if (/\.(?:cmd|bat)$/iu.test(executable)) {
    throw new Error(`Shell shim verification executable is unsupported: ${executable}`);
  }
  return { file: resolved, prefixArgs: [] };
}

function verificationHelperPath(): string {
  if (process.arch !== "x64") {
    throw new Error(`Windows verification execution supports only win32-x64 (received win32-${process.arch}).`);
  }
  const configured = process.env.AGENT_LOOP_VERIFICATION_HELPER;
  const processResourcesPath = (process as NodeJS.Process & { resourcesPath?: unknown }).resourcesPath;
  const resourcesRoot = typeof processResourcesPath === "string" && processResourcesPath.trim()
    ? processResourcesPath
    : null;
  const candidates = [
    configured,
    // TypeScript emits this module under dist/src/runtime. Both the npm
    // package (package/dist/src/runtime) and the staged desktop core
    // (core/dist/src/runtime) keep native beside dist at the same level.
    path.resolve(__dirname, "../../../native/bin/win32-x64/verification-host.exe"),
    // Forge places core/native outside ASAR. Use resourcesPath explicitly for
    // the unpacked candidate; deriving it from __dirname would insert the
    // sibling app.asar directory twice.
    ...(resourcesRoot
      ? [path.resolve(resourcesRoot, "app.asar.unpacked/core/native/bin/win32-x64/verification-host.exe")]
      : []),
  ].filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0);
  const helper = candidates.find((candidate) => {
    try { return fs.statSync(candidate).isFile(); } catch { return false; }
  });
  if (!helper) {
    throw new Error("The win32-x64 verification-host.exe helper is missing from this installation.");
  }
  return helper;
}

export interface VerificationProcessRuntimeOptions {
  /** Reuse the core's configured graceful termination window. */
  terminationGraceMs?: number;
  /** Maximum time reserved for the final kill/cleanup observation. */
  killTimeoutMs?: number;
  /** In-memory credentials that must never reach verification log artifacts. */
  sensitiveValues?: readonly string[];
}

async function killTree(
  child: ReturnType<typeof spawn>,
  terminationGraceMs = 250,
  killTimeoutMs = 2_000
): Promise<boolean> {
  if (!child.pid) return true;
  if (process.platform === "win32") {
    return new Promise((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        windowsHide: true,
        stdio: "ignore",
        shell: false,
      });
      killer.once("error", () => resolve(false));
      killer.once("exit", (code) => resolve(code === 0));
    });
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") {
      try {
        child.kill("SIGTERM");
      } catch (secondaryError) {
        const secondaryCode = (secondaryError as NodeJS.ErrnoException).code;
        if (secondaryCode !== "ESRCH") return false;
      }
    }
  }
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, terminationGraceMs)));
  try { process.kill(-child.pid, "SIGKILL"); } catch { /* exited */ }
  const deadline = Date.now() + Math.max(0, killTimeoutMs);
  while (true) {
    try {
      process.kill(-child.pid, 0);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") return true;
      // EPERM/EACCES means the group still exists but its state cannot be
      // confirmed. Treat it as unsafe instead of claiming cleanup succeeded.
      return false;
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function safeEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      !/^(?:AGENT_LOOP_|(?:.*_)?(?:API[_-]?KEY|ACCESS[_-]?KEY|TOKEN|PASSWORD|PASSWD|SECRET|CREDENTIALS?|AUTH(?:ORIZATION)?)(?:_|$))/iu.test(key) &&
      !/^(?:OPENCODE_CONFIG_CONTENT|KILO_CONFIG_CONTENT|CODEX_HOME|CLAUDE_CONFIG_DIR|NPM_CONFIG_)/iu.test(key)
    )
  ) as NodeJS.ProcessEnv;
}

export class VerificationProcessRuntime implements VerificationRuntimePort {
  constructor(private readonly options: VerificationProcessRuntimeOptions = {}) {}

  async execute(request: VerificationExecutionRequest): Promise<VerificationExecutionResult> {
    const startedAt = new Date().toISOString();
    if (request.signal?.aborted) {
      throw new Error("Verification execution was aborted before the process was spawned.");
    }
    const { file, prefixArgs } = resolveExecutable(request.command.executable);
    const projectRoot = path.resolve(request.projectRoot);
    const cwd = path.resolve(projectRoot, request.command.cwd);
    // Resolve symlinks before spawning. A lexical `..` check alone would let
    // a command cwd escape through a symlink created after the contract was
    // approved.
    const realProjectRoot = await fsp.realpath(projectRoot);
    const realCwd = await fsp.realpath(cwd);
    if (!isInside(realProjectRoot, realCwd)) {
      throw new Error(`Verification command cwd escapes the project root: ${request.command.cwd}`);
    }
    const args = [...prefixArgs, ...request.command.args];
    let stdout = "";
    let stderr = "";
    const stdoutRedactor = new StreamingRedactor(this.options.sensitiveValues ?? []);
    const stderrRedactor = new StreamingRedactor(this.options.sensitiveValues ?? []);
    let outputTruncated = false;
    let timedOut = false;
    let signal: string | null = null;
    let exitCode: number | null = null;
    let settled = false;
    const helper = process.platform === "win32" ? verificationHelperPath() : null;
    // On Windows the helper owns a Job Object and launches the resolved
    // executable as its suspended child.  Its stdout/stderr are inherited by
    // the helper, so the same bounded collectors below observe the real
    // verification command while taskkill can still terminate the complete
    // helper-owned tree.
    const child = spawn(helper ?? file, helper ? ["--parent-pid", String(process.pid), "--", file, ...args] : args, {
      cwd,
      shell: false,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: safeEnvironment(),
    });
    child.stdout.on("data", (chunk: Buffer | string) => {
      const result = appendBounded(stdout, stdoutRedactor.push(Buffer.from(chunk).toString("utf8")), MAX_OUTPUT_BYTES);
      stdout = result.value;
      outputTruncated ||= result.truncated;
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      const result = appendBounded(stderr, stderrRedactor.push(Buffer.from(chunk).toString("utf8")), MAX_OUTPUT_BYTES);
      stderr = result.value;
      outputTruncated ||= result.truncated;
    });
    let terminationPromise: Promise<boolean> | null = null;
    const terminate = (): Promise<boolean> => {
      terminationPromise ??= killTree(
        child,
        this.options.terminationGraceMs,
        this.options.killTimeoutMs
      );
      return terminationPromise;
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      void terminate();
    }, request.command.timeoutMs);
    const abortHandler = request.signal
      ? () => { void terminate(); }
      : null;
    if (abortHandler) request.signal!.addEventListener("abort", abortHandler, { once: true });
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, childSignal) => {
        if (settled) return;
        settled = true;
        exitCode = code;
        signal = childSignal;
        resolve();
      });
    }).finally(() => {
      clearTimeout(timeout);
      // Do not retain an abort callback after the command has returned.  A
      // later abort must never race a reused PID/process group and terminate
      // an unrelated process.
      if (abortHandler) request.signal!.removeEventListener("abort", abortHandler);
    });
    for (const [stream, redactor] of [["stdout", stdoutRedactor], ["stderr", stderrRedactor]] as const) {
      const tail = redactor.flush();
      if (!tail) continue;
      const result = appendBounded(stream === "stdout" ? stdout : stderr, tail, MAX_OUTPUT_BYTES);
      if (stream === "stdout") stdout = result.value;
      else stderr = result.value;
      outputTruncated ||= result.truncated;
    }
    // Detached POSIX process groups can outlive the direct child. Inspect and
    // clean the group even after a normal exit so a parent-only exit is never
    // accepted as a complete verification command. Windows descendants are
    // owned by the helper Job Object and are cleaned when it closes.
    if (!terminationPromise && process.platform !== "win32") {
      terminationPromise = killTree(
        child,
        this.options.terminationGraceMs,
        this.options.killTimeoutMs
      );
    }
    // The Windows helper returns a reserved status when the direct command
    // exited while descendants remained in its Job Object, or when cleanup
    // could not be confirmed.  Never expose that helper status as the command
    // result: it is an unknown mutation boundary and must fail closed.
    const helperTreeUnclean = process.platform === "win32" &&
      exitCode !== null &&
      (exitCode >>> 0) === (VERIFICATION_HELPER_TREE_UNCLEAN_EXIT_CODE >>> 0);
    const processTreeClean = helperTreeUnclean
      ? false
      : terminationPromise ? await terminationPromise : true;
    const completedAt = new Date().toISOString();
    return {
      resolvedExecutable: file,
      resolvedArgs: [...args],
      resolvedCwd: realCwd,
      exitCode: helperTreeUnclean ? null : exitCode,
      signal,
      stdout,
      stderr,
      timedOut,
      processTreeClean,
      outputTruncated,
      startedAt,
      completedAt,
    };
  }
}
