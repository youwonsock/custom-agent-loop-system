import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "./app";
import { SessionState } from "../shared/domain";
import { delay } from "../core/resilience";
import {
  origin,
  setup,
  wait,
  minimal,
  launch,
  resumeHeld,
  setModelPricing,
  automaticPlans,
  binary,
} from "./app_harness.test";

test("reported QA events advance to approval without auth/mutation false positives", async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const graph = await automaticPlans(s),
    id = await launch(s, graph, "fixture:qa-regression");
  const state = await wait(() => s.store.readSession(id), "SUCCESS");
  const qa = state.visits.find((v) => v.nodeId === "review")!;
  assert.equal(qa.status, "succeeded");
  assert.equal(qa.verdict, "APPROVED");
  assert.equal(qa.attempts.length, 1);
  assert.equal(qa.attempts[0]!.failureKind, null);
  assert.equal(state.visits.at(-1)!.nodeId, "approval");
});
test("exit-zero QA auth failure shows node/CLI cause and STOPPED resume retries only the same QA visit", async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const graph = await automaticPlans(s),
    id = await launch(s, graph, "fixture:qa-auth-once");
  let state = await wait(() => s.store.readSession(id), "WAITING_USER");
  assert.match(state.statusReason ?? "", /QA 검토 · Fixture CLI/);
  assert.match(state.statusReason ?? "", /인증.*authentication required/);
  const qa = state.visits.at(-1)!;
  assert.equal(qa.attempts.length, 1);
  assert.equal(qa.attempts[0]!.failureKind, "auth");
  const prior = state.visits.slice(0, -1),
    approved = state.approvedPlanRef;
  const stopped = await s.request("POST", `/api/sessions/${id}/actions`, {
    requestId: randomUUID(),
    type: "stop",
  });
  assert.equal(stopped.statusCode, 200);
  assert.equal(
    (await wait(() => s.store.readSession(id), "STOPPED")).activeVisitId,
    qa.id,
  );
  await resumeHeld(s, id);
  state = await wait(() => s.store.readSession(id), "SUCCESS");
  assert.deepEqual(state.visits.slice(0, prior.length), prior);
  assert.deepEqual(state.approvedPlanRef, approved);
  const resumed = state.visits.find((v) => v.nodeId === "review")!;
  assert.equal(resumed.id, qa.id);
  assert.equal(resumed.attempts.length, 2);
  assert.equal(resumed.attempts[0]!.failureKind, "auth");
  assert.equal(resumed.attempts[1]!.status, "succeeded");
  assert.deepEqual(
    JSON.parse(
      await fs.readFile(path.join(s.target, ".fixture-calls.json"), "utf8"),
    ),
    { planning: 1, implementation: 1, test: 1, review: 2, approval: 1 },
  );
});
test("unfinished QA mentioning auth uses bounded completion recovery and keeps its original visit", async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const graph = await automaticPlans(s),
    id = await launch(s, graph, "fixture:qa-incomplete-once");
  const state = await wait(() => s.store.readSession(id), "SUCCESS");
  const qa = state.visits.find((v) => v.nodeId === "review")!;
  assert.equal(qa.attempts.length, 2);
  assert.equal(qa.attempts[0]!.failureKind, "incomplete_response");
  assert.equal(qa.attempts[1]!.mode, "completion_recovery");
  assert.equal(qa.attempts[1]!.reconnectUsed, false);
});
test("positive verdicts with malformed requirement blocks recover in the same role without repeating implementation", async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const graph = await automaticPlans(s);
  const id = await launch(s, graph, "fixture:evidence-typo-once", {
    maxAgentAttempts: 2,
    phaseRecoveryBudgetMs: 7000,
  });
  const state = await wait(() => s.store.readSession(id), "SUCCESS");
  assert.equal(
    state.visits.filter((v) => v.nodeId === "implementation").length,
    1,
  );
  for (const nodeId of ["test", "review", "approval"]) {
    const visit = state.visits.find((v) => v.nodeId === nodeId)!;
    assert.equal(visit.status, "succeeded");
    assert.equal(visit.attempts.length, 2);
    assert.equal(visit.attempts[0]!.failureKind, "incomplete_response");
    assert.equal(visit.attempts[1]!.reconnectUsed, false);
  }
});

