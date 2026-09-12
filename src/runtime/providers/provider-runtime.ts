import * as path from "node:path";
import { createHash } from "node:crypto";
import {
  ProviderAdapter,
  ProviderCapabilityStatus,
  ProviderCapabilities,
  assertProviderCapabilities,
  capabilitiesForAdapter,
} from "./provider-capabilities";

export {
  ProviderAdapter,
  ProviderCapabilityStatus,
  ProviderCapabilities,
  resolveProviderCapability,
} from "./provider-capabilities";

export type ProviderModelCatalog =
  | { source: "command"; args: string[] }
  | { source: "configured"; models: string[] };

export interface ProviderConfig {
  label: string;
  adapter: ProviderAdapter;
  binary: string;
  enabled: boolean;
  modelCatalog: ProviderModelCatalog;
  interactionWhitelist?: string[];
  capabilities: ProviderCapabilities;
}

export type McpToolSideEffect = "read_only" | "write" | "unknown";

export interface McpToolConfig {
  name: string;
  sideEffect: McpToolSideEffect;
}

export interface McpServerConfig {
  id: string;
  name: string;
  enabled: boolean;
  type: "local" | "remote";
  command?: string;
  args?: string[];
  url?: string;
  environment?: Record<string, string>;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Explicit capability metadata used for read-only enforcement. */
  tools?: McpToolConfig[];
  /** Provider invocation allowlist derived from `tools`; not accepted as capability metadata alone. */
  allowedTools?: string[];
  /**
   * Internal trust marker for an ephemeral server constructed by the
   * orchestrator. Persistent/user configuration is never allowed to set it.
   */
  runtimeOwned?: true;
}

export interface ToolAccessConfig {
  webSearch: {
    enabled: boolean;
    mode: "cached" | "live";
  };
  mcpServers: McpServerConfig[];
}

export interface ProviderInvocationOptions {
  model: string;
  targetProjectPath: string;
  additionalAllowedPaths?: string[];
  prompt: string;
  variant?: string;
  resumeSessionId?: string;
  fullAccess: boolean;
  /** Force providers with a native filesystem sandbox to deny workspace writes. */
  readOnly?: boolean;
  workspaceMode?: "none" | "read" | "write";
  webSearch: boolean;
  webSearchMode?: "cached" | "live";
  mcpServers: McpServerConfig[];
  claudeMcpConfigPath?: string;
  /** Runtime-owned prompt attachment used to avoid Windows command-line limits. */
  promptFilePath?: string;
  /** Values resolved by the desktop/CLI secret bridge. Never persist this map. */
  secretValues?: Record<string, string>;
  /** Per-attempt name preventing inherited user agent configuration collisions. */
  readOnlyAgentName?: string;
  /**
   * Runtime-owned proof that this exact adapter/CLI/OS combination may start
   * a tool-free invocation. Persistent provider configuration never supplies
   * this value.
   */
  toolsNoneCapability?: ProviderCapabilityStatus;
}

export interface ProviderInvocation {
  binary: string;
  args: string[];
  env: Record<string, string>;
}

