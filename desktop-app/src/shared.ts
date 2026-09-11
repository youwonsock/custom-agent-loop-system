export type BridgeError = { code: string; message: string };
export type BridgeResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: BridgeError };

export interface ProviderDiscoveryResultV2 {
  schemaVersion: 2;
  providerId: string;
  label: string;
  adapter: string;
  binary: string;
  enabled: boolean;
  available: boolean;
  models: string[];
  discoveredAt: string;
  command: string | null;
  catalogSource: "command" | "configured";
  error: { code: string; message: string } | null;
}

export type RunStatus =
  | "RUNNING" | "WAITING_USER" | "PAUSED" | "SUCCESS"
  | "FAILED" | "STOPPED" | "BLOCKED";

export interface RunProjectionV2 {
  projectionSchemaVersion: 2;
  stateVersion: 5;
  sessionId: string;
  runId: string;
  definitionHash: string;
  revision: number;
  fencingEpoch: number;
  status: RunStatus;
  statusReason: string | null;
  phase: string;
  currentNodeId: string;
  currentAgentId: string | null;
  activeActivation: {
    activationId: string;
    nodeId: string;
    status: string;
    workflowStep: number;
    attemptIds: string[];
    sideEffect: "none" | "workspace_mutation";
  } | null;
  pendingInput: Record<string, unknown> | null;
  goal: string;
  targetProjectPath: string;
  additionalAllowedPaths: string[];
  accessMode: "ask" | "full_access";
  awaitingPlanApproval: boolean;
  planApproved: boolean;
  selectedPlanChoiceId: string | null;
  planChoices: Array<{ id: string; title: string; body: string; verification?: Record<string, unknown> }>;
  interruptBriefing: string | null;
  requirements: Array<Record<string, unknown>>;
  requirementEvidence: Array<Record<string, unknown>>;
  verification: {
    contract: {
      revision: number;
      contractHash: string;
      commands: Array<{
        id: string;
        label: string;
        executable: string;
        args: string[];
        cwd: string;
        timeoutMs: number;
        requirementIds: string[];
      }>;
      totalTimeoutMs: number;
      protectedPaths: string[];
      testRoots: string[];
      allowedNewTestRoots: string[];
      generatedOutputPaths: string[];
      baselineArtifactId: string;
      baselineFingerprint: string;
    } | null;
    elapsedMs: number;
    contractRevision: number | null;
    contractHash: string | null;
    currentVerificationId: string | null;
    currentCommandId: string | null;
    completedCommands: number;
    commandCount: number;
    proofId: string | null;
    proofValid: boolean;
    pendingApproval: Record<string, unknown> | null;
    criteriaChanges?: string[];
    invalidationReason: string | null;
    commands: Array<Record<string, unknown>>;
  };
  budgets: {
    workflowSteps: { consumed: number; limit: number; remaining: number };
    cycles: { consumed: number; completed: number; limit: number; remaining: number };
  };
  latestEvent: Record<string, unknown> | null;
  events: Array<Record<string, unknown>>;
  createdAt: string;
  updatedAt: string;
}

export interface SessionIndexProjectionV4 {
  version: 4;
  activeSessionIds: string[];
  sessionMetas: Array<{
    sessionId: string;
    goal: string;
    targetProjectPath: string;
    status: RunStatus;
    createdAt: string;
  }>;
  availableModels: string[];
  modelsDiscoveredAt: string | null;
  modelsDiscoveredCli: string | null;
  manualModelsOverride: null;
  modelVariants: Record<string, string[]> | null;
  providerCatalog: Record<string, ProviderDiscoveryResultV2>;
}

export interface SessionBundle {
  projection: RunProjectionV2;
  progress: string;
  plan: string | null;
  summary: Record<string, unknown> | null;
}

export interface OperatorSnapshotV3 {
  schemaVersion: 3;
  capturedAt: string;
  projection: RunProjectionV2 | null;
  sessionIndex: SessionIndexProjectionV4;
  settings: Record<string, unknown> | null;
  providerDiscovery: ProviderDiscoveryResultV2[];
}

/** DesktopSnapshot is the renderer-friendly name for the shared operator contract. */
export type DesktopSnapshot = OperatorSnapshotV3;

export interface DesktopSettings {
  paths: Record<string, unknown>;
  providers: Record<string, Record<string, unknown>>;
  toolAccess: Record<string, unknown>;
  defaults: Record<string, unknown>;
  variantDefaults: Record<string, string[]>;
}

