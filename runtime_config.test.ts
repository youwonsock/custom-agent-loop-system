import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getDefaultConfig, loadLoopConfig, RUNTIME_DEFAULTS } from "./runtime_config";

test("core, generated extension runtime, and VS Code manifest share canonical defaults", async () => {
  const root = path.resolve(__dirname, "..");
  const generated = JSON.parse(await fs.readFile(
    path.join(root, "vscode-extension", "src", "generated_runtime_defaults.json"),
    "utf8"
  )) as Record<string, unknown>;
  assert.deepEqual(generated, RUNTIME_DEFAULTS);
  const extensionPackage = JSON.parse(await fs.readFile(
    path.join(root, "vscode-extension", "package.json"),
    "utf8"
  )) as any;
  const properties = extensionPackage.contributes.configuration.properties;
  for (const [key, value] of Object.entries(RUNTIME_DEFAULTS)) {
    assert.deepEqual(properties[`agentLoop.${key}`]?.default, value, `manifest default drift: ${key}`);
  }
  for (const [canonicalName, generatedName] of [
    ["agent_roles.json", "generated_agent_roles.json"],
    ["agent_loop.json", "generated_agent_loop.json"],
  ]) {
    const canonical = JSON.parse(await fs.readFile(path.join(root, canonicalName), "utf8"));
    const generated = JSON.parse(await fs.readFile(
      path.join(root, "vscode-extension", "src", generatedName),
      "utf8"
    ));
    assert.deepEqual(generated, canonical, `generated extension template drift: ${canonicalName}`);
  }
});

test("runtime config deep-merges path/default sections from one core source", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-loop-config-"));
  try {
    await fs.writeFile(path.join(root, "loop_config.json"), JSON.stringify({
      paths: { sessionFileNames: { plan: "custom-plan.md" } },
      defaults: { maxIterations: 7 },
    }), "utf8");
    const config = await loadLoopConfig(root);
    assert.equal(config.paths.sessionFileNames.plan, "custom-plan.md");
    assert.equal(config.paths.sessionFileNames.state, "loop_state.json");
    assert.equal(config.defaults.maxIterations, 7);
    assert.equal(config.defaults.transportTimeoutMs, getDefaultConfig().defaults.transportTimeoutMs);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("malformed config and inline MCP credentials fail loudly instead of using defaults", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-loop-config-invalid-"));
  try {
    await fs.writeFile(path.join(root, "loop_config.json"), "{broken", "utf8");
    await assert.rejects(loadLoopConfig(root), /Failed to load/);
    await fs.writeFile(path.join(root, "loop_config.json"), JSON.stringify({
      toolAccess: {
        webSearch: { enabled: false, mode: "cached" },
        mcpServers: [{
          id: "docs",
          name: "Docs",
          enabled: true,
          type: "local",
          command: "docs-mcp",
          environment: { API_KEY: "plaintext" },
        }],
      },
    }), "utf8");
    await assert.rejects(loadLoopConfig(root), /contains an inline value/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("runtime config rejects data paths that escape the configured root", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-loop-config-path-"));
  try {
    for (const sessionsRoot of [
      "../outside",
      "C:\\outside",
      "/outside",
      "C:drive-relative",
      "safe/file.txt:stream",
      "safe/CON",
      "safe/trailing. ",
      "safe/control\u0001name",
    ]) {
      await fs.writeFile(path.join(root, "loop_config.json"), JSON.stringify({
        paths: { sessionsRoot },
      }), "utf8");
      await assert.rejects(loadLoopConfig(root), /must stay relative|unsafe path segment|non-portable/);
    }
    await fs.writeFile(path.join(root, "loop_config.json"), JSON.stringify({
      paths: { ownerLockFileName: "nested/session_owner.lock" },
    }), "utf8");
    await assert.rejects(loadLoopConfig(root), /single path segment/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("runtime config enforces timeout and recovery-budget relationships", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-loop-config-timeout-"));
  try {
    await fs.writeFile(path.join(root, "loop_config.json"), JSON.stringify({
      defaults: { phaseTimeoutMs: 1_000, transportTimeoutMs: 2_000 },
    }), "utf8");
    await assert.rejects(loadLoopConfig(root), /transportTimeoutMs must not exceed/);

    await fs.writeFile(path.join(root, "loop_config.json"), JSON.stringify({
      defaults: {
        phaseTimeoutMs: 10_000,
        idleTimeoutMs: 5_000,
        transportTimeoutMs: 5_000,
        toolTimeoutMs: 5_000,
        maxAgentAttempts: 3,
        retryBackoffMs: [1_000, 2_000],
        phaseRecoveryBudgetMs: 30_000,
      },
    }), "utf8");
    await assert.rejects(loadLoopConfig(root), /phaseRecoveryBudgetMs must cover/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
