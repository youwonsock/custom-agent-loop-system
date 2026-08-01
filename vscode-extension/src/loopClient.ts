import { ChildProcess, execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { AccessMode, ExtensionConfig, ModelMapping, VariantMapping, readExtensionConfig } from "./types";
import { StateStore } from "./stateStore";
import { processLiveness, shouldGracefullyStop } from "./resilience";

export interface NewSessionOptions {
  goal: string;
  targetProjectPath: string;
  accessMode: AccessMode;
  modelMapping: Partial<ModelMapping>;
  variantMapping?: Partial<VariantMapping>;
}

export interface LogEntry {
  timestamp: string;
  stream: "stdout" | "stderr";
  text: string;
}

function generateSessionId(): string {
  return `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

export class LoopClient {
  private activeProcesses: Map<string, ChildProcess> = new Map();
  private externalTails: Map<string, NodeJS.Timeout> = new Map();
  private logListeners: Map<string, (entry: LogEntry) => void> = new Map();
  private exitListeners: Map<string, (code: number | null, signal: NodeJS.Signals | null) => void> = new Map();
  private recoveryWakeup: (() => void) | null = null;
  private activePlanRevisions = new Set<string>();

  constructor(
    private readonly config: ExtensionConfig,
    private readonly store: StateStore
  ) {}

  async resolveOrchestratorScript(): Promise<string> {
    const liveScript = readExtensionConfig().orchestratorScript;
    const candidates: string[] = [];
    const addCandidate = async (p: string) => {
      if (!p || p.length === 0) return;
      const resolved = path.resolve(p);
      try {
        const stat = await fs.stat(resolved);
        if (stat.isDirectory()) {
          candidates.push(path.join(resolved, "dist", "loop_orchestrator.js"));
        } else {
          candidates.push(resolved);
        }
      } catch {
        candidates.push(resolved);
      }
    };
    if (liveScript && liveScript.length > 0) {
      await addCandidate(liveScript);
    }
    if (this.config.orchestratorScript && this.config.orchestratorScript.length > 0) {
      await addCandidate(this.config.orchestratorScript);
    }
    const root = await this.store.getRootDir();
    candidates.push(path.join(root, "dist", "loop_orchestrator.js"));
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      candidates.push(path.join(folder.uri.fsPath, "dist", "loop_orchestrator.js"));
    }
    candidates.push(path.join(process.cwd(), "dist", "loop_orchestrator.js"));
    const seen = new Set<string>();
    for (const candidate of candidates) {
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      try {
        await fs.access(candidate);
        const rootCandidate = path.dirname(path.dirname(candidate));
        const distStat = await fs.stat(candidate);
        const sourceNames = [
          "loop_orchestrator.ts",
          "process_supervisor.ts",
          "resilience.ts",
          "pipeline.ts",
          "agent_attempt_runner.ts",
        ];
        for (const sourceName of sourceNames) {
          const sourceStat = await fs.stat(path.join(rootCandidate, sourceName)).catch(() => null);
          if (sourceStat && sourceStat.mtimeMs > distStat.mtimeMs + 1) {
            throw new Error(
              `Compiled orchestrator is older than ${sourceName}. Run "npm run build" in ${rootCandidate} before starting a session.`
            );
          }
        }
        return candidate;
      } catch (err) {
        if (err instanceof Error && err.message.includes("Compiled orchestrator is older")) {
          throw err;
        }
        // try next
      }
    }
    const missing = candidates[0];
    throw new Error(
      `Orchestrator script not found. Looked for:\n  ${missing}\nSet "Agent Loop: Root Dir" in Settings to the Custom_AgentLoopSystem install path (the folder containing dist/loop_orchestrator.js).`
    );
  }

  private liveConfig(): ExtensionConfig {
    return readExtensionConfig();
  }

  async discoverModels(): Promise<{ models: string[]; exitCode: number | null; stderr: string; command: string }> {
    const root = await this.store.getRootDir();
    let script: string;
    try {
      script = await this.resolveOrchestratorScript();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(msg);
      return { models: [], exitCode: -1, stderr: msg, command: "" };
    }
    const cfg = this.liveConfig();
    const args = ["models", "--binary", cfg.cliBinary, "--profile", cfg.cliProfile, "--root", root];
    const cmdStr = `${this.config.nodeBinary} ${script} ${args.join(" ")}`;
    return new Promise<{ models: string[]; exitCode: number | null; stderr: string; command: string }>((resolve) => {
      const child = spawn(this.config.nodeBinary, [script, ...args], {
        cwd: root,
        env: process.env,
      });
      let stderr = "";
      child.stdout.on("data", (_chunk: Buffer) => {
        // Intentionally not parsing stdout here. The orchestrator writes discovered models
        // to sessions_registry.json. The caller should re-read the registry after this resolves.
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on("error", (err) => {
        vscode.window.showErrorMessage(`Failed to run model discovery: ${err.message}`);
        resolve({ models: [], exitCode: -1, stderr: err.message, command: cmdStr });
      });
      child.on("exit", (code) => {
        resolve({ models: [], exitCode: code, stderr: stderr.slice(0, 2000), command: cmdStr });
      });
    });
  }

  async startNewSession(opts: NewSessionOptions): Promise<string> {
    const sessionId = generateSessionId();
    const root = await this.store.getRootDir();
    const script = await this.resolveOrchestratorScript();
    const cfg = this.liveConfig();

    const args: string[] = [
      script,
      "run",
      "--goal", opts.goal,
      "--target", opts.targetProjectPath,
      "--binary", cfg.cliBinary,
      "--profile", cfg.cliProfile,
      "--root", root,
      "--session", sessionId,
      "--max-iterations", String(cfg.maxIterations),
      "--phase-timeout", String(cfg.phaseTimeoutMs),
      "--idle-timeout", String(cfg.idleTimeoutMs),
      "--tool-timeout", String(cfg.toolTimeoutMs),
      "--transport-timeout", String(cfg.transportTimeoutMs),
      "--phase-recovery-budget", String(cfg.phaseRecoveryBudgetMs),
      "--max-agent-attempts", String(cfg.maxAgentAttempts),
      "--completion-recovery-attempts", String(cfg.maxCompletionRecoveryAttempts),
      "--automatic-recovery-cycles", String(cfg.maxAutomaticRecoveryCycles),
      "--automatic-recovery-backoff", cfg.automaticRecoveryBackoffMs.join(","),
      "--retry-backoff", cfg.retryBackoffMs.join(","),
      "--termination-grace", String(cfg.terminationGraceMs),
      "--kill-timeout", String(cfg.killTimeoutMs),
      "--heartbeat-interval", String(cfg.heartbeatIntervalMs),
      "--lease-ttl", String(cfg.leaseTtlMs),
      "--max-output-bytes", String(cfg.maxInMemoryOutputBytes),
    ];
    if (opts.accessMode === "full_access") args.push("--full-access");

    if (opts.modelMapping.planner) args.push("--planner-model", opts.modelMapping.planner);
    if (opts.modelMapping.implementer) args.push("--implementer-model", opts.modelMapping.implementer);
    if (opts.modelMapping.tester) args.push("--tester-model", opts.modelMapping.tester);
    if (opts.modelMapping.qa_lead) args.push("--qa-model", opts.modelMapping.qa_lead);
    if (opts.modelMapping.master) args.push("--master-model", opts.modelMapping.master);
    if (opts.modelMapping.interrupter) args.push("--interrupter-model", opts.modelMapping.interrupter);

    if (opts.variantMapping?.planner) args.push("--planner-variant", opts.variantMapping.planner);
    if (opts.variantMapping?.implementer) args.push("--implementer-variant", opts.variantMapping.implementer);
    if (opts.variantMapping?.tester) args.push("--tester-variant", opts.variantMapping.tester);
    if (opts.variantMapping?.qa_lead) args.push("--qa-variant", opts.variantMapping.qa_lead);
    if (opts.variantMapping?.master) args.push("--master-variant", opts.variantMapping.master);
    if (opts.variantMapping?.interrupter) args.push("--interrupter-variant", opts.variantMapping.interrupter);
    if (cfg.pipelineConfigPath) args.push("--pipeline", cfg.pipelineConfigPath);

    this.spawnSession(args, root, sessionId);
    void this.store.syncRegistrySessionStatus(sessionId, "RUNNING");
    return sessionId;
  }

  async resumeSession(
    sessionId: string,
    recovery = false,
    accessDecision?: "allow_requested" | "full_access"
  ): Promise<string> {
    const runtime = await this.store.inspectLease(sessionId);
    if (
      this.isRunning(sessionId) ||
      runtime.disposition === "active" ||
      runtime.disposition === "expired_owner_alive" ||
      runtime.disposition === "unverifiable"
    ) {
      throw new Error(`Session ${sessionId} is already running.`);
    }
    const root = await this.store.getRootDir();
    const script = await this.resolveOrchestratorScript();

    const args: string[] = [
      script,
      "resume",
      "--session", sessionId,
      "--root", root,
    ];
    if (recovery) args.push("--recovery");
    if (!recovery) {
      const cfg = this.liveConfig();
      args.push(
        "--max-iterations", String(cfg.maxIterations),
        "--phase-timeout", String(cfg.phaseTimeoutMs),
        "--idle-timeout", String(cfg.idleTimeoutMs),
        "--tool-timeout", String(cfg.toolTimeoutMs),
        "--transport-timeout", String(cfg.transportTimeoutMs),
        "--phase-recovery-budget", String(cfg.phaseRecoveryBudgetMs),
        "--max-agent-attempts", String(cfg.maxAgentAttempts),
        "--completion-recovery-attempts", String(cfg.maxCompletionRecoveryAttempts),
        "--automatic-recovery-cycles", String(cfg.maxAutomaticRecoveryCycles),
        "--automatic-recovery-backoff", cfg.automaticRecoveryBackoffMs.join(","),
        "--retry-backoff", cfg.retryBackoffMs.join(","),
        "--termination-grace", String(cfg.terminationGraceMs),
        "--kill-timeout", String(cfg.killTimeoutMs),
        "--heartbeat-interval", String(cfg.heartbeatIntervalMs),
        "--lease-ttl", String(cfg.leaseTtlMs),
        "--max-output-bytes", String(cfg.maxInMemoryOutputBytes)
      );
    }
    if (accessDecision === "allow_requested") args.push("--approve-access");
    if (accessDecision === "full_access") args.push("--full-access");

    this.spawnSession(args, root, sessionId);
    void this.store.syncRegistrySessionStatus(sessionId, "RUNNING");
    return sessionId;
  }

  async interruptSession(sessionId: string, message: string): Promise<void> {
    await this.store.enqueueControlRequest(sessionId, "INTERRUPT", message);
    const state = await this.store.readState(sessionId);
    const runtime = await this.store.inspectLease(sessionId);
    if (state?.status === "RUNNING" && runtime.disposition !== "recoverable") {
      return;
    }
    await this.resumeSession(sessionId, runtime.disposition === "recoverable");
  }

  private spawnSession(args: string[], cwd: string, sessionId: string): string {
    const child = spawn(this.config.nodeBinary, args, {
      cwd,
      env: process.env,
    });

    this.activeProcesses.set(sessionId, child);

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      this.emitLog(sessionId, { timestamp: new Date().toISOString(), stream: "stdout", text });
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      this.emitLog(sessionId, { timestamp: new Date().toISOString(), stream: "stderr", text });
    });

    child.on("error", (err) => {
      vscode.window.showErrorMessage(`Agent loop process error: ${err.message}`);
    });

    child.on("exit", (code, signal) => {
      this.activeProcesses.delete(sessionId);
      const listeners = this.exitListeners.get(sessionId);
      if (listeners) {
        listeners(code, signal);
        this.exitListeners.delete(sessionId);
      }
      this.emitLog(sessionId, {
        timestamp: new Date().toISOString(),
        stream: "stderr",
        text: `\n[process exited] code=${code ?? "null"} signal=${signal ?? "null"}\n`,
      });
      this.recoveryWakeup?.();
    });

    return sessionId;
  }

  async stopSession(sessionId: string): Promise<boolean> {
    const request = await this.store.enqueueControlRequest(sessionId, "STOP");
    const acknowledged = await this.store.waitForControlCompletion(sessionId, request.requestId, 8_000);
    if (acknowledged) return true;

    const child = this.activeProcesses.get(sessionId);
    const runtime = await this.store.inspectLease(sessionId);
    const ownerPid = child?.pid ?? runtime.lease?.ownerPid ?? null;
    if (ownerPid && processLiveness(ownerPid) !== "dead") {
      await this.forceTerminateProcessTree(ownerPid, this.liveConfig().killTimeoutMs);
    }
    if (!ownerPid || processLiveness(ownerPid) === "dead") {
      await this.store.markSessionStopped(
        sessionId,
        "The core process did not acknowledge STOP within 8 seconds and was terminated."
      );
      await this.store.completeQueuedControlRequest(
        sessionId,
        request,
        "completed",
        "Session stopped by the extension after the core did not acknowledge STOP."
      );
    }
    return false;
  }

  async gracefullyStopAll(): Promise<void> {
    const registry = await this.store.readRegistry().catch(() => null);
    const sessionIds = new Set<string>(this.activeProcesses.keys());
    for (const meta of registry?.sessionMetas ?? []) {
      const state = await this.store.readState(meta.sessionId).catch(() => null);
      if (state && shouldGracefullyStop(state.status)) sessionIds.add(meta.sessionId);
    }
    await Promise.allSettled(Array.from(sessionIds, (sessionId) => this.stopSession(sessionId)));
  }

  /** @deprecated Use gracefullyStopAll. */
  async gracefullyPauseAll(): Promise<void> {
    await this.gracefullyStopAll();
  }

  private async forceTerminateProcessTree(pid: number, timeoutMs: number): Promise<void> {
    if (process.platform === "win32") {
      await new Promise<void>((resolve) => {
        const child = execFile(
          "taskkill",
          ["/T", "/F", "/PID", String(pid)],
          { timeout: timeoutMs, windowsHide: true },
          () => resolve()
        );
        child.on("error", () => resolve());
      });
      return;
    }
    try { process.kill(pid, "SIGTERM"); } catch { return; }
    await new Promise((resolve) => setTimeout(resolve, Math.min(1000, timeoutMs)));
    if (processLiveness(pid) === "alive") {
      try { process.kill(pid, "SIGKILL"); } catch { /* already exited */ }
    }
  }

  isRunning(sessionId: string): boolean {
    const child = this.activeProcesses.get(sessionId);
    return !!child && child.exitCode === null && child.signalCode === null;
  }

  getActiveSessionIds(): string[] {
    return Array.from(this.activeProcesses.keys());
  }

  setRecoveryWakeup(listener: (() => void) | null): void {
    this.recoveryWakeup = listener;
  }

  followExternalSession(sessionId: string): void {
    if (this.externalTails.has(sessionId)) return;
    let currentPath: string | null = null;
    let offset = 0;
    let reading = false;
    const timer = setInterval(() => {
      if (reading) return;
      reading = true;
      void (async () => {
        const state = await this.store.readState(sessionId);
        if (!state || state.status !== "RUNNING") {
          this.stopFollowingExternalSession(sessionId);
          return;
        }
        const logPath = state.activeAttempt?.outputLogPath ?? null;
        if (!logPath) return;
        if (!this.logListeners.has(sessionId)) return;
        if (currentPath !== logPath) {
          currentPath = logPath;
          offset = 0;
        }
        const stat = await fs.stat(logPath).catch(() => null);
        if (!stat || stat.size <= offset) return;
        const length = Math.min(64 * 1024, stat.size - offset);
        const handle = await fs.open(logPath, "r");
        try {
          const buffer = Buffer.alloc(length);
          const result = await handle.read(buffer, 0, length, offset);
          offset += result.bytesRead;
          if (result.bytesRead > 0) {
            this.emitLog(sessionId, {
              timestamp: new Date().toISOString(),
              stream: "stdout",
              text: buffer.subarray(0, result.bytesRead).toString("utf8"),
            });
          }
        } finally {
          await handle.close();
        }
      })().catch(() => {}).finally(() => {
        reading = false;
      });
    }, 500);
    this.externalTails.set(sessionId, timer);
  }

  stopFollowingExternalSession(sessionId: string): void {
    const timer = this.externalTails.get(sessionId);
    if (timer) clearInterval(timer);
    this.externalTails.delete(sessionId);
  }

  async revisePlan(sessionId: string, message: string): Promise<{ exitCode: number | null; stdout: string }> {
    if (this.activePlanRevisions.has(sessionId)) {
      throw new Error(`A plan revision is already running for session ${sessionId}.`);
    }
    const root = await this.store.getRootDir();
    const script = await this.resolveOrchestratorScript();
    const args: string[] = [
      script,
      "revise-plan",
      "--session", sessionId,
      "--root", root,
      "--message", message,
    ];

    this.activePlanRevisions.add(sessionId);
    try {
      return await new Promise((resolve) => {
        const child = spawn(this.config.nodeBinary, args, { cwd: root, env: process.env });
        let stdout = "";
        let settled = false;
        const finish = (exitCode: number | null, output: string) => {
          if (settled) return;
          settled = true;
          resolve({ exitCode, stdout: output });
        };
        child.stdout.on("data", (c: Buffer) => { stdout += c.toString(); });
        child.stderr.on("data", (_c: Buffer) => { /* core reports the failure through its exit code */ });
        child.on("error", (err) => finish(-1, err.message));
        child.on("exit", (code) => finish(code, stdout));
      });
    } finally {
      this.activePlanRevisions.delete(sessionId);
    }
  }

  onLog(sessionId: string, listener: (entry: LogEntry) => void): void {
    this.logListeners.set(sessionId, listener);
  }

  onExit(sessionId: string, listener: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.exitListeners.set(sessionId, listener);
  }

  removeLogListener(sessionId: string): void {
    this.logListeners.delete(sessionId);
  }

  removeExitListener(sessionId: string): void {
    this.exitListeners.delete(sessionId);
  }

  private emitLog(sessionId: string, entry: LogEntry): void {
    const listener = this.logListeners.get(sessionId);
    if (listener) {
      listener(entry);
    }
  }

  dispose(): void {
    this.recoveryWakeup = null;
    for (const sessionId of this.externalTails.keys()) {
      this.stopFollowingExternalSession(sessionId);
    }
    this.logListeners.clear();
    this.exitListeners.clear();
  }
}