const PROVIDER_KEYS = new Set(["label", "adapter", "binary", "enabled", "modelCatalog", "interactionWhitelist", "capabilities"]);
const PROVIDER_ADAPTERS = new Set(["opencode", "kilo", "codex", "claude"]);
const PATH_KEYS = new Set(["sessionsRoot", "registryFileName", "sessionsIndexFileName", "variantsConfigFileName", "loopHistoryDirName", "sessionFileNames", "roomFileNames", "roomDirNames", "controlDirName", "ownerLockFileName", "stateLockFileName", "leaseFileName", "registryLockFileName", "attemptLogsDirName", "verificationLogsDirName"]);
const DEFAULT_KEYS = new Set(["cliBinary", "maxCycles", "phaseTimeoutMs", "idleTimeoutMs", "ptyCols", "ptyRows", "transportTimeoutMs", "toolTimeoutMs", "maxAgentAttempts", "retryBackoffMs", "terminationGraceMs", "killTimeoutMs", "heartbeatIntervalMs", "leaseTtlMs", "maxInMemoryOutputBytes"]);
const MCP_KEYS = new Set(["id", "name", "enabled", "type", "command", "args", "url", "environment", "headers", "timeoutMs", "tools", "allowedTools"]);
const SETTINGS_KEYS = new Set(["paths", "providers", "toolAccess", "defaults", "variantDefaults"]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const SAFE_PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;

function validateProviderSettings(value: unknown, providerId: string): Record<string, unknown> {
  const provider = recordValue(value, `settings.providers.${providerId}`);
  for (const key of Object.keys(provider)) {
    if (!PROVIDER_KEYS.has(key)) throw new Error(`settings.providers.${providerId} contains unsupported field '${key}'.`);
  }
  if (typeof provider.label !== "string" || !provider.label.trim()) throw new Error(`settings.providers.${providerId}.label must be a non-empty string.`);
  if (typeof provider.adapter !== "string" || !PROVIDER_ADAPTERS.has(provider.adapter)) throw new Error(`settings.providers.${providerId}.adapter is invalid.`);
  if (typeof provider.binary !== "string" || !provider.binary.trim()) throw new Error(`settings.providers.${providerId}.binary must be a non-empty string.`);
  if (provider.enabled !== undefined && typeof provider.enabled !== "boolean") throw new Error(`settings.providers.${providerId}.enabled must be boolean.`);
  const catalog = recordValue(provider.modelCatalog, `settings.providers.${providerId}.modelCatalog`);
  for (const key of Object.keys(catalog)) {
    if (catalog.source === "command" && key !== "source" && key !== "args") throw new Error(`settings.providers.${providerId}.modelCatalog contains unsupported field '${key}'.`);
    if (catalog.source === "configured" && key !== "source" && key !== "models") throw new Error(`settings.providers.${providerId}.modelCatalog contains unsupported field '${key}'.`);
  }
  if (catalog.source === "command") {
    if (provider.adapter !== "opencode" && provider.adapter !== "kilo") throw new Error(`settings.providers.${providerId}.modelCatalog must use configured models for ${provider.adapter}.`);
    if (!Array.isArray(catalog.args) || catalog.args.length === 0 || catalog.args.some((entry) => typeof entry !== "string" || !entry.trim())) throw new Error(`settings.providers.${providerId}.modelCatalog.args must be a non-empty string array.`);
  } else if (catalog.source === "configured") {
    if (provider.adapter !== "codex" && provider.adapter !== "claude") throw new Error(`settings.providers.${providerId}.modelCatalog must use command discovery for ${provider.adapter}.`);
    if (!Array.isArray(catalog.models) || catalog.models.length === 0 || catalog.models.some((entry) => typeof entry !== "string" || !entry.trim())) throw new Error(`settings.providers.${providerId}.modelCatalog.models must be a non-empty string array.`);
  } else {
    throw new Error(`settings.providers.${providerId}.modelCatalog.source is invalid.`);
  }
  if (provider.interactionWhitelist !== undefined && (!Array.isArray(provider.interactionWhitelist) || provider.interactionWhitelist.some((entry) => typeof entry !== "string"))) throw new Error(`settings.providers.${providerId}.interactionWhitelist must be an array of strings.`);
  if (provider.capabilities !== undefined) recordValue(provider.capabilities, `settings.providers.${providerId}.capabilities`);
  return provider;
}

function validatePathSettings(value: Record<string, unknown>): void {
  for (const key of Object.keys(value)) if (!PATH_KEYS.has(key)) throw new Error(`settings.paths contains unsupported field '${key}'.`);
  for (const key of ["sessionsRoot", "registryFileName", "sessionsIndexFileName", "variantsConfigFileName", "loopHistoryDirName", "controlDirName", "ownerLockFileName", "stateLockFileName", "leaseFileName", "registryLockFileName", "attemptLogsDirName", "verificationLogsDirName"]) {
    if (typeof value[key] !== "string" || !String(value[key]).trim()) throw new Error(`settings.paths.${key} must be a non-empty string.`);
  }
  for (const key of ["sessionFileNames", "roomFileNames", "roomDirNames"]) {
    const child = recordValue(value[key], `settings.paths.${key}`);
    if (key === "sessionFileNames") {
      const allowed = new Set(["state", "progressNotes", "finalSummary", "plan", "planChoices", "planOverview", "planOptionsDir", "interruptMessage", "stopRequest"]);
      for (const childKey of Object.keys(child)) if (!allowed.has(childKey)) throw new Error(`settings.paths.sessionFileNames contains unsupported field '${childKey}'.`);
      for (const childKey of ["state", "progressNotes", "finalSummary", "plan", "planChoices", "planOverview", "planOptionsDir", "interruptMessage", "stopRequest"]) if (typeof child[childKey] !== "string" || !String(child[childKey]).trim()) throw new Error(`settings.paths.sessionFileNames.${childKey} must be a non-empty string.`);
    }
    if (key === "roomFileNames") {
      const allowed = new Set(["state", "skills", "input", "output"]);
      for (const childKey of Object.keys(child)) if (!allowed.has(childKey)) throw new Error(`settings.paths.roomFileNames contains unsupported field '${childKey}'.`);
      for (const childKey of ["state", "skills", "input", "output"]) if (typeof child[childKey] !== "string" || !String(child[childKey]).trim()) throw new Error(`settings.paths.roomFileNames.${childKey} must be a non-empty string.`);
    }
    for (const childValue of Object.values(child)) if (typeof childValue !== "string" || !childValue.trim()) throw new Error(`settings.paths.${key} values must be non-empty strings.`);
  }
}

function validateToolSettings(value: Record<string, unknown>): void {
  for (const key of Object.keys(value)) if (key !== "webSearch" && key !== "mcpServers") throw new Error(`settings.toolAccess contains unsupported field '${key}'.`);
  const web = recordValue(value.webSearch, "settings.toolAccess.webSearch");
  for (const key of Object.keys(web)) if (key !== "enabled" && key !== "mode") throw new Error(`settings.toolAccess.webSearch contains unsupported field '${key}'.`);
  if (typeof web.enabled !== "boolean" || (web.mode !== "cached" && web.mode !== "live")) throw new Error("settings.toolAccess.webSearch is invalid.");
  if (!Array.isArray(value.mcpServers)) throw new Error("settings.toolAccess.mcpServers must be an array.");
  const ids = new Set<string>();
  value.mcpServers.forEach((raw, index) => {
    const server = recordValue(raw, `settings.toolAccess.mcpServers[${index}]`);
    for (const key of Object.keys(server)) if (!MCP_KEYS.has(key)) throw new Error(`MCP server contains unsupported field '${key}'.`);
    if (typeof server.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(server.id) || ids.has(server.id)) throw new Error(`settings.toolAccess.mcpServers[${index}].id is invalid.`);
    ids.add(server.id);
    if (typeof server.name !== "string" || !server.name.trim() || typeof server.enabled !== "boolean" || (server.type !== "local" && server.type !== "remote")) throw new Error(`settings.toolAccess.mcpServers[${index}] identity is invalid.`);
    if (server.type === "local" && (typeof server.command !== "string" || !server.command.trim())) throw new Error(`MCP server ${server.id} needs a command.`);
    if (server.type === "remote" && (typeof server.url !== "string" || !/^https?:\/\//iu.test(server.url))) throw new Error(`MCP server ${server.id} needs an http(s) URL.`);
    for (const field of ["environment", "headers"] as const) {
      if (server[field] === undefined) continue;
      const values = recordValue(server[field], `MCP server ${server.id}.${field}`);
      for (const [name, configured] of Object.entries(values)) {
        if (field === "environment" && !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) throw new Error(`MCP server ${server.id} has an invalid environment name.`);
        if (typeof configured !== "string" || !/^\$\{(?:secret|env):[^}]+\}$/u.test(configured)) throw new Error(`MCP server ${server.id} credentials must use references.`);
      }
    }
    if (server.args !== undefined && (!Array.isArray(server.args) || server.args.some((entry) => typeof entry !== "string"))) throw new Error(`MCP server ${server.id}.args must be an array of strings.`);
    if (server.timeoutMs !== undefined && (!Number.isSafeInteger(server.timeoutMs) || Number(server.timeoutMs) <= 0)) throw new Error(`MCP server ${server.id}.timeoutMs must be positive.`);
    if (server.tools !== undefined && (!Array.isArray(server.tools) || server.tools.some((tool) => {
      const candidate = tool && typeof tool === "object" && !Array.isArray(tool) ? tool as Record<string, unknown> : null;
      if (candidate) for (const key of Object.keys(candidate)) if (key !== "name" && key !== "sideEffect") return true;
      return !candidate || typeof candidate.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(candidate.name) || !["read_only", "write", "unknown"].includes(String(candidate.sideEffect));
    }))) throw new Error(`MCP server ${server.id}.tools is invalid.`);
    if (server.allowedTools !== undefined && !Array.isArray(server.tools)) throw new Error(`MCP server ${server.id} must classify tools before setting allowedTools.`);
    if (server.allowedTools !== undefined && (!Array.isArray(server.allowedTools) || server.allowedTools.some((entry) => typeof entry !== "string"))) throw new Error(`MCP server ${server.id}.allowedTools is invalid.`);
    if (Array.isArray(server.allowedTools) && Array.isArray(server.tools)) {
      const declared = new Set(server.tools.flatMap((tool) => {
        if (!tool || typeof tool !== "object" || Array.isArray(tool)) return [];
        const name = (tool as Record<string, unknown>).name;
        return typeof name === "string" ? [name] : [];
      }));
      if (server.allowedTools.some((entry) => !declared.has(entry))) throw new Error(`MCP server ${server.id}.allowedTools contains an undeclared tool.`);
    }
  });
}

function validateDefaultSettings(value: Record<string, unknown>): void {
  for (const key of Object.keys(value)) if (!DEFAULT_KEYS.has(key)) throw new Error(`settings.defaults contains unsupported field '${key}'.`);
  if (typeof value.cliBinary !== "string" || !value.cliBinary.trim()) throw new Error("settings.defaults.cliBinary must be a non-empty string.");
  for (const key of ["maxCycles", "phaseTimeoutMs", "idleTimeoutMs", "ptyCols", "ptyRows", "transportTimeoutMs", "toolTimeoutMs", "maxAgentAttempts", "terminationGraceMs", "killTimeoutMs", "heartbeatIntervalMs", "leaseTtlMs", "maxInMemoryOutputBytes"]) if (!Number.isSafeInteger(value[key]) || Number(value[key]) < 1) throw new Error(`settings.defaults.${key} must be a positive integer.`);
  if (!Array.isArray(value.retryBackoffMs) || value.retryBackoffMs.some((entry) => !Number.isSafeInteger(entry) || Number(entry) < 0)) throw new Error("settings.defaults.retryBackoffMs is invalid.");
  if (Number(value.transportTimeoutMs) > Number(value.phaseTimeoutMs) || Number(value.idleTimeoutMs) > Number(value.phaseTimeoutMs) || Number(value.toolTimeoutMs) > Number(value.phaseTimeoutMs)) throw new Error("Provider timeouts must not exceed phaseTimeoutMs.");
  if (Number(value.heartbeatIntervalMs) >= Number(value.leaseTtlMs)) throw new Error("heartbeatIntervalMs must be lower than leaseTtlMs.");
  if (Number(value.terminationGraceMs) > Number(value.killTimeoutMs)) throw new Error("terminationGraceMs must not exceed killTimeoutMs.");
  if (Number(value.maxInMemoryOutputBytes) < 1024) throw new Error("maxInMemoryOutputBytes must be at least 1024 bytes.");
}

function recordValue(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object.`);
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string.`);
  return value;
}

function nullableString(value: unknown, field: string): void {
  if (value !== null && typeof value !== "string") throw new Error(`${field} must be a string or null.`);
}

export function validateRunProjectionV2(value: unknown): RunProjectionV2 {
  const candidate = recordValue(value, "projection");
  if (candidate.projectionSchemaVersion !== 2 || candidate.stateVersion !== 5) throw new Error("Desktop projection must use schema 2/state 5.");
  for (const field of ["sessionId", "runId", "definitionHash", "goal", "targetProjectPath", "phase", "currentNodeId", "createdAt", "updatedAt"] as const) stringValue(candidate[field], `projection.${field}`);
  if (!SAFE_ID.test(String(candidate.sessionId)) || candidate.sessionId !== candidate.runId) throw new Error("projection session identity is invalid.");
  for (const field of ["createdAt", "updatedAt"] as const) if (!Number.isFinite(Date.parse(String(candidate[field])))) throw new Error(`projection.${field} is invalid.`);
  for (const field of ["revision", "fencingEpoch"] as const) {
    if (!Number.isSafeInteger(candidate[field]) || Number(candidate[field]) < 0) throw new Error(`projection.${field} must be a non-negative integer.`);
  }
  if (!(["RUNNING", "WAITING_USER", "PAUSED", "SUCCESS", "FAILED", "STOPPED", "BLOCKED"] as string[]).includes(String(candidate.status))) throw new Error("projection.status is invalid.");
  for (const field of ["statusReason", "currentAgentId", "selectedPlanChoiceId", "interruptBriefing"] as const) nullableString(candidate[field], `projection.${field}`);
  if (candidate.accessMode !== "ask" && candidate.accessMode !== "full_access") throw new Error("projection.accessMode is invalid.");
  if (typeof candidate.awaitingPlanApproval !== "boolean" || typeof candidate.planApproved !== "boolean") throw new Error("projection plan flags are invalid.");
  for (const field of ["pendingInput", "latestEvent"] as const) {
    if (candidate[field] !== null) recordValue(candidate[field], `projection.${field}`);
  }
  const paths = candidate.additionalAllowedPaths;
  if (!Array.isArray(paths) || paths.some((entry) => typeof entry !== "string")) throw new Error("projection.additionalAllowedPaths is invalid.");
  for (const field of ["requirements", "requirementEvidence", "events"] as const) {
    const values = candidate[field];
    if (!Array.isArray(values) || values.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry))) throw new Error(`projection.${field} is invalid.`);
  }
  if (candidate.activeActivation !== null) {
    const active = recordValue(candidate.activeActivation, "projection.activeActivation");
    for (const field of ["activationId", "nodeId", "status"] as const) stringValue(active[field], `projection.activeActivation.${field}`);
    if (!Number.isSafeInteger(active.workflowStep) || Number(active.workflowStep) < 0 || !Array.isArray(active.attemptIds) || active.attemptIds.some((entry) => typeof entry !== "string") || (active.sideEffect !== "none" && active.sideEffect !== "workspace_mutation")) throw new Error("projection.activeActivation is invalid.");
  }
  if (candidate.verification !== undefined) {
    const verification = recordValue(candidate.verification, "projection.verification");
    if (verification.contract !== undefined && verification.contract !== null) {
      const contract = recordValue(verification.contract, "projection.verification.contract");
      if (!Number.isSafeInteger(contract.revision) || Number(contract.revision) < 1 ||
          typeof contract.contractHash !== "string" || !/^[a-f0-9]{64}$/u.test(contract.contractHash) ||
          typeof contract.baselineArtifactId !== "string" || !contract.baselineArtifactId.trim() ||
          typeof contract.baselineFingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(contract.baselineFingerprint)) {
        throw new Error("projection.verification.contract metadata is invalid.");
      }
      if (!Array.isArray(contract.commands) || !Number.isSafeInteger(contract.totalTimeoutMs) || Number(contract.totalTimeoutMs) < 1) {
        throw new Error("projection.verification.contract is invalid.");
      }
      for (const [index, rawCommand] of contract.commands.entries()) {
        const command = recordValue(rawCommand, `projection.verification.contract.commands[${index}]`);
        for (const field of ["id", "label", "executable", "cwd"] as const) stringValue(command[field], `projection.verification.contract.commands[${index}].${field}`);
        if (!Array.isArray(command.args) || command.args.some((arg) => typeof arg !== "string") ||
            !Number.isSafeInteger(command.timeoutMs) || Number(command.timeoutMs) < 1 ||
            !Array.isArray(command.requirementIds) || command.requirementIds.some((id) => typeof id !== "string")) {
          throw new Error(`projection.verification.contract.commands[${index}] is invalid.`);
        }
      }
      for (const field of ["protectedPaths", "testRoots", "allowedNewTestRoots", "generatedOutputPaths"] as const) {
        if (!Array.isArray(contract[field]) || contract[field].some((entry) => typeof entry !== "string")) {
          throw new Error(`projection.verification.contract.${field} is invalid.`);
        }
      }
    }
    if (verification.elapsedMs !== undefined &&
        (!Number.isSafeInteger(verification.elapsedMs) || Number(verification.elapsedMs) < 0)) {
      throw new Error("projection.verification.elapsedMs is invalid.");
    }
    if (verification.contractRevision !== null &&
        (!Number.isSafeInteger(verification.contractRevision) || Number(verification.contractRevision) < 0)) {
      throw new Error("projection.verification.contractRevision is invalid.");
    }
    if (verification.contractHash !== null && typeof verification.contractHash !== "string") {
      throw new Error("projection.verification.contractHash is invalid.");
    }
    if (typeof verification.proofValid !== "boolean") throw new Error("projection.verification.proofValid is invalid.");
    if (verification.criteriaChanges !== undefined &&
        (!Array.isArray(verification.criteriaChanges) ||
         verification.criteriaChanges.some((entry) => typeof entry !== "string" || !entry.trim()))) {
      throw new Error("projection.verification.criteriaChanges is invalid.");
    }
    if (verification.resultArtifactId !== undefined && verification.resultArtifactId !== null && typeof verification.resultArtifactId !== "string") {
      throw new Error("projection.verification.resultArtifactId is invalid.");
    }
    if (!Array.isArray(verification.commands)) throw new Error("projection.verification.commands is invalid.");
    verification.commands.forEach((command, commandIndex) => {
      const item = recordValue(command, `projection.verification.commands[${commandIndex}]`);
      stringValue(item.commandId, `projection.verification.commands[${commandIndex}].commandId`);
      stringValue(item.status, `projection.verification.commands[${commandIndex}].status`);
      if (item.executable !== undefined) stringValue(item.executable, `projection.verification.commands[${commandIndex}].executable`);
      if (item.args !== undefined && (!Array.isArray(item.args) || item.args.some((arg) => typeof arg !== "string"))) throw new Error(`projection.verification.commands[${commandIndex}].args is invalid.`);
      if (item.cwd !== undefined) stringValue(item.cwd, `projection.verification.commands[${commandIndex}].cwd`);
      if (item.exitCode !== null && !Number.isSafeInteger(item.exitCode)) throw new Error(`projection.verification.commands[${commandIndex}].exitCode is invalid.`);
      nullableString(item.signal, `projection.verification.commands[${commandIndex}].signal`);
      if (typeof item.timedOut !== "boolean" || (item.processTreeClean !== null && typeof item.processTreeClean !== "boolean")) throw new Error(`projection.verification.commands[${commandIndex}] process state is invalid.`);
      stringValue(item.summary, `projection.verification.commands[${commandIndex}].summary`);
      if (item.elapsedMs !== undefined && (!Number.isSafeInteger(item.elapsedMs) || Number(item.elapsedMs) < 0)) throw new Error(`projection.verification.commands[${commandIndex}].elapsedMs is invalid.`);
      if (item.outputTruncated !== undefined && typeof item.outputTruncated !== "boolean") throw new Error(`projection.verification.commands[${commandIndex}].outputTruncated is invalid.`);
    });
  }
  if (!Array.isArray(candidate.planChoices)) throw new Error("projection.planChoices is invalid.");
  candidate.planChoices.forEach((choice, index) => {
    const item = recordValue(choice, `projection.planChoices[${index}]`);
    for (const field of ["id", "title", "body"] as const) stringValue(item[field], `projection.planChoices[${index}].${field}`);
    if (item.verification !== undefined) {
      const verification = recordValue(item.verification, `projection.planChoices[${index}].verification`);
      if (!Array.isArray(verification.commands) || verification.commands.length < 1 || verification.commands.length > 10) throw new Error(`projection.planChoices[${index}].verification.commands is invalid.`);
      verification.commands.forEach((command, commandIndex) => {
        const candidate = recordValue(command, `projection.planChoices[${index}].verification.commands[${commandIndex}]`);
        for (const field of ["id", "label"] as const) stringValue(candidate[field], `projection.planChoices[${index}].verification.commands[${commandIndex}].${field}`);
        stringValue(candidate.executable, `projection.planChoices[${index}].verification.commands[${commandIndex}].executable`);
        stringValue(candidate.cwd, `projection.planChoices[${index}].verification.commands[${commandIndex}].cwd`);
        if (!Array.isArray(candidate.args) || !Array.isArray(candidate.requirementIds) || !Number.isSafeInteger(candidate.timeoutMs) || Number(candidate.timeoutMs) < 1) throw new Error(`projection.planChoices[${index}].verification.commands[${commandIndex}] is invalid.`);
        if (candidate.args.some((arg) => typeof arg !== "string")) throw new Error(`projection.planChoices[${index}].verification.commands[${commandIndex}].args is invalid.`);
        if (candidate.requirementIds.some((id) => typeof id !== "string")) throw new Error(`projection.planChoices[${index}].verification.commands[${commandIndex}].requirementIds is invalid.`);
      });
    }
  });
  const budgets = recordValue(candidate.budgets, "projection.budgets");
  for (const field of ["workflowSteps", "cycles"] as const) {
    const budget = recordValue(budgets[field], `projection.budgets.${field}`);
    for (const numberField of ["consumed", "limit", "remaining"] as const) {
      if (!Number.isSafeInteger(budget[numberField]) || Number(budget[numberField]) < 0) throw new Error(`projection.budgets.${field}.${numberField} is invalid.`);
    }
    if (field === "cycles" && (!Number.isSafeInteger(budget.completed) || Number(budget.completed) < 0)) throw new Error("projection.budgets.cycles.completed is invalid.");
  }
  const verification = recordValue(candidate.verification, "projection.verification");
  if (verification.contract === undefined || verification.elapsedMs === undefined) {
    throw new Error("Desktop v2 verification projection is missing contract progress fields.");
  }
  const commands = verification.commands;
  if (!Array.isArray(commands)) throw new Error("projection.verification.commands is invalid.");
  commands.forEach((command, commandIndex) => {
    const item = recordValue(command, `projection.verification.commands[${commandIndex}]`);
    stringValue(item.executable, `projection.verification.commands[${commandIndex}].executable`);
    if (!Array.isArray(item.args) || item.args.some((arg) => typeof arg !== "string")) throw new Error(`projection.verification.commands[${commandIndex}].args is invalid.`);
    stringValue(item.cwd, `projection.verification.commands[${commandIndex}].cwd`);
  });
  return value as RunProjectionV2;
}