export const DEFAULT_PROVIDERS: Record<string, ProviderConfig> = {
  opencode: {
    label: "OpenCode",
    adapter: "opencode",
    binary: "opencode",
    enabled: true,
    modelCatalog: { source: "command", args: ["models"] },
    capabilities: capabilitiesForAdapter("opencode"),
  },
  kilo: {
    label: "Kilo Code",
    adapter: "kilo",
    binary: "kilo",
    enabled: true,
    modelCatalog: { source: "command", args: ["models", "--pure"] },
    capabilities: capabilitiesForAdapter("kilo"),
  },
  codex: {
    label: "OpenAI GPT / Codex",
    adapter: "codex",
    binary: "codex",
    enabled: true,
    modelCatalog: { source: "configured", models: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"] },
    capabilities: capabilitiesForAdapter("codex"),
  },
  claude: {
    label: "Anthropic Claude Code",
    adapter: "claude",
    binary: "claude",
    enabled: true,
    modelCatalog: { source: "configured", models: ["sonnet", "opus"] },
    capabilities: capabilitiesForAdapter("claude"),
  },
};

/** Each adapter has one authoritative model-catalog mechanism.  Command
 * discovery is intentionally limited to the OpenCode-family adapters; the
 * Codex/Claude CLIs do not expose a stable model-list command and therefore
 * use the operator-configured catalog instead. */
function expectedCatalogSource(adapter: ProviderAdapter): ProviderModelCatalog["source"] {
  return adapter === "opencode" || adapter === "kilo" ? "command" : "configured";
}

function defaultCatalogForAdapter(adapter: ProviderAdapter): ProviderModelCatalog {
  switch (adapter) {
    case "opencode": return { source: "command", args: ["models"] };
    case "kilo": return { source: "command", args: ["models", "--pure"] };
    case "codex": return { source: "configured", models: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"] };
    case "claude": return { source: "configured", models: ["sonnet", "opus"] };
  }
}

export const DEFAULT_TOOL_ACCESS: ToolAccessConfig = {
  webSearch: { enabled: false, mode: "cached" },
  mcpServers: [],
};

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SAFE_TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const SAFE_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SECRET_REFERENCE = /^\$\{secret:([^}]+)\}$/;
const ENV_REFERENCE = /^\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/;

export const CODEX_DEFAULT_REASONING_EFFORT = "medium";
export const OPENCODE_READ_ONLY_AGENT = "agent-loop-readonly";

/**
 * Codex inherits model_reasoning_effort from the operator's global config when
 * no per-invocation value is supplied. Pin a conservative per-session default
 * so launches remain reproducible across machines and model selections.
 */
export function resolveProviderVariant(
  adapter: ProviderAdapter,
  requested: string | undefined
): string | undefined {
  const normalized = requested?.trim() || undefined;
  return adapter === "codex" ? normalized ?? CODEX_DEFAULT_REASONING_EFFORT : normalized;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function codexUntrustedProjectOverrides(targetProjectPath: string): string[] {
  const overrides: string[] = [];
  let current = path.resolve(targetProjectPath);
  while (true) {
    overrides.push(`projects.${tomlString(current)}.trust_level=${tomlString("untrusted")}`);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return overrides;
}

function jsonObject(value: Record<string, string> | undefined): Record<string, string> {
  return value ? { ...value } : {};
}

function resolveConfiguredValue(
  value: string,
  secretValues: Readonly<Record<string, string>>,
  environment: NodeJS.ProcessEnv
): string {
  const secret = value.match(SECRET_REFERENCE);
  if (secret) {
    if (!Object.prototype.hasOwnProperty.call(secretValues, secret[1])) {
      throw new Error(`MCP secret '${secret[1]}' is unavailable. Re-enter it in Agent Loop tool settings.`);
    }
    return secretValues[secret[1]];
  }
  const env = value.match(ENV_REFERENCE);
  if (env) {
    const resolved = environment[env[1]];
    if (resolved === undefined) {
      throw new Error(`MCP environment variable '${env[1]}' is unavailable.`);
    }
    return resolved;
  }
  return value;
}

/** Resolve secret/environment references only in memory immediately before provider launch. */
export function resolveMcpServerSecrets(
  servers: readonly McpServerConfig[],
  secretValues: Readonly<Record<string, string>> = {},
  environment: NodeJS.ProcessEnv = process.env
): McpServerConfig[] {
  return servers.map((server) => ({
    ...server,
    args: [...(server.args ?? [])],
    tools: (server.tools ?? []).map((tool) => ({ ...tool })),
    allowedTools: [...(server.allowedTools ?? [])],
    environment: Object.fromEntries(
      Object.entries(server.environment ?? {}).map(([key, value]) => [
        key,
        resolveConfiguredValue(value, secretValues, environment),
      ])
    ),
    headers: Object.fromEntries(
      Object.entries(server.headers ?? {}).map(([key, value]) => [
        key,
        resolveConfiguredValue(value, secretValues, environment),
      ])
    ),
  }));
}

/** Values materialized into provider MCP configuration and therefore requiring log redaction. */
export function collectMcpSensitiveValues(
  servers: readonly McpServerConfig[]
): string[] {
  const values = new Set<string>();
  for (const server of servers) {
    for (const configured of [server.environment, server.headers]) {
      for (const value of Object.values(configured ?? {})) {
        if (value) values.add(value);
      }
    }
  }
  return [...values];
}

/** Host credentials inherited by a provider must join the streaming redaction set. */
export function collectSensitiveEnvironmentValues(
  environment: Readonly<Record<string, string | undefined>>
): string[] {
  const sensitiveName = /(?:^|_)(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|AUTH)(?:_|$)/i;
  return [...new Set(
    Object.entries(environment)
      .filter(([name, value]) => sensitiveName.test(name) && Boolean(value))
      .map(([, value]) => value as string)
  )];
}

export function normalizeProviders(
  input?: Record<string, Partial<ProviderConfig>> | null
): Record<string, ProviderConfig> {
  const merged: Record<string, ProviderConfig> = {};
  const allowedKeys = new Set(["label", "adapter", "binary", "enabled", "modelCatalog", "interactionWhitelist", "capabilities"]);
  const normalizeCatalog = (providerId: string, candidate: unknown, base: ProviderModelCatalog, adapter: ProviderAdapter, allowAdapterDefault = false): ProviderModelCatalog => {
    const expectedSource = expectedCatalogSource(adapter);
    if (candidate === undefined) {
      const inherited = base.source === expectedSource
        ? base
        : allowAdapterDefault ? defaultCatalogForAdapter(adapter) : base;
      if ((inherited.source === "command" && inherited.args.length === 0) || (inherited.source === "configured" && inherited.models.length === 0)) {
        throw new Error(`Provider ${providerId} must define a non-empty model catalog.`);
      }
      return {
        source: inherited.source,
        ...(inherited.source === "command" ? { args: [...inherited.args] } : { models: [...inherited.models] }),
      } as ProviderModelCatalog;
    }
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error(`Provider ${providerId} must define a model catalog.`);
    }
    const record = candidate as Record<string, unknown>;
    if (record.source === "command") {
      if (expectedSource !== "command") throw new Error(`Provider ${providerId} adapter '${adapter}' requires a configured model catalog.`);
      for (const key of Object.keys(record)) {
        if (key !== "source" && key !== "args") throw new Error(`Provider ${providerId} command catalog contains an unsupported field: ${key}.`);
      }
      if (!Array.isArray(record.args) || record.args.length === 0 || record.args.some((value) => typeof value !== "string" || !value.trim())) {
        throw new Error(`Provider ${providerId} command catalog args must be a non-empty string array.`);
      }
      return { source: "command", args: record.args.map(String) };
    }
    if (record.source === "configured") {
      if (expectedSource !== "configured") throw new Error(`Provider ${providerId} adapter '${adapter}' requires a command model catalog.`);
      for (const key of Object.keys(record)) {
        if (key !== "source" && key !== "models") throw new Error(`Provider ${providerId} configured catalog contains an unsupported field: ${key}.`);
      }
      if (!Array.isArray(record.models) || record.models.length === 0 || record.models.some((value) => typeof value !== "string" || !value.trim())) {
        throw new Error(`Provider ${providerId} configured catalog models must be a non-empty string array.`);
      }
      return { source: "configured", models: record.models.map((value) => String(value).trim()) };
    }
    throw new Error(`Provider ${providerId} has an invalid model catalog source.`);
  };
  const assertAllowedKeys = (providerId: string, candidate: Record<string, unknown>): void => {
    for (const key of Object.keys(candidate)) {
      if (!allowedKeys.has(key)) throw new Error(`Provider ${providerId} contains an unsupported configuration field.`);
    }
  };
  for (const [id, base] of Object.entries(DEFAULT_PROVIDERS)) {
    const supplied = input?.[id];
    if (supplied !== undefined && (!supplied || typeof supplied !== "object" || Array.isArray(supplied))) {
      throw new Error(`Provider ${id} configuration must be an object.`);
    }
    const override = (supplied ?? {}) as Partial<ProviderConfig> & Record<string, unknown>;
    assertAllowedKeys(id, override);
    const adapter = override.adapter ?? base.adapter;
    if (!["opencode", "kilo", "codex", "claude"].includes(adapter)) {
      throw new Error(`Provider ${id} has an unsupported adapter.`);
    }
    const binary = String(override.binary ?? base.binary).trim();
    if (!binary) throw new Error(`Provider ${id} must define a binary.`);
    if (override.label !== undefined && (typeof override.label !== "string" || !override.label.trim())) {
      throw new Error(`Provider ${id} must define a non-empty label.`);
    }
    if (override.binary !== undefined && (typeof override.binary !== "string" || !override.binary.trim())) {
      throw new Error(`Provider ${id} must define a binary.`);
    }
    if (override.enabled !== undefined && typeof override.enabled !== "boolean") {
      throw new Error(`Provider ${id}.enabled must be boolean.`);
    }
    if (override.interactionWhitelist !== undefined && (!Array.isArray(override.interactionWhitelist) || override.interactionWhitelist.some((entry) => typeof entry !== "string"))) {
      throw new Error(`Provider ${id}.interactionWhitelist must be an array of strings.`);
    }
    merged[id] = {
      label: override.label === undefined ? base.label : override.label.trim(),
      adapter,
      binary,
      enabled: override.enabled !== false,
      modelCatalog: normalizeCatalog(id, override.modelCatalog, base.modelCatalog, adapter, true),
      interactionWhitelist: Array.isArray(override.interactionWhitelist)
        ? override.interactionWhitelist.map(String)
        : base.interactionWhitelist,
      capabilities: capabilitiesForAdapter(adapter),
    };
  }
  for (const [id, candidate] of Object.entries(input ?? {})) {
    if (merged[id]) continue;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error(`Provider ${id} configuration must be an object.`);
    }
    if (!SAFE_ID.test(id)) throw new Error(`Unsafe provider id: ${id}`);
    const candidateRecord = candidate as Partial<ProviderConfig> & Record<string, unknown>;
    assertAllowedKeys(id, candidateRecord);
    const adapter = candidateRecord.adapter;
    if (!adapter || !["opencode", "kilo", "codex", "claude"].includes(adapter)) {
      throw new Error(`Provider ${id} has an unsupported adapter.`);
    }
    if (candidateRecord.label !== undefined && (typeof candidateRecord.label !== "string" || !candidateRecord.label.trim())) {
      throw new Error(`Provider ${id} must define a non-empty label.`);
    }
    if (candidateRecord.enabled !== undefined && typeof candidateRecord.enabled !== "boolean") {
      throw new Error(`Provider ${id}.enabled must be boolean.`);
    }
    if (candidateRecord.interactionWhitelist !== undefined && (!Array.isArray(candidateRecord.interactionWhitelist) || candidateRecord.interactionWhitelist.some((entry) => typeof entry !== "string"))) {
      throw new Error(`Provider ${id}.interactionWhitelist must be an array of strings.`);
    }
    const binary = String(candidateRecord.binary ?? "").trim();
    if (!binary) throw new Error(`Provider ${id} must define a binary.`);
    merged[id] = {
      label: candidateRecord.label === undefined ? id : candidateRecord.label.trim(),
      adapter,
      binary,
      enabled: candidateRecord.enabled !== false,
      modelCatalog: normalizeCatalog(id, candidateRecord.modelCatalog, { source: "command", args: [] }, adapter),
      interactionWhitelist: Array.isArray(candidateRecord.interactionWhitelist)
        ? candidateRecord.interactionWhitelist.map(String)
        : undefined,
      capabilities: capabilitiesForAdapter(adapter),
    };
  }
  return merged;
}

export function validateToolAccess(input?: Partial<ToolAccessConfig> | null): ToolAccessConfig {
  if (input !== undefined && input !== null && (typeof input !== "object" || Array.isArray(input))) {
    throw new Error("toolAccess must be an object.");
  }
  if (input) {
    for (const key of Object.keys(input)) if (key !== "webSearch" && key !== "mcpServers") throw new Error(`toolAccess contains an unsupported field: ${key}.`);
  }
  const webInput = input?.webSearch;
  if (webInput !== undefined && (!webInput || typeof webInput !== "object" || Array.isArray(webInput))) {
    throw new Error("toolAccess.webSearch must be an object.");
  }
  if (webInput?.enabled !== undefined && typeof webInput.enabled !== "boolean") {
    throw new Error("toolAccess.webSearch.enabled must be boolean.");
  }
  if (webInput?.mode !== undefined && webInput.mode !== "cached" && webInput.mode !== "live") {
    throw new Error("toolAccess.webSearch.mode is invalid.");
  }
  if (webInput) for (const key of Object.keys(webInput)) if (key !== "enabled" && key !== "mode") throw new Error(`toolAccess.webSearch contains an unsupported field: ${key}.`);
  const webSearch = {
    enabled: Boolean(webInput?.enabled),
    mode: webInput?.mode === "live" ? "live" as const : "cached" as const,
  };
  if (input?.mcpServers !== undefined && !Array.isArray(input.mcpServers)) {
    throw new Error("toolAccess.mcpServers must be an array.");
  }
  const serverKeys = new Set(["id", "name", "enabled", "type", "command", "args", "url", "environment", "headers", "timeoutMs", "tools", "allowedTools", "runtimeOwned"]);
  const ids = new Set<string>();
  const mcpServers = (input?.mcpServers ?? []).map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("MCP server configuration must be an object.");
    for (const key of Object.keys(raw)) if (!serverKeys.has(key)) throw new Error(`MCP server contains an unsupported field: ${key}.`);
    const candidate = raw as McpServerConfig & Record<string, unknown>;
    const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
    if (!SAFE_ID.test(id)) throw new Error(`Unsafe MCP server id: ${id}`);
    if (ids.has(id)) throw new Error(`Duplicate MCP server id: ${id}`);
    ids.add(id);
    if (typeof candidate.name !== "string" || !candidate.name.trim()) throw new Error(`MCP server ${id} needs a name.`);
    if (typeof candidate.enabled !== "boolean") throw new Error(`MCP server ${id}.enabled must be boolean.`);
    if (candidate.type !== "local" && candidate.type !== "remote") throw new Error(`MCP server ${id}.type is invalid.`);
    const type = candidate.type;
    if (candidate.runtimeOwned !== undefined && candidate.runtimeOwned !== true) throw new Error(`MCP server ${id}.runtimeOwned is invalid.`);
    if (candidate.command !== undefined && (typeof candidate.command !== "string" || !candidate.command.trim())) throw new Error(`MCP server ${id}.command must be a non-empty string.`);
    const command = typeof candidate.command === "string" ? candidate.command.trim() : "";
    if (candidate.url !== undefined && (typeof candidate.url !== "string" || !candidate.url.trim())) throw new Error(`MCP server ${id}.url must be a non-empty string.`);
    const url = typeof candidate.url === "string" ? candidate.url.trim() : "";
    if (type === "local" && !command) throw new Error(`Local MCP server ${id} needs a command.`);
    if (type === "remote" && !/^https?:\/\//i.test(url)) {
      throw new Error(`Remote MCP server ${id} needs an http(s) URL.`);
    }
    if (candidate.args !== undefined && (!Array.isArray(candidate.args) || candidate.args.some((entry) => typeof entry !== "string"))) throw new Error(`MCP server ${id}.args must be an array of strings.`);
    const timeoutMs = candidate.timeoutMs === undefined ? undefined : Number(candidate.timeoutMs);
    if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)) {
      throw new Error(`MCP server ${id} timeoutMs must be positive.`);
    }
    if (candidate.allowedTools !== undefined && (!Array.isArray(candidate.allowedTools) || candidate.allowedTools.some((entry) => typeof entry !== "string"))) {
      throw new Error(`MCP server ${id}.allowedTools must be an array of strings.`);
    }
    if (Array.isArray(candidate.allowedTools) && !Array.isArray(candidate.tools)) {
      throw new Error(
        `MCP server ${id} uses the removed name-only allowedTools contract; declare tools with sideEffect.`
      );
    }
    if (candidate.environment !== undefined && (!candidate.environment || typeof candidate.environment !== "object" || Array.isArray(candidate.environment))) throw new Error(`MCP server ${id}.environment must be an object.`);
    if (candidate.headers !== undefined && (!candidate.headers || typeof candidate.headers !== "object" || Array.isArray(candidate.headers))) throw new Error(`MCP server ${id}.headers must be an object.`);
    for (const [field, values] of [["environment", candidate.environment], ["headers", candidate.headers]] as const) {
      for (const [key, value] of Object.entries(values ?? {})) {
        if (typeof value !== "string") throw new Error(`MCP server ${id}.${field}.${key} must be a string.`);
      }
    }
    if (candidate.tools !== undefined && !Array.isArray(candidate.tools)) throw new Error(`MCP server ${id}.tools must be an array.`);
    const toolCandidates = Array.isArray(candidate.tools) ? candidate.tools : [];
    const toolNames = new Set<string>();
    const tools = toolCandidates.map((rawTool) => {
      if (!rawTool || typeof rawTool !== "object" || Array.isArray(rawTool)) throw new Error(`MCP server ${id} tool configuration must be an object.`);
      const toolRecord = rawTool as McpToolConfig & Record<string, unknown>;
      for (const key of Object.keys(toolRecord)) if (key !== "name" && key !== "sideEffect") throw new Error(`MCP server ${id} tool contains an unsupported field: ${key}.`);
      const name = typeof toolRecord.name === "string" ? toolRecord.name.trim() : "";
      if (!SAFE_TOOL_NAME.test(name)) throw new Error(`MCP server ${id} has an unsafe tool name: ${name}`);
      if (toolNames.has(name)) throw new Error(`MCP server ${id} has a duplicate tool: ${name}`);
      toolNames.add(name);
      const sideEffect = toolRecord.sideEffect;
      if (!(["read_only", "write", "unknown"] as const).includes(sideEffect)) {
        throw new Error(`MCP server ${id} tool ${name} has an invalid side effect.`);
      }
      return { name, sideEffect };
    });
    return {
      id,
      name: candidate.name.trim(),
      enabled: candidate.enabled,
      type,
      command: command || undefined,
      args: Array.isArray(candidate.args) ? candidate.args.map(String) : [],
      url: url || undefined,
      environment: jsonObject(candidate.environment),
      headers: jsonObject(candidate.headers),
      timeoutMs,
      tools,
      allowedTools: tools.map((tool) => tool.name),
    };
  });
  return { webSearch, mcpServers };
}

