import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { DEFAULT_PROVIDERS } from "../../src/runtime/providers/provider-runtime";
import { discoverAndMergeSessionIndex, discoverProvider } from "../../src/application/provider-discovery";

test("provider discovery executes a confirmed binary with bounded structured output", async () => {
  const provider = {
    ...DEFAULT_PROVIDERS.opencode,
    binary: process.execPath,
    modelCatalog: { source: "command" as const, args: ["-e", "console.log(JSON.stringify({models:['alpha','beta']}))"] },
  };
  const result = await discoverProvider("test", provider, { timeoutMs: 2_000, maxOutputBytes: 4_096 });
  assert.equal(result.schemaVersion, 2);
  assert.equal(result.available, true);
  assert.deepEqual(result.models, ["alpha", "beta"]);
  assert.equal(result.catalogSource, "command");
  assert.equal(result.error, null);
});

test("provider discovery merges only catalog fields under the v4 index lock", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-loop-provider-discovery-"));
  const indexPath = path.join(root, "sessions_index.json");
  const lockPath = path.join(root, "registry.lock");
  try {
    await fs.writeFile(indexPath, JSON.stringify({
      version: 4,
      activeSessionIds: ["run_1"],
      sessionMetas: [{ sessionId: "run_1", goal: "keep", targetProjectPath: "C:\\repo", status: "RUNNING", createdAt: "2026-01-01T00:00:00.000Z" }],
      availableModels: ["old"],
      modelsDiscoveredAt: "2026-01-01T00:00:00.000Z",
      modelsDiscoveredCli: "old",
      manualModelsOverride: null,
      modelVariants: { openai: ["high"] },
      providerCatalog: {},
    }), "utf8");
    const merged = await discoverAndMergeSessionIndex(indexPath, lockPath, [{
      schemaVersion: 2,
      providerId: "test",
      label: "Test",
      adapter: "opencode",
      binary: process.execPath,
      enabled: true,
      available: true,
      models: ["new"],
      discoveredAt: "2026-01-02T00:00:00.000Z",
      command: process.execPath,
      catalogSource: "command",
      error: null,
    }]);
    assert.deepEqual(merged.activeSessionIds, ["run_1"]);
    assert.equal(merged.sessionMetas[0]?.goal, "keep");
    assert.deepEqual(merged.availableModels, ["new"]);
    assert.deepEqual(merged.modelVariants, { openai: ["high"] });
    assert.equal(merged.providerCatalog.test.models[0], "new");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
