import test from "node:test";
import assert from "node:assert/strict";
import { createAutonomousGraph, createGraph } from "./graph";
import { isolationNotes } from "../shared/isolation";
import { LocalConnection } from "../shared/domain";

const kilo: LocalConnection = {
  id: "k",
  label: "My Kilo",
  type: "kilo",
  binary: "kilo",
};
const codex: LocalConnection = {
  id: "c",
  label: "My Codex",
  type: "codex",
  binary: "codex",
};
const ready = { platform: "darwin", programIoVm: true };

function bound(connection: LocalConnection, override?: LocalConnection) {
  const graph = createAutonomousGraph();
  graph.defaultBinding = { connectionId: connection.id, modelId: "m" };
  if (override)
    graph.nodes[0]!.binding = { connectionId: override.id, modelId: "m" };
  return graph;
}

test("graphs without the program I/O guard carry no isolation notes", () => {
  const graph = createGraph();
  graph.defaultBinding = { connectionId: "k", modelId: "m" };
  assert.deepEqual(
    isolationNotes(graph, [kilo], { platform: "win32", programIoVm: false }),
    [],
  );
});

test("a prepared VM host has nothing to warn about for an all-Kilo graph", () => {
  assert.deepEqual(isolationNotes(bound(kilo), [kilo], ready), []);
});

test("Kilo nodes on a host without the VM runtime are reported before running", () => {
  const [mac] = isolationNotes(bound(kilo), [kilo], {
    platform: "darwin",
    programIoVm: false,
  });
  assert.match(mac!, /sandbox:prepare/);
  const [windows] = isolationNotes(bound(kilo), [kilo], {
    platform: "win32",
    programIoVm: false,
  });
  assert.match(windows!, /macOS 26에서만/);
});

test("non-Kilo connections are named as covered only by their native sandbox", () => {
  const notes = isolationNotes(bound(kilo, codex), [kilo, codex], ready);
  assert.equal(notes.length, 1);
  assert.match(notes[0]!, /^My Codex: .*Kilo에만/);
});
