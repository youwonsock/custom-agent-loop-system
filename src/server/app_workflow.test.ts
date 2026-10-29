import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { AgentGraphDocument, SessionState } from "../shared/domain";
import { delay } from "../core/resilience";
import {
  sessionWaitMs,
  runManualRuntime,
  quickSettings,
  setup,
  wait,
  minimal,
  launch,
  resumeHeld,
  host,
} from "./app_harness.test";

test("API rejects missing cookies, foreign Host and Origin, and protects revision writes", async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  assert.equal(
    (await s.app.inject({ url: "/api/graphs", headers: { host } })).statusCode,
    401,
  );
  assert.equal(
    (
      await s.app.inject({
        url: "/api/bootstrap",
        headers: { host: "attacker.test" },
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await s.app.inject({
        method: "POST",
        url: "/api/graphs",
        headers: { host, origin: "https://attacker.test" },
        payload: { name: "bad" },
      })
    ).statusCode,
    403,
  );
  const doc = { ...s.graph, name: "changed" };
  assert.equal(
    (
      await s.request("PUT", `/api/graphs/${doc.id}`, {
        document: doc,
        expectedRevision: doc.revision,
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await s.request("PUT", `/api/graphs/${doc.id}`, {
        document: doc,
        expectedRevision: doc.revision,
      })
    ).statusCode,
    409,
  );
  const imported = await s.request("POST", "/api/graphs/import", doc);
  assert.equal(imported.statusCode, 200);
  assert.notEqual(imported.json<AgentGraphDocument>().id, doc.id);
});
test("default graph plans, accepts edited approval, executes all roles and preserves run snapshot", async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const requestId = randomUUID();
  const response = await s.request("POST", "/api/sessions", {
    requestId,
    graphId: s.graph.id,
    expectedRevision: s.graph.revision,
    goal: "Create and verify an acceptance artifact.",
    targetProjectPath: s.target,
    settings: quickSettings,
  });
  assert.equal(response.statusCode, 202, response.body);
  const id = response.json<SessionState>().id;
  const read = () => s.store.readSession(id);
  let state = await wait(read, "WAITING_USER");
  assert.ok(state.pendingApproval);
  assert.equal(state.visits.length, 1);
  const pending = state.pendingApproval!,
    plan = state.visits[0]!.plans[1]!;
  const stale = await s.request("POST", `/api/sessions/${id}/actions`, {
    requestId: randomUUID(),
    type: "approve_plan",
    ...pending,
    visitId: randomUUID(),
    choiceId: plan.id,
    expectedRevision: plan.revision,
  });
  assert.equal(stale.statusCode, 409);
  const edited = await s.request("POST", `/api/sessions/${id}/actions`, {
    requestId: randomUUID(),
    type: "edit_plan",
    ...pending,
    choiceId: plan.id,
    expectedRevision: plan.revision,
    body: plan.body + "\nOperator reviewed the ordered steps.",
  });
  assert.equal(edited.statusCode, 200, edited.body);
  const wrongRev = await s.request("POST", `/api/sessions/${id}/actions`, {
    requestId: randomUUID(),
    type: "approve_plan",
    ...pending,
    choiceId: plan.id,
    expectedRevision: plan.revision,
  });
  assert.equal(wrongRev.statusCode, 409);
  const live = await s.store.graph(s.graph.id);
  await s.store.saveGraph(
    live.id,
    { ...live, name: "edited during run" },
    live.revision,
  );
  const approved = await s.request("POST", `/api/sessions/${id}/actions`, {
    requestId: randomUUID(),
    type: "approve_plan",
    ...pending,
    choiceId: plan.id,
    expectedRevision: plan.revision + 1,
  });
  assert.equal(approved.statusCode, 200, approved.body);
  state = await wait(read, "SUCCESS");
  assert.equal(state.graph.name, s.graph.name);
  assert.equal(state.visits.length, 5);
  assert.equal(state.approvedPlanRef?.revision, 2);
  assert.equal(state.visits[0]!.selectedPlanId, 2);
  assert.equal(
    await fs.readFile(path.join(s.target, "artifact.txt"), "utf8"),
    "implemented goal\n",
  );
  assert.ok(state.visits.every((v) => v.transitionCommitted));
  assert.ok(state.requirements.evidence.some((e) => e.status === "SATISFIED"));
  assert.equal(
    (
      await s.request("POST", "/api/sessions", {
        requestId,
        graphId: s.graph.id,
        expectedRevision: s.graph.revision,
        goal: "changed",
        targetProjectPath: s.target,
      })
    ).json<SessionState>().id,
    id,
  );
  const log = await s.request("GET", `/api/sessions/${id}/logs`);
  assert.ok(log.json<{ text: string }>().text.includes("PHASE_DONE"));
});
test("planning revisits get new visit IDs and new approvals; earlier approval cannot affect a later visit", async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  let g = s.graph;
  g.edges = g.edges.map((e) =>
    e.source === "review" && e.outcome === "failure"
      ? { ...e, target: "planning" }
      : e,
  );
  g = await s.store.saveGraph(g.id, g, g.revision);
  const response = await s.request("POST", "/api/sessions", {
    requestId: randomUUID(),
    graphId: g.id,
    expectedRevision: g.revision,
    goal: "fixture:reject-once exercise planning reentry",
    targetProjectPath: s.target,
    settings: quickSettings,
  });
  assert.equal(response.statusCode, 202, response.body);
  const id = response.json<SessionState>().id;
  const read = () => s.store.readSession(id);
  let state = await wait(read, "WAITING_USER");
  const first = state.pendingApproval!,
    plan = state.visits[0]!.plans[0]!;
  const approve = await s.request("POST", `/api/sessions/${id}/actions`, {
    requestId: randomUUID(),
    type: "approve_plan",
    ...first,
    choiceId: plan.id,
    expectedRevision: 1,
  });
  assert.equal(approve.statusCode, 200, approve.body);
  const deadline = Date.now() + sessionWaitMs;
  do {
    state = await read();
    if (
      state.status === "WAITING_USER" &&
      state.pendingApproval?.visitId !== first.visitId
    )
      break;
    await delay(30);
  } while (Date.now() < deadline);
  assert.equal(state.status, "WAITING_USER");
  assert.notEqual(state.pendingApproval?.visitId, first.visitId);
  assert.equal(state.visits.filter((v) => v.nodeId === "planning").length, 2);
  assert.equal(
    (
      await s.request("POST", `/api/sessions/${id}/actions`, {
        requestId: randomUUID(),
        type: "approve_plan",
        ...first,
        choiceId: 1,
        expectedRevision: 1,
      })
    ).statusCode,
    409,
  );
});
test("unknown model fails before coding without an automatic model change", async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  let g = s.graph;
  g.defaultBinding = { connectionId: "fixture", modelId: "not-in-model-api" };
  g = await s.store.saveGraph(g.id, g, g.revision);
  const response = await s.request("POST", "/api/sessions", {
    requestId: randomUUID(),
    graphId: g.id,
    expectedRevision: g.revision,
    goal: "do work",
    targetProjectPath: s.target,
    settings: quickSettings,
  });
  const state = await wait(
    () => s.store.readSession(response.json<SessionState>().id),
    "WAITING_USER",
  );
  assert.equal(state.visits.length, 0);
  assert.equal(
    (await fs.readdir(s.target)).includes(".fixture-calls.json"),
    false,
  );
});
test("STOP safely terminates a running child and does not restart it", async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const g = await minimal(s);
  const response = await s.request("POST", "/api/sessions", {
    requestId: randomUUID(),
    graphId: g.id,
    expectedRevision: g.revision,
    goal: "fixture:hang",
    targetProjectPath: s.target,
    settings: { ...quickSettings, idleTimeoutMs: 2500, toolTimeoutMs: 2500 },
  });
  const id = response.json<SessionState>().id;
  let state = await s.store.readSession(id);
  const deadline = Date.now() + 5000;
  while (!state.visits.at(-1)?.attempts.at(-1)?.pid && Date.now() < deadline) {
    await delay(30);
    state = await s.store.readSession(id);
  }
  assert.ok(state.visits.at(-1)?.attempts.at(-1)?.pid);
  const stopped = await s.request("POST", `/api/sessions/${id}/actions`, {
    requestId: randomUUID(),
    type: "stop",
  });
  assert.equal(stopped.statusCode, 200, stopped.body);
  assert.equal(stopped.json<SessionState>().status, "STOPPED");
  await delay(200);
  assert.equal((await s.store.readSession(id)).status, "STOPPED");
});

