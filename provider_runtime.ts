import * as path from "node:path";
import { createHash } from "node:crypto";

export type ProviderAdapter = "opencode" | "kilo" | "codex" | "claude";

export interface ProviderConfig {
  label: string;
  adapter: ProviderAdapter;
  binary: string;
  enabled: boolean;
  modelsArgs: string[];
  fallbackModels: string[];
  interactionWhitelist?: string[];
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
  allowedTools?: string[];
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
  webSearch: boolean;
  webSearchMode?: "cached" | "live";
  mcpServers: McpServerConfig[];
  claudeMcpConfigPath?: string;
  /** Values resolved by the VS Code SecretStorage bridge. Never persist this map. */
  secretValues?: Record<string, string>;
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
    modelsArgs: ["models"],
    fallbackModels: ["opencode/big-pickle"],
  },
  kilo: {
    label: "Kilo Code",
    adapter: "kilo",
    binary: "kilo",
    enabled: true,
    modelsArgs: ["models", "--pure"],
    fallbackModels: ["anthropic/claude-sonnet-4-5"],
  },
  codex: {
    label: "OpenAI GPT / Codex",
    adapter: "codex",
    binary: "codex",
    enabled: true,
    modelsArgs: [],
    fallbackModels: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
  },
  claude: {
    label: "Anthropic Claude Code",
    adapter: "claude",
    binary: "claude",
    enabled: true,
    modelsArgs: [],
    fallbackModels: ["sonnet", "opus"],
  },
};

export const DEFAULT_TOOL_ACCESS: ToolAccessConfig = {
  webSearch: { enabled: false, mode: "cached" },
  mcpServers: [],
};

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SAFE_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SECRET_REFERENCE = /^\$\{secret:([^}]+)\}$/;
const ENV_REFERENCE = /^\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/;