test("environment-blocked checks wait without repairing implementation and resume the same test visit", async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const graph = await automaticPlans(s);
  const id = await launch(s, graph, "fixture:environment-once");
  let state = await wait(() => s.store.readSession(id), "WAITING_USER");
  const visit = state.visits.at(-1)!;
  assert.equal(visit.nodeId, "test");
  assert.equal(visit.verdict, "BLOCKED");
  assert.equal(visit.attempts.length, 1);
  assert.match(state.statusReason!, /listen EPERM/);
  await delay(150);
  assert.equal((await s.store.readSession(id)).visits.length, 3);
  await resumeHeld(s, id);
  state = await wait(() => s.store.readSession(id), "SUCCESS");
  assert.equal(
    state.visits.filter((v) => v.nodeId === "implementation").length,
    1,
  );
  assert.equal(state.visits.find((v) => v.id === visit.id)!.attempts.length, 2);
});
test("transport retry reconnects once within the same visit with the saved CLI session", async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const graph = await minimal(s),
    id = await launch(s, graph, "fixture:network-once", {
      maxAgentAttempts: 2,
      phaseRecoveryBudgetMs: 7000,
    });
  const state = await wait(() => s.store.readSession(id), "SUCCESS");
  assert.deepEqual(
    state.visits.map((v) => v.nodeId),
    ["implementation", "test", "approval"],
  );
  assert.equal(state.visits[0]!.attempts.length, 2);
  assert.equal(state.visits[0]!.attempts[1]!.reconnectUsed, true);
  const args = await fs.readFile(
    path.join(s.target, ".fixture-arguments.jsonl"),
    "utf8",
  );
  assert.match(args, /fixture-session/);
});
test("malformed Kilo tool calls recover with schema feedback in a fresh attempt on the same model", async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  await s.store.saveConnection({
    id: "fixture",
    label: "Fixture Kilo",
    type: "kilo",
    binary,
  });
  const graph = await minimal(s);
  graph.defaultBinding = {
    connectionId: "fixture",
    modelId: "fixture/fixture-model",
  };
  const saved = await s.store.saveGraph(graph.id, graph, graph.revision);
  const id = await launch(s, saved, "fixture:tool-arguments-once", {
    maxAgentAttempts: 2,
    phaseRecoveryBudgetMs: 7000,
  });
  const state = await wait(() => s.store.readSession(id), "SUCCESS");
  const attempts = state.visits[0]!.attempts;
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0]!.failureKind, "tool_arguments");
  assert.equal(attempts[1]!.reconnectUsed, false);
  assert.ok(
    attempts.every((a) => a.requestedModelId === "fixture/fixture-model"),
  );
});
test("provider-confirmed free transport exhaustion schedules recovery then resumes automatically", async (t) => {
  const s = await setup(true);
  t.after(s.cleanup);
  await setModelPricing(s, { isFree: true, cost: { input: 0, output: 0 } });
  const graph = await minimal(s),
    id = await launch(s, graph, "fixture:network-once", {
      maxAutomaticRecoveryCycles: 1,
      automaticRecoveryBackoffMs: [100],
    });
  const recovering = await wait(() => s.store.readSession(id), "RECOVERING");
  assert.equal(recovering.automaticRecovery?.count, 1);
  const state = await wait(() => s.store.readSession(id), "SUCCESS");
  assert.deepEqual(
    state.visits.map((v) => v.nodeId),
    ["implementation", "test", "approval"],
  );
  assert.equal(state.visits[0]!.attempts.length, 2);
});
test("unknown pricing with observed model usage pauses instead of scheduling a new automatic cycle", async (t) => {
  const s = await setup(true);
  t.after(s.cleanup);
  const graph = await minimal(s),
    id = await launch(s, graph, "fixture:spent-network", {
      maxAutomaticRecoveryCycles: 2,
      automaticRecoveryBackoffMs: [100],
    });
  const state = await wait(() => s.store.readSession(id), "PAUSED");
  assert.equal(state.automaticRecovery, null);
  assert.ok(state.visits[0]!.attempts[0]!.assistantTextBytes > 0);
  await delay(200);
  assert.equal((await s.store.readSession(id)).status, "PAUSED");
});
test("free models retry after observed usage and keep the same model and visit", async (t) => {
  const s = await setup(true);
  t.after(s.cleanup);
  await setModelPricing(s, { isFree: true, cost: { input: 0, output: 0 } });
  const id = await launch(s, await minimal(s), "fixture:spent-network-once", {
    maxAutomaticRecoveryCycles: 1,
    automaticRecoveryBackoffMs: [100],
  });
  const recovering = await wait(() => s.store.readSession(id), "RECOVERING");
  assert.match(recovering.statusReason!, /무료.*자동 복구 1\/1/);
  const state = await wait(() => s.store.readSession(id), "SUCCESS");
  assert.deepEqual(
    state.visits.map((v) => v.nodeId),
    ["implementation", "test", "approval"],
  );
  assert.equal(state.visits[0]!.attempts.length, 2);
  assert.ok(state.visits[0]!.attempts[0]!.assistantTextBytes > 0);
  assert.ok(
    state.visits[0]!.attempts.every(
      (a) =>
        a.pricing?.status === "free" && a.requestedModelId === "fixture-model",
    ),
  );
});
for (const metadata of [
  { isFree: false, cost: { input: 1, output: 1 } },
  { cost: { input: 0, output: 0 } },
]) {
  test(`${metadata.isFree === false ? "paid" : "unknown"} models stop at attempt limit even without observed tokens`, async (t) => {
    const s = await setup(true);
    t.after(s.cleanup);
    await setModelPricing(s, metadata);
    const id = await launch(s, await minimal(s), "fixture:network", {
      maxAutomaticRecoveryCycles: 2,
      automaticRecoveryBackoffMs: [50],
    });
    const state = await wait(() => s.store.readSession(id), "PAUSED");
    assert.equal(state.automaticRecovery, null);
    assert.equal(state.visits[0]!.attempts.length, 1);
    assert.equal(state.visits[0]!.attempts[0]!.assistantTextBytes, 0);
    assert.match(state.statusReason!, /유료|가격 미확인/);
    await delay(150);
    assert.equal((await s.store.readSession(id)).visits[0]!.attempts.length, 1);
  });
}
test("free models still obey the automatic recovery cycle cap", async (t) => {
  const s = await setup(true);
  t.after(s.cleanup);
  await setModelPricing(s, { isFree: true });
  const id = await launch(s, await minimal(s), "fixture:spent-network", {
    maxAutomaticRecoveryCycles: 1,
    automaticRecoveryBackoffMs: [50],
  });
  const state = await wait(() => s.store.readSession(id), "PAUSED");
  assert.equal(state.visits[0]!.automaticCycles, 1);
  assert.equal(state.visits[0]!.attempts.length, 2);
  assert.match(state.statusReason!, /무료 모델의 자동 복구 한도/);
  assert.equal(state.automaticRecovery, null);
});
for (const metadata of [{ isFree: false, cost: { input: 1, output: 1 } }, {}]) {
  test(`automatic recovery rechecks pricing and stops when free changes to ${"isFree" in metadata ? "paid" : "unknown"}`, async (t) => {
    const s = await setup(true);
    t.after(s.cleanup);
    await setModelPricing(s, { isFree: true });
    const id = await launch(s, await minimal(s), "fixture:spent-network-once", {
      maxAutomaticRecoveryCycles: 1,
      automaticRecoveryBackoffMs: [1500],
    });
    await wait(() => s.store.readSession(id), "RECOVERING");
    await setModelPricing(s, metadata);
    const state = await wait(() => s.store.readSession(id), "PAUSED");
    assert.match(state.statusReason!, /무료 모델임을 다시 확인하지 못/);
    assert.equal(state.visits[0]!.attempts.length, 1);
    assert.equal(state.automaticRecovery, null);
  });
}
test("stop cancels a free-model automatic recovery without another model call", async (t) => {
  const s = await setup(true);
  t.after(s.cleanup);
  await setModelPricing(s, { isFree: true });
  const id = await launch(s, await minimal(s), "fixture:spent-network-once", {
    maxAutomaticRecoveryCycles: 1,
    automaticRecoveryBackoffMs: [1500],
  });
  await wait(() => s.store.readSession(id), "RECOVERING");
  const stopped = await s.request("POST", `/api/sessions/${id}/actions`, {
    requestId: randomUUID(),
    type: "stop",
  });
  assert.equal(stopped.statusCode, 200);
  const state = await wait(() => s.store.readSession(id), "STOPPED");
  assert.equal(state.automaticRecovery, null);
  await delay(1700);
  assert.equal((await s.store.readSession(id)).visits[0]!.attempts.length, 1);
});
for (const isFree of [true, false]) {
  test(`provider quota exhaustion ${isFree ? "retries a free model" : "stops a paid model before remaining attempts"}`, async (t) => {
    const s = await setup(true);
    t.after(s.cleanup);
    await setModelPricing(s, { isFree });
    const id = await launch(s, await minimal(s), "fixture:quota-once", {
      maxAgentAttempts: isFree ? 1 : 2,
      phaseRecoveryBudgetMs: 7000,
      maxAutomaticRecoveryCycles: 1,
      automaticRecoveryBackoffMs: [50],
    });
    const state = await wait(
      () => s.store.readSession(id),
      isFree ? "SUCCESS" : "PAUSED",
    );
    assert.equal(state.visits[0]!.attempts.length, isFree ? 2 : 1);
    assert.equal(state.visits[0]!.attempts[0]!.failureKind, "quota_exhausted");
    if (!isFree) assert.match(state.statusReason!, /공급자 사용 한도/);
  });
}
for (const isFree of [true, false]) {
  test(`absolute recovery budget exhaustion ${isFree ? "retries a free model" : "pauses a paid model"}`, async (t) => {
    const s = await setup(true);
    t.after(s.cleanup);
    await setModelPricing(s, { isFree });
    const id = await launch(
      s,
      await minimal(s),
      "fixture:progress-budget-once",
      {
        phaseTimeoutMs: 1000,
        phaseRecoveryBudgetMs: 1200,
        transportTimeoutMs: 600,
        idleTimeoutMs: 600,
        toolTimeoutMs: 600,
        maxAutomaticRecoveryCycles: 1,
        automaticRecoveryBackoffMs: [100],
      },
    );
    const state = await wait(
      () => s.store.readSession(id),
      isFree ? "SUCCESS" : "PAUSED",
    );
    assert.equal(state.visits[0]!.attempts[0]!.failureKind, "phase_timeout");
    assert.equal(state.visits[0]!.attempts.length, isFree ? 2 : 1);
  });
}
test("interrupt briefing reaches PAUSED and manual resume uses the reentry node", async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const graph = await minimal(s),
    id = await launch(s, graph, "fixture:hang-once", {
      idleTimeoutMs: 2500,
      toolTimeoutMs: 2500,
    });
  let state = await s.store.readSession(id);
  const end = Date.now() + 5000;
  while (!state.visits[0]?.attempts[0]?.pid && Date.now() < end) {
    await delay(20);
    state = await s.store.readSession(id);
  }
  assert.ok(state.visits[0]?.attempts[0]?.pid);
  const interrupted = await s.request("POST", `/api/sessions/${id}/actions`, {
    requestId: randomUUID(),
    type: "interrupt",
    message: "Inspect the stall before continuing.",
  });
  assert.equal(interrupted.statusCode, 200, interrupted.body);
  state = await wait(() => s.store.readSession(id), "PAUSED");
  assert.equal(state.currentNodeId, "PAUSED");
  assert.ok(
    state.visits.some(
      (v) => v.nodeId === "interrupt" && v.status === "succeeded",
    ),
  );
  await resumeHeld(s, id);
  state = await wait(() => s.store.readSession(id), "SUCCESS");
  assert.equal(
    state.visits.filter((v) => v.nodeId === "implementation").length,
    2,
  );
});
test("iteration budget pauses a loop and only manual resume grants another budget", async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  let graph = await minimal(s);
  graph.nodes = graph.nodes.filter((n) =>
    ["implementation", "interrupt"].includes(n.id),
  );
  graph.edges = graph.edges.filter((e) =>
    graph.nodes.some((n) => n.id === e.source),
  );
  graph.edges = graph.edges.map((e) =>
    e.source === "implementation" && e.outcome === "success"
      ? { ...e, target: "implementation" }
      : e,
  );
  graph = await s.store.saveGraph(graph.id, graph, graph.revision);
  const id = await launch(s, graph, "bounded repeated implementation", {
    maxIterations: 2,
  });
  let state = await wait(() => s.store.readSession(id), "PAUSED");
  assert.equal(state.completedIterations, 2);
  assert.equal(state.visits.length, 2);
  await resumeHeld(s, id);
  state = await wait(() => s.store.readSession(id), "PAUSED");
  assert.equal(state.iterationLimit, 4);
  assert.equal(state.completedIterations, 4);
  assert.equal(state.visits.length, 4);
});
test("normal server close stops active workers and cancels scheduled recovery", async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  await setModelPricing(s, { isFree: true });
  const graph = await minimal(s),
    id = await launch(s, graph, "fixture:network", {
      maxAutomaticRecoveryCycles: 1,
      automaticRecoveryBackoffMs: [60000],
    });
  await wait(() => s.store.readSession(id), "RECOVERING");
  await s.app.close();
  assert.equal((await s.store.readSession(id)).status, "STOPPED");
  assert.equal((await s.store.readSession(id)).automaticRecovery, null);
  const restarted = await createServer({ root: s.root, origin, monitor: true });
  await delay(1100);
  assert.equal((await restarted.store.readSession(id)).status, "STOPPED");
  await restarted.app.close();
});

