import { ChildProcess, execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { AccessMode, ExtensionConfig, ModelMapping, ProviderMapping, VariantMapping, readExtensionConfig } from "./types";
import { StateStore, getGlobalContext } from "./stateStore";
import { decideRecoveryAction, processLiveness, shouldGracefullyStop } from "./resilience";
import {
  launchTrusted,
  requireWorkspaceTrust,
  WorkspaceProcessLaunch,
} from "./workspaceExecutionPolicy";
import { assertPathOutsideBases } from "./pathSafety";
import { validateCoreHandshake } from "./coreProtocol";

export interface NewSessionOptions {
  goal: string;
  targetProjectPath: string;
  accessMode: AccessMode;
  modelMapping: Partial<ModelMapping>;
  providerMapping?: Partial<ProviderMapping>;
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
  private recoveryCancellations = new Set<string>();
  private activePlanRevisions = new Set<string>();
  private startingSessions = new Set<string>();
  private auxiliaryProcesses = new Set<ChildProcess>();
  private compatibleCoreKeys = new Set<string>();

  constructor(
    private config: ExtensionConfig,
    private readonly store: StateStore
  ) {}

  updateConfig(config: ExtensionConfig): void {
    this.config = config;
  }

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
    const extensionContext = getGlobalContext();
    if (extensionContext) {
      candidates.push(
        path.join(extensionContext.extensionUri.fsPath, "core", "dist", "loop_orchestrator.js")
      );
    }
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
          "provider_runtime.ts",
          path.join("src", "application", "workflow-runner.ts"),
          path.join("src", "application", "agent-task-runner.ts"),
          path.join("src", "interfaces", "cli", "main.ts"),
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
      `Orchestrator script not found. Looked for:\n  ${missing}\n` +
      `Set "Agent Loop: Orchestrator Script" to the compiled loop_orchestrator.js path, ` +
      `or reinstall the extension so its bundled core is available.`
    );
  }

  private liveConfig(): ExtensionConfig {
    return readExtensionConfig();
  }

  private async coreProcessEnvironment(): Promise<NodeJS.ProcessEnv> {
    return {
      ...process.env,
      ...await this.store.buildCoreSecretEnvironment(),
    };
  }

  private assertWorkspaceTrusted(action: string): void {
    requireWorkspaceTrust(vscode.workspace.isTrusted, action);
  }

  private async assertCoreCompatible(script: string, dataRoot: string): Promise<void> {
    const cacheKey = `${script}\0${dataRoot}`;
    if (this.compatibleCoreKeys.has(cacheKey)) return;
    this.assertWorkspaceTrusted("check core compatibility");
    const args = [
      script,
      "capabilities",
      "--data-root",
      dataRoot,
      "--config-root",
      dataRoot,
    ];
    const output = await new Promise<string>((resolve, reject) => {
      const child = launchTrusted(vscode.workspace.isTrusted, "discoverModels", () =>
        spawn(this.config.nodeBinary, args, {
          cwd: dataRoot,
          env: process.env,
        })
      );
      this.auxiliaryProcesses.add(child);
      let stdout = "";
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        this.auxiliaryProcesses.delete(child);
        reject(new Error("Timed out while checking Agent Loop core compatibility."));
      }, 10_000);
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.auxiliaryProcesses.delete(child);
        if (error) reject(error);
        else resolve(stdout.trim());
      };
      child.stdout.on("data", (chunk: Buffer) => {
        stdout = (stdout + chunk.toString()).slice(-64 * 1024);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-8 * 1024);
      });
      child.once("error", (error) => finish(error));
      child.once("close", (code) => {
        finish(
          code === 0
            ? undefined
            : new Error(
                `Agent Loop core compatibility check failed (${String(code)}): ${stderr.trim()}`
              )
        );
      });
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(output);
    } catch {
      throw new Error("Agent Loop core returned malformed capability JSON.");
    }
    validateCoreHandshake(parsed);
    this.compatibleCoreKeys.add(cacheKey);
  }

  private async assertIsolatedDataRoot(root: string, targetProjectPath?: string): Promise<void> {
    const protectedBases = [
      ...(vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
      ...(targetProjectPath?.trim() ? [targetProjectPath] : []),
    ];
    try {
      await assertPathOutsideBases(root, protectedBases, "Agent Loop data root");
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`${reason} Clear "agentLoop.rootDir" to use VS Code global storage.`);
    }
  }

  async discoverModels(): Promise<{ models: string[]; exitCode: number | null; stderr: string; command: string }> {
    this.assertWorkspaceTrusted("discover models");
    const root = await this.store.getRootDir();
    await this.assertIsolatedDataRoot(root);
    let script: string;
    try {
      script = await this.resolveOrchestratorScript();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(msg);
      return { models: [], exitCode: -1, stderr: msg, command: "" };
    }
    await this.assertCoreCompatible(script, root);
    const args = ["models", "--data-root", root, "--config-root", root];
    const cmdStr = `${this.config.nodeBinary} ${script} ${args.join(" ")}`;
    return new Promise<{ models: string[]; exitCode: number | null; stderr: string; command: string }>((resolve) => {
      const child = launchTrusted(vscode.workspace.isTrusted, "discoverModels", () =>
        spawn(this.config.nodeBinary, [script, ...args], {
          cwd: root,
          env: process.env,
        })
      );
      this.auxiliaryProcesses.add(child);
      let stderr = "";
      let settled = false;
      const finish = (exitCode: number | null, message = stderr): void => {
        if (settled) return;
        settled = true;
        this.auxiliaryProcesses.delete(child);
        resolve({ models: [], exitCode, stderr: message.slice(0, 2000), command: cmdStr });
      };
      child.stdout.on("data", (_chunk: Buffer) => {
        // Intentionally not parsing stdout here. The orchestrator writes discovered models
        // to sessions_registry.json. The caller should re-read the registry after this resolves.
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.once("error", (err) => {
        vscode.window.showErrorMessage(`Failed to run model discovery: ${err.message}`);
        finish(-1, err.message);
      });
      child.once("exit", (code) => finish(code));
      child.once("close", (code) => finish(code));
    });
  }

  async startNewSession(opts: NewSessionOptions): Promise<string> {
    this.assertWorkspaceTrusted("start a session");
    const sessionId = generateSessionId();
    const root = await this.store.getRootDir();
    await this.assertIsolatedDataRoot(root, opts.targetProjectPath);
    const script = await this.resolveOrchestratorScript();
    await this.assertCoreCompatible(script, root);
    const cfg = this.liveConfig();

    const args: string[] = [
      script,
      "run",
      "--goal", opts.goal,
      "--target", opts.targetProjectPath,
      "--binary", cfg.cliBinary,
      "--profile", cfg.cliProfile,
      "--data-root", root,
      "--config-root", root,
      "--session", sessionId,
      "--max-cycles", String(cfg.maxCycles),
      "--phase-timeout", String(cfg.phaseTimeoutMs),
      "--idle-timeout", String(cfg.idleTimeoutMs),
      "--tool-timeout", String(cfg.toolTimeoutMs),
      "--transport-timeout", String(cfg.transportTimeoutMs),
      "--max-agent-attempts", String(cfg.maxAgentAttempts),
      "--retry-backoff", cfg.retryBackoffMs.join(","),
      "--termination-grace", String(cfg.terminationGraceMs),
      "--kill-timeout", String(cfg.killTimeoutMs),
      "--heartbeat-interval", String(cfg.heartbeatIntervalMs),
      "--lease-ttl", String(cfg.leaseTtlMs),
      "--max-output-bytes", String(cfg.maxInMemoryOutputBytes),
    ];
    if (opts.accessMode === "full_access") args.push("--full-access");

    args.push("--model-mapping", JSON.stringify(opts.modelMapping));
    args.push("--provider-mapping", JSON.stringify(opts.providerMapping ?? {}));

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

    const env = await this.coreProcessEnvironment();
    await this.spawnSession(args, root, sessionId, env, "newSession");
    void this.store.syncRegistrySessionStatus(sessionId, "RUNNING").catch((err) => {
      console.error(`[LoopClient] Failed to synchronize session ${sessionId}:`, err);
    });
    return sessionId;
  }

  async resumeSession(
    sessionId: string,
    recovery = false,
    accessDecision?: "allow_requested" | "full_access"
  ): Promise<string> {
    this.assertWorkspaceTrusted(recovery ? "recover a session" : "resume a session");
    if (recovery && this.recoveryCancellations.has(sessionId)) return sessionId;
    if (!recovery) this.recoveryCancellations.delete(sessionId);
    if (this.startingSessions.has(sessionId)) {
      throw new Error(`Session ${sessionId} is already starting.`);
    }
    this.startingSessions.add(sessionId);
    try {
      const runtime = await this.store.inspectLease(sessionId);
      const activeChild = this.activeProcesses.get(sessionId);
      if (
        (activeChild !== undefined && activeChild.exitCode === null && activeChild.signalCode === null) ||
        runtime.disposition === "active" ||
        runtime.disposition === "expired_owner_alive" ||
        runtime.disposition === "unverifiable"
      ) {
        throw new Error(`Session ${sessionId} is already running.`);
      }
      const root = await this.store.getRootDir();
      const state = await this.store.readState(sessionId);
      await this.assertIsolatedDataRoot(root, state?.targetProjectPath);
      const script = await this.resolveOrchestratorScript();
      await this.assertCoreCompatible(script, root);

      const args: string[] = [
        script,
        "resume",
        "--session", sessionId,
        "--data-root", root,
        "--config-root", root,
      ];
      if (recovery) args.push("--recovery");
      if (!recovery) {
        const cfg = this.liveConfig();
        args.push(
        "--max-cycles", String(cfg.maxCycles),
        "--phase-timeout", String(cfg.phaseTimeoutMs),
        "--idle-timeout", String(cfg.idleTimeoutMs),
        "--tool-timeout", String(cfg.toolTimeoutMs),
        "--transport-timeout", String(cfg.transportTimeoutMs),
        "--max-agent-attempts", String(cfg.maxAgentAttempts),
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

      const env = await this.coreProcessEnvironment();
      if (recovery && this.recoveryCancellations.has(sessionId)) return sessionId;
      if (recovery) {
        // Recovery decisions are advisory snapshots. Revalidate immediately
        // before spawning so a completed external STOP (or a new owner) cannot
        // be resurrected by a stale monitor pass.
        const [latestState, latestRuntime] = await Promise.all([
          this.store.readState(sessionId),
          this.store.inspectLease(sessionId),
        ]);
        const action = latestState
          ? decideRecoveryAction(
              latestState.status,
              latestState.stateVersion,
              latestRuntime.disposition,
              this.isRunning(sessionId)
            )
          : "ignore";
        if (
          action !== "recover" ||
          !["missing", "recoverable"].includes(latestRuntime.disposition)
        ) {
          return sessionId;
        }
      }
      await this.spawnSession(
        args,
        root,
        sessionId,
        env,
        recovery ? "recoverSession" : "resumeSession"
      );
      void this.store.syncRegistrySessionStatus(sessionId, "RUNNING").catch((err) => {
        console.error(`[LoopClient] Failed to synchronize session ${sessionId}:`, err);
      });
      return sessionId;
    } finally {
      this.startingSessions.delete(sessionId);
    }
  }

  async interruptSession(sessionId: string, message: string): Promise<void> {
    await this.invokeCoreCommand(
      "controlSession",
      "interrupt",
      sessionId,
      ["--message", message]
    );
  }

  private spawnSession(
    args: string[],
    cwd: string,
    sessionId: string,
    env: NodeJS.ProcessEnv,
    launchKind: WorkspaceProcessLaunch
  ): Promise<string> {
    this.assertWorkspaceTrusted("spawn an orchestrator process");
    const child = launchTrusted(vscode.workspace.isTrusted, launchKind, () =>
      spawn(this.config.nodeBinary, args, {
        cwd,
        env,
        detached: process.platform !== "win32",
      })
    );

    this.activeProcesses.set(sessionId, child);

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      this.emitLog(sessionId, { timestamp: new Date().toISOString(), stream: "stdout", text });
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      this.emitLog(sessionId, { timestamp: new Date().toISOString(), stream: "stderr", text });
    });

    return new Promise<string>((resolve, reject) => {
      let startupSettled = false;
      let finalized = false;
      const finalize = (
        code: number | null,
        signal: NodeJS.Signals | null,
        error?: Error
      ): void => {
        if (finalized) return;
        finalized = true;
        if (this.activeProcesses.get(sessionId) === child) {
          this.activeProcesses.delete(sessionId);
        }
        this.stopFollowingExternalSession(sessionId);
        const listener = this.exitListeners.get(sessionId);
        this.exitListeners.delete(sessionId);
        try {
          listener?.(code, signal);
        } catch (err) {
          console.error(`[LoopClient] Exit listener failed for ${sessionId}:`, err);
        }
        this.emitLog(sessionId, {
          timestamp: new Date().toISOString(),
          stream: "stderr",
          text: error
            ? `\n[process error] ${error.message}\n`
            : `\n[process exited] code=${code ?? "null"} signal=${signal ?? "null"}\n`,
        });
        if (!startupSettled) {
          startupSettled = true;
          reject(error ?? new Error(`Agent loop process exited before startup (code=${code ?? "null"}).`));
        }
        this.recoveryWakeup?.();
      };

      child.once("spawn", () => {
        if (startupSettled) return;
        startupSettled = true;
        resolve(sessionId);
      });
      child.once("error", (err) => finalize(null, null, err));
      child.once("exit", (code, signal) => finalize(code, signal));
      child.once("close", (code, signal) => finalize(code, signal));
    });
  }

  async stopSession(sessionId: string): Promise<boolean> {
    this.recoveryCancellations.add(sessionId);
    await this.invokeCoreCommand("controlSession", "stop", sessionId);
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      const state = await this.store.readState(sessionId);
      if (!state || ["STOPPED", "BLOCKED", "SUCCESS"].includes(state.status)) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  }

  async prepareSessionDeletion(
    sessionId: string
  ): Promise<{ safe: boolean; reason: string | null }> {
    this.recoveryCancellations.add(sessionId);
    this.stopFollowingExternalSession(sessionId);
    let state = await this.store.readState(sessionId);
    let runtime = await this.store.inspectLease(sessionId);
    const ownerMayBeRunning = [
      "active",
      "expired_owner_alive",
      "unverifiable",
    ].includes(runtime.disposition);
    if (
      this.isRunning(sessionId) ||
      state?.status === "RUNNING" ||
      ownerMayBeRunning
    ) {
      await this.stopSession(sessionId);
    }

    const deadline = Date.now() + 8_000;
    do {
      state = await this.store.readState(sessionId);
      runtime = await this.store.inspectLease(sessionId);
      const activeChildPid = state?.activeAttempt &&
        ["starting", "running", "retry_wait"].includes(state.activeAttempt.status)
        ? state.activeAttempt.childPid
        : null;
      const childLiveness = processLiveness(activeChildPid);
      const ownershipSafe = runtime.disposition === "missing" || runtime.disposition === "recoverable";
      if (ownershipSafe && childLiveness === "dead" && state?.status !== "RUNNING") {
        return { safe: true, reason: null };
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < deadline);

    return {
      safe: false,
      reason:
        `Session ownership or a child process is still live/unverifiable ` +
        `(status=${state?.status ?? "missing"}, lease=${runtime.disposition}).`,
    };
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

  isRunning(sessionId: string): boolean {
    const child = this.activeProcesses.get(sessionId);
    return this.startingSessions.has(sessionId) ||
      (!!child && child.exitCode === null && child.signalCode === null);
  }

  getActiveSessionIds(): string[] {
    return Array.from(new Set([...this.activeProcesses.keys(), ...this.startingSessions]));
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
        const configuredLogPath = state.activeAttempt?.outputLogPath ?? null;
        if (!configuredLogPath) return;
        if (!this.logListeners.has(sessionId)) return;
        const logPath = await this.store.resolveSessionRuntimePath(
          sessionId,
          configuredLogPath,
          "Attempt output log"
        );
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
      })().catch((err) => {
        this.emitLog(sessionId, {
          timestamp: new Date().toISOString(),
          stream: "stderr",
          text: `\n[log tail stopped] ${err instanceof Error ? err.message : String(err)}\n`,
        });
        this.stopFollowingExternalSession(sessionId);
      }).finally(() => {
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
    this.assertWorkspaceTrusted("revise a plan");
    if (this.activePlanRevisions.has(sessionId)) {
      throw new Error(`A plan revision is already running for session ${sessionId}.`);
    }
    const root = await this.store.getRootDir();
    const script = await this.resolveOrchestratorScript();
    await this.assertCoreCompatible(script, root);
    const args: string[] = [
      script,
      "revise-plan",
      "--session", sessionId,
      "--data-root", root,
      "--config-root", root,
      "--message", message,
    ];

    this.activePlanRevisions.add(sessionId);
    try {
      const env = await this.coreProcessEnvironment();
      return await new Promise((resolve) => {
        const child = launchTrusted(vscode.workspace.isTrusted, "revisePlan", () =>
          spawn(this.config.nodeBinary, args, { cwd: root, env })
        );
        this.auxiliaryProcesses.add(child);
        let stdout = "";
        let settled = false;
        const finish = (exitCode: number | null, output: string) => {
          if (settled) return;
          settled = true;
          this.auxiliaryProcesses.delete(child);
          resolve({ exitCode, stdout: output });
        };
        child.stdout.on("data", (c: Buffer) => {
          stdout = (stdout + c.toString()).slice(-this.liveConfig().maxInMemoryOutputBytes);
        });
        child.stderr.on("data", (_c: Buffer) => { /* core reports the failure through its exit code */ });
        child.once("error", (err) => finish(-1, err.message));
        child.once("exit", (code) => finish(code, stdout));
        child.once("close", (code) => finish(code, stdout));
      });
    } finally {
      this.activePlanRevisions.delete(sessionId);
    }
  }

  async approvePlan(sessionId: string, choiceId: string): Promise<void> {
    await this.invokeCoreCommand(
      "approvePlan",
      "approve-plan",
      sessionId,
      ["--choice-id", choiceId]
    );
  }

  async setAccessMode(sessionId: string, accessMode: "ask" | "full_access"): Promise<void> {
    await this.invokeCoreCommand(
      "controlSession",
      "set-access",
      sessionId,
      ["--mode", accessMode]
    );
  }

  private async invokeCoreCommand(
    launchKind: WorkspaceProcessLaunch,
    command: string,
    sessionId: string,
    extraArgs: string[] = []
  ): Promise<string> {
    this.assertWorkspaceTrusted(`${command} a session`);
    const root = await this.store.getRootDir();
    const script = await this.resolveOrchestratorScript();
    await this.assertCoreCompatible(script, root);
    const env = await this.coreProcessEnvironment();
    return new Promise<string>((resolve, reject) => {
      const child = launchTrusted(vscode.workspace.isTrusted, launchKind, () =>
        execFile(
          this.config.nodeBinary,
          [
            script,
            command,
            "--session",
            sessionId,
            "--data-root",
            root,
            "--config-root",
            root,
            ...extraArgs,
          ],
          { cwd: root, env },
          (error, stdout, stderr) => {
            this.auxiliaryProcesses.delete(child);
            if (error) {
              reject(new Error(stderr.trim() || error.message));
              return;
            }
            resolve(stdout.trim());
          }
        )
      );
      this.auxiliaryProcesses.add(child);
      child.once("error", () => this.auxiliaryProcesses.delete(child));
    });
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
    for (const child of this.auxiliaryProcesses) {
      child.kill();
    }
    this.auxiliaryProcesses.clear();
    this.startingSessions.clear();
    this.logListeners.clear();
    this.exitListeners.clear();
  }
}
