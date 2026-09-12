import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  CODEX_DEFAULT_REASONING_EFFORT,
  DEFAULT_PROVIDERS,
  OPENCODE_READ_ONLY_AGENT,
  assertMcpCredentialsAreReferenced,
  buildProviderInvocation,
  claudeMcpDocument,
  collectMcpSensitiveValues,
  collectSensitiveEnvironmentValues,
  normalizeProviders,
  resolveMcpServerSecrets,
  selectMcpServersForInvocation,
  validateToolAccess,
} from "../../src/runtime/providers/provider-runtime";
import { extractAssistantText, findSessionId } from "../../src/runtime/process-supervisor";
import {
  DEFAULT_VISUAL_RESEARCH_MODEL,
  REFERENCE_DISCOVERY_MCP_TOOL_NAME,
  VISUAL_RESEARCH_MCP_TOOL_NAME,
  createVisualResearchMcpServer,
} from "../../src/runtime/mcp/visual-research-mcp";

const localMcp = {
  id: "docs",
  name: "Docs",
  enabled: true,
  type: "local" as const,
  command: "npx",
  args: ["-y", "docs-mcp"],
  environment: { API_KEY: "secret" },
  tools: [{ name: "search", sideEffect: "unknown" as const }],
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
      modelCatalog: { source: "configured", models: ["company-gpt"] },
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
      modelCatalog: { source: "configured", models: ["gpt-test"] },
    },
  });
  assert.equal(providers.codex.label, "Local Codex");
  assert.equal(providers.codex.binary, "codex-custom");
  assert.deepEqual(providers.codex.modelCatalog, { source: "configured", models: ["gpt-test"] });
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

