import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  DEFAULT_PROVIDERS,
  assertMcpCredentialsAreReferenced,
  buildProviderInvocation,
  claudeMcpDocument,
  collectMcpSensitiveValues,
  collectSensitiveEnvironmentValues,
  normalizeProviders,
  resolveMcpServerSecrets,
  selectMcpServersForInvocation,
  validateToolAccess,
} from "./provider_runtime";
import { extractAssistantText, findSessionId } from "./process_supervisor";

const localMcp = {
  id: "docs",
  name: "Docs",
  enabled: true,
  type: "local" as const,
  command: "npx",
  args: ["-y", "docs-mcp"],
  environment: { API_KEY: "secret" },
  allowedTools: ["search"],
};

const providerFixtureRoot = path.join(process.cwd(), "provider-runtime-fixtures");
const providerTargetPath = path.join(providerFixtureRoot, "repo");
const providerAdditionalPath = path.join(providerFixtureRoot, "additional");
const providerOutsidePath = path.join(providerFixtureRoot, "outside");
const providerSharedPath = path.join(providerFixtureRoot, "shared");
const providerMcpConfigPath = path.join(providerFixtureRoot, "tmp", "mcp.json");

test("provider registry includes OpenCode, Kilo, Codex, and Claude and accepts custom instances", () => {
  const providers = normalizeProviders({
    custom_codex: {
      label: "Company Codex",
      adapter: "codex",
      binary: "company-codex",
      enabled: true,
      fallbackModels: ["company-gpt"],
    },
  });
  assert.deepEqual(Object.keys(providers).slice(0, 4), ["opencode", "kilo", "codex", "claude"]);
  assert.equal(providers.custom_codex.adapter, "codex");
  assert.equal(providers.custom_codex.binary, "company-codex");
});

test("built-in provider overrides are normalized and reject invalid adapters or binaries", () => {
  const providers = normalizeProviders({
    codex: {
      label: "  Local Codex  ",
      binary: " codex-custom ",
      fallbackModels: ["gpt-test", ""],
    },
  });
  assert.equal(providers.codex.label, "Local Codex");
  assert.equal(providers.codex.binary, "codex-custom");
  assert.deepEqual(providers.codex.fallbackModels, ["gpt-test"]);
  assert.throws(
    () => normalizeProviders({ codex: { adapter: "invalid" as any } }),
    /unsupported adapter/
  );
  assert.throws(() => normalizeProviders({ codex: { binary: " " } }), /must define a binary/);
});

test("Codex invocation maps live web search, resume, sandbox, and MCP configuration", () => {
  const invocation = buildProviderInvocation(DEFAULT_PROVIDERS.codex, {
    model: "gpt-5.6-sol",
    targetProjectPath: providerTargetPath,
    additionalAllowedPaths: [providerAdditionalPath],
    prompt: "continue",
    variant: "xhigh",
    resumeSessionId: "thread-1",
    fullAccess: false,
    webSearch: true,
    webSearchMode: "live",
    mcpServers: [localMcp],
  });
  assert.equal(invocation.binary, "codex");
  assert.ok(invocation.args.includes("--json"));
  assert.ok(invocation.args.includes("--search"));
  assert.ok(invocation.args.indexOf("--search") < invocation.args.indexOf("exec"));
  assert.ok(invocation.args.includes("workspace-write"));
  assert.ok(invocation.args.includes("--add-dir"));
  assert.ok(invocation.args.includes(providerAdditionalPath));
  assert.ok(invocation.args.includes("resume"));
  assert.ok(invocation.args.some((arg) => arg.includes("model_reasoning_effort") && arg.includes("xhigh")));
  assert.ok(invocation.args.some((arg) => arg.includes("mcp_servers.docs.command")));
  assert.ok(invocation.args.some((arg) => arg.includes("mcp_servers.docs.env_vars")));
  assert.equal(invocation.env.API_KEY, "secret");
  assert.equal(invocation.args.some((arg) => arg.includes("secret")), false);
});

test("MCP secret and environment references resolve only at invocation time", () => {
  const resolved = resolveMcpServerSecrets([
    {
      ...localMcp,
      environment: { API_KEY: "${secret:agentLoop.mcp.docs.environment.key}" },
      headers: { "X-Region": "${env:MCP_REGION}" },
    },
  ], {
    "agentLoop.mcp.docs.environment.key": "top-secret",
  }, {
    MCP_REGION: "ap-northeast-2",
  });
  assert.equal(resolved[0].environment?.API_KEY, "top-secret");
  assert.equal(resolved[0].headers?.["X-Region"], "ap-northeast-2");
  assert.throws(() => resolveMcpServerSecrets([
    { ...localMcp, environment: { API_KEY: "${secret:missing}" } },
  ]), /MCP secret 'missing' is unavailable/);
});

