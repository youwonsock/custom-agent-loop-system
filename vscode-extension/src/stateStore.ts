import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import * as vscode from "vscode";
import {
  ExtensionConfig,
  LoopState,
  LoopStatus,
  SessionBundle,
  SessionRegistry,
  LoopHistoryEntry,
  FinalSummary,
  SessionMeta,
  AgentRole,
  readExtensionConfig,
  loadLoopPathsConfig,
  LoopPathsConfig,
  ControlRequest,
  ControlAck,
  PlanChoice,
  SystemSettings,
  ProviderConfig,
  ToolAccessConfig,
  PipelineDefinition,
  PipelineCompletionContract,
  PipelineRole,
  PipelineStageExecutor,
  PipelineStageType,
  AgentRolesDefinition,
  AgentLoopDefinition,
} from "./types";
import {
  LeaseDisposition,
  SessionLease,
  SessionOwnerLock,
  assessSessionDeletionSafety,
  evaluateOwnership,
  processLiveness,
} from "./resilience";
import { validatePipeline } from "./generated_pipeline";
import generatedAgentRoles from "./generated_agent_roles.json";
import generatedAgentLoop from "./generated_agent_loop.json";

let globalContext: vscode.ExtensionContext | undefined;
const SECRET_REFERENCE = /^\$\{secret:([^}]+)\}$/;
const ENV_REFERENCE = /^\$\{env:[A-Za-z_][A-Za-z0-9_]*\}$/;
export const CORE_SECRET_VALUES_ENV = "AGENT_LOOP_SECRET_VALUES";

const STAGE_EXECUTORS: PipelineStageExecutor[] = [
  "planning", "implementation", "test", "review", "approval", "interrupt",
];

function completionContractForExecutor(executor: PipelineStageExecutor): PipelineCompletionContract {
  if (executor === "planning") return "plan_options";
  if (executor === "test") return "verdict";
  if (executor === "review" || executor === "approval") return "approval";
  return "phase_done";
}

function defaultStageTypes(): PipelineStageType[] {
  return STAGE_EXECUTORS.map((executor) => ({
    id: executor,
    label: executor.charAt(0).toUpperCase() + executor.slice(1),
    executor,
    completionContract: completionContractForExecutor(executor),
    description: `Built-in ${executor} stage behavior.`,
  }));
}

function fixedPipelineDefinition(existing?: PipelineDefinition | null): PipelineDefinition {
  const canonicalRoles = generatedAgentRoles as AgentRolesDefinition;
  const canonicalLoop = generatedAgentLoop as AgentLoopDefinition;
  const existingRoles = new Map((existing?.roles ?? []).map((role) => [role.id, role]));
  const role = (
    id: string,
    modelRole: PipelineRole["modelRole"],
    description: string,
    instructions: string
  ): PipelineRole => {
    const previous = existingRoles.get(id);
    return {
      id,
      modelRole,
      description,
      instructions,
      ...(previous?.provider ? { provider: previous.provider } : {}),
      ...(previous?.model ? { model: previous.model } : {}),
      ...(previous?.variant ? { variant: previous.variant } : {}),
    };
  };
  return {
    version: 1,
    name: canonicalLoop.name,
    startStageId: canonicalLoop.startStageId,
    interruptStageId: canonicalLoop.interruptStageId,
    reentryStageId: canonicalLoop.reentryStageId,
    iterationCompletionStageId: canonicalLoop.iterationCompletionStageId,
    stageTypes: canonicalLoop.stageTypes ?? defaultStageTypes(),
    roles: canonicalRoles.roles.map((candidate) => role(
      candidate.id,
      candidate.modelRole,
      candidate.description,
      candidate.instructions
    )),
    stages: canonicalLoop.stages,
  };
}

function combinePipelineDefinitions(
  rolesDefinition?: AgentRolesDefinition | null,
  loopDefinition?: AgentLoopDefinition | null
): PipelineDefinition {
  const defaults = fixedPipelineDefinition();
  return {
    version: 1,
    name: loopDefinition?.name ?? defaults.name,
    startStageId: loopDefinition?.startStageId ?? defaults.startStageId,
    interruptStageId: loopDefinition?.interruptStageId ?? defaults.interruptStageId,
    reentryStageId: loopDefinition?.reentryStageId ?? defaults.reentryStageId,
    iterationCompletionStageId:
      loopDefinition?.iterationCompletionStageId ?? defaults.iterationCompletionStageId,
    stageTypes: loopDefinition?.stageTypes ?? defaults.stageTypes,
    roles: rolesDefinition?.roles ?? defaults.roles,
    stages: loopDefinition?.stages ?? defaults.stages,
  };
}