export function validateSessionIndexProjectionV4(value: unknown): SessionIndexProjectionV4 {
  const index = recordValue(value, "session index");
  if (index.version !== 4 || !Array.isArray(index.activeSessionIds) || !Array.isArray(index.sessionMetas) || !Array.isArray(index.availableModels) || index.manualModelsOverride !== null || (index.modelVariants !== null && (typeof index.modelVariants !== "object" || Array.isArray(index.modelVariants))) || !index.providerCatalog || typeof index.providerCatalog !== "object" || Array.isArray(index.providerCatalog)) throw new Error("Desktop session index must use the strict version 4 contract.");
  if (index.activeSessionIds.some((entry) => typeof entry !== "string" || !SAFE_ID.test(String(entry))) || new Set(index.activeSessionIds).size !== index.activeSessionIds.length || index.availableModels.some((entry) => typeof entry !== "string" || !String(entry).trim())) throw new Error("Desktop session index contains invalid identifiers.");
  if (index.modelsDiscoveredAt !== null && (typeof index.modelsDiscoveredAt !== "string" || !Number.isFinite(Date.parse(index.modelsDiscoveredAt)))) throw new Error("Desktop session index modelsDiscoveredAt is invalid.");
  if (index.modelsDiscoveredCli !== null && (typeof index.modelsDiscoveredCli !== "string" || !index.modelsDiscoveredCli.trim())) throw new Error("Desktop session index modelsDiscoveredCli is invalid.");
  const ids = new Set<string>();
  index.sessionMetas.forEach((meta, indexNumber) => {
    const item = recordValue(meta, `session index sessionMetas[${indexNumber}]`);
    for (const field of ["sessionId", "goal", "targetProjectPath", "createdAt"] as const) stringValue(item[field], `sessionMetas[${indexNumber}].${field}`);
    if (!String(item.goal).trim() || !String(item.targetProjectPath).trim() || !Number.isFinite(Date.parse(String(item.createdAt))) || !["RUNNING", "WAITING_USER", "PAUSED", "SUCCESS", "FAILED", "STOPPED", "BLOCKED"].includes(String(item.status)) || ids.has(String(item.sessionId))) throw new Error(`Desktop session index sessionMetas[${indexNumber}] is invalid.`);
    ids.add(String(item.sessionId));
  });
  if (index.activeSessionIds.some((entry) => !ids.has(String(entry)))) throw new Error("Desktop session index active metadata is missing.");
  if (index.modelVariants !== null) {
    for (const [provider, models] of Object.entries(index.modelVariants as Record<string, unknown>)) {
      if (!Array.isArray(models) || models.some((entry) => typeof entry !== "string" || !entry.trim())) throw new Error(`Desktop session index modelVariants.${provider} is invalid.`);
    }
  }
  for (const [providerId, discovery] of Object.entries(index.providerCatalog as Record<string, unknown>)) {
    validateProviderDiscoveryResultV2(discovery);
    if ((discovery as ProviderDiscoveryResultV2).providerId !== providerId) throw new Error(`Desktop session index providerCatalog key mismatch: ${providerId}.`);
  }
  return value as SessionIndexProjectionV4;
}