function tomlString(value: string): string {
  return JSON.stringify(value);
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

export function normalizeProviders(
  input?: Record<string, Partial<ProviderConfig>> | null
): Record<string, ProviderConfig> {
  const merged: Record<string, ProviderConfig> = {};
  for (const [id, base] of Object.entries(DEFAULT_PROVIDERS)) {
    const override = input?.[id] ?? {};
    const adapter = override.adapter ?? base.adapter;
    if (!["opencode", "kilo", "codex", "claude"].includes(adapter)) {
      throw new Error(`Provider ${id} has an unsupported adapter.`);
    }
    const binary = String(override.binary ?? base.binary).trim();
    if (!binary) throw new Error(`Provider ${id} must define a binary.`);
    merged[id] = {
      label: String(override.label ?? base.label).trim() || base.label,
      adapter,
      binary,
      enabled: override.enabled !== false,
      modelsArgs: Array.isArray(override.modelsArgs) ? override.modelsArgs.map(String) : [...base.modelsArgs],
      fallbackModels: Array.isArray(override.fallbackModels)
        ? override.fallbackModels.map(String).filter(Boolean)
        : [...base.fallbackModels],
      interactionWhitelist: Array.isArray(override.interactionWhitelist)
        ? override.interactionWhitelist.map(String)
        : base.interactionWhitelist,
    };
  }
  for (const [id, candidate] of Object.entries(input ?? {})) {
    if (merged[id]) continue;
    if (!SAFE_ID.test(id)) throw new Error(`Unsafe provider id: ${id}`);
    const adapter = candidate.adapter;
    if (!adapter || !["opencode", "kilo", "codex", "claude"].includes(adapter)) {
      throw new Error(`Provider ${id} has an unsupported adapter.`);
    }
    const binary = String(candidate.binary ?? "").trim();
    if (!binary) throw new Error(`Provider ${id} must define a binary.`);
    merged[id] = {
      label: String(candidate.label ?? id),
      adapter,
      binary,
      enabled: candidate.enabled !== false,
      modelsArgs: Array.isArray(candidate.modelsArgs) ? candidate.modelsArgs.map(String) : [],
      fallbackModels: Array.isArray(candidate.fallbackModels)
        ? candidate.fallbackModels.map(String).filter(Boolean)
        : [],
      interactionWhitelist: Array.isArray(candidate.interactionWhitelist)
        ? candidate.interactionWhitelist.map(String)
        : undefined,
    };
  }
  return merged;
}

export function validateToolAccess(input?: Partial<ToolAccessConfig> | null): ToolAccessConfig {
  const webInput = input?.webSearch;
  const webSearch = {
    enabled: Boolean(webInput?.enabled),
    mode: webInput?.mode === "live" ? "live" as const : "cached" as const,
  };
  const ids = new Set<string>();
  const mcpServers = (input?.mcpServers ?? []).map((raw) => {
    const id = String(raw.id ?? "").trim();
    if (!SAFE_ID.test(id)) throw new Error(`Unsafe MCP server id: ${id}`);
    if (ids.has(id)) throw new Error(`Duplicate MCP server id: ${id}`);
    ids.add(id);
    const type = raw.type === "remote" ? "remote" as const : "local" as const;
    const command = String(raw.command ?? "").trim();
    const url = String(raw.url ?? "").trim();
    if (type === "local" && !command) throw new Error(`Local MCP server ${id} needs a command.`);
    if (type === "remote" && !/^https?:\/\//i.test(url)) {
      throw new Error(`Remote MCP server ${id} needs an http(s) URL.`);
    }
    const timeoutMs = raw.timeoutMs === undefined ? undefined : Number(raw.timeoutMs);
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      throw new Error(`MCP server ${id} timeoutMs must be positive.`);
    }
    return {
      id,
      name: String(raw.name ?? id).trim() || id,
      enabled: raw.enabled !== false,
      type,
      command: command || undefined,
      args: Array.isArray(raw.args) ? raw.args.map(String) : [],
      url: url || undefined,
      environment: jsonObject(raw.environment),
      headers: jsonObject(raw.headers),
      timeoutMs,
      allowedTools: Array.isArray(raw.allowedTools) ? raw.allowedTools.map(String).filter(Boolean) : [],
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
          `Use \${env:VARIABLE_NAME}, or save it through the VS Code tools settings so SecretStorage is used.`
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

function opencodeMcpDocument(servers: McpServerConfig[], enabledKey: "enabled" | "disabled"): Record<string, unknown> {
  const mapped: Record<string, unknown> = {};
  for (const server of servers) {
    mapped[server.id] = server.type === "remote"
      ? {
          type: "remote",
          url: server.url,
          headers: server.headers ?? {},
          [enabledKey]: enabledKey === "enabled" ? true : false,
        }
      : {
          type: "local",
          command: [server.command, ...(server.args ?? [])],
          environment: server.environment ?? {},
          [enabledKey]: enabledKey === "enabled" ? true : false,
        };
  }
  return mapped;
}

function externalDirectoryPermission(paths: readonly string[]): Record<string, "allow"> {
  return Object.fromEntries(paths.map((entry) => {
    const normalized = path.resolve(entry).replace(/\\/g, "/").replace(/\/+$/, "");
    return [`${normalized}/**`, "allow" as const];
  }));
}

function opencodePermissionDocument(opts: ProviderInvocationOptions): Record<string, unknown> {
  const permission: Record<string, unknown> = {
    read: "allow",
    glob: "allow",
    grep: "allow",
    list: "allow",
    bash: "allow",
    edit: opts.readOnly ? "deny" : "allow",
    websearch: opts.webSearch ? "allow" : "deny",
    webfetch: opts.webSearch ? "allow" : "deny",
  };
  const additional = externalDirectoryPermission(opts.additionalAllowedPaths ?? []);
  if (Object.keys(additional).length > 0) permission.external_directory = additional;
  return permission;
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
  const mcpServers = resolveMcpServerSecrets(opts.mcpServers, opts.secretValues);
  let args: string[];
  switch (provider.adapter) {
    case "opencode": {
      args = ["run", "--format", "json", "--model", opts.model, "--dir", opts.targetProjectPath];
      if (opts.fullAccess && !opts.readOnly) args.push("--dangerously-skip-permissions");
      if (opts.variant) args.push("--variant", opts.variant);
      if (opts.resumeSessionId) args.push("--session", opts.resumeSessionId);
      const runtime: Record<string, unknown> = { permission: opencodePermissionDocument(opts) };
      if (opts.webSearch) {
        env.OPENCODE_ENABLE_EXA = "1";
      }
      if (mcpServers.length > 0) runtime.mcp = { servers: opencodeMcpDocument(mcpServers, "disabled") };
      if (Object.keys(runtime).length > 0) env.OPENCODE_CONFIG_CONTENT = JSON.stringify(runtime);
      args.push(opts.prompt);
      break;
    }
    case "kilo": {
      args = ["run", "--pure", "--format", "json", "--model", opts.model, "--dir", opts.targetProjectPath];
      if (opts.fullAccess && !opts.readOnly) args.push("--auto");
      if (opts.variant) args.push("--variant", opts.variant);
      if (opts.resumeSessionId) args.push("--session", opts.resumeSessionId);
      const runtime: Record<string, unknown> = { permission: opencodePermissionDocument(opts) };
      if (mcpServers.length > 0) runtime.mcp = opencodeMcpDocument(mcpServers, "enabled");
      if (Object.keys(runtime).length > 0) env.KILO_CONFIG_CONTENT = JSON.stringify(runtime);
      args.push(opts.prompt);
      break;
    }
    case "codex": {
      const globalArgs: string[] = [];
      if (opts.webSearch && opts.webSearchMode === "live") globalArgs.push("--search");
      args = [...globalArgs, "exec", "--json", "--model", opts.model, "--skip-git-repo-check"];
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
      if (opts.variant) args.push("-c", `model_reasoning_effort=${tomlString(opts.variant)}`);
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
      if (opts.readOnly) args.push("--disallowedTools", "Edit,Write,NotebookEdit");
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
      if (allowed.size > 0) args.push("--allowedTools", [...allowed].join(","));
      break;
    }
  }
  return { binary: provider.binary, args, env };
}

export function providerModelEntries(
  providers: Record<string, ProviderConfig>,
  discovered?: Record<string, { models?: string[] }>
): Array<{ providerId: string; model: string }> {
  const entries: Array<{ providerId: string; model: string }> = [];
  for (const [providerId, provider] of Object.entries(providers)) {
    if (!provider.enabled) continue;
    const models = discovered?.[providerId]?.models?.length
      ? discovered[providerId].models!
      : provider.fallbackModels;
    for (const model of models) entries.push({ providerId, model });
  }
  return entries;
}