test("Codex remote MCP headers use environment references and never expose values in args", () => {
  const invocation = buildProviderInvocation(DEFAULT_PROVIDERS.codex, {
    model: "gpt-5.6-sol",
    targetProjectPath: providerTargetPath,
    prompt: "inspect",
    fullAccess: false,
    webSearch: false,
    mcpServers: [{
      id: "remote_docs",
      name: "Remote docs",
      enabled: true,
      type: "remote",
      url: "https://example.test/mcp",
      headers: { Authorization: "Bearer top-secret", "X-Region": "kr" },
    }],
  });
  const joined = invocation.args.join(" ");
  assert.match(joined, /env_http_headers/);
  assert.equal(joined.includes("top-secret"), false);
  assert.equal(joined.includes("Bearer"), false);
  assert.equal(Object.values(invocation.env).includes("Bearer top-secret"), true);
});

test("Codex read-only roles fail closed while inherited MCP cannot be isolated", () => {
  assert.throws(
    () => buildProviderInvocation(DEFAULT_PROVIDERS.codex, {
      model: "gpt-5.6-sol",
      targetProjectPath: providerTargetPath,
      prompt: "inspect only",
      fullAccess: true,
      readOnly: true,
      webSearch: false,
      mcpServers: [localMcp],
    }),
    /read-only roles are unsupported.*isolated inherited tool configuration/i
  );
});

test("provider capability profiles are adapter-owned and cannot be escalated by configuration", () => {
  const providers = normalizeProviders({
    codex: {
      capabilities: {
        ...DEFAULT_PROVIDERS.claude.capabilities,
        readOnlyFilesystem: "enforced",
        mcpIsolation: "explicit",
        readOnlyMcpToolFiltering: "enforced",
      },
    },
  });
  assert.equal(providers.codex.capabilities.readOnlyFilesystem, "unsupported");
  assert.equal(providers.codex.capabilities.mcpIsolation, "inherited");
  assert.throws(() => buildProviderInvocation({
    ...providers.codex,
    capabilities: DEFAULT_PROVIDERS.claude.capabilities,
  }, {
    model: "gpt",
    targetProjectPath: providerTargetPath,
    prompt: "inspect",
    fullAccess: false,
    readOnly: true,
    webSearch: false,
    mcpServers: [],
  }), /read-only roles are unsupported/i);
});

test("OpenCode-family access policies map approved roots and never bypass read-only roles", () => {
  const readOnly = buildProviderInvocation(DEFAULT_PROVIDERS.opencode, {
    model: "open/model",
    targetProjectPath: providerTargetPath,
    additionalAllowedPaths: [providerOutsidePath],
    prompt: "inspect",
    fullAccess: true,
    readOnly: true,
    webSearch: false,
    mcpServers: [localMcp],
  });
  assert.equal(readOnly.args.includes("--dangerously-skip-permissions"), false);
  const openConfig = JSON.parse(readOnly.env.OPENCODE_CONFIG_CONTENT) as any;
  assert.equal(openConfig.permission["*"], "deny");
  assert.equal(openConfig.permission.read, "allow");
  assert.equal(openConfig.permission.glob, "allow");
  assert.equal(openConfig.permission.grep, "allow");
  assert.equal(openConfig.permission.list, "allow");
  assert.equal(openConfig.permission.edit, "deny");
  assert.equal(openConfig.permission.bash, "deny");
  const outsidePermission = `${providerOutsidePath.replace(/\\/g, "/")}/**`;
  assert.equal(openConfig.permission["external_directory"][outsidePermission], "allow");
  assert.equal(openConfig.mcp, undefined);

  const kiloReadOnly = buildProviderInvocation(DEFAULT_PROVIDERS.kilo, {
    model: "anthropic/model",
    targetProjectPath: providerTargetPath,
    prompt: "inspect",
    fullAccess: true,
    readOnly: true,
    webSearch: false,
    mcpServers: [localMcp],
  });
  const kiloReadOnlyConfig = JSON.parse(kiloReadOnly.env.KILO_CONFIG_CONTENT) as any;
  assert.equal(kiloReadOnlyConfig.permission["*"], "deny");
  assert.equal(kiloReadOnlyConfig.permission.bash, "deny");
  assert.equal(kiloReadOnlyConfig.permission.edit, "deny");
  assert.equal(kiloReadOnlyConfig.mcp, undefined);

  const askMode = buildProviderInvocation(DEFAULT_PROVIDERS.kilo, {
    model: "anthropic/model",
    targetProjectPath: providerTargetPath,
    prompt: "work",
    fullAccess: false,
    webSearch: false,
    mcpServers: [],
  });
  assert.equal(askMode.args.includes("--auto"), false);
  const fullAccess = buildProviderInvocation(DEFAULT_PROVIDERS.kilo, {
    model: "anthropic/model",
    targetProjectPath: providerTargetPath,
    prompt: "work",
    fullAccess: true,
    webSearch: false,
    mcpServers: [],
  });
  assert.equal(fullAccess.args.includes("--auto"), true);
});

