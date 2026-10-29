import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { queryModels, normalizeModels, stopChild } from "./catalog";
import { buildInvocation } from "./invocation";
import { createGraph } from "./graph";
import { CliDiagnosticError } from "./cli_diagnostics";
const binary = path.resolve(__dirname, "../../../test/fixture_cli.cjs");
test("model query cleanup waits for process and stdio close", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "catalog-close-test-"));
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: root,
    stdio: "pipe",
    windowsHide: true,
  });
  t.after(async () => {
    await stopChild(child);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
  });
  await once(child, "spawn");
  let closed = false;
  child.once("close", () => {
    closed = true;
  });
  await stopChild(child);
  assert.equal(closed, true);
});
for (const type of ["codex", "opencode", "kilo", "claude"] as const)
  test(`${type} queries native model API with project context, without coding turns`, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "catalog-api-test-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const catalog = await queryModels(
      { id: type, label: type, type, binary },
      root,
      { timeoutMs: 5000 },
    );
    assert.equal(catalog.status, "ready", catalog.error ?? "");
    assert.equal(catalog.models.length, 1);
    assert.equal(
      catalog.models[0]!.id,
      (type === "opencode" || type === "kilo" ? "fixture/" : "") +
        "fixture-model",
    );
    assert.equal(catalog.targetProjectPath, await fs.realpath(root));
    assert.equal(JSON.stringify(catalog).includes("DO_NOT_PERSIST"), false);
    assert.equal(
      (await fs.readdir(root)).includes("unexpected-turn.txt"),
      false,
    );
    assert.equal(
      (await fs.readdir(root)).includes(".fixture-calls.json"),
      false,
    );
  });
test("missing binary produces empty catalog, with no model fallback", async () => {
  const c = await queryModels(
    { id: "missing", label: "missing", type: "codex", binary: "/not-a-cli" },
    os.tmpdir(),
  );
  assert.equal(c.status, "missing_binary");
  assert.deepEqual(c.models, []);
});

test("catalog auth uses the same explicit diagnostic rules and never infers login from 403 or identifiers", async () => {
  for (const [error, expected] of [
    [
      new Error("query id-440358e11c92 timestamp-1791946608401 failed"),
      "query_failed",
    ],
    [
      new Error("authentication documentation could not be read"),
      "query_failed",
    ],
    [
      new CliDiagnosticError({ statusCode: 403, message: "Forbidden" }),
      "query_failed",
    ],
    [
      new CliDiagnosticError({ statusCode: 401, message: "Unauthorized" }),
      "auth_required",
    ],
    [new Error("Invalid API key"), "auth_required"],
  ] as const) {
    const catalog = await queryModels(
      { id: "fixture", label: "fixture", type: "claude", binary },
      os.tmpdir(),
      {
        claudeQuery: async () => {
          throw error;
        },
      },
    );
    assert.equal(catalog.status, expected, catalog.error ?? "");
    assert.deepEqual(catalog.models, []);
  }
});
test("native invocation preserves MCP/web/hooks and never forces pure mode", async () => {
  const g = createGraph(),
    node = g.nodes.find((n) => n.type === "implementation")!;
  for (const type of ["codex", "claude", "opencode", "kilo"] as const) {
    const invocation = await buildInvocation(
      { id: type, label: type, type, binary },
      { connectionId: type, modelId: "fixture-model" },
      node,
      { prompt: "work", cwd: os.tmpdir(), fullAccess: false, allowedPaths: [] },
    );
    assert.equal(invocation.args.includes("--pure"), false);
    assert.equal(invocation.args.includes("--mcp-config"), false);
    assert.equal(invocation.args.includes("--search"), false);
    assert.equal(JSON.stringify(invocation).includes("mcpServers"), false);
    if (type === "kilo") {
      assert.ok(
        invocation.args.indexOf("--print-logs") <
          invocation.args.indexOf("run"),
      );
      assert.match(invocation.args.at(-1)!, /filePath.*content/);
      if (process.platform === "win32")
        assert.match(invocation.args.at(-1)!, /npm\.cmd.*execution policy/);
      if (process.platform === "win32")
        assert.equal(invocation.transport, "pipe");
      const review = await buildInvocation(
        { id: type, label: type, type, binary },
        { connectionId: type, modelId: "fixture-model" },
        g.nodes.find((n) => n.type === "review")!,
        {
          prompt: "review",
          cwd: os.tmpdir(),
          fullAccess: false,
          allowedPaths: [],
        },
      );
      assert.match(review.args.at(-1)!, /only permitted read-only tools/);
      assert.doesNotMatch(review.args.at(-1)!, /use bash/);
    }
  }
});