export function enabledMcpServers(
  toolAccess: ToolAccessConfig,
  selectedIds?: string[]
): McpServerConfig[] {
  const selected = selectedIds ? new Set(selectedIds) : null;
  return toolAccess.mcpServers.filter(
    (server) => server.enabled && (!selected || selected.has(server.id))
  );
}

/** Select only MCP capabilities that the provider can enforce for this role. */
export function selectMcpServersForInvocation(
  provider: ProviderConfig,
  servers: readonly McpServerConfig[],
  readOnly: boolean
): McpServerConfig[] {
  if (!readOnly) return servers.map((server) => ({
    ...server,
    args: [...(server.args ?? [])],
    tools: (server.tools ?? []).map((tool) => ({ ...tool })),
    allowedTools: [...(server.allowedTools ?? [])],
  }));
  const trustedCapabilities = capabilitiesForAdapter(provider.adapter);
  if (
    trustedCapabilities.mcpIsolation !== "explicit" ||
    trustedCapabilities.readOnlyMcpToolFiltering !== "enforced"
  ) {
    // OpenCode cannot prove that inherited user/project MCP configuration is
    // absent. It may nevertheless receive a narrowly scoped server that this
    // process constructed itself: the runtime agent denies every unknown tool
    // and explicitly re-enables only the server's classified read-only tools.
    // Persisted configuration cannot manufacture this marker because
    // validateToolAccess deliberately omits it.
    if (provider.adapter !== "opencode") return [];
    return servers
      .filter((server) => server.runtimeOwned === true)
      .flatMap((server) => {
        const tools = (server.tools ?? []).filter((tool) => tool.sideEffect === "read_only");
        if (tools.length === 0) return [];
        return [{
          ...server,
          args: [...(server.args ?? [])],
          tools: tools.map((tool) => ({ ...tool })),
          allowedTools: tools.map((tool) => tool.name),
        }];
      });
  }
  return servers.flatMap((server) => {
    const tools = (server.tools ?? []).filter((tool) => tool.sideEffect === "read_only");
    if (tools.length === 0) return [];
    return [{
      ...server,
      args: [...(server.args ?? [])],
      tools: tools.map((tool) => ({ ...tool })),
      allowedTools: tools.map((tool) => tool.name),
    }];
  });
}