test("Claude invocation maps stream JSON, web tools, resume, and generated MCP document", () => {
  const invocation = buildProviderInvocation(DEFAULT_PROVIDERS.claude, {
    model: "sonnet",
    targetProjectPath: providerTargetPath,
    additionalAllowedPaths: [providerSharedPath],
    prompt: "work",
    resumeSessionId: "claude-session",
    fullAccess: true,
    webSearch: true,
    mcpServers: [localMcp],
    claudeMcpConfigPath: providerMcpConfigPath,
  });
  assert.ok(invocation.args.includes("stream-json"));
  assert.ok(invocation.args.includes("--resume"));
  assert.ok(invocation.args.includes("--mcp-config"));
  assert.ok(invocation.args.includes("--add-dir"));
  assert.ok(invocation.args.includes(providerSharedPath));
  assert.ok(invocation.args.some((arg) => arg.includes("WebSearch") && arg.includes("mcp__docs__search")));
  assert.deepEqual(claudeMcpDocument([localMcp]), {
    mcpServers: { docs: { command: "npx", args: ["-y", "docs-mcp"], env: { API_KEY: "secret" } } },
  });
});

test("Claude read-only roles expose only an explicit safe tool allowlist", () => {
  const invocation = buildProviderInvocation(DEFAULT_PROVIDERS.claude, {
    model: "sonnet",
    targetProjectPath: providerTargetPath,
    prompt: "inspect only",
    fullAccess: true,
    readOnly: true,
    webSearch: true,
    mcpServers: [localMcp],
    claudeMcpConfigPath: providerMcpConfigPath,
  });
  const toolsIndex = invocation.args.indexOf("--tools");
  assert.ok(toolsIndex >= 0);
  assert.equal(invocation.args[toolsIndex + 1], "Read,Glob,Grep,WebSearch,WebFetch");
  assert.equal(invocation.args.includes("--disallowedTools"), false);
  assert.equal(invocation.args[toolsIndex + 1].includes("Bash"), false);
  assert.equal(invocation.args[toolsIndex + 1].includes("Task"), false);
  assert.equal(invocation.args[toolsIndex + 1].includes("Skill"), false);
  assert.equal(invocation.args.includes("--strict-mcp-config"), true);
  assert.equal(invocation.args.includes("--mcp-config"), false);
  assert.equal(invocation.args.some((arg) => arg.includes("mcp__")), false);
  assert.equal(invocation.args.includes("--dangerously-skip-permissions"), false);
});

test("Claude read-only MCP exposes only tools explicitly classified read_only", () => {
  const classified = validateToolAccess({
    webSearch: { enabled: false, mode: "live" },
    mcpServers: [{
      ...localMcp,
      tools: [
        { name: "search", sideEffect: "read_only" },
        { name: "publish", sideEffect: "write" },
        { name: "mystery", sideEffect: "unknown" },
      ],
    }],
  }).mcpServers;
  const selected = selectMcpServersForInvocation(DEFAULT_PROVIDERS.claude, classified, true);
  assert.deepEqual(selected[0].tools, [{ name: "search", sideEffect: "read_only" }]);
  assert.deepEqual(selected[0].allowedTools, ["search"]);

  const invocation = buildProviderInvocation(DEFAULT_PROVIDERS.claude, {
    model: "sonnet",
    targetProjectPath: providerTargetPath,
    prompt: "inspect",
    fullAccess: false,
    readOnly: true,
    webSearch: false,
    webSearchMode: "live",
    mcpServers: classified,
    claudeMcpConfigPath: providerMcpConfigPath,
  });
  const tools = invocation.args[invocation.args.indexOf("--tools") + 1];
  assert.match(tools, /mcp__docs__search/);
  assert.equal(tools.includes("publish"), false);
  assert.equal(tools.includes("mystery"), false);
  assert.equal(invocation.args.includes("--mcp-config"), true);
});

test("legacy MCP allowlists migrate to unknown and cannot enter read-only roles", () => {
  const migrated = validateToolAccess({
    webSearch: { enabled: false, mode: "cached" },
    mcpServers: [localMcp],
  }).mcpServers;
  assert.deepEqual(migrated[0].tools, [{ name: "search", sideEffect: "unknown" }]);
  assert.deepEqual(selectMcpServersForInvocation(DEFAULT_PROVIDERS.claude, migrated, true), []);
});