/** Validate data crossing the packaged core/desktop boundary before rendering. */
export function validateProviderDiscoveryResultV2(value: unknown): ProviderDiscoveryResultV2 {
  const candidate = recordValue(value, "provider discovery");
  if (candidate.schemaVersion !== 2) throw new Error("Provider discovery schema must be version 2.");
  for (const field of ["providerId", "label", "adapter", "binary", "discoveredAt"] as const) stringValue(candidate[field], field);
  if (!PROVIDER_ADAPTERS.has(String(candidate.adapter))) throw new Error("Provider discovery adapter is invalid.");
  if (!SAFE_ID.test(String(candidate.providerId)) || !String(candidate.label).trim() || !String(candidate.binary).trim()) throw new Error("Provider discovery identity is invalid.");
  if (typeof candidate.enabled !== "boolean" || typeof candidate.available !== "boolean") throw new Error("Provider discovery availability fields must be boolean.");
  if (!Array.isArray(candidate.models) || candidate.models.some((model) => typeof model !== "string" || !model.trim())) throw new Error("Provider discovery models must be strings.");
  if (candidate.catalogSource !== "command" && candidate.catalogSource !== "configured") throw new Error("Provider discovery catalogSource is invalid.");
  if ((candidate.adapter === "opencode" || candidate.adapter === "kilo") && candidate.catalogSource !== "command") throw new Error("OpenCode/Kilo discovery must use a command catalog.");
  if ((candidate.adapter === "codex" || candidate.adapter === "claude") && candidate.catalogSource !== "configured") throw new Error("Codex/Claude discovery must use a configured catalog.");
  nullableString(candidate.command, "command");
  if (!Number.isFinite(Date.parse(String(candidate.discoveredAt)))) throw new Error("discoveredAt is invalid.");
  if (candidate.catalogSource === "command" && candidate.available && typeof candidate.command !== "string") throw new Error("Command catalog discovery must include its command.");
  if (candidate.catalogSource === "configured" && candidate.command !== null) throw new Error("Configured catalog discovery cannot include a command.");
  if (candidate.catalogSource === "command" && typeof candidate.command === "string" && !candidate.command.trim()) throw new Error("Provider discovery command must not be empty.");
  if (candidate.error !== null) {
    const error = recordValue(candidate.error, "error");
    stringValue(error.code, "error.code");
    stringValue(error.message, "error.message");
    if (!String(error.code).trim() || !String(error.message).trim()) throw new Error("Provider discovery error code/message must not be empty.");
  }
  if (candidate.available && candidate.error !== null) throw new Error("Available provider discovery cannot contain an error.");
  if (!candidate.available && candidate.error === null) throw new Error("Unavailable provider discovery must contain an error.");
  if (candidate.available && candidate.models.length === 0) throw new Error("Available provider discovery must contain at least one model.");
  if (!candidate.available && candidate.models.length > 0) throw new Error("Unavailable provider discovery cannot contain models.");
  return value as ProviderDiscoveryResultV2;
}