test("a live foreign owner prevents duplicate resume and deletion", async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const graph = await minimal(s),
    id = await launch(s, graph, "fixture:hang-once", {
      idleTimeoutMs: 2500,
      toolTimeoutMs: 2500,
    });
  let state = await s.store.readSession(id);
  const deadline = Date.now() + 5000;
  while (!state.visits[0]?.attempts[0]?.pid && Date.now() < deadline) {
    await delay(20);
    state = await s.store.readSession(id);
  }
  const { SessionCoordinator } = await import("./coordinator.js");
  const other = new SessionCoordinator(s.store);
  await assert.rejects(() => other.resume(id), /다른 워커/);
  await assert.rejects(() => other.deleteSession(id), /실행을 중지/);
  await s.request("POST", `/api/sessions/${id}/actions`, {
    requestId: randomUUID(),
    type: "stop",
  });
});
test("blocked orphan PID remains a blocker after lease release without killing an unrelated process", async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const graph = await minimal(s),
    id = await launch(s, graph, "completed fixture");
  await wait(() => s.store.readSession(id), "SUCCESS");
  await delay(100);
  await s.store.mutateSession(id, (state) => {
    state.status = "BLOCKED";
    const a = state.visits[0]!.attempts[0]!;
    a.failureKind = "orphaned_process";
    a.pid = process.pid;
  });
  await assert.rejects(() => s.coordinator.resume(id), /자식 프로세스/);
  await assert.rejects(() => s.coordinator.deleteSession(id), /자식 프로세스/);
  assert.equal((await s.store.readSession(id)).status, "BLOCKED");
  assert.doesNotThrow(() => process.kill(process.pid, 0));
});
test("server restart restores held plan state and resumes the same saved snapshot", async (t) => {
  const s = await setup();
  let restart: Awaited<ReturnType<typeof createServer>> | undefined;
  t.after(async () => {
    await restart?.app.close();
    await s.cleanup();
  });
  const id = await launch(s, s.graph, "persisted plan approval");
  const held = await wait(() => s.store.readSession(id), "WAITING_USER");
  await s.app.close();
  const restarted = await createServer({ root: s.root, origin, monitor: true });
  restart = restarted;
  const restored = await restarted.store.readSession(id);
  assert.deepEqual(restored.pendingApproval, held.pendingApproval);
  const p = restored.visits[0]!.plans[0]!;
  const decision = {
    requestId: randomUUID(),
    type: "approve_plan" as const,
    ...restored.pendingApproval!,
    choiceId: p.id,
    expectedRevision: p.revision,
  };
  await restarted.coordinator.action(id, decision);
  const completed = await wait(
    () => restarted.store.readSession(id),
    "SUCCESS",
  );
  assert.equal(completed.visits[0]!.id, held.visits[0]!.id);
  const repeated = await restarted.coordinator.action(id, decision);
  assert.equal(repeated.status, "SUCCESS");
  assert.equal(repeated.visits.length, completed.visits.length);
});
test("a crashed worker pauses then manual resume cleans its old CLI child before starting another", async (t) => {
  const s = await setup(true);
  t.after(s.cleanup);
  const graph = await minimal(s),
    id = await launch(s, graph, "fixture:hang-once", {
      idleTimeoutMs: 2500,
      toolTimeoutMs: 2500,
    });
  let state = await s.store.readSession(id);
  const deadline = Date.now() + 5000;
  while (
    state.visits[0]?.attempts[0]?.activity !== "model_generation" &&
    Date.now() < deadline
  ) {
    await delay(20);
    state = await s.store.readSession(id);
  }
  assert.equal(state.visits[0]?.attempts[0]?.activity, "model_generation");
  const { readJsonFile, checkProcessLiveness } =
    await import("../core/resilience.js");
  const lease = await readJsonFile<{ ownerPid: number; childPid: number }>(
    path.join(s.store.sessionDir(id), "lease.json"),
  );
  assert.ok(lease);
  assert.notEqual(lease.ownerPid, process.pid);
  const childPid = state.visits[0]!.attempts[0]!.pid!;
  process.kill(lease.ownerPid, "SIGKILL");
  await wait(() => s.store.readSession(id), "PAUSED");
  // Heartbeats can lag behind persisted activity when the worker dies. The
  // saved attempt PID must be checked even when the lease missed the child.
  const { atomicWriteJsonFile } = await import("../core/resilience.js");
  await atomicWriteJsonFile(path.join(s.store.sessionDir(id), "lease.json"), {
    ...lease,
    childPid: null,
  });
  await resumeHeld(s, id);
  state = await wait(() => s.store.readSession(id), "SUCCESS");
  assert.equal(checkProcessLiveness(childPid), "dead");
  assert.equal(state.visits[0]!.attempts[0]!.failureKind, "worker_crash");
  assert.deepEqual(
    state.visits.map((v) => v.nodeId),
    ["implementation", "test", "approval"],
  );
  assert.equal(state.visits[0]!.attempts.length, 2);
});