test("provider preflight rejects unsupported explicit web modes", () => {
  assert.throws(() => buildProviderInvocation(DEFAULT_PROVIDERS.claude, {
    model: "sonnet",
    targetProjectPath: providerTargetPath,
    prompt: "research",
    fullAccess: false,
    webSearch: true,
    webSearchMode: "cached",
    mcpServers: [],
  }), /does not support cached web search/i);
});

test("OpenCode and Kilo receive runtime MCP and web search configuration without file edits", () => {
  const open = buildProviderInvocation(DEFAULT_PROVIDERS.opencode, {
    model: "open/model",
    targetProjectPath: providerTargetPath,
    prompt: "work",
    fullAccess: true,
    webSearch: true,
    mcpServers: [localMcp],
  });
  assert.equal(open.env.OPENCODE_ENABLE_EXA, "1");
  assert.match(open.env.OPENCODE_CONFIG_CONTENT, /"docs"/);

  const kilo = buildProviderInvocation(DEFAULT_PROVIDERS.kilo, {
    model: "anthropic/model",
    targetProjectPath: providerTargetPath,
    prompt: "work",
    fullAccess: true,
    webSearch: true,
    mcpServers: [localMcp],
  });
  assert.match(kilo.env.KILO_CONFIG_CONTENT, /"websearch":"allow"/);
  assert.match(kilo.env.KILO_CONFIG_CONTENT, /"docs"/);
});

test("tool access validation rejects duplicate or malformed MCP entries", () => {
  assert.throws(() => validateToolAccess({
    webSearch: { enabled: true, mode: "live" },
    mcpServers: [{ ...localMcp }, { ...localMcp }],
  }), /Duplicate MCP server id/);
  assert.throws(() => validateToolAccess({
    webSearch: { enabled: false, mode: "cached" },
    mcpServers: [{ id: "remote", name: "Remote", enabled: true, type: "remote", url: "file://bad" }],
  }), /http\(s\) URL/);
  assert.throws(() => validateToolAccess({
    webSearch: { enabled: false, mode: "cached" },
    mcpServers: [{
      ...localMcp,
      tools: [{ name: "search", sideEffect: "destructive" as any }],
    }],
  }), /invalid side effect/);
});

test("persistent MCP settings reject inline credentials and accept references", () => {
  assert.throws(() => assertMcpCredentialsAreReferenced({
    webSearch: { enabled: false, mode: "cached" },
    mcpServers: [localMcp],
  }), /contains an inline value/);
  assert.doesNotThrow(() => assertMcpCredentialsAreReferenced({
    webSearch: { enabled: false, mode: "cached" },
    mcpServers: [{
      ...localMcp,
      environment: { API_KEY: "${env:DOCS_API_KEY}" },
      headers: { Authorization: "${secret:agentLoop.mcp.docs.headers.auth}" },
    }],
  }));
});

test("resolved MCP environment and header values are collected for streaming redaction", () => {
  const servers = resolveMcpServerSecrets([{
    ...localMcp,
    environment: { API_KEY: "${env:DOCS_API_KEY}" },
    headers: { Authorization: "${secret:docs.authorization}" },
  }], {
    "docs.authorization": "Bearer secret-storage-value",
  }, {
    DOCS_API_KEY: "environment-secret-value",
  });
  assert.deepEqual(
    new Set(collectMcpSensitiveValues(servers)),
    new Set(["environment-secret-value", "Bearer secret-storage-value"])
  );
});

test("credential-shaped inherited environment values join the redaction set", () => {
  assert.deepEqual(new Set(collectSensitiveEnvironmentValues({
    PATH: "ordinary-path",
    OPENAI_API_KEY: "openai-secret",
    CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret",
    DATABASE_PASSWORD: "database-secret",
    EMPTY_SECRET: "",
  })), new Set(["openai-secret", "oauth-secret", "database-secret"]));
});

test("supervisor extracts only provider assistant fields and all supported session IDs", () => {
  assert.equal(extractAssistantText({
    type: "item.completed",
    item: { type: "agent_message", text: "Codex answer" },
  }), "Codex answer");
  assert.equal(extractAssistantText({
    type: "assistant",
    message: { content: [{ type: "text", text: "Claude answer" }, { type: "tool_use", name: "Read" }] },
  }), "Claude answer");
  assert.equal(extractAssistantText({ type: "user", message: "[PHASE_DONE]" }), null);
  assert.equal(findSessionId({ type: "thread.started", thread_id: "thread-1" }), "thread-1");
  assert.equal(findSessionId({ session_id: "claude-1" }), "claude-1");
});