export function validateModelDiscoveryPayload(value: unknown): {
  schemaVersion: 2;
  discoveredAt: string | null;
  providers: ProviderDiscoveryResultV2[];
  models: string[];
} {
  const candidate = recordValue(value, "models discovery");
  if (candidate.schemaVersion !== 2) throw new Error("Models discovery schema must be version 2.");
  nullableString(candidate.discoveredAt, "discoveredAt");
  if (candidate.discoveredAt !== null && !Number.isFinite(Date.parse(String(candidate.discoveredAt)))) throw new Error("Models discovery discoveredAt is invalid.");
  if (!Array.isArray(candidate.providers)) throw new Error("Models discovery providers must be an array.");
  const providers = candidate.providers.map(validateProviderDiscoveryResultV2);
  const providerIds = new Set<string>();
  for (const provider of providers) {
    if (providerIds.has(provider.providerId)) throw new Error(`Models discovery contains duplicate provider id: ${provider.providerId}`);
    providerIds.add(provider.providerId);
  }
  if (!Array.isArray(candidate.models) || candidate.models.some((model) => typeof model !== "string" || !model.trim())) throw new Error("Models discovery models must be non-empty strings.");
  return { schemaVersion: 2, discoveredAt: candidate.discoveredAt as string | null, providers, models: candidate.models as string[] };
}

