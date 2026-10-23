import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  createGraph,
  graphDiagnostics,
  validateGraphDocument,
  transition,
} from "./graph";
import { StudioStore } from "./store";
test("drafts allow partial binding, while execution requires model and complete graph", () => {
  const g = createGraph();
  g.defaultBinding = { connectionId: "", modelId: "" };
  assert.equal(validateGraphDocument(g).version, 2);
  assert.equal(
    graphDiagnostics(g).filter((d) => d.code === "binding").length,
    6,
  );
  g.defaultBinding = { connectionId: "cli", modelId: "model" };
  assert.deepEqual(graphDiagnostics(g), []);
  assert.equal(transition(g, "review", "failure"), "implementation");
});
test("execution rejects skipped tests, non-approval success and failure edges to SUCCESS, while drafts remain editable", () => {
  for (const [source, outcome] of [["implementation", "success"], ["test", "failure"], ["approval", "failure"]] as const) {
    const g = createGraph();
    g.edges.find(e => e.source === source && e.outcome === outcome)!.target = "SUCCESS";
    assert.equal(validateGraphDocument(g).version, 2);
    assert.ok(graphDiagnostics(g, false).some(d => d.code === "unsafe_success"), `${source}/${outcome}`);
  }
  for (const entry of ["start", "reentry", "interrupt"] as const) {
    const g = createGraph();
    if (entry === "interrupt") g.edges.find(e => e.source === "interrupt" && e.outcome === "success")!.target = "approval";
    else g.entrypoints[entry] = "approval";
    assert.ok(graphDiagnostics(g, false).some(d => d.code === "test_bypass"), entry);
  }
  assert.deepEqual(graphDiagnostics(createGraph(), false), [], "normal failure/rework routes remain supported");
});
test("cycles with an exit are valid; closed cycles and duplicate ports are rejected", () => {
  const g = createGraph();
  g.defaultBinding = { connectionId: "cli", modelId: "model" };
  g.edges = g.edges.map((e) =>
    e.source === "approval"
      ? { ...e, target: "implementation" }
      : e.source === "implementation" && e.outcome === "failure"
        ? { ...e, target: "test" }
        : e,
  );
  assert.ok(graphDiagnostics(g).some((d) => d.code === "trapped_cycle"));
  const good = createGraph();
  good.defaultBinding = g.defaultBinding;
  good.edges.push({ ...good.edges[0]!, id: "duplicate" });
  assert.ok(graphDiagnostics(good).some((d) => d.code === "edge_count"));
});
test("legacy and traversal IDs are rejected and imported unknown credentials are stripped", () => {
  assert.throws(() => validateGraphDocument({ version: 1 }), /version 2/);
  const g = createGraph();
  g.id = "../escape";
  assert.throws(() => validateGraphDocument(g));
  const clean = createGraph();
  const input = {
    ...clean,
    defaultBinding: {
      connectionId: "cli",
      modelId: "model",
      apiKey: "DO_NOT_PERSIST",
    },
    entrypoints: { ...clean.entrypoints, secret: "DO_NOT_PERSIST" },
  };
  assert.equal(
    JSON.stringify(validateGraphDocument(input)).includes("DO_NOT_PERSIST"),
    false,
  );
});
test("graph save uses revision CAS across concurrent clients and imported graphs receive a new identity", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "graph-store-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new StudioStore(root);
  await store.init();
  const g = (await store.graphs())[0]!;
  const first = { ...g, name: "first" },
    second = { ...g, name: "second" };
  const results = await Promise.allSettled([
    store.saveGraph(g.id, first, g.revision),
    store.saveGraph(g.id, second, g.revision),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal((await store.graph(g.id)).revision, g.revision + 1);
  const imported = await store.createGraph({ document: g });
  assert.notEqual(imported.id, g.id);
  assert.equal(imported.revision, 1);
  await assert.rejects(() => store.graph("../escape"));
});