for (const type of ["stop", "interrupt"] as const)
  test(`${type} cancels an in-flight model query and cleans its process`, async (t) => {
    const s = await setup();
    t.after(s.cleanup);
    const graph = await minimal(s);
    await fs.writeFile(
      path.join(s.target, ".fixture-slow-query"),
      "hold one metadata request",
    );
    const id = await launch(s, graph, "metadata cancellation acceptance");
    let pid = 0;
    const deadline = Date.now() + 5000;
    while (!pid && Date.now() < deadline) {
      pid = Number(
        await fs
          .readFile(path.join(s.target, ".fixture-query-pid"), "utf8")
          .catch(() => ""),
      );
      if (!pid) await delay(20);
    }
    assert.ok(pid);
    const response = await s.request("POST", `/api/sessions/${id}/actions`, {
      requestId: randomUUID(),
      type,
      message: "Review cancellation evidence.",
    });
    assert.equal(response.statusCode, 200, response.body);
    const state = await wait(
      () => s.store.readSession(id),
      type === "stop" ? "STOPPED" : "PAUSED",
    );
    const { checkProcessLiveness } = await import("../core/resilience.js");
    // Windows can report a terminated process as alive briefly while its handle closes.
    const killedBy = Date.now() + 2000;
    while (checkProcessLiveness(pid) !== "dead" && Date.now() < killedBy)
      await delay(20);
    assert.equal(checkProcessLiveness(pid), "dead");
    if (type === "stop") assert.equal(state.visits.length, 0);
    else
      assert.deepEqual(
        state.visits.map((v) => v.nodeId),
        ["interrupt"],
      );
  });