export function assertProviderInvocationSupported(
  provider: ProviderConfig,
  opts: ProviderInvocationOptions,
  selectedMcpServers: readonly McpServerConfig[] = opts.mcpServers
): void {
  if (opts.workspaceMode === "none" && selectedMcpServers.length > 0) {
    throw new Error("Tool-free invocations cannot receive MCP servers.");
  }
  if (opts.workspaceMode === "none" && opts.webSearch) {
    throw new Error("Tool-free invocations cannot enable web search.");
  }
  const trustedCapabilities = capabilitiesForAdapter(provider.adapter);
  assertProviderCapabilities(provider.adapter, trustedCapabilities, {
    readOnly: opts.readOnly === true,
    fullAccess: opts.fullAccess,
    hasAdditionalRoots: (opts.additionalAllowedPaths?.length ?? 0) > 0,
    resumeSession: Boolean(opts.resumeSessionId),
    webSearch: opts.webSearch,
    webSearchMode: opts.webSearchMode ?? trustedCapabilities.webSearchModes[0] ?? "cached",
    hasMcpServers: selectedMcpServers.length > 0,
    toolsNone: opts.workspaceMode === "none",
    toolsNoneCapability: opts.toolsNoneCapability,
  });
  if (opts.readOnly && selectedMcpServers.some(
    (server) => (server.tools ?? []).some((tool) => tool.sideEffect !== "read_only")
  )) {
    throw new Error(`${provider.adapter} read-only roles may receive only MCP tools marked read_only.`);
  }
}