test("Codex invocation pins a safe reasoning effort instead of inheriting global config", () => {
  const invocation = buildProviderInvocation(DEFAULT_PROVIDERS.codex, {
    model: "gpt-5.3-codex-spark",
    targetProjectPath: providerTargetPath,
    prompt: "implement",
    fullAccess: false,
    webSearch: false,
    mcpServers: [],
  });
  assert.ok(invocation.args.some(
    (arg) => arg === `model_reasoning_effort=${JSON.stringify(CODEX_DEFAULT_REASONING_EFFORT)}`
  ));
  assert.equal(invocation.args.some((arg) => arg.includes("ultra") || arg.includes("max")), false);
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

test("Codex read-only roles isolate inherited config and withhold MCP tools", () => {
  const invocation = buildProviderInvocation(DEFAULT_PROVIDERS.codex, {
    model: "gpt-5.6-sol",
    targetProjectPath: providerTargetPath,
    prompt: "inspect only",
    fullAccess: true,
    readOnly: true,
    webSearch: false,
    mcpServers: [localMcp],
  });
  assert.ok(invocation.args.includes("--ignore-user-config"));
  assert.ok(invocation.args.includes("--ignore-rules"));
  assert.equal(
    invocation.args[invocation.args.indexOf("--ask-for-approval") + 1],
    "never"
  );
  assert.equal(invocation.args[invocation.args.indexOf("--sandbox") + 1], "read-only");
  assert.ok(invocation.args.some((arg) =>
    arg.startsWith("projects.") && arg.endsWith('trust_level="untrusted"')
  ));
  assert.equal(invocation.args.some((arg) => arg.includes("mcp_servers.docs")), false);
  assert.equal(Object.values(invocation.env).includes("secret"), false);
});

test("Codex tool-free formatting recovery fails closed without a verified capability", () => {
  assert.throws(
    () => buildProviderInvocation(DEFAULT_PROVIDERS.codex, {
      model: "gpt-5.6-sol",
      targetProjectPath: providerTargetPath,
      prompt: "format this response",
      fullAccess: false,
      readOnly: true,
      workspaceMode: "none",
      webSearch: false,
      mcpServers: [],
    }),
    /verified tools-none capability/
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
  assert.equal(providers.codex.capabilities.readOnlyFilesystem, "enforced");
  assert.equal(providers.codex.capabilities.mcpIsolation, "inherited");
  const readOnly = buildProviderInvocation({
    ...providers.codex,
    capabilities: {
      ...providers.codex.capabilities,
      readOnlyFilesystem: "unsupported",
    },
  }, {
    model: "gpt",
    targetProjectPath: providerTargetPath,
    prompt: "inspect",
    fullAccess: false,
    readOnly: true,
    webSearch: false,
    mcpServers: [],
  });
  assert.ok(readOnly.args.includes("--ignore-user-config"));
  assert.equal(readOnly.args[readOnly.args.indexOf("--sandbox") + 1], "read-only");
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
  assert.ok(readOnly.args.includes("--pure"));
  assert.equal(readOnly.args[readOnly.args.indexOf("--agent") + 1], OPENCODE_READ_ONLY_AGENT);
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
  assert.equal(openConfig.agent[OPENCODE_READ_ONLY_AGENT].tools.bash, false);
  assert.equal(openConfig.agent[OPENCODE_READ_ONLY_AGENT].tools.edit, false);
  assert.equal(openConfig.agent[OPENCODE_READ_ONLY_AGENT].tools.task, false);
  assert.equal(openConfig.agent[OPENCODE_READ_ONLY_AGENT].tools.apply_patch, false);
  assert.equal(openConfig.agent[OPENCODE_READ_ONLY_AGENT].tools.read, true);
  assert.equal(openConfig.agent[OPENCODE_READ_ONLY_AGENT].tools.websearch, false);
  assert.match(openConfig.agent[OPENCODE_READ_ONLY_AGENT].prompt, /authoritative role, goal, and output contract/i);
  assert.match(openConfig.agent[OPENCODE_READ_ONLY_AGENT].prompt, /CurrentWork templates/i);
  assert.equal(openConfig.agent[OPENCODE_READ_ONLY_AGENT].permission["*"], undefined);
  assert.equal(openConfig.agent[OPENCODE_READ_ONLY_AGENT].permission.apply_patch, "deny");

  const kiloReadOnly = buildProviderInvocation(DEFAULT_PROVIDERS.kilo, {
    model: "anthropic/model",
    targetProjectPath: providerTargetPath,
    prompt: "inspect",
    fullAccess: true,
    readOnly: true,
    webSearch: false,
    mcpServers: [localMcp],
  });
  assert.equal(
    kiloReadOnly.args[kiloReadOnly.args.indexOf("--agent") + 1],
    OPENCODE_READ_ONLY_AGENT
  );
  const kiloReadOnlyConfig = JSON.parse(kiloReadOnly.env.KILO_CONFIG_CONTENT) as any;
  assert.equal(kiloReadOnlyConfig.permission["*"], "deny");
  assert.equal(kiloReadOnlyConfig.permission.bash, "deny");
  assert.equal(kiloReadOnlyConfig.permission.edit, "deny");
  assert.equal(kiloReadOnlyConfig.mcp, undefined);
  assert.equal(kiloReadOnlyConfig.agent[OPENCODE_READ_ONLY_AGENT].tools.bash, false);
  assert.equal(kiloReadOnlyConfig.agent[OPENCODE_READ_ONLY_AGENT].tools.write, false);
  assert.equal(kiloReadOnlyConfig.agent[OPENCODE_READ_ONLY_AGENT].tools.read, true);
  assert.match(kiloReadOnlyConfig.agent[OPENCODE_READ_ONLY_AGENT].prompt, /requested structured response/i);
  assert.match(kiloReadOnlyConfig.agent[OPENCODE_READ_ONLY_AGENT].prompt, /never inspect parent or sibling/i);
  assert.equal(kiloReadOnlyConfig.agent[OPENCODE_READ_ONLY_AGENT].permission["*"], undefined);
  assert.equal(kiloReadOnlyConfig.agent[OPENCODE_READ_ONLY_AGENT].permission.external_directory["*"], "deny");
  assert.equal(kiloReadOnlyConfig.agent[OPENCODE_READ_ONLY_AGENT].permission.apply_patch, "deny");

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

test("OpenCode read-only roles admit only runtime-owned classified MCP tools", () => {
  const runtimeServer = createVisualResearchMcpServer({
    nodeBinary: process.execPath,
    scriptPath: path.join(process.cwd(), "dist", "core", "runtime", "mcp", "visual-research-mcp.js"),
    providerBinary: "C:\\tools\\opencode.exe",
    tempRoot: path.join(providerFixtureRoot, "session", "visual-research"),
  });
  const selected = selectMcpServersForInvocation(
    DEFAULT_PROVIDERS.opencode,
    [localMcp, runtimeServer],
    true
  );
  assert.equal(selected.length, 1);
  assert.equal(selected[0].runtimeOwned, true);
  assert.deepEqual(selected[0].tools, [
    { name: "inspect_remote_images", sideEffect: "read_only" },
    { name: "discover_reference_candidates", sideEffect: "read_only" },
  ]);

  const agentName = "agent-loop-readonly-deadbeef";
  const invocation = buildProviderInvocation(DEFAULT_PROVIDERS.opencode, {
    model: "opencode/deepseek-v4-flash-free",
    targetProjectPath: providerTargetPath,
    prompt: "inspect exact product screenshots",
    fullAccess: false,
    readOnly: true,
    readOnlyAgentName: agentName,
    webSearch: true,
    webSearchMode: "live",
    mcpServers: [localMcp, runtimeServer],
  });
  assert.equal(invocation.args[invocation.args.indexOf("--agent") + 1], agentName);
  const config = JSON.parse(invocation.env.OPENCODE_CONFIG_CONTENT) as any;
  assert.equal(config.mcp.servers, undefined);
  assert.equal(config.mcp.agent_loop_visual.type, "local");
  assert.equal(config.mcp.agent_loop_visual.enabled, true);
  assert.equal(config.mcp.docs, undefined);
  assert.equal(config.permission[VISUAL_RESEARCH_MCP_TOOL_NAME], "allow");
  assert.equal(config.permission[REFERENCE_DISCOVERY_MCP_TOOL_NAME], "allow");
  assert.equal(config.agent[agentName].tools["*"], false);
  assert.equal(config.agent[agentName].tools[VISUAL_RESEARCH_MCP_TOOL_NAME], true);
  assert.equal(config.agent[agentName].tools[REFERENCE_DISCOVERY_MCP_TOOL_NAME], true);
  assert.equal(config.agent[agentName].permission[VISUAL_RESEARCH_MCP_TOOL_NAME], "allow");
  assert.equal(config.agent[agentName].permission[REFERENCE_DISCOVERY_MCP_TOOL_NAME], "allow");
  assert.match(JSON.stringify(config.mcp), new RegExp(DEFAULT_VISUAL_RESEARCH_MODEL.replace(/[./-]/g, "\\$&")));

  const persisted = validateToolAccess({
    webSearch: { enabled: false, mode: "cached" },
    mcpServers: [{ ...runtimeServer, runtimeOwned: true }],
  }).mcpServers[0];
  assert.equal(persisted.runtimeOwned, undefined);
  assert.deepEqual(
    selectMcpServersForInvocation(DEFAULT_PROVIDERS.opencode, [persisted], true),
    []
  );
});

test("Kilo transports multiline prompts as one PTY-safe positional argument", () => {
  const prompt = "PLANNER role\r\nORIGINAL USER GOAL: build the game\nReturn exactly PLAN_READY";
  const invocation = buildProviderInvocation(DEFAULT_PROVIDERS.kilo, {
    model: "kilo/model",
    targetProjectPath: providerTargetPath,
    prompt,
    fullAccess: false,
    readOnly: true,
    webSearch: false,
    mcpServers: [],
  });
  const transported = invocation.args[invocation.args.length - 1];
  assert.equal(transported, "PLANNER role\u2028ORIGINAL USER GOAL: build the game\u2028Return exactly PLAN_READY");
  assert.doesNotMatch(transported ?? "", /[\r\n]/);
  assert.match(transported ?? "", /ORIGINAL USER GOAL/);
  assert.match(transported ?? "", /PLAN_READY/);
});

test("Kilo can attach a runtime-owned prompt file to avoid Windows command-line limits", () => {
  const prompt = "A".repeat(20_000) + "\n[PHASE_DONE]";
  const promptFilePath = path.join(providerFixtureRoot, "runtime", "kilo_prompt_attempt.md");
  const invocation = buildProviderInvocation(DEFAULT_PROVIDERS.kilo, {
    model: "kilo/model",
    targetProjectPath: providerTargetPath,
    prompt,
    promptFilePath,
    fullAccess: false,
    readOnly: true,
    webSearch: false,
    mcpServers: [],
  });
  const fileIndex = invocation.args.indexOf("--file");
  assert.notEqual(fileIndex, -1);
  assert.equal(invocation.args[fileIndex + 1], path.resolve(promptFilePath));
  assert.match(invocation.args[fileIndex - 1], /complete authoritative instruction set/i);
  assert.equal(fileIndex + 1, invocation.args.length - 1);
  assert.equal(invocation.args.some((arg) => arg.includes("A".repeat(1_000))), false);
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

test("removed name-only MCP allowlists are rejected instead of migrated", () => {
  assert.throws(() => validateToolAccess({
    webSearch: { enabled: false, mode: "cached" },
    mcpServers: [{ ...localMcp, tools: undefined }],
  }), /removed name-only allowedTools contract/u);
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
  const openConfig = JSON.parse(open.env.OPENCODE_CONFIG_CONTENT) as any;
  assert.equal(openConfig.mcp.servers, undefined);
  assert.equal(openConfig.mcp.docs.type, "local");
  assert.equal(openConfig.mcp.docs.enabled, true);

  const kilo = buildProviderInvocation(DEFAULT_PROVIDERS.kilo, {
    model: "anthropic/model",
    targetProjectPath: providerTargetPath,
    prompt: "work",
    fullAccess: true,
    webSearch: true,
    mcpServers: [localMcp],
  });
  const kiloConfig = JSON.parse(kilo.env.KILO_CONFIG_CONTENT) as any;
  assert.equal(kiloConfig.permission.websearch, "allow");
  assert.equal(kiloConfig.mcp.docs.type, "local");
  assert.equal(kiloConfig.mcp.docs.enabled, true);
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