test("external path approval is scoped to the current visit and preserves the same visit on resume", async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const graph = await minimal(s),
    external = path.join(s.root, "external");
  await fs.mkdir(external);
  const id = await launch(
    s,
    graph,
    `Implement the artifact with reference to ${external}`,
  );
  const held = await wait(() => s.store.readSession(id), "WAITING_USER");
  assert.deepEqual(held.pendingAccess?.paths, [external]);
  assert.equal(held.visits[0]!.attempts.length, 0);
  const stale = await s.request("POST", `/api/sessions/${id}/actions`, {
    requestId: randomUUID(),
    type: "approve_access",
    nodeId: "implementation",
    visitId: randomUUID(),
    decision: "allow_requested",
  });
  assert.equal(stale.statusCode, 409);
  const approved = await s.request("POST", `/api/sessions/${id}/actions`, {
    requestId: randomUUID(),
    type: "approve_access",
    ...held.pendingAccess!,
    decision: "allow_requested",
  });
  assert.equal(approved.statusCode, 200, approved.body);
  const done = await wait(() => s.store.readSession(id), "SUCCESS");
  assert.equal(done.visits[0]!.id, held.visits[0]!.id);
  assert.deepEqual(done.additionalAllowedPaths, [external]);
  assert.equal(done.accessMode, "ask");
});
test("incomplete output gets a fresh bounded completion attempt without a transport reconnect", async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const graph = await minimal(s),
    id = await launch(s, graph, "fixture:incomplete-once");
  const state = await wait(() => s.store.readSession(id), "SUCCESS");
  assert.deepEqual(
    state.visits.map((v) => v.nodeId),
    ["implementation", "test", "approval"],
  );
  assert.equal(state.visits[0]!.attempts.length, 2);
  assert.equal(
    state.visits[0]!.attempts[0]!.failureKind,
    "incomplete_response",
  );
  assert.equal(state.visits[0]!.attempts[1]!.mode, "completion_recovery");
  assert.equal(state.visits[0]!.attempts[1]!.reconnectUsed, false);
});
test("normal server shutdown terminates its active CLI and persists STOPPED", async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const graph = await minimal(s),
    id = await launch(s, graph, "fixture:hang", {
      idleTimeoutMs: 2500,
      toolTimeoutMs: 2500,
    });
  let state = await s.store.readSession(id);
  const deadline = Date.now() + 5000;
  while (
    state.visits[0]?.attempts[0]?.activity !== "model_generation" &&
    Date.now() < deadline
  ) {
    await delay(20);
    state = await s.store.readSession(id);
  }
  const pid = state.visits[0]?.attempts[0]?.pid;
  assert.ok(pid);
  await s.app.close();
  assert.equal((await s.store.readSession(id)).status, "STOPPED");
  const { checkProcessLiveness } = await import("../core/resilience.js");
  assert.equal(checkProcessLiveness(pid), "dead");
});
test("a saved RUNNING state without a lease is paused instead of remaining stuck or spending automatically", async (t) => {
  const s = await setup(true);
  t.after(s.cleanup);
  const graph = await minimal(s),
    id = await launch(s, graph, "missing owner acceptance");
  await wait(() => s.store.readSession(id), "SUCCESS");
  await delay(100);
  const state = await s.store.readSession(id);
  state.status = "RUNNING";
  state.updatedAt = new Date(Date.now() - 10000).toISOString();
  const { atomicWriteJsonFile } = await import("../core/resilience.js");
  await atomicWriteJsonFile(
    path.join(s.store.sessionDir(id), "state.json"),
    state,
  );
  await fs.rm(path.join(s.store.sessionDir(id), "lease.json"), { force: true });
  const paused = await wait(() => s.store.readSession(id), "PAUSED");
  assert.match(paused.statusReason ?? "", /소유권/);
  assert.equal(paused.visits[0]!.attempts.length, 1);
});

