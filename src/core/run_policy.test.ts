import test from "node:test";
import assert from "node:assert/strict";
import { createAutonomousGraph, createGraph } from "./graph";
import { runPolicy } from "./run_policy";

test("manual graphs enable no automation decisions for any CLI", () => {
  for (const type of ["codex", "claude", "opencode", "kilo"] as const)
    assert.deepEqual(
      Object.values(runPolicy(createGraph(), { type })).filter(Boolean),
      [],
    );
});

test("CLI-specific decisions apply only to the CLI that implements them", () => {
  const graph = createAutonomousGraph();
  const table = Object.fromEntries(
    (["codex", "claude", "opencode", "kilo"] as const).map((type) => {
      const p = runPolicy(graph, { type });
      return [type, [p.localHttpAccess, p.kiloScopeGuard, p.kiloProgramIo]];
    }),
  );
  assert.deepEqual(table, {
    codex: [true, false, false],
    claude: [false, false, false],
    opencode: [false, false, false],
    kilo: [false, true, true],
  });
});

test("graph-level decisions follow their flags independently of the CLI", () => {
  const graph = createAutonomousGraph();
  graph.automation!.testSourceGuard = false;
  graph.automation!.browserVerification = false;
  const p = runPolicy(graph, { type: "codex" });
  assert.equal(p.automated, true);
  assert.equal(p.testSourceGuard, false);
  assert.equal(p.localHttpAccess, false);
  assert.equal(p.verificationContract, true);
  assert.equal(p.reserveFinalizationBudget, true);
  assert.equal(p.guardOwnedProcesses, true);
  assert.equal(p.nativeApprovalReview, true);
});