export function validateDesktopSnapshot(value: unknown): DesktopSnapshot {
  const candidate = recordValue(value, "desktop snapshot");
  if (candidate.schemaVersion !== 3) throw new Error("Desktop snapshot schema must be version 3.");
  stringValue(candidate.capturedAt, "capturedAt");
  if (!Number.isFinite(Date.parse(String(candidate.capturedAt)))) throw new Error("capturedAt is invalid.");
  if (candidate.projection !== null) {
    validateRunProjectionV2(candidate.projection);
  }
  validateSessionIndexProjectionV4(candidate.sessionIndex);
  if (!Array.isArray(candidate.providerDiscovery)) throw new Error("Desktop snapshot provider discovery must be an array.");
  candidate.providerDiscovery.forEach(validateProviderDiscoveryResultV2);
  if (candidate.settings !== null) validateDesktopSettings(candidate.settings);
  return value as DesktopSnapshot;
}

/** Runtime schema guard used for IPC settings payloads before persistence. */
export function validateDesktopSettings(value: unknown): DesktopSettings {
  const candidate = recordValue(value, "settings");
  for (const key of Object.keys(candidate)) if (!SETTINGS_KEYS.has(key)) throw new Error(`settings contains unsupported field '${key}'.`);
  const paths = recordValue(candidate.paths, "settings.paths");
  const providers = recordValue(candidate.providers, "settings.providers");
  const toolAccess = recordValue(candidate.toolAccess, "settings.toolAccess");
  const defaults = recordValue(candidate.defaults, "settings.defaults");
  const variants = recordValue(candidate.variantDefaults, "settings.variantDefaults");
  validatePathSettings(paths);
  validateToolSettings(toolAccess);
  validateDefaultSettings(defaults);
  for (const [id, provider] of Object.entries(providers)) {
    if (!SAFE_PROVIDER_ID.test(id)) throw new Error(`settings.providers.${id} has an unsafe provider id.`);
    validateProviderSettings(provider, id);
  }
  for (const [id, values] of Object.entries(variants)) {
    if (!Array.isArray(values) || values.some((entry) => typeof entry !== "string" || !entry.trim())) throw new Error(`settings.variantDefaults.${id} must be an array of non-empty strings.`);
  }
  return { paths, providers: providers as DesktopSettings["providers"], toolAccess, defaults, variantDefaults: variants as DesktopSettings["variantDefaults"] };
}