for (const role of ["review", "approval"] as const)
  test(`${role} failed extra check rejects approval and requires a new verified cycle`, async (t) => {
    const s = await setup();
    t.after(s.cleanup);
    const id = await launch(
      s,
      await automaticPlans(s),
      `fixture:${role}-check-fail-once`,
    );
    const state = await wait(() => s.store.readSession(id), "SUCCESS");
    const visits = state.visits.filter((v) => v.nodeId === role);
    assert.equal(visits[0]!.verdict, "REJECTED");
    assert.equal(visits[0]!.status, "failed");
    assert.equal(visits.at(-1)!.verdict, "APPROVED");
    assert.equal(state.visits.filter((v) => v.nodeId === "test").length, 2);
  });

test("summary API preserves full API compatibility and unchanged completed records are not reread each tick", async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const id = await launch(s, await minimal(s), "summary acceptance");
  await wait(() => s.store.readSession(id), "SUCCESS");
  await delay(100);
  const full = (
    await s.request("GET", `/api/sessions/${id}`)
  ).json<SessionState>();
  const summary = (await s.request("GET", "/api/sessions?summary=1")).json()[0];
  assert.ok(full.visits.length);
  assert.ok(full.revision! > 1);
  assert.equal(summary.revision, full.revision);
  assert.equal(summary.visits, undefined);
  assert.equal(
    (await s.request("GET", "/api/sessions")).json()[0].visits.length,
    full.visits.length,
  );
  const original = s.store.readSession.bind(s.store);
  let reads = 0;
  s.store.readSession = async (value) => {
    reads++;
    return original(value);
  };
  await s.store.sessionSummaries();
  await s.store.sessionSummaries();
  assert.equal(reads, 0, "summary cache decodes only changed snapshots");
  await s.store.mutateSession(id, (state) => {
    state.statusReason = "updated";
  });
  assert.equal((await s.store.sessionSummaries())[0]!.statusReason, "updated");
});