function assertSafeSessionId(sessionId: string): void {
  if (
    !sessionId ||
    sessionId === "." ||
    sessionId === ".." ||
    sessionId.includes("/") ||
    sessionId.includes("\\") ||
    sessionId.includes("\0")
  ) {
    throw new Error(`Unsafe session ID: ${JSON.stringify(sessionId)}`);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function emptySessionRegistry(): SessionRegistry {
  return {
    version: 1,
    activeSessionIds: [],
    availableModels: [],
    modelsDiscoveredAt: null,
    modelsDiscoveredCli: null,
    sessionMetas: [],
    manualModelsOverride: null,
    modelVariants: null,
  };
}

function mcpSecretStorageKey(
  serverId: string,
  scope: "environment" | "headers",
  fieldName: string
): string {
  const digest = createHash("sha256").update(fieldName).digest("hex").slice(0, 24);
  return `agentLoop.mcp.${serverId}.${scope}.${digest}`;
}

function secretReferences(toolAccess?: ToolAccessConfig): Set<string> {
  const references = new Set<string>();
  for (const server of toolAccess?.mcpServers ?? []) {
    for (const values of [server.environment, server.headers]) {
      for (const value of Object.values(values ?? {})) {
        const match = value.match(SECRET_REFERENCE);
        if (match) references.add(match[1]);
      }
    }
  }
  return references;
}

function hasLiteralMcpCredentials(toolAccess?: ToolAccessConfig): boolean {
  for (const server of toolAccess?.mcpServers ?? []) {
    for (const values of [server.environment, server.headers]) {
      for (const value of Object.values(values ?? {})) {
        if (!SECRET_REFERENCE.test(value) && !ENV_REFERENCE.test(value)) return true;
      }
    }
  }
  return false;
}

export class StateStore {
  private registryCache: SessionRegistry | null = null;
  private stateCache: Map<string, LoopState> = new Map();
  private pollTimer: NodeJS.Timeout | null = null;
  private listeners: Array<() => void> = [];
  private pathsCache: LoopPathsConfig | null = null;

  constructor(private config: ExtensionConfig) {}

  updateConfig(config: ExtensionConfig): void {
    this.config = config;
    this.pathsCache = null;
    this.registryCache = null;
    this.stateCache.clear();
    this.notifyListeners();
  }

  async getPathsConfig(): Promise<LoopPathsConfig> {
    if (this.pathsCache) return this.pathsCache;
    const root = await this.getRootDir();
    this.pathsCache = await loadLoopPathsConfig(root);
    return this.pathsCache;
  }

  async getRootDir(): Promise<string> {
    const liveRootDir = readExtensionConfig().rootDir;
    if (liveRootDir && liveRootDir.length > 0) {
      return path.resolve(liveRootDir);
    }
    if (this.config.rootDir && this.config.rootDir.length > 0) {
      return path.resolve(this.config.rootDir);
    }
    const envRoot = process.env.AGENT_LOOP_ROOT;
    if (envRoot && envRoot.length > 0) {
      const resolved = path.resolve(envRoot);
      try {
        await fs.access(path.join(resolved, "dist", "loop_orchestrator.js"));
        await this.cacheDetectedRoot(resolved);
        return resolved;
      } catch {
        // env var stale, continue
      }
    }
    if (globalContext) {
      const storagePath = globalContext.globalStorageUri.fsPath;
      await fs.mkdir(storagePath, { recursive: true });
      return storagePath;
    }
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const distScript = path.join(folder.uri.fsPath, "dist", "loop_orchestrator.js");
      const registry = path.join(folder.uri.fsPath, "sessions_registry.json");
      try {
        await fs.access(distScript);
        await this.cacheDetectedRoot(folder.uri.fsPath);
        return folder.uri.fsPath;
      } catch {
        // not here
      }
      try {
        await fs.access(registry);
        await this.cacheDetectedRoot(folder.uri.fsPath);
        return folder.uri.fsPath;
      } catch {
        // not here
      }
    }
    const defaultDir = path.join(os.homedir(), ".agent-loop");
    await fs.mkdir(defaultDir, { recursive: true });
    return defaultDir;
  }

  private async cacheDetectedRoot(root: string): Promise<void> {
    if (globalContext) {
      try {
        await globalContext.globalState.update("agentLoop.detectedRoot", root);
      } catch {
        // ignore persistence failure
      }
    }
  }

  getRegistryPath = async (): Promise<string> => {
    const root = await this.getRootDir();
    const cfg = await this.getPathsConfig();
    return path.join(root, cfg.registryFileName);
  };

  getSessionDir = async (sessionId: string): Promise<string> => {
    assertSafeSessionId(sessionId);
    const root = await this.getRootDir();
    const cfg = await this.getPathsConfig();
    const sessionsRoot = path.resolve(root, cfg.sessionsRoot);
    const resolved = path.resolve(sessionsRoot, sessionId);
    const relative = path.relative(sessionsRoot, resolved);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Session path escapes sessions root: ${sessionId}`);
    }
    return resolved;
  };

  getPlanChoicesPath = async (sessionId: string): Promise<string> => {
    const dir = await this.getSessionDir(sessionId);
    const cfg = await this.getPathsConfig();
    return path.join(dir, cfg.sessionFileNames.planChoices);
  };

  getPlanMdPath = async (sessionId: string): Promise<string> => {
    const dir = await this.getSessionDir(sessionId);
    const cfg = await this.getPathsConfig();
    return path.join(dir, cfg.sessionFileNames.plan);
  };

  getPlanOverviewPath = async (sessionId: string): Promise<string> => {
    const sessionDir = await this.getSessionDir(sessionId);
    const cfg = await this.getPathsConfig();
    const state = await this.readState(sessionId);
    return this.resolveContainedSessionFile(
      sessionDir,
      state?.planOverviewPath || cfg.sessionFileNames.planOverview
    );
  };

  getPlanChoiceMarkdownPath = async (
    sessionId: string,
    choice: PlanChoice
  ): Promise<string> => {
    const sessionDir = await this.getSessionDir(sessionId);
    const cfg = await this.getPathsConfig();
    const configured =
      choice.markdownPath ??
      path.join(cfg.sessionFileNames.planOptionsDir, `option_${choice.id}.md`);
    return this.resolveContainedSessionFile(sessionDir, configured);
  };

  async readPlanChoices(sessionId: string): Promise<PlanChoice[] | null> {
    const p = await this.getPlanChoicesPath(sessionId);
    try {
      const raw = await fs.readFile(p, "utf8");
      return JSON.parse(raw) as PlanChoice[];
    } catch {
      return null;
    }
  }

  async readPlanMd(sessionId: string): Promise<string | null> {
    const p = await this.getPlanMdPath(sessionId);
    try {
      return await fs.readFile(p, "utf8");
    } catch {
      return null;
    }
  }

  async readSystemSettings(): Promise<SystemSettings> {
    const root = await this.getRootDir();
    return this.withFileLock(path.join(root, "settings_write.lock"), () => this.readSystemSettingsLocked(root));
  }

  private async readSystemSettingsLocked(root: string): Promise<SystemSettings> {
    const loopConfigPath = path.join(root, "loop_config.json");
    const rolesPath = path.join(root, "agent_roles.json");
    const agentLoopPath = path.join(root, "agent_loop.json");
    const loopConfig = await this.readJsonAtomic<{
      providers?: Record<string, ProviderConfig>;
      toolAccess?: ToolAccessConfig;
    }>(loopConfigPath) ?? {};
    if (globalContext && loopConfig.toolAccess && hasLiteralMcpCredentials(loopConfig.toolAccess)) {
      loopConfig.toolAccess = await this.protectMcpCredentials(loopConfig.toolAccess);
      await this.writeJsonAtomic(loopConfigPath, loopConfig);
    }
    const fallbackProviders: Record<string, ProviderConfig> = {
      opencode: { label: "OpenCode", adapter: "opencode", binary: "opencode", enabled: true, modelsArgs: ["models"], fallbackModels: ["opencode/big-pickle"] },
      kilo: { label: "Kilo Code", adapter: "kilo", binary: "kilo", enabled: true, modelsArgs: ["models", "--pure"], fallbackModels: ["anthropic/claude-sonnet-4-5"] },
      codex: { label: "OpenAI GPT / Codex", adapter: "codex", binary: "codex", enabled: true, modelsArgs: [], fallbackModels: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"] },
      claude: { label: "Anthropic Claude Code", adapter: "claude", binary: "claude", enabled: true, modelsArgs: [], fallbackModels: ["sonnet", "opus"] },
    };
    const storedRoles = await this.readJsonAtomic<AgentRolesDefinition>(rolesPath);
    const storedLoop = await this.readJsonAtomic<AgentLoopDefinition>(agentLoopPath);
    if (storedRoles && storedRoles.version !== 1) {
      throw new Error("Agent roles version must be 1.");
    }
    if (storedLoop && storedLoop.version !== 1) {
      throw new Error("Agent loop version must be 1.");
    }
    const pipeline = combinePipelineDefinitions(storedRoles, storedLoop);
    this.normalizePipelineStageTypes(pipeline);
    this.stripLegacyRoleToolOverrides(pipeline);
    const settings: SystemSettings = {
      providers: { ...fallbackProviders, ...(loopConfig.providers ?? {}) },
      toolAccess: loopConfig.toolAccess ?? {
        webSearch: { enabled: false, mode: "cached" },
        mcpServers: [],
      },
      pipeline,
    };
    this.validateSystemSettings(settings);
    return settings;
  }

  async saveSystemSettings(settings: SystemSettings): Promise<void> {
    this.normalizePipelineStageTypes(settings.pipeline);
    this.stripLegacyRoleToolOverrides(settings.pipeline);
    this.validateSystemSettings(settings);
    const root = await this.getRootDir();
    const rolesPath = path.join(root, "agent_roles.json");
    const agentLoopPath = path.join(root, "agent_loop.json");
    const loopConfigPath = path.join(root, "loop_config.json");
    const lockPath = path.join(root, "settings_write.lock");
    let removedSecrets = new Set<string>();
    await this.withFileLock(lockPath, async () => {
      const current = await this.readJsonAtomic<Record<string, unknown> & { toolAccess?: ToolAccessConfig }>(loopConfigPath) ?? {};
      const previousSecrets = secretReferences(current.toolAccess);
      const protectedToolAccess = await this.protectMcpCredentials(settings.toolAccess);
      const nextSecrets = secretReferences(protectedToolAccess);
      removedSecrets = new Set([...previousSecrets].filter((key) => !nextSecrets.has(key)));
      current.providers = settings.providers;
      current.toolAccess = protectedToolAccess;
      current.$schema = "./loop_config.schema.json";
      await this.writeJsonAtomic(loopConfigPath, current);
      await this.writeJsonAtomic(rolesPath, {
        $schema: "./agent_roles.schema.json",
        version: 1,
        roles: settings.pipeline.roles,
      });
      const { roles: _roles, ...loop } = settings.pipeline;
      await this.writeJsonAtomic(agentLoopPath, { $schema: "./agent_loop.schema.json", ...loop });
    });
    if (globalContext) {
      await Promise.allSettled([...removedSecrets].map((key) => globalContext!.secrets.delete(key)));
    }
    this.registryCache = null;
    this.notifyListeners();
  }

  /** Build the one-process-only secret bundle consumed and removed by the core at startup. */
  async buildCoreSecretEnvironment(): Promise<Record<string, string>> {
    const settings = await this.readSystemSettings();
    const references = secretReferences(settings.toolAccess);
    if (references.size === 0) return {};
    if (!globalContext) {
      throw new Error("VS Code SecretStorage is unavailable for configured MCP credentials.");
    }
    const values: Record<string, string> = {};
    for (const key of references) {
      const value = await globalContext.secrets.get(key);
      if (value === undefined) {
        throw new Error(`MCP credential '${key}' is missing. Re-enter it in Agent Loop tool settings.`);
      }
      values[key] = value;
    }
    return { [CORE_SECRET_VALUES_ENV]: JSON.stringify(values) };
  }

  private async protectMcpCredentials(toolAccess: ToolAccessConfig): Promise<ToolAccessConfig> {
    const protectMap = async (
      serverId: string,
      scope: "environment" | "headers",
      values: Record<string, string> | undefined
    ): Promise<Record<string, string>> => {
      const protectedValues: Record<string, string> = {};
      for (const [fieldName, value] of Object.entries(values ?? {})) {
        if (SECRET_REFERENCE.test(value) || ENV_REFERENCE.test(value)) {
          protectedValues[fieldName] = value;
          continue;
        }
        if (!globalContext) {
          throw new Error("VS Code SecretStorage is unavailable; MCP credentials cannot be saved safely.");
        }
        const secretKey = mcpSecretStorageKey(serverId, scope, fieldName);
        await globalContext.secrets.store(secretKey, value);
        protectedValues[fieldName] = `\${secret:${secretKey}}`;
      }
      return protectedValues;
    };

    return {
      webSearch: { ...toolAccess.webSearch },
      mcpServers: await Promise.all(toolAccess.mcpServers.map(async (server) => ({
        ...server,
        args: [...(server.args ?? [])],
        allowedTools: [...(server.allowedTools ?? [])],
        environment: await protectMap(server.id, "environment", server.environment),
        headers: await protectMap(server.id, "headers", server.headers),
      }))),
    };
  }

  private validateSystemSettings(settings: SystemSettings): void {
    const safeId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
    const providerIds = Object.keys(settings.providers);
    if (providerIds.length === 0) throw new Error("At least one provider is required.");
    for (const [id, provider] of Object.entries(settings.providers)) {
      if (!safeId.test(id)) throw new Error(`Unsafe provider id: ${id}`);
      if (!provider.binary?.trim()) throw new Error(`Provider ${id} needs a binary.`);
      if (!["opencode", "kilo", "codex", "claude"].includes(provider.adapter)) {
        throw new Error(`Provider ${id} uses an unsupported adapter.`);
      }
    }
    if (!Object.values(settings.providers).some((provider) => provider.enabled)) {
      throw new Error("At least one provider must be enabled.");
    }
    const mcpIds = new Set<string>();
    for (const server of settings.toolAccess.mcpServers) {
      if (!safeId.test(server.id)) throw new Error(`Unsafe MCP server id: ${server.id}`);
      if (mcpIds.has(server.id)) throw new Error(`Duplicate MCP server id: ${server.id}`);
      mcpIds.add(server.id);
      if (!["local", "remote"].includes(server.type)) throw new Error(`Invalid MCP transport: ${server.type}`);
      for (const field of ["headers", "environment"] as const) {
        const values = server[field];
        if (values !== undefined && (!values || typeof values !== "object" || Array.isArray(values) || Object.values(values).some((value) => typeof value !== "string"))) {
          throw new Error(`MCP server ${server.id} ${field} must be a JSON object with string values.`);
        }
      }
      if (server.type === "local" && !server.command?.trim()) {
        throw new Error(`Local MCP server ${server.id} needs a command.`);
      }
      if (server.type === "remote" && !/^https?:\/\//i.test(server.url ?? "")) {
        throw new Error(`Remote MCP server ${server.id} needs an http(s) URL.`);
      }
      if (server.timeoutMs !== undefined && (!Number.isFinite(server.timeoutMs) || server.timeoutMs <= 0)) {
        throw new Error(`MCP server ${server.id} timeout must be positive.`);
      }
    }
    validatePipeline(settings.pipeline);
    for (const role of settings.pipeline.roles) {
      if (role.provider && !settings.providers[role.provider]?.enabled) {
        throw new Error(`Role ${role.id} references a missing or disabled provider ${role.provider}.`);
      }
    }
  }

  private normalizePipelineStageTypes(pipeline: PipelineDefinition): void {
    const legacy = pipeline as PipelineDefinition & { stageTypes?: PipelineStageType[] };
    if (!Array.isArray(legacy.stageTypes) || legacy.stageTypes.length === 0) {
      pipeline.stageTypes = defaultStageTypes();
    }
  }

  private stripLegacyRoleToolOverrides(pipeline: PipelineDefinition): void {
    for (const role of pipeline.roles) {
      const legacy = role as typeof role & { webSearch?: boolean; mcpServers?: string[] };
      delete legacy.webSearch;
      delete legacy.mcpServers;
    }
  }

  async selectPlanChoice(
    sessionId: string,
    choiceId: number
  ): Promise<{ choice: PlanChoice; markdownPath: string }> {
    const choices = await this.readPlanChoices(sessionId);
    const choice = choices?.find((candidate) => candidate.id === choiceId);
    if (!choice) throw new Error(`Plan option ${choiceId} was not found.`);
    const planPath = await this.getPlanMdPath(sessionId);
    await this.writeTextAtomic(planPath, `${choice.body.trim()}\n`);
    await this.updateState(sessionId, (state) => {
      state.planPath = planPath;
      state.selectedPlanChoiceId = choice.id;
      state.planApproved = false;
    });
    return {
      choice,
      markdownPath: await this.getPlanChoiceMarkdownPath(sessionId, choice),
    };
  }

  async clearPlanChoice(sessionId: string): Promise<void> {
    const planPath = await this.getPlanMdPath(sessionId);
    await fs.rm(planPath, { force: true });
    await this.updateState(sessionId, (state) => {
      state.selectedPlanChoiceId = null;
      state.planApproved = false;
    });
  }

  async updateState(
    sessionId: string,
    mutate: (state: LoopState) => void
  ): Promise<LoopState> {
    const cfg = await this.getPathsConfig();
    const sessionDir = await this.getSessionDir(sessionId);
    const statePath = path.join(sessionDir, cfg.sessionFileNames.state);
    const lockPath = path.join(sessionDir, cfg.stateLockFileName);
    const updated = await this.withFileLock(lockPath, async () => {
      const state = await this.readJsonAtomic<LoopState>(statePath);
      if (!state) throw new Error(`Session state not found: ${sessionId}`);
      mutate(state);
      state.updatedAt = new Date().toISOString();
      await this.writeJsonAtomic(statePath, state);
      return state;
    });
    this.stateCache.set(sessionId, updated);
    this.notifyListeners();
    return updated;
  }

  async updateAccessMode(
    sessionId: string,
    accessMode: "ask" | "full_access"
  ): Promise<LoopState> {
    return this.updateState(sessionId, (state) => {
      if (["RUNNING", "SUCCESS", "FAILED"].includes(state.status)) {
        throw new Error("Access mode can only be changed while the session is held.");
      }
      state.accessMode = accessMode;
      if (accessMode === "full_access") {
        state.pendingAccessRequest = null;
        if (state.lastFailure?.kind === "permission") state.lastFailure = null;
        state.lastFailureDigest = null;
      }
    });
  }

  async approvePlan(sessionId: string): Promise<LoopState> {
    return this.updateState(sessionId, (state) => {
      if (!state.awaitingPlanApproval) {
        throw new Error(`Session ${sessionId} is not awaiting plan approval.`);
      }
      state.planApproved = true;
    });
  }

  async enqueueControlRequest(
    sessionId: string,
    type: ControlRequest["type"],
    message: string | null = null
  ): Promise<ControlRequest> {
    const cfg = await this.getPathsConfig();
    const sessionDir = await this.getSessionDir(sessionId);
    const requestDir = path.join(sessionDir, cfg.controlDirName, "requests");
    await fs.mkdir(requestDir, { recursive: true });
    const request: ControlRequest = {
      requestId: `control_${Date.now().toString(36)}_${randomBytes(6).toString("hex")}`,
      type,
      createdAt: new Date().toISOString(),
      message: message?.trim() || null,
    };
    await this.writeJsonAtomic(path.join(requestDir, `${request.requestId}.json`), request);
    return request;
  }

  async readControlAck(sessionId: string, requestId: string): Promise<ControlAck | null> {
    const cfg = await this.getPathsConfig();
    const sessionDir = await this.getSessionDir(sessionId);
    return this.readJsonAtomic<ControlAck>(
      path.join(sessionDir, cfg.controlDirName, "acks", `${requestId}.json`)
    );
  }

  async completeQueuedControlRequest(
    sessionId: string,
    request: ControlRequest,
    result: ControlAck["result"],
    message: string
  ): Promise<void> {
    const cfg = await this.getPathsConfig();
    const sessionDir = await this.getSessionDir(sessionId);
    const controlDir = path.join(sessionDir, cfg.controlDirName);
    const ackPath = path.join(controlDir, "acks", `${request.requestId}.json`);
    const existing = await this.readJsonAtomic<ControlAck>(ackPath);
    await this.writeJsonAtomic(ackPath, {
      requestId: request.requestId,
      type: request.type,
      acceptedAt: existing?.acceptedAt ?? new Date().toISOString(),
      completedAt: new Date().toISOString(),
      result,
      message,
    } satisfies ControlAck);
    await Promise.all([
      fs.rm(path.join(controlDir, "requests", `${request.requestId}.json`), { force: true }),
      fs.rm(path.join(controlDir, "processing", `${request.requestId}.json`), { force: true }),
    ]);
  }

  async waitForControlCompletion(
    sessionId: string,
    requestId: string,
    timeoutMs = 8_000
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const [ack, state] = await Promise.all([
        this.readControlAck(sessionId, requestId),
        this.readState(sessionId),
      ]);
      if (
        (state?.status === "STOPPED" || state?.status === "PAUSED") &&
        ack &&
        (ack.result === "completed" || ack.result === "cancelled")
      ) {
        return true;
      }
      await delay(Math.min(100, Math.max(1, deadline - Date.now())));
    }
    return false;
  }

  async inspectLease(
    sessionId: string
  ): Promise<{
    lease: SessionLease | null;
    ownerLock: SessionOwnerLock | null;
    disposition: LeaseDisposition;
  }> {
    const cfg = await this.getPathsConfig();
    const sessionDir = await this.getSessionDir(sessionId);
    const [lease, ownerLock] = await Promise.all([
      this.readJsonAtomic<SessionLease>(
        path.join(sessionDir, cfg.leaseFileName)
      ),
      this.readJsonAtomic<SessionOwnerLock>(
        path.join(sessionDir, cfg.ownerLockFileName)
      ),
    ]);
    const liveness = processLiveness(
      lease?.ownerPid ?? ownerLock?.ownerPid
    );
    return {
      lease,
      ownerLock,
      disposition: evaluateOwnership(
        lease,
        ownerLock,
        Date.now(),
        this.config.leaseTtlMs,
        liveness
      ),
    };
  }

  async pauseLegacyRunningSession(sessionId: string): Promise<boolean> {
    const current = await this.readState(sessionId);
    if (!current || current.status !== "RUNNING") return false;
    await this.updateState(sessionId, (state) => {
      if (state.status !== "RUNNING") return;
      state.status = "BLOCKED";
      state.statusReason = "Legacy RUNNING session has no verifiable ownership lease.";
      for (const role of Object.keys(state.agentStates) as AgentRole[]) {
        if (state.agentStates[role].status === "running") {
          state.agentStates[role] = {
            status: "idle",
            lastExitCode: -1,
            lastRunAt: new Date().toISOString(),
          };
        }
      }
    });
    await this.syncRegistrySessionStatus(sessionId, "BLOCKED");
    return true;
  }

  async markSessionStopped(sessionId: string, reason: string): Promise<void> {
    const state = await this.updateState(sessionId, (current) => {
      current.status = "STOPPED";
      current.statusReason = reason;
      current.automaticRecovery = null;
      for (const role of Object.keys(current.agentStates) as AgentRole[]) {
        if (
          current.agentStates[role].status === "running" ||
          current.agentStates[role].status === "retry_wait"
        ) {
          current.agentStates[role] = {
            status: "idle",
            lastExitCode: -1,
            lastRunAt: new Date().toISOString(),
          };
        }
      }
      if (current.activeAttempt && ["starting", "running", "retry_wait"].includes(current.activeAttempt.status)) {
        current.activeAttempt.status = "cancelled";
        current.activeAttempt.endedAt = new Date().toISOString();
        current.activeAttempt.failureKind = "cancelled";
        current.activeAttempt.failureMessage = reason;
      }
    });
    await this.mergeSessionMetaStatus(sessionId, {
      status: "STOPPED",
      goal: state.goal,
      targetProjectPath: state.targetProjectPath,
      createdAt: state.createdAt,
    });
  }

  async ensureInitialized(): Promise<void> {
    const root = await this.getRootDir();
    const settingsLockPath = path.join(root, "settings_write.lock");
    await this.withFileLock(settingsLockPath, async () => {
      const pipeline = fixedPipelineDefinition();
      const context = getGlobalContext();
      const configurationFiles: Array<[string, unknown]> = [
        ["agent_roles.json", {
          $schema: "./agent_roles.schema.json",
          version: 1,
          roles: pipeline.roles,
        }],
        ["agent_loop.json", {
          $schema: "./agent_loop.schema.json",
          version: 1,
          name: pipeline.name,
          startStageId: pipeline.startStageId,
          interruptStageId: pipeline.interruptStageId,
          reentryStageId: pipeline.reentryStageId,
          iterationCompletionStageId: pipeline.iterationCompletionStageId,
          stageTypes: pipeline.stageTypes,
          stages: pipeline.stages,
        }],
      ];
      for (const [fileName, contents] of configurationFiles) {
        const target = path.join(root, fileName);
        const exists = await fs.stat(target).then((stat) => stat.isFile()).catch(() => false);
        if (exists) continue;
        const bundledSource = context
          ? path.join(context.extensionUri.fsPath, "core", fileName)
          : null;
        const bundledSourceExists = bundledSource
          ? await fs.stat(bundledSource).then((stat) => stat.isFile()).catch(() => false)
          : false;
        if (bundledSource && bundledSourceExists) {
          await fs.copyFile(bundledSource, target);
        } else {
          await this.writeJsonAtomic(target, contents);
        }
      }

      if (context) {
        for (const schemaName of [
          "agent_roles.schema.json",
          "agent_loop.schema.json",
          "loop_config.schema.json",
        ]) {
          const target = path.join(root, schemaName);
          const exists = await fs.stat(target).then((stat) => stat.isFile()).catch(() => false);
          if (exists) continue;
          const source = path.join(context.extensionUri.fsPath, "core", schemaName);
          const sourceExists = await fs.stat(source).then((stat) => stat.isFile()).catch(() => false);
          if (sourceExists) await fs.copyFile(source, target);
        }
      }
    });
    const registryPath = await this.getRegistryPath();
    const cfg = await this.getPathsConfig();
    try {
      await fs.access(registryPath);
    } catch {
      const root = await this.getRootDir();
      await fs.mkdir(path.join(root, cfg.sessionsRoot), { recursive: true });
      const empty = emptySessionRegistry();
      const lockPath = path.join(path.dirname(registryPath), cfg.registryLockFileName);
      await this.withFileLock(lockPath, async () => {
        try {
          await fs.access(registryPath);
        } catch {
          await this.writeJsonAtomic(registryPath, empty);
          this.registryCache = empty;
        }
      });
    }
    await this.reconcileRegistryWithSessionDirectories();
  }

  async readRegistry(): Promise<SessionRegistry> {
    const registryPath = await this.getRegistryPath();
    const data = await this.readJsonAtomic<SessionRegistry>(registryPath);
    if (data) {
      this.registryCache = data;
      return data;
    }
    const cfg = await this.getPathsConfig();
    const lockPath = path.join(path.dirname(registryPath), cfg.registryLockFileName);
    const recovered = await this.withFileLock(lockPath, async () => {
      const latest = await this.readJsonAtomic<SessionRegistry>(registryPath);
      if (latest) return latest;
      const exists = await fs.stat(registryPath).then((stat) => stat.isFile()).catch(() => false);
      if (exists) {
        const backupPath = `${registryPath}.corrupt.${Date.now()}.${randomBytes(4).toString("hex")}`;
        await fs.rename(registryPath, backupPath);
        console.error(`[StateStore] Corrupted registry at ${registryPath}. Moved atomically to ${backupPath}.`);
      }
      const fallback: SessionRegistry = this.registryCache ?? emptySessionRegistry();
      await this.writeJsonAtomic(registryPath, fallback);
      return fallback;
    });
    this.registryCache = recovered;
    await this.reconcileRegistryWithSessionDirectories();
    return this.registryCache ?? recovered;
  }

  async deleteSession(sessionId: string): Promise<{ removedFromRegistry: boolean; dirRemoved: boolean; error?: string }> {
    assertSafeSessionId(sessionId);
    let removedFromRegistry = false;
    let dirRemoved = false;
    let tombstonePath: string | null = null;
    try {
      const sessionDir = await this.getSessionDir(sessionId);
      const sessionsRoot = path.dirname(sessionDir);
      const deletionLock = path.join(
        path.dirname(sessionsRoot),
        `session_delete_${sessionId}.lock`
      );
      const registryPath = await this.getRegistryPath();
      const cfg = await this.getPathsConfig();
      await this.withFileLock(deletionLock, async () => {
        const state = await this.readState(sessionId);
        const runtime = await this.inspectLease(sessionId);
        const activeAttemptPid = state?.activeAttempt &&
          ["starting", "running", "retry_wait"].includes(state.activeAttempt.status)
          ? state.activeAttempt.childPid
          : null;
        const childPids = new Set(
          [runtime.lease?.childPid, activeAttemptPid]
            .filter((pid): pid is number => typeof pid === "number" && pid > 0)
        );
        const deletionSafety = assessSessionDeletionSafety(
          state?.status ?? null,
          runtime.disposition,
          [...childPids].map((pid) => processLiveness(pid))
        );
        if (!deletionSafety.safe) {
          throw new Error(
            `${deletionSafety.reason} Stop the session and wait for ownership/child termination before deletion.`
          );
        }

        const sessionExists = await fs.stat(sessionDir).then((stat) => stat.isDirectory()).catch(() => false);
        if (sessionExists) {
          const tombstoneRoot = path.join(path.dirname(sessionsRoot), "session_tombstones");
          await fs.mkdir(tombstoneRoot, { recursive: true });
          tombstonePath = path.join(
            tombstoneRoot,
            `${sessionId}.${Date.now()}.${randomBytes(4).toString("hex")}`
          );
          await fs.rename(sessionDir, tombstonePath);
        }

        const registryLock = path.join(path.dirname(registryPath), cfg.registryLockFileName);
        try {
          await this.withFileLock(registryLock, async () => {
            const registry = await this.readJsonAtomic<SessionRegistry>(registryPath);
            if (!registry) throw new Error("Session registry is missing or invalid.");
            const before = registry.sessionMetas.length;
            registry.sessionMetas = registry.sessionMetas.filter((m) => m.sessionId !== sessionId);
            registry.activeSessionIds = (registry.activeSessionIds || []).filter((id) => id !== sessionId);
            if (registry.sessionMetas.length < before) removedFromRegistry = true;
            await this.writeJsonAtomic(registryPath, registry);
            this.registryCache = registry;
          });
        } catch (err) {
          if (tombstonePath) {
            await fs.rename(tombstonePath, sessionDir).catch(() => {});
            tombstonePath = null;
          }
          throw err;
        }
      });
      this.stateCache.delete(sessionId);
      if (tombstonePath) {
        try {
          await fs.rm(tombstonePath, { recursive: true, force: true });
          dirRemoved = true;
        } catch (err) {
          return {
            removedFromRegistry,
            dirRemoved: false,
            error:
              `Session was detached into a recoverable tombstone but cleanup failed: ` +
              `${err instanceof Error ? err.message : String(err)}`,
          };
        }
      } else {
        dirRemoved = true;
      }
    } catch (err) {
      return {
        removedFromRegistry,
        dirRemoved,
        error: `Failed to delete session: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    return { removedFromRegistry, dirRemoved };
  }

  async healOrphanedSession(sessionId: string): Promise<boolean> {
    const state = await this.readState(sessionId);
    if (!state || state.status !== "RUNNING") {
      return false;
    }
    const runtime = await this.inspectLease(sessionId);
    if (runtime.disposition !== "missing") return false;
    return this.pauseLegacyRunningSession(sessionId);
  }

  async syncRegistrySessionStatus(sessionId: string, status: LoopStatus): Promise<void> {
    const state = await this.readState(sessionId);
    const registry = await this.readRegistry();
    const existing = registry.sessionMetas.find((m) => m.sessionId === sessionId);
    await this.mergeSessionMetaStatus(sessionId, {
      status,
      goal: state?.goal ?? existing?.goal ?? "",
      targetProjectPath: state?.targetProjectPath ?? existing?.targetProjectPath ?? "",
      createdAt: state?.createdAt ?? existing?.createdAt ?? new Date().toISOString(),
    });
  }

  async resolveSessionDisplayStatus(
    sessionId: string,
    registryStatus: LoopStatus
  ): Promise<LoopStatus> {
    const state = await this.readState(sessionId);
    if (state?.status) {
      if (state.status === "RUNNING") {
        const runtime = await this.inspectLease(sessionId);
        if (
          runtime.disposition === "active" ||
          runtime.disposition === "expired_owner_alive" ||
          runtime.disposition === "recoverable" ||
          runtime.disposition === "unverifiable"
        ) {
          return "RUNNING";
        }
      }
      return state.status;
    }
    return registryStatus;
  }

  private async mergeSessionMetaStatus(
    sessionId: string,
    patch: Pick<SessionMeta, "status" | "goal" | "targetProjectPath" | "createdAt">
  ): Promise<void> {
    const registryPath = await this.getRegistryPath();
    const cfg = await this.getPathsConfig();
    const lockPath = path.join(path.dirname(registryPath), cfg.registryLockFileName);
    const fresh = await this.withFileLock(lockPath, async () => {
      const latest = (await this.readJsonAtomic<SessionRegistry>(registryPath)) ??
        this.registryCache ??
        emptySessionRegistry();
      const existing = latest.sessionMetas.find((m) => m.sessionId === sessionId);
      if (existing) {
        existing.status = patch.status;
        if (patch.goal !== undefined) existing.goal = patch.goal;
        if (patch.targetProjectPath !== undefined) existing.targetProjectPath = patch.targetProjectPath;
      } else {
        latest.sessionMetas.push({
          sessionId,
          goal: patch.goal,
          targetProjectPath: patch.targetProjectPath,
          status: patch.status,
          createdAt: patch.createdAt,
        });
        if (!latest.activeSessionIds.includes(sessionId)) {
          latest.activeSessionIds.push(sessionId);
        }
      }
      await this.writeJsonAtomic(registryPath, latest);
      return latest;
    });
    this.registryCache = fresh;
    this.notifyListeners();
  }

  private async reconcileRegistryWithSessionDirectories(): Promise<void> {
    const root = await this.getRootDir();
    const cfg = await this.getPathsConfig();
    const registryPath = await this.getRegistryPath();
    const sessionsRoot = path.join(root, cfg.sessionsRoot);
    const entries = await fs.readdir(sessionsRoot, { withFileTypes: true }).catch(() => []);
    const discovered: SessionMeta[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        assertSafeSessionId(entry.name);
        const state = await this.readJsonAtomic<LoopState>(
          path.join(
            await this.getSessionDir(entry.name),
            cfg.sessionFileNames.state
          )
        );
        if (!state) continue;
        discovered.push({
          sessionId: entry.name,
          goal: state.goal,
          targetProjectPath: state.targetProjectPath,
          status: state.status,
          createdAt: state.createdAt,
        });
      } catch {
        // Ignore malformed or unsafe session directories.
      }
    }
    if (discovered.length === 0) return;

    const lockPath = path.join(path.dirname(registryPath), cfg.registryLockFileName);
    const reconciled = await this.withFileLock(lockPath, async () => {
      const registry = await this.readJsonAtomic<SessionRegistry>(registryPath);
      if (!registry) return null;
      let changed = false;
      for (const meta of discovered) {
        if (!registry.sessionMetas.some((item) => item.sessionId === meta.sessionId)) {
          registry.sessionMetas.push(meta);
          changed = true;
        }
        if (!registry.activeSessionIds.includes(meta.sessionId)) {
          registry.activeSessionIds.push(meta.sessionId);
          changed = true;
        }
      }
      if (changed) await this.writeJsonAtomic(registryPath, registry);
      return registry;
    });
    if (reconciled) this.registryCache = reconciled;
  }

  async readState(sessionId: string): Promise<LoopState | null> {
    const cached = this.stateCache.get(sessionId);
    const cfg = await this.getPathsConfig();
    const statePath = path.join(await this.getSessionDir(sessionId), cfg.sessionFileNames.state);
    const data = await this.readJsonAtomic<LoopState>(statePath);
    if (data) {
      this.stateCache.set(sessionId, data);
      return data;
    }
    const exists = await fs.stat(statePath).then((stat) => stat.isFile()).catch(() => false);
    if (!exists) {
      this.stateCache.delete(sessionId);
      return null;
    }
    return cached ?? null;
  }

  async readProgressNotes(sessionId: string): Promise<string> {
    const cfg = await this.getPathsConfig();
    const notesPath = path.join(await this.getSessionDir(sessionId), cfg.sessionFileNames.progressNotes);
    try {
      return await fs.readFile(notesPath, "utf8");
    } catch {
      return "";
    }
  }

  async readHistory(sessionId: string): Promise<LoopHistoryEntry[]> {
    const cfg = await this.getPathsConfig();
    const historyDir = path.join(await this.getSessionDir(sessionId), cfg.loopHistoryDirName);
    try {
      const files = await fs.readdir(historyDir);
      const entries: LoopHistoryEntry[] = [];
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const filePath = path.join(historyDir, file);
        const data = await this.readJsonAtomic<LoopHistoryEntry>(filePath);
        if (data) entries.push(data);
      }
      entries.sort((a, b) => {
        if (a.loopNumber !== b.loopNumber) return a.loopNumber - b.loopNumber;
        return a.startedAt.localeCompare(b.startedAt);
      });
      return entries;
    } catch {
      return [];
    }
  }

  async readFinalSummary(sessionId: string): Promise<FinalSummary | null> {
    const cfg = await this.getPathsConfig();
    const summaryPath = path.join(await this.getSessionDir(sessionId), cfg.sessionFileNames.finalSummary);
    return this.readJsonAtomic<FinalSummary>(summaryPath);
  }

  async readBundle(sessionId: string): Promise<SessionBundle> {
    const registry = await this.readRegistry();
    const [state, progressNotes, history, finalSummary] = await Promise.all([
      this.readState(sessionId),
      this.readProgressNotes(sessionId),
      this.readHistory(sessionId),
      this.readFinalSummary(sessionId),
    ]);
    return { registry, state, progressNotes, history, finalSummary };
  }

  startPolling(intervalMs: number): void {
    this.stopPolling();
    this.pollTimer = setInterval(() => {
      this.notifyListeners();
    }, intervalMs);
  }

  stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  onChange(listener: () => void): void {
    this.listeners.push(listener);
  }

  removeChangeListener(listener: () => void): void {
    this.listeners = this.listeners.filter((l) => l !== listener);
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (err) {
        console.error("[StateStore] listener error:", err);
      }
    }
  }

  private resolveContainedSessionFile(sessionDir: string, configuredPath: string): string {
    const resolvedSessionDir = path.resolve(sessionDir);
    const resolvedFile = path.isAbsolute(configuredPath)
      ? path.resolve(configuredPath)
      : path.resolve(resolvedSessionDir, configuredPath);
    const relative = path.relative(resolvedSessionDir, resolvedFile);
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error(`Plan document escapes session directory: ${configuredPath}`);
    }
    return resolvedFile;
  }

  private async withFileLock<T>(
    lockPath: string,
    operation: () => Promise<T>,
    timeoutMs = 5_000
  ): Promise<T> {
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    const ownerId = `owner_${Date.now().toString(36)}_${randomBytes(6).toString("hex")}`;
    const deadline = Date.now() + timeoutMs;
    while (true) {
      let handle: fs.FileHandle | null = null;
      try {
        handle = await fs.open(lockPath, "wx");
        await handle.writeFile(
          JSON.stringify({
            ownerId,
            ownerPid: process.pid,
            createdAt: new Date().toISOString(),
          }, null, 2),
          "utf8"
        );
        await handle.close();
        handle = null;
        break;
      } catch (err) {
        if (handle) await handle.close().catch(() => {});
        const code = (err as NodeJS.ErrnoException).code;
        const transientWindowsContention =
          process.platform === "win32" &&
          (code === "EPERM" || code === "EBUSY" || code === "EACCES");
        if (code !== "EEXIST" && !transientWindowsContention) throw err;
        const record = await this.readJsonAtomic<{
          ownerId: string;
          ownerPid: number;
          createdAt: string;
        }>(lockPath);
        const stat = await fs.stat(lockPath).catch(() => null);
        const ageMs = record
          ? Date.now() - Date.parse(record.createdAt)
          : stat
          ? Date.now() - stat.mtimeMs
          : 0;
        if (
          code === "EEXIST" &&
          Number.isFinite(ageMs) &&
          ageMs > 30_000 &&
          (!record || processLiveness(record.ownerPid) === "dead")
        ) {
          const stalePath = `${lockPath}.stale.${ownerId}`;
          await fs.rename(lockPath, stalePath).catch(() => {});
          await fs.rm(stalePath, { force: true }).catch(() => {});
        }
        if (Date.now() >= deadline) throw new Error(`Timed out acquiring lock: ${lockPath}`);
        await delay(40 + Math.floor(Math.random() * 40));
      }
    }

    try {
      return await operation();
    } finally {
      const current = await this.readJsonAtomic<{ ownerId: string }>(lockPath);
      if (current?.ownerId === ownerId) {
        await fs.rm(lockPath, { force: true }).catch(() => {});
      }
    }
  }

  private async readJsonAtomic<T>(filePath: string): Promise<T | null> {
    try {
      const content = await fs.readFile(filePath, "utf8");
      return JSON.parse(content) as T;
    } catch {
      return null;
    }
  }

  private async writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}`;
    await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), "utf8");
    await this.renameWithRetry(tmpPath, filePath);
  }

  private async writeTextAtomic(filePath: string, content: string): Promise<void> {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}`;
    await fs.writeFile(tmpPath, content, "utf8");
    await this.renameWithRetry(tmpPath, filePath);
  }

  private async renameWithRetry(src: string, dest: string, maxRetries = 5): Promise<void> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        await fs.rename(src, dest);
        return;
      } catch (err: unknown) {
        lastErr = err;
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EPERM" || code === "EBUSY" || code === "EACCES") {
          await new Promise<void>((resolve) => setTimeout(resolve, 50 * Math.pow(2, attempt)));
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  }
}

export function setGlobalContext(context: vscode.ExtensionContext): void {
  globalContext = context;
}

export function getGlobalContext(): vscode.ExtensionContext | undefined {
  return globalContext;
}