for (const cancel of [false, true])
  test(`model metadata ${cancel ? "cancellation" : "timeout"} returns no fallback and cleans its child`, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "catalog-cancel-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.writeFile(
      path.join(root, ".fixture-slow-query"),
      "hold one query",
    );
    const controller = new AbortController();
    let pid: number | null = null;
    const result = await queryModels(
      { id: "fixture", label: "fixture", type: "codex", binary },
      root,
      {
        timeoutMs: cancel ? 5000 : 200,
        signal: controller.signal,
        onPid: (child) => {
          if (child) {
            pid = child;
            if (cancel)
              setTimeout(
                () => controller.abort(new Error("Acceptance cancellation")),
                100,
              );
          }
        },
      },
    );
    assert.equal(result.status, "query_failed");
    assert.deepEqual(result.models, []);
    assert.ok(pid);
    const { checkProcessLiveness } = await import("./resilience.js");
    assert.equal(checkProcessLiveness(pid), "dead");
  });

test("API-reported variant maps exclude disabled entries without retaining provider options", () => {
  const models = normalizeModels(
    [
      {
        id: "native-model",
        variants: {
          high: { reasoningEffort: "high", secret: "DO_NOT_PERSIST" },
          max: {},
          disabled: { disabled: true },
        },
      },
    ],
    "fixture",
  );
  assert.deepEqual(models[0]!.variants, ["high", "max"]);
  assert.equal(JSON.stringify(models).includes("DO_NOT_PERSIST"), false);
});
test("OpenCode and Kilo use native auto permission flag only for approved writable nodes", async () => {
  const graph = createGraph();
  for (const type of ["opencode", "kilo"] as const) {
    for (const role of ["implementation", "review"] as const) {
      const invocation = await buildInvocation(
        { id: type, label: type, type, binary },
        { connectionId: type, modelId: "fixture/native-model" },
        graph.nodes.find((n) => n.type === role)!,
        {
          prompt: "acceptance",
          cwd: os.tmpdir(),
          fullAccess: true,
          allowedPaths: [],
        },
      );
      assert.equal(
        invocation.args.includes("--auto"),
        role === "implementation",
      );
      assert.equal(
        invocation.args.includes("--dangerously-skip-permissions"),
        false,
      );
      const env = JSON.parse(
        invocation.env[
          type === "kilo" ? "KILO_CONFIG_CONTENT" : "OPENCODE_CONFIG_CONTENT"
        ]!,
      );
      assert.equal(
        env.permission.edit,
        role === "implementation" ? "allow" : "deny",
      );
    }
  }
});

test("Codex uses the orchestrator Node PATH without a login shell or changing sandbox permissions", async () => {
  for (const role of ["implementation", "test", "review"] as const) {
    const invocation = await buildInvocation(
      { id: "codex", label: "codex", type: "codex", binary },
      { connectionId: "codex", modelId: "fixture-model" },
      createGraph().nodes.find((n) => n.type === role)!,
      {
        prompt: "check",
        cwd: os.tmpdir(),
        fullAccess: false,
        allowedPaths: [],
      },
    );
    assert.ok(invocation.args.includes("allow_login_shell=false"));
    assert.ok(
      invocation.args.some(
        (a) =>
          a.startsWith("shell_environment_policy.set.PATH=") &&
          a.includes(path.dirname(process.execPath).replaceAll("\\", "\\\\")),
      ),
    );
    assert.equal(
      invocation.args[invocation.args.indexOf("--sandbox") + 1],
      role === "review" ? "read-only" : "workspace-write",
    );
    assert.equal(invocation.args.includes("--approve-for-me"), false);
    assert.equal(
      invocation.args.some((a) => a.includes("network_access=true")),
      false,
    );
  }
});