/** Persistent config may contain references, but never inline MCP credentials. */
export function assertMcpCredentialsAreReferenced(toolAccess: ToolAccessConfig): void {
  for (const server of toolAccess.mcpServers) {
    for (const [scope, values] of [
      ["environment", server.environment],
      ["headers", server.headers],
    ] as const) {
      for (const [key, value] of Object.entries(values ?? {})) {
        if (!value || SECRET_REFERENCE.test(value) || ENV_REFERENCE.test(value)) continue;
        throw new Error(
          `MCP server ${server.id} ${scope}.${key} contains an inline value. ` +
          `Use \${env:VARIABLE_NAME}, or save it through the desktop tools settings so secure storage is used.`
        );
      }
    }
  }
}

export function claudeMcpDocument(servers: McpServerConfig[]): { mcpServers: Record<string, unknown> } {
  const mcpServers: Record<string, unknown> = {};
  for (const server of servers) {
    mcpServers[server.id] = server.type === "remote"
      ? { type: "http", url: server.url, headers: server.headers ?? {} }
      : { command: server.command, args: server.args ?? [], env: server.environment ?? {} };
  }
  return { mcpServers };
}

function opencodeMcpDocument(servers: McpServerConfig[]): Record<string, unknown> {
  const mapped: Record<string, unknown> = {};
  for (const server of servers) {
    mapped[server.id] = server.type === "remote"
      ? {
          type: "remote",
          url: server.url,
          headers: server.headers ?? {},
          enabled: true,
          ...(server.timeoutMs ? { timeout: server.timeoutMs } : {}),
        }
      : {
          type: "local",
          command: [server.command, ...(server.args ?? [])],
          environment: server.environment ?? {},
          enabled: true,
          ...(server.timeoutMs ? { timeout: server.timeoutMs } : {}),
        };
  }
  return mapped;
}

