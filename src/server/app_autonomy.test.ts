import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import {
  quickSettings,
  setup,
  wait,
  launch,
  contracted,
  nativeScopeContract,
  binary,
} from "./app_harness.test";

test("autonomous preset repairs a product BLOCKED and reaches final approval without any operator action", async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  let graph = await s.store.createGraph({ template: "autonomous" });
  graph.automation!.verificationContract = false; // legacy-policy coverage; contract cases are separate below
  graph.automation!.browserVerification = false;
  graph.defaultBinding = s.graph.defaultBinding;
  graph = await s.store.saveGraph(graph.id, graph, graph.revision);
  const started = await s.coordinator.start({
    requestId: randomUUID(),
    graphId: graph.id,
    expectedRevision: graph.revision,
    goal: "fixture:auto-product-blocked build the app",
    targetProjectPath: s.target,
    settings: quickSettings,
  });
  const done = await wait(() => s.store.readSession(started.id), "SUCCESS");
  assert.equal(done.pendingApproval, null);
  assert.equal(done.processedRequests.length, 0, "no approval/resume actions");
  assert.deepEqual(
    done.visits.map((v) => v.nodeId),
    [
      "planning",
      "implementation",
      "test",
      "implementation",
      "test",
      "review",
      "approval",
    ],
  );
  assert.equal(done.visits[2]!.verdict, "FAIL");
  assert.equal(done.visits.at(-1)!.verdict, "APPROVED");
});
test("autonomous failures stop at repair budget instead of requesting endless interventions", async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  let graph = await s.store.createGraph({ template: "autonomous" });
  graph.automation!.verificationContract = false; // legacy-policy coverage; contract cases are separate below
  graph.automation!.browserVerification = false;
  graph.automation!.maxRepairCycles = 1;
  graph.defaultBinding = s.graph.defaultBinding;
  graph = await s.store.saveGraph(graph.id, graph, graph.revision);
  const started = await s.coordinator.start({
    requestId: randomUUID(),
    graphId: graph.id,
    expectedRevision: graph.revision,
    goal: "fixture:auto-product-always-blocked",
    targetProjectPath: s.target,
    settings: quickSettings,
  });
  const done = await wait(() => s.store.readSession(started.id), "PAUSED");
  assert.match(done.statusReason!, /자동 수정 1회/);
  assert.equal(
    done.visits.filter((v) => v.nodeId === "implementation").length,
    2,
  );
  assert.equal(
    done.visits.some((v) => v.nodeId === "approval"),
    false,
  );
});

test("autonomous policy never bypasses an explicitly enabled planning approval", async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  let graph = await s.store.createGraph({ template: "autonomous" });
  graph.automation!.verificationContract = false; // legacy-policy coverage; contract cases are separate below
  graph.nodes.find((n) => n.type === "planning")!.planning!.requiresApproval =
    true;
  graph.defaultBinding = s.graph.defaultBinding;
  graph = await s.store.saveGraph(graph.id, graph, graph.revision);
  const started = await s.coordinator.start({
    requestId: randomUUID(),
    graphId: graph.id,
    expectedRevision: graph.revision,
    goal: "build app",
    targetProjectPath: s.target,
    settings: quickSettings,
  });
  const held = await wait(
    () => s.store.readSession(started.id),
    "WAITING_USER",
  );
  assert.equal(held.pendingApproval!.nodeId, "planning");
  assert.equal(held.visits.length, 1);
});

test("autonomous runtime detects hidden production writes even without native file-change events", async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  let graph = await s.store.createGraph({ template: "autonomous" });
  graph.automation!.verificationContract = false; // legacy-policy coverage; contract cases are separate below
  graph.automation!.browserVerification = false;
  graph.defaultBinding = s.graph.defaultBinding;
  graph = await s.store.saveGraph(graph.id, graph, graph.revision);
  const started = await s.coordinator.start({
    requestId: randomUUID(),
    graphId: graph.id,
    expectedRevision: graph.revision,
    goal: "fixture:auto-source-edit build the app",
    targetProjectPath: s.target,
    settings: quickSettings,
  });
  const done = await wait(() => s.store.readSession(started.id), "SUCCESS");
  const tests = done.visits.filter((v) => v.nodeId === "test");
  assert.equal(tests.length, 2);
  assert.equal(tests[0]!.verdict, "FAIL");
  assert.match(tests[0]!.output, /(?:제품|소스).*변경/);
  assert.ok(
    tests[0]!.attempts.some((a) => a.fileMutation),
    "the actual source mutation must be retained as evidence",
  );
  assert.equal(tests[1]!.verdict, "PASS");
});

