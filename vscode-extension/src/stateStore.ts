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
  loadLoopPathsConfig,
  LoopPathsConfig,
  PlanChoice,
  SystemSettings,
  ProviderConfig,
  ToolAccessConfig,
  PipelineDefinition,
  PipelineRole,
  PipelineStageExecutor,
} from "./types";
import {
  LeaseDisposition,
  SessionLease,
  SessionOwnerLock,
  assessSessionDeletionSafety,
  evaluateOwnership,
  processLiveness,
} from "./resilience";
import generatedAgents from "./generated_agents.json";
import generatedTasks from "./generated_tasks.json";
import generatedWorkflow from "./generated_workflow.json";
import { resolveConfiguredDataRoot, resolveContainedPath } from "./pathSafety";
import {
  assertSecureRemoteMcpTransport,
  namespacedMcpSecretStorageKey,
  protectMcpCredentialValue,
  SECRET_REFERENCE,
} from "./mcpSecurityPolicy";

let globalContext: vscode.ExtensionContext | undefined;
export const CORE_SECRET_VALUES_ENV = "AGENT_LOOP_SECRET_VALUES";

const STAGE_EXECUTORS: PipelineStageExecutor[] = [
  "planning", "implementation", "test", "review", "approval", "interrupt",
];
function fixedPipelineDefinition(existing?: PipelineDefinition | null): PipelineDefinition {
  const existingRoles = new Map((existing?.roles ?? []).map((role) => [role.id, role]));
  const taskExecutors = new Map<string, PipelineStageExecutor>([
    ["produce_plan", "planning"],
    ["implement_changes", "implementation"],
    ["run_tests", "test"],
    ["audit_quality", "review"],
    ["approve_completion", "approval"],
    ["analyze_interrupt", "interrupt"],
  ]);
  const tasks = new Map(generatedTasks.tasks.map((task) => [task.id, task]));
  const transitions = new Map<string, Array<{ on: string; to: string }>>();
  for (const transition of generatedWorkflow.transitions) {
    const entries = transitions.get(transition.from) ?? [];
    entries.push({ on: transition.on, to: transition.to });
    transitions.set(transition.from, entries);
  }
  return {
    version: 1,
    name: generatedWorkflow.name,
    startStageId: generatedWorkflow.startNodeId,
    interruptStageId: generatedWorkflow.applicationPolicy.interruptNodeId,
    reentryStageId: generatedWorkflow.cyclePolicy.startNodeId,
    iterationCompletionStageId: generatedWorkflow.cyclePolicy.completionNodeId,
    roles: generatedAgents.agents.map((agent) => {
      const previous = existingRoles.get(agent.id);
      const runtimeDefaults = agent.runtimeDefaults as {
        provider?: string;
        model?: string;
        variant?: string;
      };
      return {
        id: agent.id,
        modelRole: agent.id as PipelineRole["modelRole"],
        description: agent.objective,
        instructions: agent.instructions,
        ...(previous?.provider ?? runtimeDefaults.provider
          ? { provider: previous?.provider ?? runtimeDefaults.provider }
          : {}),
        ...(previous?.model ?? runtimeDefaults.model
          ? { model: previous?.model ?? runtimeDefaults.model }
          : {}),
        ...(previous?.variant ?? runtimeDefaults.variant
          ? { variant: previous?.variant ?? runtimeDefaults.variant }
          : {}),
      };
    }),
    stages: generatedWorkflow.nodes.map((node) => {
      const taskId = "taskId" in node && typeof node.taskId === "string"
        ? node.taskId
        : null;
      const agentId = "agentId" in node && typeof node.agentId === "string"
        ? node.agentId
        : "planner";
      const gateType = "gate" in node && node.gate
        ? node.gate.type
        : null;
      const task = taskId ? tasks.get(taskId) : undefined;
      const executor = task ? taskExecutors.get(task.id) ?? "planning" : "planning";
      const routes = transitions.get(node.id) ?? [];
      return {
        id: node.id,
        name: node.id.replaceAll("_", " "),
        role: agentId,
        kind: executor,
        instructions: "",
        onSuccess: routes[0]?.to ?? "PAUSED",
        onFailure: routes[1]?.to ?? routes[0]?.to ?? "PAUSED",
        countsIteration: node.id === generatedWorkflow.cyclePolicy.startNodeId,
        requiresPlanApproval: node.kind === "human_gate" && gateType === "plan_approval",
        planOptionsCount: task?.id === "produce_plan" ? 3 : 0,
      };
    }),
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

export class StateStore {
  private registryCache: SessionRegistry | null = null;
  private stateCache: Map<string, LoopState> = new Map();
  private pollTimer: NodeJS.Timeout | null = null;
  private listeners: Array<() => void> = [];
  private pathsCache: LoopPathsConfig | null = null;
  private secretNamespaceCache: string | null = null;
  private readonly pendingPlanSelections = new Map<string, string>();

  constructor(private config: ExtensionConfig) {}

  updateConfig(config: ExtensionConfig): void {
    this.config = config;
    this.pathsCache = null;
    this.secretNamespaceCache = null;
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
    if (this.config.rootDir && this.config.rootDir.length > 0) {
      return resolveConfiguredDataRoot(this.config.rootDir);
    }
    if (globalContext) {
      const storagePath = globalContext.globalStorageUri.fsPath;
      await fs.mkdir(storagePath, { recursive: true });
      return storagePath;
    }
    const envRoot = process.env.AGENT_LOOP_DATA_ROOT ?? process.env.AGENT_LOOP_ROOT;
    if (envRoot && envRoot.length > 0) {
      return resolveConfiguredDataRoot(envRoot);
    }
    const defaultDir = process.platform === "win32"
      ? path.join(
          process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"),
          "CustomAgentLoopSystem"
        )
      : process.platform === "darwin"
        ? path.join(os.homedir(), "Library", "Application Support", "CustomAgentLoopSystem")
        : path.join(
            process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"),
            "custom-agent-loop-system"
          );
    await fs.mkdir(defaultDir, { recursive: true });
    return defaultDir;
  }

  getRegistryPath = async (): Promise<string> => {
    const root = await this.getRootDir();
    const cfg = await this.getPathsConfig();
    return resolveContainedPath(root, cfg.sessionsIndexFileName, "Sessions index");
  };

  getSessionDir = async (sessionId: string): Promise<string> => {
    assertSafeSessionId(sessionId);
    const root = await this.getRootDir();
    const cfg = await this.getPathsConfig();
    const sessionsRoot = await resolveContainedPath(root, cfg.sessionsRoot, "Sessions root");
    return resolveContainedPath(sessionsRoot, sessionId, "Session directory");
  };

  resolveSessionRuntimePath = async (
    sessionId: string,
    configuredPath: string,
    label = "Session runtime path"
  ): Promise<string> => {
    return resolveContainedPath(await this.getSessionDir(sessionId), configuredPath, label);
  };

  getPlanChoicesPath = async (sessionId: string): Promise<string> => {
    const dir = await this.getSessionDir(sessionId);
    const cfg = await this.getPathsConfig();
    return resolveContainedPath(dir, cfg.sessionFileNames.planChoices, "Plan choices file");
  };

  getPlanMdPath = async (sessionId: string): Promise<string> => {
    const dir = await this.getSessionDir(sessionId);
    const cfg = await this.getPathsConfig();
    return resolveContainedPath(dir, cfg.sessionFileNames.plan, "Plan file");
  };

  getPlanOverviewPath = async (sessionId: string): Promise<string> => {
    const sessionDir = await this.getSessionDir(sessionId);
    const cfg = await this.getPathsConfig();
    const state = await this.readState(sessionId);
    return resolveContainedPath(
      sessionDir,
      state?.planOverviewPath || cfg.sessionFileNames.planOverview,
      "Plan overview file"
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
    return resolveContainedPath(sessionDir, configured, "Plan option file");
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
    const loopConfigPath = path.join(root, "loop_config.json");
    const agentsPath = path.join(root, "agents.json");
    let loopConfig = await this.readJsonAtomic<{
      providers?: Record<string, ProviderConfig>;
      toolAccess?: ToolAccessConfig;
    }>(loopConfigPath) ?? {};
    if (globalContext && loopConfig.toolAccess) {
      const lockPath = path.join(root, "settings_write.lock");
      await this.withFileLock(lockPath, async () => {
        const latest = await this.readJsonAtomic<{
          providers?: Record<string, ProviderConfig>;
          toolAccess?: ToolAccessConfig;
          [key: string]: unknown;
        }>(loopConfigPath) ?? {};
        if (latest.toolAccess) {
          const before = JSON.stringify(latest.toolAccess);
          latest.toolAccess = await this.protectMcpCredentials(latest.toolAccess);
          if (JSON.stringify(latest.toolAccess) !== before) {
            await this.writeJsonAtomic(loopConfigPath, latest);
          }
        }
        loopConfig = latest;
      });
    }
    const fallbackProviders: Record<string, ProviderConfig> = {
      opencode: { label: "OpenCode", adapter: "opencode", binary: "opencode", enabled: true, modelsArgs: ["models"], fallbackModels: ["opencode/big-pickle"] },
      kilo: { label: "Kilo Code", adapter: "kilo", binary: "kilo", enabled: true, modelsArgs: ["models", "--pure"], fallbackModels: ["anthropic/claude-sonnet-4-5"] },
      codex: { label: "OpenAI GPT / Codex", adapter: "codex", binary: "codex", enabled: true, modelsArgs: [], fallbackModels: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"] },
      claude: { label: "Anthropic Claude Code", adapter: "claude", binary: "claude", enabled: true, modelsArgs: [], fallbackModels: ["sonnet", "opus"] },
    };
    const storedAgents = await this.readJsonAtomic<{
      schemaVersion: number;
      agents: Array<{
        id: string;
        runtimeDefaults?: { provider?: string; model?: string; variant?: string };
      }>;
    }>(agentsPath);
    if (storedAgents && storedAgents.schemaVersion !== 1) {
      throw new Error("Agent definitions schemaVersion must be 1.");
    }
    const runtimePipeline = fixedPipelineDefinition();
    if (storedAgents) {
      const byId = new Map(storedAgents.agents.map((agent) => [agent.id, agent]));
      for (const role of runtimePipeline.roles) {
        const runtime = byId.get(role.id)?.runtimeDefaults;
        if (runtime?.provider) role.provider = runtime.provider;
        if (runtime?.model) role.model = runtime.model;
        if (runtime?.variant) role.variant = runtime.variant;
      }
    }
    const pipeline = runtimePipeline;
    this.stripUnsupportedRoleToolOverrides(pipeline);
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
    this.stripUnsupportedRoleToolOverrides(settings.pipeline);
    this.validateSystemSettings(settings);
    const root = await this.getRootDir();
    const agentsPath = path.join(root, "agents.json");
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
      const agentsDocument = await this.readJsonAtomic<{
        $schema?: string;
        schemaVersion: 1;
        agents: Array<Record<string, unknown> & {
          id: string;
          runtimeDefaults?: Record<string, string>;
        }>;
      }>(agentsPath) ?? structuredClone(generatedAgents);
      const rolesById = new Map(settings.pipeline.roles.map((role) => [role.id, role]));
      for (const agent of agentsDocument.agents) {
        const role = rolesById.get(agent.id);
        if (!role) continue;
        agent.runtimeDefaults = {
          ...(role.provider ? { provider: role.provider } : {}),
          ...(role.model ? { model: role.model } : {}),
          ...(role.variant ? { variant: role.variant } : {}),
        };
      }
      agentsDocument.$schema = "./agents.schema.json";
      agentsDocument.schemaVersion = 1;
      await this.writeJsonAtomic(agentsPath, agentsDocument);
    });
    if (globalContext) {
      const namespace = await this.getSecretNamespace();
      const currentPrefix = `agentLoop.mcp.v2.${namespace}.`;
      await Promise.allSettled(
        [...removedSecrets]
          .filter((key) => key.startsWith(currentPrefix))
          .map((key) => globalContext!.secrets.delete(key))
      );
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

  private async getSecretNamespace(): Promise<string> {
    if (this.secretNamespaceCache) return this.secretNamespaceCache;
    const root = await this.getRootDir();
    const canonicalRoot = await fs.realpath(root).catch(() => path.resolve(root));
    const normalizedRoot = process.platform === "win32"
      ? canonicalRoot.toLocaleLowerCase("en-US")
      : canonicalRoot;
    const rootDigest = createHash("sha256").update(normalizedRoot).digest("hex").slice(0, 24);
    if (!globalContext) {
      this.secretNamespaceCache = rootDigest;
      return rootDigest;
    }
    const stateKey = `agentLoop.secretNamespace.${rootDigest}`;
    const stored = globalContext.globalState.get<string>(stateKey);
    if (stored && /^[a-f0-9]{32}$/.test(stored)) {
      this.secretNamespaceCache = stored;
      return stored;
    }
    const created = randomBytes(16).toString("hex");
    await globalContext.globalState.update(stateKey, created);
    this.secretNamespaceCache = created;
    return created;
  }

  private async protectMcpCredentials(toolAccess: ToolAccessConfig): Promise<ToolAccessConfig> {
    const namespace = await this.getSecretNamespace();
    const protectMap = async (
      serverId: string,
      scope: "environment" | "headers",
      values: Record<string, string> | undefined
    ): Promise<Record<string, string>> => {
      const protectedValues: Record<string, string> = {};
      for (const [fieldName, value] of Object.entries(values ?? {})) {
        const currentKey = namespacedMcpSecretStorageKey(namespace, serverId, scope, fieldName);
        protectedValues[fieldName] = await protectMcpCredentialValue(
          value,
          currentKey,
          globalContext?.secrets
        );
      }
      return protectedValues;
    };

    return {
      webSearch: { ...toolAccess.webSearch },
      mcpServers: await Promise.all(toolAccess.mcpServers.map(async (server) => ({
        ...server,
        args: [...(server.args ?? [])],
        tools: (server.tools ?? []).map((tool) => ({ ...tool })),
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
      if (server.type === "local" && !server.command?.trim()) {
        throw new Error(`Local MCP server ${server.id} needs a command.`);
      }
      if (server.type === "remote") {
        assertSecureRemoteMcpTransport(
          server.id,
          server.url,
          server.environment,
          server.headers
        );
      }
      if (server.timeoutMs !== undefined && (!Number.isFinite(server.timeoutMs) || server.timeoutMs <= 0)) {
        throw new Error(`MCP server ${server.id} timeout must be positive.`);
      }
      const toolNames = new Set<string>();
      for (const tool of server.tools ?? []) {
        if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(tool.name)) {
          throw new Error(`MCP server ${server.id} has an unsafe tool name: ${tool.name}`);
        }
        if (toolNames.has(tool.name)) {
          throw new Error(`MCP server ${server.id} has a duplicate tool: ${tool.name}`);
        }
        toolNames.add(tool.name);
        if (!["read_only", "write", "unknown"].includes(tool.sideEffect)) {
          throw new Error(`MCP server ${server.id} tool ${tool.name} has an invalid side effect.`);
        }
      }
    }
    const pipeline = settings.pipeline;
    if (pipeline.version !== 1 || pipeline.roles.length === 0 || pipeline.stages.length === 0) {
      throw new Error("Pipeline version 1 requires at least one role and stage.");
    }
    const roleIds = new Set<string>();
    for (const role of pipeline.roles) {
      if (!safeId.test(role.id) || roleIds.has(role.id)) throw new Error(`Invalid or duplicate role id: ${role.id}`);
      roleIds.add(role.id);
      if (!["planner", "implementer", "tester", "qa_lead", "master", "interrupter"].includes(role.modelRole)) {
        throw new Error(`Role ${role.id} has an invalid template.`);
      }
      if (role.provider && !settings.providers[role.provider]) throw new Error(`Role ${role.id} references unknown provider ${role.provider}.`);
    }
    const stageIds = new Set<string>();
    for (const stage of pipeline.stages) {
      if (!safeId.test(stage.id) || stageIds.has(stage.id)) throw new Error(`Invalid or duplicate stage id: ${stage.id}`);
      if (!roleIds.has(stage.role)) throw new Error(`Stage ${stage.id} references unknown role ${stage.role}.`);
      if (!STAGE_EXECUTORS.includes(stage.kind as PipelineStageExecutor)) {
        throw new Error(`Stage ${stage.id} has an invalid task kind ${stage.kind}.`);
      }
      stageIds.add(stage.id);
    }
    for (const required of [pipeline.startStageId, pipeline.interruptStageId, pipeline.reentryStageId, pipeline.iterationCompletionStageId]) {
      if (!stageIds.has(required)) throw new Error(`Pipeline references unknown required stage ${required}.`);
    }
    const interruptStage = pipeline.stages.find((stage) => stage.id === pipeline.interruptStageId);
    if (interruptStage?.kind !== "interrupt") {
      throw new Error("The interrupt stage must use the interrupt kind.");
    }
    if (!pipeline.stages.some((stage) => stage.countsIteration)) {
      throw new Error("At least one stage must count an iteration.");
    }
    for (const stage of pipeline.stages) {
      for (const target of [stage.onSuccess, stage.onFailure]) {
        if (
          !stageIds.has(target) &&
          target !== "SUCCESS" &&
          target !== "PAUSED" &&
          target !== "BLOCKED"
        ) {
          throw new Error(`Stage ${stage.id} references unknown transition ${target}.`);
        }
      }
    }
  }

  private stripUnsupportedRoleToolOverrides(pipeline: PipelineDefinition): void {
    for (const role of pipeline.roles) {
      const candidate = role as typeof role & { webSearch?: boolean; mcpServers?: string[] };
      delete candidate.webSearch;
      delete candidate.mcpServers;
    }
  }

  async selectPlanChoice(
    sessionId: string,
    choiceId: string
  ): Promise<{ choice: PlanChoice; markdownPath: string }> {
    const choices = await this.readPlanChoices(sessionId);
    const choice = choices?.find((candidate) => candidate.id === choiceId);
    if (!choice) throw new Error(`Plan option ${choiceId} was not found.`);
    this.pendingPlanSelections.set(sessionId, choice.id);
    const cached = this.stateCache.get(sessionId);
    if (cached) cached.selectedPlanChoiceId = choice.id;
    this.notifyListeners();
    return {
      choice,
      markdownPath: await this.getPlanChoiceMarkdownPath(sessionId, choice),
    };
  }

  async clearPlanChoice(sessionId: string): Promise<void> {
    this.pendingPlanSelections.delete(sessionId);
    const cached = this.stateCache.get(sessionId);
    if (cached) cached.selectedPlanChoiceId = null;
    this.notifyListeners();
  }

  async approvePlan(sessionId: string): Promise<LoopState> {
    const state = await this.readState(sessionId);
    if (!state?.awaitingPlanApproval) {
      throw new Error(`Session ${sessionId} is not awaiting plan approval.`);
    }
    const choiceId = this.pendingPlanSelections.get(sessionId) ?? state.selectedPlanChoiceId;
    if (!choiceId) throw new Error("Select a plan choice before approval.");
    state.selectedPlanChoiceId = choiceId;
    return state;
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
    const [leasePath, ownerLockPath] = await Promise.all([
      resolveContainedPath(sessionDir, cfg.leaseFileName, "Session lease file"),
      resolveContainedPath(sessionDir, cfg.ownerLockFileName, "Session owner lock"),
    ]);
    const [lease, ownerLock] = await Promise.all([
      this.readJsonAtomic<SessionLease>(leasePath),
      this.readJsonAtomic<SessionOwnerLock>(ownerLockPath),
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

  async ensureInitialized(): Promise<void> {
    const root = await this.getRootDir();
    const settingsLockPath = path.join(root, "settings_write.lock");
    await this.withFileLock(settingsLockPath, async () => {
      const context = getGlobalContext();
      const configurationFiles: Array<[string, unknown]> = [
        ["agents.json", generatedAgents],
        ["tasks.json", generatedTasks],
        ["workflow.json", generatedWorkflow],
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
          "agents.schema.json",
          "tasks.schema.json",
          "workflow.schema.json",
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
      const sessionsRoot = await resolveContainedPath(root, cfg.sessionsRoot, "Sessions root");
      await fs.mkdir(sessionsRoot, { recursive: true });
      const empty = emptySessionRegistry();
      const lockPath = await resolveContainedPath(
        path.dirname(registryPath),
        cfg.registryLockFileName,
        "Session registry lock"
      );
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
    const lockPath = await resolveContainedPath(
      path.dirname(registryPath),
      cfg.registryLockFileName,
      "Session registry lock"
    );
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
      const dataRoot = await this.getRootDir();
      const deletionBase = await resolveContainedPath(
        dataRoot,
        path.dirname(sessionsRoot),
        "Session deletion base",
        true
      );
      const deletionLock = await resolveContainedPath(
        deletionBase,
        `session_delete_${sessionId}.lock`,
        "Session deletion lock"
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
          const revalidatedSessionDir = await this.getSessionDir(sessionId);
          if (revalidatedSessionDir !== sessionDir) {
            throw new Error("Session directory changed while preparing deletion.");
          }
          const tombstoneRoot = await resolveContainedPath(
            deletionBase,
            "session_tombstones",
            "Session tombstone directory"
          );
          await fs.mkdir(tombstoneRoot, { recursive: true });
          tombstonePath = await resolveContainedPath(
            tombstoneRoot,
            `${sessionId}.${Date.now()}.${randomBytes(4).toString("hex")}`,
            "Session tombstone"
          );
          await fs.rename(sessionDir, tombstonePath);
        }

        const registryLock = await resolveContainedPath(
          path.dirname(registryPath),
          cfg.registryLockFileName,
          "Session registry lock"
        );
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
          const verifiedDeletionBase = await resolveContainedPath(
            dataRoot,
            deletionBase,
            "Session deletion base",
            true
          );
          const verifiedTombstoneRoot = await resolveContainedPath(
            verifiedDeletionBase,
            "session_tombstones",
            "Session tombstone directory"
          );
          const verifiedTombstone = await resolveContainedPath(
            verifiedTombstoneRoot,
            path.basename(tombstonePath),
            "Session tombstone cleanup"
          );
          await fs.rm(verifiedTombstone, { recursive: true, force: true });
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
    const lockPath = await resolveContainedPath(
      path.dirname(registryPath),
      cfg.registryLockFileName,
      "Session registry lock"
    );
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
    const sessionsRoot = await resolveContainedPath(root, cfg.sessionsRoot, "Sessions root");
    const entries = await fs.readdir(sessionsRoot, { withFileTypes: true }).catch(() => []);
    const discovered: SessionMeta[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        assertSafeSessionId(entry.name);
        const state = await this.readState(entry.name);
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

    const lockPath = await resolveContainedPath(
      path.dirname(registryPath),
      cfg.registryLockFileName,
      "Session registry lock"
    );
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
    const cfg = await this.getPathsConfig();
    const sessionDir = await this.getSessionDir(sessionId);
    const projectionPath = await resolveContainedPath(
      sessionDir,
      cfg.sessionFileNames.state,
      "Run projection"
    );
    const raw = await this.readJsonAtomic<Record<string, unknown>>(projectionPath);
    if (raw?.projectionSchemaVersion === 1 && raw.stateVersion === 4) {
      const data = this.projectRunState(raw, cfg);
      const pendingSelection = this.pendingPlanSelections.get(sessionId);
      if (pendingSelection && data.awaitingPlanApproval) {
        data.selectedPlanChoiceId = pendingSelection;
      }
      this.stateCache.set(sessionId, data);
      return data;
    }
    this.stateCache.delete(sessionId);
    return null;
  }

  private projectRunState(
    raw: Record<string, unknown>,
    cfg: LoopPathsConfig
  ): LoopState {
    const pipeline = fixedPipelineDefinition();
    const status = String(raw.status) as LoopStatus;
    const phase = typeof raw.phase === "string" ? raw.phase : "PLANNING";
    const active = raw.activeActivation && typeof raw.activeActivation === "object"
      ? raw.activeActivation as Record<string, unknown>
      : null;
    const pending = raw.pendingInput && typeof raw.pendingInput === "object"
      ? raw.pendingInput as Record<string, unknown>
      : null;
    const budgets = raw.budgets && typeof raw.budgets === "object"
      ? raw.budgets as Record<string, Record<string, unknown>>
      : {};
    const workflowSteps = budgets.workflowSteps ?? {};
    const cycles = budgets.cycles ?? {};
    const rawRequirements = Array.isArray(raw.requirements) ? raw.requirements : [];
    const rawEvidence = Array.isArray(raw.requirementEvidence)
      ? raw.requirementEvidence
      : [];
    const rawEvents = Array.isArray(raw.events) ? raw.events : [];
    const pendingContext = pending?.context && typeof pending.context === "object" &&
      !Array.isArray(pending.context)
      ? pending.context as Record<string, unknown>
      : null;
    const pendingRequestedPaths = Array.isArray(pendingContext?.requestedPaths)
      ? pendingContext.requestedPaths.filter(
          (value): value is string => typeof value === "string"
        )
      : [];
    const modelMapping = {
      planner: "",
      implementer: "",
      tester: "",
      qa_lead: "",
      master: "",
      interrupter: "",
    };
    const agentStates = Object.fromEntries(
      pipeline.roles.map((role) => [role.id, {
        status: "idle" as const,
        lastExitCode: null,
        lastRunAt: null,
      }])
    );
    const currentExecutor: PipelineStageExecutor = phase === "PLANNING"
      ? "planning"
      : phase === "IMPLEMENTATION"
        ? "implementation"
        : phase === "TEST"
          ? "test"
          : phase === "QA_REVIEW"
            ? "review"
            : phase === "MASTER_APPROVAL"
              ? "approval"
              : "interrupt";
    const result: LoopState = {
      stateVersion: 4,
      sessionId: String(raw.sessionId ?? raw.runId ?? ""),
      status,
      phase,
      loopCount: Number(cycles.consumed ?? 0),
      completedIterations: Number(cycles.completed ?? 0),
      maxCycles: Number(cycles.limit ?? this.config.maxCycles),
      cyclesStarted: Number(cycles.consumed ?? 0),
      cyclesCompleted: Number(cycles.completed ?? 0),
      maxWorkflowSteps: Number(workflowSteps.limit ?? 100),
      workflowStepsConsumed: Number(workflowSteps.consumed ?? 0),
      currentActivation: active
        ? {
            activationId: String(active.activationId ?? ""),
            sequence: Number(active.workflowStep ?? 0),
            stageId: String(active.nodeId ?? phase),
            executor: currentExecutor,
            mutationCapable: active.sideEffect === "workspace_mutation",
            workflowStep: Number(active.workflowStep ?? 0),
            cycleNumber: null,
            attemptsReserved: Array.isArray(active.attemptIds) ? active.attemptIds.length : 0,
            maxAgentAttempts: this.config.maxAgentAttempts,
            status: String(active.status) === "unknown_mutation"
              ? "unknown_mutation"
              : String(active.status) === "completed"
                ? "completed"
                : String(active.status) === "failed"
                  ? "failed"
                  : String(active.status) === "running"
                    ? "running"
                    : "reserved",
            reservedAt: String(raw.updatedAt ?? raw.createdAt ?? new Date().toISOString()),
            completedAt: null,
          }
        : null,
      activationHistory: [],
      goal: String(raw.goal ?? ""),
      targetProjectPath: String(raw.targetProjectPath ?? ""),
      additionalAllowedPaths: Array.isArray(raw.additionalAllowedPaths)
        ? raw.additionalAllowedPaths.filter((value): value is string => typeof value === "string")
        : [],
      accessMode: raw.accessMode === "full_access" ? "full_access" : "ask",
      pendingAccessRequest: pending?.kind === "access_approval"
        ? {
            requestId: String(pending.requestId ?? ""),
            requestedPaths: pendingRequestedPaths,
            requestedAt: String(pending.createdAt ?? raw.updatedAt ?? ""),
            sourcePhase: phase,
            reason: typeof pendingContext?.failure === "string"
              ? pendingContext.failure
              : String(pending.prompt ?? "Provider access approval is required."),
          }
        : null,
      modelMapping,
      providerMapping: {},
      providerConfigs: {},
      errorQueue: [],
      agentStates,
      refinedGoal: null,
      referenceIdentity: null,
      planningComplete: phase !== "PLANNING",
      masterApproved: status === "SUCCESS",
      createdAt: String(raw.createdAt ?? ""),
      updatedAt: String(raw.updatedAt ?? ""),
      phaseTimeoutMs: this.config.phaseTimeoutMs,
      idleTimeoutMs: this.config.idleTimeoutMs,
      cliBinary: this.config.cliBinary,
      cliProfile: this.config.cliProfile,
      variantMapping: {},
      toolAccess: { webSearch: { enabled: true, mode: "live" }, mcpServers: [] },
      awaitingPlanApproval:
        raw.awaitingPlanApproval === true ||
        (status === "WAITING_USER" && pending?.kind === "plan_approval"),
      planApproved: raw.planApproved === true,
      planPath: cfg.sessionFileNames.plan,
      planOverviewPath: cfg.sessionFileNames.planOverview,
      selectedPlanChoiceId:
        typeof raw.selectedPlanChoiceId === "string" ? raw.selectedPlanChoiceId : null,
      interruptBriefing:
        typeof raw.interruptBriefing === "string" ? raw.interruptBriefing : null,
      planRevisionPending: false,
      interruptedFromPhase: null,
      activeAttempt: null,
      lastFailure: null,
      recoveryCount: 0,
      totalAgentAttempts: active && Array.isArray(active.attemptIds)
        ? active.attemptIds.length
        : 0,
      statusReason: typeof raw.statusReason === "string" ? raw.statusReason : null,
      resilience: {
        transportTimeoutMs: this.config.transportTimeoutMs,
        toolTimeoutMs: this.config.toolTimeoutMs,
        maxAgentAttempts: this.config.maxAgentAttempts,
        retryBackoffMs: [...this.config.retryBackoffMs],
        terminationGraceMs: this.config.terminationGraceMs,
        killTimeoutMs: this.config.killTimeoutMs,
        heartbeatIntervalMs: this.config.heartbeatIntervalMs,
        leaseTtlMs: this.config.leaseTtlMs,
        maxInMemoryOutputBytes: this.config.maxInMemoryOutputBytes,
      },
      pipeline,
      pipelineConfigPath: null,
      stageResults: {},
      domainEventSequence: rawEvents.length,
      domainEvents: rawEvents.map((candidate, index) => {
        const event = candidate && typeof candidate === "object"
          ? candidate as Record<string, unknown>
          : {};
        const rawType = String(event.type ?? "node.completed");
        const type = rawType === "run.completed"
          ? "workflow.completed"
          : rawType === "run.started"
            ? "workflow.started"
            : rawType === "run.resumed"
              ? "workflow.resumed"
              : rawType === "run.paused"
                ? "workflow.paused"
                : rawType === "node.failed"
                  ? "stage.failed"
                  : rawType === "node.completed"
                    ? "stage.completed"
                    : "stage.started";
        return {
          schemaVersion: 1,
          sequence: Number(event.sequence ?? index + 1),
          eventId: String(event.eventId ?? `event_${index + 1}`),
          type,
          recordedAt: String(event.recordedAt ?? raw.updatedAt ?? ""),
          stageId: typeof event.nodeId === "string" ? event.nodeId : null,
          activationId: typeof event.activationId === "string" ? event.activationId : null,
          attemptId: typeof event.attemptId === "string" ? event.attemptId : null,
          role: null,
          summary: String(event.summary ?? ""),
          detail: event.detail && typeof event.detail === "object"
            ? event.detail as Record<string, string | number | boolean | null>
            : {},
        };
      }),
      requirements: {
        version: 1,
        derivedAt: String(raw.createdAt ?? ""),
        items: rawRequirements.map((candidate, index) => {
          const item = candidate && typeof candidate === "object"
            ? candidate as Record<string, unknown>
            : {};
          return {
            id: String(item.id ?? `REQ-${index + 1}`),
            text: String(item.text ?? ""),
            category: "deliverable" as const,
            mandatory: true as const,
            source: "original_goal" as const,
          };
        }),
        evidence: rawEvidence.map((candidate) => {
          const item = candidate && typeof candidate === "object"
            ? candidate as Record<string, unknown>
            : {};
          const evidenceStatus = String(item.status ?? "unknown");
          return {
            requirementId: String(item.requirementId ?? ""),
            stageId: phase,
            role: String(raw.currentAgentId ?? "core"),
            status: evidenceStatus === "satisfied"
              ? "SATISFIED" as const
              : evidenceStatus === "unsatisfied"
                ? "FAILED" as const
                : "PARTIAL" as const,
            summary: String(item.evidence ?? ""),
            attemptId: null,
            recordedAt: String(raw.updatedAt ?? ""),
          };
        }),
      },
      convergence: { stagnantCycles: 0, history: [] },
    };
    return result;
  }

  async readProgressNotes(sessionId: string): Promise<string> {
    const cfg = await this.getPathsConfig();
    const notesPath = await this.resolveSessionRuntimePath(
      sessionId,
      cfg.sessionFileNames.progressNotes,
      "Progress notes file"
    );
    try {
      return await fs.readFile(notesPath, "utf8");
    } catch {
      return "";
    }
  }

  async readHistory(sessionId: string): Promise<LoopHistoryEntry[]> {
    const cfg = await this.getPathsConfig();
    const historyDir = await this.resolveSessionRuntimePath(
      sessionId,
      cfg.loopHistoryDirName,
      "Loop history directory"
    );
    try {
      const files = await fs.readdir(historyDir);
      const entries: LoopHistoryEntry[] = [];
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const filePath = await resolveContainedPath(historyDir, file, "Loop history entry");
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
    const summaryPath = await this.resolveSessionRuntimePath(
      sessionId,
      cfg.sessionFileNames.finalSummary,
      "Final summary file"
    );
    return this.readJsonAtomic<FinalSummary>(summaryPath);
  }

  async readBundle(sessionId: string): Promise<SessionBundle> {
    const registry = await this.readRegistry();
    const [state, progressNotes, finalSummary] = await Promise.all([
      this.readState(sessionId),
      this.readProgressNotes(sessionId),
      this.readFinalSummary(sessionId),
    ]);
    return { registry, state, progressNotes, finalSummary };
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