function opencodeToolName(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_");
}

function opencodeReadOnlyMcpToolNames(opts: ProviderInvocationOptions): string[] {
  if (!opts.readOnly) return [];
  return opts.mcpServers.flatMap((server) => {
    if (server.runtimeOwned !== true) return [];
    return (server.tools ?? [])
      .filter((tool) => tool.sideEffect === "read_only")
      .map((tool) => `${opencodeToolName(server.id)}_${opencodeToolName(tool.name)}`);
  });
}

function externalDirectoryPermission(paths: readonly string[]): Record<string, "allow"> {
  return Object.fromEntries(paths.map((entry) => {
    const normalized = path.resolve(entry).replace(/\\/g, "/").replace(/\/+$/, "");
    return [`${normalized}/**`, "allow" as const];
  }));
}

function opencodePermissionDocument(opts: ProviderInvocationOptions): Record<string, unknown> {
  if (opts.workspaceMode === "none") {
    return {
      "*": "deny",
      read: "deny",
      glob: "deny",
      grep: "deny",
      list: "deny",
      bash: "deny",
      edit: "deny",
      write: "deny",
      patch: "deny",
      apply_patch: "deny",
      task: "deny",
      todowrite: "deny",
      skill: "deny",
      question: "deny",
      websearch: "deny",
      webfetch: "deny",
    };
  }
  const permission: Record<string, unknown> = opts.readOnly ? { "*": "deny" } : {};
  Object.assign(permission, {
    read: "allow",
    glob: "allow",
    grep: "allow",
    list: "allow",
    bash: opts.readOnly ? "deny" : "allow",
    edit: opts.readOnly ? "deny" : "allow",
    websearch: opts.webSearch ? "allow" : "deny",
    webfetch: opts.webSearch ? "allow" : "deny",
  });
  const additional = externalDirectoryPermission(opts.additionalAllowedPaths ?? []);
  if (Object.keys(additional).length > 0) permission.external_directory = additional;
  for (const toolName of opencodeReadOnlyMcpToolNames(opts)) {
    permission[toolName] = "allow";
  }
  return permission;
}

/**
 * OpenCode-family global permissions are merged before the selected agent's
 * own permissions. A user/default agent can therefore re-enable bash or edit
 * after a top-level deny. Select a runtime-owned agent whose final tool map and
 * permission layer both deny mutation and delegation surfaces.
 */
function opencodeReadOnlyAgentPermission(
  opts: ProviderInvocationOptions
): Record<string, unknown> {
  const permission = opencodePermissionDocument(opts);
  // OpenCode-family CLIs normalize a custom-agent wildcard to the end of its
  // rule list, after explicit read allows, which disables every tool. Keep the
  // top-level fail-closed wildcard and make the final agent layer explicit.
  delete permission["*"];
  permission.external_directory = {
    "*": "deny",
    ...externalDirectoryPermission(opts.additionalAllowedPaths ?? []),
  };
  Object.assign(permission, {
    bash: "deny",
    edit: "deny",
    write: "deny",
    patch: "deny",
    apply_patch: "deny",
    task: "deny",
    todowrite: "deny",
    skill: "deny",
    question: "deny",
    suggest: "deny",
    recall: "deny",
    kilo_local_recall: "deny",
    lsp: "deny",
  });
  return permission;
}

function opencodeReadOnlyAgentDocument(
  opts: ProviderInvocationOptions
): Record<string, unknown> {
  const toolsNone = opts.workspaceMode === "none";
  const mcpTools = Object.fromEntries(
    opencodeReadOnlyMcpToolNames(opts).map((toolName) => [toolName, true])
  );
  return {
    description: "Agent Loop enforced read-only role",
    mode: "primary",
    prompt: [
      "You are a read-only role inside an orchestrated workflow.",
      "The supplied user prompt contains the authoritative role, goal, and output contract; follow it exactly.",
      `Inspect only the target project directory (${path.resolve(opts.targetProjectPath)}) and explicitly approved additional paths; never inspect parent or sibling directories.`,
      "Return the requested structured response in assistant text and include every required final token or verdict.",
      "Do not replace the requested task with generic workspace-management conventions, CurrentWork templates, or sibling-project patterns.",
      "Never claim the task is unspecified when the prompt contains an ORIGINAL USER GOAL.",
      toolsNone
        ? "This is a tool-free formatting recovery; do not invoke any workspace, network, or MCP tool."
        : "Use only explicitly enabled read or research tools, and do not ask to create planning files.",
    ].join(" "),
    tools: {
      "*": false,
      bash: false,
      background_process: false,
      edit: false,
      write: false,
      patch: false,
      apply_patch: false,
      task: false,
      todowrite: false,
      skill: false,
      question: false,
      suggest: false,
      recall: false,
      kilo_local_recall: false,
      lsp: false,
      read: !toolsNone,
      glob: !toolsNone,
      grep: !toolsNone,
      list: !toolsNone,
      codebase_search: !toolsNone,
      semantic_search: !toolsNone,
      webfetch: !toolsNone && opts.webSearch,
      websearch: !toolsNone && opts.webSearch,
      ...mcpTools,
    },
    permission: opencodeReadOnlyAgentPermission(opts),
  };
}