export interface ReleaseFailure {
  resource: "session" | "process" | "poller" | "listener" | "tray" | "lock" | "temporary-file";
  resourceId: string | null;
  code: string;
  message: string;
}

export interface ReleaseResult {
  releasedSessionIds: string[];
  failures: ReleaseFailure[];
}

export interface DesktopBridge {
  getStartupStatus(): Promise<BridgeResult<{ ready: boolean; lifecycle: "new" | "initializing" | "initialized" | "releasing" | "released" | "failed"; error: string | null; configRoot: string; dataRoot: string }>>;
  openProfileFolder(kind: "config" | "data"): Promise<BridgeResult<void>>;
  getSnapshot(sessionId?: string): Promise<BridgeResult<DesktopSnapshot>>;
  getSessionBundle(sessionId: string): Promise<BridgeResult<SessionBundle>>;
  getSettings(): Promise<BridgeResult<DesktopSettings>>;
  chooseProjectDirectory(): Promise<BridgeResult<string | null>>;
  chooseProviderBinary(): Promise<BridgeResult<string | null>>;
  startSession(input: { goal: string; projectPath: string; accessMode?: "ask" | "full_access"; sessionId?: string }): Promise<BridgeResult<{ sessionId: string }>>;
  resumeSession(sessionId: string): Promise<BridgeResult<{ sessionId: string }>>;
  stopSession(sessionId: string): Promise<BridgeResult<DesktopSnapshot>>;
  interruptSession(sessionId: string, message: string): Promise<BridgeResult<DesktopSnapshot>>;
  deleteSession(sessionId: string): Promise<BridgeResult<{ sessionId: string }>>;
  resolveAccessRequest(sessionId: string, approved: boolean): Promise<BridgeResult<DesktopSnapshot>>;
  setAccessMode(sessionId: string, mode: "ask" | "full_access"): Promise<BridgeResult<DesktopSnapshot>>;
  selectPlanChoice(sessionId: string, choiceId: string): Promise<BridgeResult<{ choiceId: string }>>;
  approvePlan(sessionId: string, choiceId?: string): Promise<BridgeResult<{ sessionId: string }>>;
  revisePlan(sessionId: string, message: string): Promise<BridgeResult<{ sessionId: string }>>;
  approveVerification(sessionId: string, requestId: string, candidateHash: string): Promise<BridgeResult<{ sessionId: string }>>;
  rejectVerification(sessionId: string, requestId: string, candidateHash: string, message: string): Promise<BridgeResult<{ sessionId: string }>>;
  saveSettings(settings: DesktopSettings, secrets?: Record<string, string>): Promise<BridgeResult<DesktopSettings>>;
  discoverModels(): Promise<BridgeResult<{ schemaVersion: 2; discoveredAt: string | null; providers: ProviderDiscoveryResultV2[]; models: string[] }>>;
  revealSessionFolder(sessionId: string): Promise<BridgeResult<void>>;
  requestQuit(): Promise<BridgeResult<ReleaseResult>>;
  openExternal(url: string): Promise<BridgeResult<void>>;
  onStateInvalidated(listener: (snapshot: DesktopSnapshot) => void): () => void;
  onLog(listener: (event: { sessionId: string; stream: "stdout" | "stderr"; text: string }) => void): () => void;
  onNotification(listener: (event: { level: "info" | "warning" | "error"; message: string }) => void): () => void;
}
