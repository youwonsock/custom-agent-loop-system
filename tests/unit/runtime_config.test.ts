import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getDefaultConfig, loadLoopConfig, RUNTIME_DEFAULTS } from "../../src/config/runtime-config";

test("core definitions are the single source staged into the desktop bundle", async () => {
  const root = process.cwd();
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, "config", "runtime_defaults.json"), "utf8")), RUNTIME_DEFAULTS);
  for (const canonicalName of [
    "agents.json", "agents.schema.json", "tasks.json", "tasks.schema.json", "workflow.json",
    "workflow.schema.json", "loop_config.json", "loop_config.schema.json", "protocol_contract.json",
  ]) {
    assert.doesNotThrow(() => JSON.parse(require("node:fs").readFileSync(path.join(root, "config", canonicalName), "utf8")));
  }
});

test("runtime config deep-merges path/default sections from one core source", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-loop-config-"));
  try {
    await fs.writeFile(path.join(root, "loop_config.json"), JSON.stringify({
      paths: { sessionFileNames: { plan: "custom-plan.md" } },
      defaults: { maxCycles: 7 },
    }), "utf8");
    const config = await loadLoopConfig(root);
    assert.equal(config.paths.sessionFileNames.plan, "custom-plan.md");
    assert.equal(config.paths.sessionFileNames.state, "run_projection.json");
    assert.equal(config.defaults.maxCycles, 7);
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

test("runtime config enforces provider timeout relationships", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-loop-config-timeout-"));
  try {
    await fs.writeFile(path.join(root, "loop_config.json"), JSON.stringify({
      defaults: { phaseTimeoutMs: 1_000, transportTimeoutMs: 2_000 },
    }), "utf8");
    await assert.rejects(loadLoopConfig(root), /transportTimeoutMs must not exceed/);

  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