for (const mode of [
  "fixture:contract-early-fail",
  "fixture:contract-hidden-guard",
  "fixture:contract-policy-guard",
])
  test(`${mode} returns promptly to implementation with invalid proof and completes a fresh immutable test/approval cycle`, async (t) => {
    const s = await setup();
    t.after(s.cleanup);
    const graph = await contracted(s),
      id = await launch(s, graph, mode);
    const done = await wait(() => s.store.readSession(id), "SUCCESS"),
      tests = done.visits.filter((v) => v.nodeId === "test");
    assert.equal(tests.length, 2);
    assert.equal(tests[0]!.verdict, "FAIL");
    assert.equal(tests[0]!.attempts.length, 1);
    assert.ok(tests[0]!.attempts[0]!.verificationInvalidation);
    assert.deepEqual(tests[0]!.verifiedCommands, []);
    assert.ok(
      Date.parse(tests[0]!.completedAt!) - Date.parse(tests[0]!.startedAt) <
        4500,
    );
    assert.equal(
      await fs
        .stat(path.join(s.target, "verification/forbidden-late-write"))
        .then(
          () => true,
          () => false,
        ),
      false,
    );
    assert.equal(tests[1]!.verdict, "PASS");
    assert.ok(tests[1]!.verificationSourceHashes?.["artifact.txt"]);
    assert.equal(done.visits.at(-1)!.verdict, "APPROVED");
    assert.deepEqual(done.processedRequests, []);
    if (mode.includes("hidden"))
      assert.ok(
        tests[0]!.attempts[0]!.verificationInvalidation!.files.includes(
          "artifact.txt",
        ),
      );
    if (mode.includes("policy"))
      assert.equal(tests[0]!.attempts[0]!.fileMutation, false);
  });
test("blocked broad process termination is corrected within implementation without operator approval or proof reuse", async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const graph = await contracted(s),
    id = await launch(s, graph, "fixture:contract-owned-process", {
      maxAgentAttempts: 2,
      phaseRecoveryBudgetMs: 9000,
    });
  const done = await wait(() => s.store.readSession(id), "SUCCESS"),
    impl = done.visits.find((v) => v.nodeId === "implementation")!;
  assert.equal(impl.attempts.length, 2);
  assert.equal(impl.attempts[0]!.failureKind, "tool_arguments");
  assert.match(impl.attempts[0]!.message!, /UNSCOPED_TERMINATION/);
  assert.equal(impl.attempts[1]!.completionAccepted, true);
  assert.equal(done.visits.at(-1)!.verdict, "APPROVED");
  assert.deepEqual(done.processedRequests, []);
});

test("Kilo scope denials in every role recover without operator input and preserve an audited success", async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  await s.store.saveConnection({
    id: "fixture",
    label: "Fixture Kilo",
    type: "kilo",
    binary,
  });
  s.graph.defaultBinding = {
    connectionId: "fixture",
    modelId: "fixture/fixture-model",
  };
  const graph = await nativeScopeContract(s),
    id = await launch(s, graph, "fixture:contract-scope-policy");
  const done = await wait(() => s.store.readSession(id), "SUCCESS");
  assert.deepEqual(done.processedRequests, []);
  assert.equal(done.visits.at(-1)!.verdict, "APPROVED");
  assert.deepEqual(
    done.visits.map((v) => v.nodeId),
    ["planning", "implementation", "test", "review", "approval"],
  );
  for (const visit of done.visits)
    for (const attempt of visit.attempts) {
      assert.equal(attempt.scopeAudit!.blockedCalls, 1, visit.nodeId);
      assert.equal(attempt.scopeAudit!.outsideCalls, 0);
      assert.equal(attempt.scopeAudit!.unresolvedCalls, 0);
    }
});
test("observed outside Kilo discovery blocks the workflow instead of repairing away the evidence", async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  await s.store.saveConnection({
    id: "fixture",
    label: "Fixture Kilo",
    type: "kilo",
    binary,
  });
  s.graph.defaultBinding = {
    connectionId: "fixture",
    modelId: "fixture/fixture-model",
  };
  const graph = await nativeScopeContract(s),
    id = await launch(s, graph, "fixture:contract-scope-escape");
  const done = await wait(() => s.store.readSession(id), "BLOCKED");
  assert.match(done.statusReason!, /SCOPE_VIOLATION/);
  assert.equal(done.visits.length, 1);
  assert.equal(done.visits[0]!.attempts[0]!.scopeAudit!.outsideCalls, 1);
  assert.deepEqual(done.processedRequests, []);
});