test("stale runtime snapshot cannot overwrite a newer STOP decision", async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const id = await launch(s, await minimal(s), "write ownership acceptance");
  const stale = await wait(() => s.store.readSession(id), "SUCCESS");
  await delay(100);
  const current = await s.store.mutateSession(id, (state) => {
    state.status = "STOPPED";
    state.statusReason = "new controller decision";
  });
  stale.status = "RUNNING";
  await assert.rejects(
    s.store.writeSession(stale),
    (e: unknown) => (e as { code?: string }).code === "stale_session",
  );
  assert.deepEqual(await s.store.readSession(id), current);
});

test("snapshot decoding rejects malformed v3 data and preserves compatible legacy evidence", async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const id = await launch(s, await minimal(s), "snapshot validation");
  const valid = await wait(() => s.store.readSession(id), "SUCCESS");
  await delay(100);
  const file = path.join(s.store.sessionDir(id), "state.json");
  const { decodeSession } = await import("../core/session_schema.js");
  const legacy = structuredClone(valid);
  delete legacy.revision;
  delete legacy.executionBudget;
  delete legacy.settings.sessionTimeoutMs;
  delete legacy.settings.maxSessionAttempts;
  for (const v of legacy.visits)
    for (const a of v.attempts) {
      delete a.completionAccepted;
      delete a.fileMutation;
      delete a.commands;
      delete a.pricing;
    }
  assert.equal(decodeSession(legacy, id).stateVersion, 3);
  for (const mutate of [
    (v: any) => {
      v.executionBudget.deadlineAt = "invalid";
    },
    (v: any) => {
      v.executionBudget.maxAttempts = 0;
    },
    (v: any) => {
      v.verificationContract = { version: 1, status: "locked" };
    },
    (v: any) => {
      delete v.graph;
    },
    (v: any) => {
      v.visits = null;
    },
    (v: any) => {
      delete v.settings;
    },
    (v: any) => {
      v.activeVisitId = "nonexistent";
    },
    (v: any) => {
      v.visits[0].attempts[0].status = "fake-success";
    },
    (v: any) => {
      v.visits[1].attempts[0].commands[0].exitCode = "0";
    },
    (v: any) => {
      v.id = "different";
    },
  ]) {
    const broken = structuredClone(valid);
    mutate(broken);
    await fs.writeFile(file, JSON.stringify(broken));
    await assert.rejects(
      s.store.readSession(id),
      (e: unknown) => (e as { code?: string }).code === "invalid_session",
    );
    assert.deepEqual(
      JSON.parse(await fs.readFile(file, "utf8")),
      broken,
      "corrupt original is never rewritten",
    );
  }
  await fs.writeFile(file, "{ broken json");
  await assert.rejects(s.store.readSession(id), /JSON이 손상/);
  await fs.writeFile(file, JSON.stringify(valid));
});