test("API prevents execution of editable drafts that bypass tests or final approval", async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const graph = s.graph;
  graph.edges.find(
    (e) => e.source === "implementation" && e.outcome === "success",
  )!.target = "SUCCESS";
  const saved = await s.store.saveGraph(graph.id, graph, graph.revision);
  const response = await s.request("POST", "/api/sessions", {
    requestId: randomUUID(),
    graphId: saved.id,
    expectedRevision: saved.revision,
    goal: "must test",
    targetProjectPath: s.target,
    settings: quickSettings,
  });
  assert.equal(response.statusCode, 400);
  assert.match(response.body, /unsafe_success/);
  assert.equal((await s.store.sessions()).length, 0);
});

test("recovered terminal snapshots fail closed without current test evidence and final approval", async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const id = await launch(s, await minimal(s), "verified recovery");
  const completed = await wait(() => s.store.readSession(id), "SUCCESS");
  await delay(100);
  const calls = await fs.readFile(
    path.join(s.target, ".fixture-calls.json"),
    "utf8",
  );
  for (const mode of [
    "missing-tests",
    "failed-approval",
    "legacy-metadata",
  ] as const) {
    const snapshot = structuredClone(completed);
    snapshot.status = "PAUSED";
    if (mode === "missing-tests")
      snapshot.visits = snapshot.visits.filter((v) => v.nodeId !== "test");
    if (mode === "failed-approval") snapshot.visits.at(-1)!.status = "failed";
    if (mode === "legacy-metadata")
      for (const v of snapshot.visits)
        for (const a of v.attempts) delete a.completionAccepted;
    snapshot.revision = (await s.store.readSession(id)).revision;
    await s.store.writeSession(snapshot);
    await runManualRuntime(s.root, id);
    const held = await s.store.readSession(id);
    assert.equal(held.status, "PAUSED", mode);
    assert.equal(held.currentNodeId, "PAUSED");
    assert.match(held.statusReason!, /성공 조건 미충족/);
    assert.equal(held.automaticRecovery, null);
    assert.equal(
      await fs.readFile(path.join(s.target, ".fixture-calls.json"), "utf8"),
      calls,
      "gate cannot spend on an automatic repair",
    );
  }
  await runManualRuntime(s.root, id);
  const repaired = await s.store.readSession(id);
  assert.equal(repaired.status, "SUCCESS", repaired.statusReason!);
  assert.deepEqual(
    repaired.visits.slice(-3).map((v) => v.nodeId),
    ["implementation", "test", "approval"],
  );
});

