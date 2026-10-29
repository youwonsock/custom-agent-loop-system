import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { StudioStore } from "../core/store";

const execute = promisify(execFile);
test("public CLI init, graphs, models, run and resume share the standalone workspace", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "graph-headless-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cli = path.join(__dirname, "cli.js");
  const invoke = (...args: string[]) => {
    console.log("Public CLI smoke:", args[0]);
    return execute(process.execPath, [cli, ...args, "--root", root], {
      timeout: 10_000,
    });
  };
  assert.match((await invoke("init")).stdout, /Initialized/);
  const store = new StudioStore(root);
  const listed = JSON.parse((await invoke("graphs")).stdout);
  assert.equal(listed.length, 1);
  await store.saveConnection({
    id: "fixture",
    label: "Fixture",
    type: "codex",
    binary: path.resolve(__dirname, "../../../test/fixture_cli.cjs"),
  });
  const models = JSON.parse(
    (await invoke("models", "--connection", "fixture", "--target", root))
      .stdout,
  );
  assert.equal(models.status, "ready");
  assert.deepEqual(
    models.models.map((m: { id: string }) => m.id),
    ["fixture-model"],
  );
  const graph = await store.graph(listed[0].id);
  graph.defaultBinding = { connectionId: "fixture", modelId: "fixture-model" };
  graph.nodes = graph.nodes.filter((n) =>
    ["implementation", "test", "approval", "interrupt"].includes(n.id),
  );
  graph.edges = graph.edges
    .filter((e) => graph.nodes.some((n) => n.id === e.source))
    .map((e) =>
      e.source === "test"
        ? {
            ...e,
            target: e.outcome === "success" ? "approval" : "implementation",
          }
        : e,
    );
  graph.entrypoints = {
    start: "implementation",
    reentry: "implementation",
    interrupt: "interrupt",
    cycleCompletion: "implementation",
  };
  await store.saveGraph(graph.id, graph, graph.revision);
  const started = await invoke(
    "run",
    "--graph",
    graph.id,
    "--target",
    root,
    "--goal",
    "fixture:auth-once",
  );
  const id = started.stdout.match(/Session: ([\w-]+)/)?.[1];
  assert.ok(id);
  const held = await store.readSession(id);
  assert.equal(held.status, "WAITING_USER");
  await invoke("resume", "--session", id);
  const completed = await store.readSession(id);
  assert.equal(completed.status, "SUCCESS");
  assert.equal(completed.visits[0]!.id, held.visits[0]!.id);
  assert.equal(completed.visits[0]!.attempts.length, 2);
  assert.equal(
    await fs.readFile(path.join(root, "artifact.txt"), "utf8"),
    "implemented goal\n",
  );
});