/**
 * Kilo's `run [message..]` receives positional arguments through a PTY. On
 * Windows, embedded CR/LF characters in one argument can be interpreted by
 * the ConPTY command-line layer, leaving Kilo with only the first line. U+2028
 * preserves the prompt's line boundaries for the model without introducing a
 * command separator or moving the prompt into the size-limited environment.
 */
function kiloPromptArgument(prompt: string): string {
  return prompt.replace(/\r\n|\r|\n/g, "\u2028");
}

const KILO_ATTACHED_PROMPT_MESSAGE =
  "Read the attached Agent Loop prompt file in full. It is the complete authoritative instruction set for this attempt. Follow every contract in it exactly and emit all required completion markers.";

function addOpenCodeReadOnlyAgent(
  runtime: Record<string, unknown>,
  opts: ProviderInvocationOptions,
  agentName: string
): void {
  if (!opts.readOnly) return;
  runtime.agent = {
    [agentName]: opencodeReadOnlyAgentDocument(opts),
  };
}

function readOnlyAgentName(opts: ProviderInvocationOptions): string {
  const value = opts.readOnlyAgentName?.trim() || OPENCODE_READ_ONLY_AGENT;
  if (!SAFE_ID.test(value)) {
    throw new Error(`Unsafe runtime read-only agent name: ${value}`);
  }
  return value;
}

function codexHeaderEnvName(serverId: string, header: string): string {
  const digest = createHash("sha256").update(`${serverId}\0${header}`).digest("hex").slice(0, 20);
  return `AGENT_LOOP_MCP_HEADER_${digest.toUpperCase()}`;
}

function tomlInlineStringMap(values: Record<string, string>): string {
  const entries = Object.entries(values).map(
    ([key, value]) => `${tomlString(key)} = ${tomlString(value)}`
  );
  return `{ ${entries.join(", ")} }`;
}

function codexMcpRuntime(servers: McpServerConfig[]): { args: string[]; env: Record<string, string> } {
  const args: string[] = [];
  const env: Record<string, string> = {};
  for (const server of servers) {
    const prefix = `mcp_servers.${server.id}`;
    if (server.type === "remote") {
      args.push("-c", `${prefix}.url=${tomlString(server.url ?? "")}`);
      const envHeaders: Record<string, string> = {};
      for (const [header, value] of Object.entries(server.headers ?? {})) {
        const envName = codexHeaderEnvName(server.id, header);
        env[envName] = value;
        envHeaders[header] = envName;
      }
      if (Object.keys(envHeaders).length > 0) {
        args.push("-c", `${prefix}.env_http_headers=${tomlInlineStringMap(envHeaders)}`);
      }
    } else {
      args.push("-c", `${prefix}.command=${tomlString(server.command ?? "")}`);
      if ((server.args ?? []).length > 0) {
        args.push("-c", `${prefix}.args=${JSON.stringify(server.args)}`);
      }
      const inheritedNames: string[] = [];
      for (const [key, value] of Object.entries(server.environment ?? {})) {
        if (!SAFE_ENV_NAME.test(key)) {
          throw new Error(`MCP server ${server.id} has an invalid environment variable name: ${key}`);
        }
        if (env[key] !== undefined && env[key] !== value) {
          throw new Error(
            `Codex MCP servers define conflicting values for inherited environment variable '${key}'.`
          );
        }
        env[key] = value;
        inheritedNames.push(key);
      }
      if (inheritedNames.length > 0) {
        args.push("-c", `${prefix}.env_vars=${JSON.stringify(inheritedNames)}`);
      }
    }
    if (server.timeoutMs) {
      args.push("-c", `${prefix}.tool_timeout_sec=${Math.max(1, Math.ceil(server.timeoutMs / 1000))}`);
    }
  }
  return { args, env };
}