test("legacy failure edges cannot turn test FAIL or approval REJECTED into SUCCESS", async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const id = await launch(s, await minimal(s), "failure edge recovery");
  const completed = await wait(() => s.store.readSession(id), "SUCCESS");
  await delay(100);
  await fs.rm(path.join(s.target, "artifact.txt"));
  for (const nodeId of ["test", "approval"]) {
    const snapshot = structuredClone(completed);
    snapshot.status = "PAUSED";
    snapshot.currentNodeId = nodeId;
    snapshot.visits = [];
    snapshot.graph.edges.find(
      (e) => e.source === nodeId && e.outcome === "failure",
    )!.target = "SUCCESS";
    snapshot.revision = (await s.store.readSession(id)).revision;
    await s.store.writeSession(snapshot);
    await runManualRuntime(s.root, id);
    const held = await s.store.readSession(id);
    assert.equal(held.status, "PAUSED", held.statusReason!);
    assert.equal(
      held.visits.at(-1)!.verdict,
      nodeId === "test" ? "FAIL" : "REJECTED",
    );
    assert.match(held.statusReason!, /성공 조건 미충족/);
  }
});

test("auth failure waits without replacing model and manual resume continues the same visit", async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const graph = await minimal(s),
    id = await launch(s, graph, "fixture:auth-once");
  let state = await wait(() => s.store.readSession(id), "WAITING_USER");
  assert.match(state.statusReason ?? "", /인증/);
  assert.equal(state.visits.length, 1);
  assert.equal(state.visits[0]!.attempts.length, 1);
  const visit = state.activeVisitId;
  await resumeHeld(s, id);
  state = await wait(() => s.store.readSession(id), "SUCCESS");
  assert.equal(state.visits[0]!.id, visit);
  assert.equal(state.visits[0]!.attempts.length, 2);
  assert.equal(state.bindings.implementation!.modelId, "fixture-model");
});