export function buildProviderInvocation(
  provider: ProviderConfig,
  opts: ProviderInvocationOptions
): ProviderInvocation {
  const env: Record<string, string> = {};
  const selectedMcpServers = selectMcpServersForInvocation(
    provider,
    opts.mcpServers,
    opts.readOnly === true && opts.workspaceMode !== "none"
  );
  assertProviderInvocationSupported(provider, opts, selectedMcpServers);
  const mcpServers = resolveMcpServerSecrets(selectedMcpServers, opts.secretValues);
  const variant = resolveProviderVariant(provider.adapter, opts.variant);
  const runtimeReadOnlyAgent = readOnlyAgentName(opts);
  let args: string[];
  switch (provider.adapter) {
    case "opencode": {
      args = ["run", "--format", "json", "--model", opts.model, "--dir", opts.targetProjectPath];
      if (opts.fullAccess && !opts.readOnly) args.push("--dangerously-skip-permissions");
      if (opts.readOnly) args.push("--pure", "--agent", runtimeReadOnlyAgent);
      if (variant) args.push("--variant", variant);
      if (opts.resumeSessionId) args.push("--session", opts.resumeSessionId);
      const runtime: Record<string, unknown> = { permission: opencodePermissionDocument(opts) };
      addOpenCodeReadOnlyAgent(runtime, { ...opts, mcpServers }, runtimeReadOnlyAgent);
      if (opts.webSearch) {
        env.OPENCODE_ENABLE_EXA = "1";
      }
      if (mcpServers.length > 0) runtime.mcp = opencodeMcpDocument(mcpServers);
      if (Object.keys(runtime).length > 0) env.OPENCODE_CONFIG_CONTENT = JSON.stringify(runtime);
      args.push(opts.prompt);
      break;
    }
    case "kilo": {
      args = ["run", "--pure", "--format", "json", "--model", opts.model, "--dir", opts.targetProjectPath];
      if (opts.fullAccess && !opts.readOnly) args.push("--auto");
      if (opts.readOnly) args.push("--agent", runtimeReadOnlyAgent);
      if (variant) args.push("--variant", variant);
      if (opts.resumeSessionId) args.push("--session", opts.resumeSessionId);
      const runtime: Record<string, unknown> = { permission: opencodePermissionDocument(opts) };
      addOpenCodeReadOnlyAgent(runtime, { ...opts, mcpServers }, runtimeReadOnlyAgent);
      if (mcpServers.length > 0) runtime.mcp = opencodeMcpDocument(mcpServers);
      if (Object.keys(runtime).length > 0) env.KILO_CONFIG_CONTENT = JSON.stringify(runtime);
      if (opts.promptFilePath) {
        // Kilo declares --file as an array option and greedily consumes later
        // non-option arguments. Put the positional authority message first and
        // leave the file option last so it receives exactly one path.
        args.push(KILO_ATTACHED_PROMPT_MESSAGE, "--file", path.resolve(opts.promptFilePath));
      } else {
        args.push(kiloPromptArgument(opts.prompt));
      }
      break;
    }
    case "codex": {
      const globalArgs: string[] = [];
      if (opts.webSearch && opts.webSearchMode === "live") globalArgs.push("--search");
      if (opts.readOnly) globalArgs.push("--ask-for-approval", "never");
      args = [...globalArgs, "exec", "--json", "--model", opts.model, "--skip-git-repo-check"];
      if (opts.readOnly) {
        // Authentication still comes from CODEX_HOME, but no user-configured
        // MCP, plugins, hooks, or rules may enter a read-only role. Project
        // config is a separate layer, so mark the target and every possible
        // ancestor project root untrusted with highest-precedence CLI values.
        args.push("--ignore-user-config", "--ignore-rules");
        for (const override of codexUntrustedProjectOverrides(opts.targetProjectPath)) {
          args.push("-c", override);
        }
      }
      args.push(
        "--sandbox",
        opts.readOnly ? "read-only" : opts.fullAccess ? "danger-full-access" : "workspace-write"
      );
      for (const allowedPath of opts.additionalAllowedPaths ?? []) {
        args.push("--add-dir", path.resolve(allowedPath));
      }
      if (opts.webSearch) {
        if (opts.webSearchMode !== "live") args.push("-c", `web_search=${tomlString("cached")}`);
      }
      if (variant) args.push("-c", `model_reasoning_effort=${tomlString(variant)}`);
      const codexMcp = codexMcpRuntime(mcpServers);
      args.push(...codexMcp.args);
      Object.assign(env, codexMcp.env);
      if (opts.resumeSessionId) args.push("resume", opts.resumeSessionId, opts.prompt);
      else args.push(opts.prompt);
      break;
    }
    case "claude": {
      args = ["-p", opts.prompt, "--output-format", "stream-json", "--verbose", "--model", opts.model];
      if (opts.fullAccess && !opts.readOnly) args.push("--dangerously-skip-permissions");
      for (const allowedPath of opts.additionalAllowedPaths ?? []) {
        args.push("--add-dir", path.resolve(allowedPath));
      }
      if (opts.workspaceMode === "none") {
        // An explicit empty allowlist is the only safe default for format
        // recovery: omitting --tools would allow the CLI's evolving default
        // tool set to reintroduce reads, shell, or MCP.
        args.push("--tools", "");
        args.push("--strict-mcp-config");
      } else if (opts.readOnly) {
        // Claude's --tools flag is an available-tool allowlist. Keep read-only
        // roles fail-closed as the CLI adds tools over time: delegation, shell,
        // mutation, skills, and MCP are absent unless explicitly listed here.
        const readOnlyTools = ["Read", "Glob", "Grep"];
        if (opts.webSearch) readOnlyTools.push("WebSearch", "WebFetch");
        for (const server of mcpServers) {
          for (const tool of server.tools ?? []) {
            readOnlyTools.push(`mcp__${server.id}__${tool.name}`);
          }
        }
        args.push("--tools", readOnlyTools.join(","));
        // Do not merge user, project, or plugin MCP configuration. `--tools`
        // contains only built-in readers and explicitly classified MCP readers.
        args.push("--strict-mcp-config");
      }
      if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
      if (mcpServers.length > 0) {
        if (!opts.claudeMcpConfigPath) throw new Error("Claude MCP requires a generated config path.");
        args.push("--mcp-config", path.resolve(opts.claudeMcpConfigPath));
      }
      const allowed = new Set<string>();
      if (opts.webSearch) {
        allowed.add("WebSearch");
        allowed.add("WebFetch");
      }
      for (const server of mcpServers) {
        for (const tool of server.allowedTools ?? []) allowed.add(`mcp__${server.id}__${tool}`);
        if ((server.allowedTools ?? []).length === 0) allowed.add(`mcp__${server.id}__*`);
      }
      if (!opts.readOnly && allowed.size > 0) args.push("--allowedTools", [...allowed].join(","));
      break;
    }
  }
  return { binary: provider.binary, args, env };
}
