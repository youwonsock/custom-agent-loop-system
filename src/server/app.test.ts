import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "./app";
import { AgentGraphDocument, SessionState } from "../shared/domain";
import { delay } from "../core/resilience";
import { nodeTestVerificationCommand } from "../core/node_test_command";
const origin = "http://127.0.0.1:4317",
  host = "127.0.0.1:4317",
  binary = path.resolve(__dirname, "../../../test/fixture_cli.cjs");
// ConPTY drains output for about a second per role before reporting process exit.
const sessionWaitMs = process.platform === "win32" ? 20_000 : 10_000;
const execute = promisify(execFile);
// Match production's worker isolation: ConPTY may retain native handles in the
// calling process even after every runtime assertion and lease release passes.
async function runManualRuntime(root: string, id: string): Promise<void> {
  await execute(process.execPath, [path.join(__dirname, "worker.js"), root, id, "manual"], {
    timeout: sessionWaitMs,
    windowsHide: true,
  });
}
const quickSettings = {
  maxAgentAttempts: 1,
  maxCompletionRecoveryAttempts: 1,
  maxAutomaticRecoveryCycles: 0,
  phaseTimeoutMs: 3000,
  idleTimeoutMs: 1000,
  toolTimeoutMs: 1000,
  transportTimeoutMs: 1000,
  phaseRecoveryBudgetMs: 6000,
  retryBackoffMs: [10, 20],
  terminationGraceMs: 50,
  killTimeoutMs: 1000,
  heartbeatIntervalMs: 100,
  leaseTtlMs: 500,
};
async function setup(monitor = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "graph-api-")),
    target = path.join(root, "project");
  await fs.mkdir(target);
  const server = await createServer({
    root,
    origin,
    defaultTarget: target,
    monitor,
  });
  const response = await server.app.inject({
    url: "/api/bootstrap",
    headers: { host },
  });
  const cookie = String(response.headers["set-cookie"]).split(";")[0]!;
  const request = (
    method: "GET" | "POST" | "PUT" | "DELETE",
    url: string,
    payload?: unknown,
  ) =>
    server.app.inject({
      method,
      url,
      headers: { host, origin, cookie },
      ...(payload === undefined
        ? {}
        : {
            payload: JSON.stringify(payload),
            headers: {
              host,
              origin,
              cookie,
              "content-type": "application/json",
            },
          }),
    });
  const cleanup = async () => {
    await server.app.close();
    await fs.rm(root, { recursive: true, force: true });
  };
  await server.store.saveConnection({
    id: "fixture",
    label: "Fixture CLI",
    type: "codex",
    binary,
  });
  let graph = (await server.store.graphs())[0]!;
  graph.defaultBinding = { connectionId: "fixture", modelId: "fixture-model" };
  graph = await server.store.saveGraph(graph.id, graph, graph.revision);
  return { ...server, root, target, graph, request, cleanup };
}
async function wait(
  read: () => Promise<SessionState>,
  status: SessionState["status"],
  timeout = sessionWaitMs,
): Promise<SessionState> {
  const end = Date.now() + timeout;
  let s = await read();
  while (Date.now() < end) {
    s = await read();
    if (s.status === status) return s;
    if (["FAILED", "BLOCKED"].includes(s.status))
      throw new Error(s.statusReason ?? s.status);
    await delay(30);
  }
  throw new Error(
    `status ${s.status}: ${s.statusReason}; visits ${JSON.stringify(s.visits.map((v) => ({ node: v.nodeId, status: v.status, attempts: v.attempts.map((a) => ({ status: a.status, activity: a.activity, pid: a.pid, failure: a.failureKind })) })))}`,
  );
}
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
async function minimal(s: Awaited<ReturnType<typeof setup>>) {
  const g = s.graph;
  g.nodes = g.nodes.filter((n) =>
    ["implementation", "test", "approval", "interrupt"].includes(n.id),
  );
  g.edges = g.edges
    .filter((e) => g.nodes.some((n) => n.id === e.source))
    .map((e) =>
      e.source === "test"
        ? {
            ...e,
            target: e.outcome === "success" ? "approval" : "implementation",
          }
        : e,
    );
  g.entrypoints = {
    start: "implementation",
    reentry: "implementation",
    interrupt: "interrupt",
    cycleCompletion: "implementation",
  };
  return s.store.saveGraph(g.id, g, g.revision);
}
async function launch(
  s: Awaited<ReturnType<typeof setup>>,
  graph: AgentGraphDocument,
  goal: string,
  settings: Partial<SessionState["settings"]> = {},
) {
  const response = await s.request("POST", "/api/sessions", {
    requestId: randomUUID(),
    graphId: graph.id,
    expectedRevision: graph.revision,
    goal,
    targetProjectPath: s.target,
    settings: { ...quickSettings, ...settings },
  });
  assert.equal(response.statusCode, 202, response.body);
  return response.json<SessionState>().id;
}
async function resumeHeld(s: Awaited<ReturnType<typeof setup>>, id: string) {
  await delay(100);
  const response = await s.request("POST", `/api/sessions/${id}/actions`, {
    requestId: randomUUID(),
    type: "resume",
  });
  assert.equal(response.statusCode, 200, response.body);
}
async function setModelPricing(
  s: Awaited<ReturnType<typeof setup>>,
  metadata: Record<string, unknown>,
) {
  await fs.writeFile(
    path.join(s.target, ".fixture-model-metadata.json"),
    JSON.stringify(metadata),
  );
}

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

async function automaticPlans(s: Awaited<ReturnType<typeof setup>>) {
  const graph = s.graph;
  graph.nodes.find((n) => n.type === "planning")!.planning!.requiresApproval =
    false;
  return s.store.saveGraph(graph.id, graph, graph.revision);
}
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
  const { readJsonFile, checkProcessLiveness } = await import(
    "../core/resilience.js"
  );
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
    (v: any) => { v.executionBudget.deadlineAt = "invalid"; },
    (v: any) => { v.executionBudget.maxAttempts = 0; },
    (v: any) => { v.verificationContract = { version: 1, status: "locked" }; },
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
  assert.match(tests[0]!.output, /제품.*변경/);
  assert.equal(tests[1]!.verdict, "PASS");
});

async function contracted(s: Awaited<ReturnType<typeof setup>>, supplied = true, failing = false, second = false) {
  let graph = await s.store.createGraph({ template: "autonomous" });
  graph.automation!.authoredNodeTests = false; // Legacy frozen-check profile; own-suite cases have dedicated coverage.
  graph.automation!.browserVerification = false;
  graph.automation!.maxRepairCycles = 1;
  graph.defaultBinding = s.graph.defaultBinding;
  graph = await s.store.saveGraph(graph.id, graph, graph.revision);
  if (supplied) {
    await fs.mkdir(path.join(s.target, ".agent-graph"));
    await fs.mkdir(path.join(s.target, "tests"));
    await fs.writeFile(path.join(s.target, "tests/verify-acceptance.mjs"), `import { readFileSync } from 'node:fs'; import assert from 'node:assert/strict'; assert.equal(readFileSync('artifact.txt','utf8'), ${JSON.stringify(failing ? "incorrect artifact\n" : "implemented goal\n")});`);
    const check = { id: "acceptance", command: "node tests/verify-acceptance.mjs", requirements: ["REQ-001"] };
    await fs.writeFile(path.join(s.target, ".agent-graph/verification.json"), JSON.stringify({ version: 1, protectedFiles: ["tests/verify-acceptance.mjs"], checks: [check, ...(second ? [{ ...check, id: "second", command: "node tests/verify-acceptance.mjs --second" }] : [])] }));
  }
  return graph;
}
for(const mode of ["fixture:contract-early-fail","fixture:contract-hidden-guard","fixture:contract-policy-guard"])test(`${mode} returns promptly to implementation with invalid proof and completes a fresh immutable test/approval cycle`,async t=>{
 const s=await setup();t.after(s.cleanup);const graph=await contracted(s),id=await launch(s,graph,mode);
 const done=await wait(()=>s.store.readSession(id),"SUCCESS"),tests=done.visits.filter(v=>v.nodeId==="test");
 assert.equal(tests.length,2);assert.equal(tests[0]!.verdict,"FAIL");assert.equal(tests[0]!.attempts.length,1);assert.ok(tests[0]!.attempts[0]!.verificationInvalidation);assert.deepEqual(tests[0]!.verifiedCommands,[]);
 assert.ok(Date.parse(tests[0]!.completedAt!)-Date.parse(tests[0]!.startedAt)<4500);assert.equal(await fs.stat(path.join(s.target,"verification/forbidden-late-write")).then(()=>true,()=>false),false);
 assert.equal(tests[1]!.verdict,"PASS");assert.ok(tests[1]!.verificationSourceHashes?.["artifact.txt"]);assert.equal(done.visits.at(-1)!.verdict,"APPROVED");assert.deepEqual(done.processedRequests,[]);
 if(mode.includes("hidden"))assert.ok(tests[0]!.attempts[0]!.verificationInvalidation!.files.includes("artifact.txt"));
 if(mode.includes("policy"))assert.equal(tests[0]!.attempts[0]!.fileMutation,false);
});
test("blocked broad process termination is corrected within implementation without operator approval or proof reuse",async t=>{
 const s=await setup();t.after(s.cleanup);const graph=await contracted(s),id=await launch(s,graph,"fixture:contract-owned-process",{maxAgentAttempts:2,phaseRecoveryBudgetMs:9000});
 const done=await wait(()=>s.store.readSession(id),"SUCCESS"),impl=done.visits.find(v=>v.nodeId==="implementation")!;
 assert.equal(impl.attempts.length,2);assert.equal(impl.attempts[0]!.failureKind,"tool_arguments");assert.match(impl.attempts[0]!.message!,/UNSCOPED_TERMINATION/);assert.equal(impl.attempts[1]!.completionAccepted,true);assert.equal(done.visits.at(-1)!.verdict,"APPROVED");assert.deepEqual(done.processedRequests,[]);
});
test("supplied frozen contract executes a real protected assertion and JSON reports through final approval", async t => {
  const s = await setup(); t.after(s.cleanup);
  const graph = await contracted(s), id = await launch(s, graph, "fixture:contract-workflow");
  const done = await wait(() => s.store.readSession(id), "SUCCESS");
  assert.equal(done.verificationContract!.origin, "supplied");
  assert.equal(done.verificationContract!.status, "locked");
  assert.equal(done.pendingApproval, null);
  assert.equal(done.processedRequests.length, 0);
  assert.deepEqual(done.visits.map(v => v.nodeId), ["planning", "implementation", "test", "review", "approval"]);
  assert.ok(done.visits.slice(2).every(v => v.output.includes("[REPORT_PROTOCOL: json-v1]")));
  assert.equal(done.visits[2]!.attempts[0]!.commands![0]!.exitCode, 0);
  assert.equal(done.visits.at(-1)!.verdict, "APPROVED");
});
test("own Node quality rejects empty assertions despite claimed PASS and repairs before independent final approval",async t=>{
 const s=await setup();t.after(s.cleanup);
 let graph=await s.store.createGraph({template:"autonomous"});graph.automation!.browserVerification=false;graph.automation!.maxRepairCycles=1;graph.defaultBinding=s.graph.defaultBinding;graph=await s.store.saveGraph(graph.id,graph,graph.revision);
 await fs.mkdir(path.join(s.target,".agent-graph"));await fs.mkdir(path.join(s.target,"probes"));
 await fs.writeFile(path.join(s.target,"value.mjs"),"export const value=1;\n");
 await fs.writeFile(path.join(s.target,"package.json"),JSON.stringify({type:"module",scripts:{test:"node --test --test-concurrency=1 test/value.test.mjs"}}));
 await fs.writeFile(path.join(s.target,"probes/verify-value.mjs"),"export async function mutate({enabled}){return {'value.mjs':'export const value='+(enabled?2:1)+';'}}");
 const manifest={version:1,protectedFiles:["probes/verify-value.mjs"],checks:[{id:"node",command:"npm test",requirements:["REQ-001"]},{id:"quality",command:nodeTestVerificationCommand(),requirements:["REQ-001"]}],nodeTests:{checkId:"quality",suiteCheckId:"node",scopes:[{id:"value",file:"test/value.test.mjs",requirements:["REQ-001"],cases:["value:correct"],challenges:[{id:"wrong-value",adapter:"probes/verify-value.mjs",targets:["value.mjs"]}]}]}};
 await fs.writeFile(path.join(s.target,".agent-graph/verification.json"),JSON.stringify(manifest));
 const id=await launch(s,graph,"fixture:contract-own-node",{phaseTimeoutMs:15000,idleTimeoutMs:10000,toolTimeoutMs:10000,phaseRecoveryBudgetMs:30000});
 const done=await wait(()=>s.store.readSession(id),"SUCCESS",45000),tests=done.visits.filter(v=>v.nodeId==="test");
 assert.equal(tests.length,2);assert.equal(tests[0]!.verdict,"FAIL");assert.equal(tests[1]!.verdict,"PASS");
 assert.equal(tests[0]!.nodeTestProof,undefined);assert.deepEqual(tests[1]!.nodeTestProof!.scopes[0]!.challenges,["wrong-value"]);
 assert.equal(tests[0]!.attempts.at(-1)!.commands!.find(c=>c.command===nodeTestVerificationCommand())!.exitCode,1);
 assert.equal(tests[1]!.attempts.at(-1)!.commands!.find(c=>c.command===nodeTestVerificationCommand())!.exitCode,0);
 assert.deepEqual(done.processedRequests,[]);assert.equal(done.visits.at(-1)!.verdict,"APPROVED");
});
test("a model-authored contract freezes before test and reaches final approval without operator actions", async t => {
  const s = await setup(); t.after(s.cleanup);
  const id = await launch(s, await contracted(s, false), "fixture:contract-create");
  const done = await wait(() => s.store.readSession(id), "SUCCESS");
  assert.equal(done.verificationContract!.origin, "implementation");
  assert.equal(done.processedRequests.length, 0);
});
test("a claimed JSON PASS cannot hide an actual failing protected assertion", async t => {
  const s = await setup(); t.after(s.cleanup);
  const id = await launch(s, await contracted(s, true, true), "fixture:contract-workflow");
  const done = await wait(() => s.store.readSession(id), "PAUSED");
  assert.ok(done.visits.some(v => v.nodeId === "test" && v.verdict === "FAIL"));
  assert.equal(done.visits.some(v => v.nodeId === "approval"), false);
  assert.ok(done.visits.filter(v => v.nodeId === "test").every(v => v.attempts[0]!.commands![0]!.exitCode === 1));
});
test("every registered check is mandatory even if another check covers all requirement IDs", async t => {
  const s = await setup(); t.after(s.cleanup);
  const id = await launch(s, await contracted(s, true, false, true), "fixture:contract-omit-check");
  const done = await wait(() => s.store.readSession(id), "PAUSED");
  assert.equal(done.visits.some(v => v.nodeId === "approval"), false);
  assert.match(done.statusReason!, /second|한도|예산/);
});
for (const mode of ["fixture:contract-tamper", "fixture:contract-tamper-restore"]) test(`${mode} blocks protected writes before test execution`, async t => {
  const s = await setup(); t.after(s.cleanup);
  const id = await launch(s, await contracted(s), mode);
  let done = await s.store.readSession(id);
  const until = Date.now() + sessionWaitMs;
  while (done.status !== "BLOCKED" && Date.now() < until) { await delay(30); done = await s.store.readSession(id); }
  assert.equal(done.status, "BLOCKED", done.statusReason!);
  assert.match(done.statusReason!, /고정 검증 파일/);
  assert.equal(done.visits.some(v => v.nodeId === "test"), false);
});
test("a missing verification contract returns a bounded implementation repair rather than SUCCESS", async t => {
  const s = await setup(); t.after(s.cleanup);
  const id = await launch(s, await contracted(s, false), "fixture:contract-missing");
  const done = await wait(() => s.store.readSession(id), "PAUSED");
  assert.equal(done.visits.filter(v => v.nodeId === "implementation").length, 2);
  assert.equal(done.visits.some(v => v.nodeId === "approval"), false);
  assert.ok(done.visits.some(v => /검증 계약/.test(v.output)));
});
test("whole-session attempts stop before another call and cannot be renewed by manual resume", async t => {
  const s = await setup(); t.after(s.cleanup);
  const id = await launch(s, await contracted(s), "fixture:contract-workflow", { maxSessionAttempts: 2 });
  const done = await wait(() => s.store.readSession(id), "PAUSED");
  assert.equal(done.visits.reduce((n, v) => n + v.attempts.length, 0), 2);
  assert.match(done.statusReason!, /전체 네이티브 시도 2회/);
  await delay(200);
  const resume = await s.request("POST", `/api/sessions/${id}/actions`, { requestId: randomUUID(), type: "resume" });
  assert.equal(resume.statusCode, 409);
  assert.equal((await s.store.readSession(id)).executionBudget!.deadlineAt, done.executionBudget!.deadlineAt);
});
test("whole-session wall time terminates continuous native progress and persists across automatic reconciliation", async t => {
  const s = await setup(); t.after(s.cleanup);
  const id = await launch(s, await minimal(s), "fixture:progress-budget-once", { sessionTimeoutMs: process.platform === "win32" ? 4500 : 1200, phaseTimeoutMs: 10000, phaseRecoveryBudgetMs: 12000, idleTimeoutMs: 5000, maxAutomaticRecoveryCycles: 1 });
  const done = await wait(() => s.store.readSession(id), "PAUSED");
  assert.match(done.statusReason!, /전체 실행 시간 예산/);
  assert.equal(done.automaticRecovery, null);
  assert.equal(done.visits.flatMap(v => v.attempts).some(a => a.pid !== null), false);
  const attempts = done.visits.flatMap(v => v.attempts).length;
  await s.store.mutateSession(id, state => { state.status = "RECOVERING"; state.automaticRecovery = { count: 1, resumeAt: new Date(0).toISOString() }; });
  await delay(100);
  await (s.coordinator as unknown as { reconcile(): Promise<void> }).reconcile();
  const reconciled = await s.store.readSession(id);
  assert.equal(reconciled.status, "PAUSED");
  assert.equal(reconciled.visits.flatMap(v => v.attempts).length, attempts);
  assert.equal(reconciled.automaticRecovery, null);
});

test("a free provider cannot schedule another recovery after the global native-attempt cap", async t => {
  const s = await setup(true); t.after(s.cleanup);
  await setModelPricing(s, { isFree: true });
  const id = await launch(s, await minimal(s), "fixture:network", { maxSessionAttempts: 1, maxAutomaticRecoveryCycles: 3 });
  const done = await wait(() => s.store.readSession(id), "PAUSED");
  assert.match(done.statusReason!, /전체 네이티브 시도 1회/);
  assert.equal(done.automaticRecovery, null);
  assert.equal(done.visits.flatMap(v => v.attempts).length, 1);
  await delay(1100);
  assert.equal((await s.store.readSession(id)).visits.flatMap(v => v.attempts).length, 1);
});
test("an invalid supplied contract is rejected before any agent CLI is invoked", async t => {
  const s = await setup(); t.after(s.cleanup);
  const graph = await contracted(s);
  await fs.writeFile(path.join(s.target, ".agent-graph/verification.json"), "{invalid");
  const response = await s.request("POST", "/api/sessions", { requestId: randomUUID(), graphId: graph.id, expectedRevision: graph.revision, goal: "fixture:contract-workflow", targetProjectPath: s.target, settings: quickSettings });
  assert.equal(response.statusCode, 400, response.body);
  assert.match(response.body, /검증 계약/);
  assert.equal((await s.store.sessions()).length, 0);
  await assert.rejects(fs.access(path.join(s.target, "artifact.txt")));
});

test("the whole-session deadline also cancels model-catalog preflight without an agent call", async t => {
  const s = await setup(); t.after(s.cleanup);
  await fs.writeFile(path.join(s.target, ".fixture-slow-query"), "hold metadata request");
  const id = await launch(s, await minimal(s), "preflight global deadline", { sessionTimeoutMs: process.platform === "win32" ? 4500 : 1200 });
  const done = await wait(() => s.store.readSession(id), "PAUSED");
  assert.match(done.statusReason!, /전체 실행 시간 예산/);
  assert.equal(done.visits.length, 0);
  const pid = Number(await fs.readFile(path.join(s.target, ".fixture-query-pid"), "utf8"));
  const { checkProcessLiveness } = await import("../core/resilience.js");
  assert.equal(checkProcessLiveness(pid), "dead");
});

test("unchanged approval waits expire under the original wall-clock budget without another agent call", async t => {
  const s = await setup(true); t.after(s.cleanup);
  const id = await launch(s, s.graph, "approval wait global deadline", { sessionTimeoutMs: process.platform === "win32" ? 4500 : 1200 });
  const held = await wait(() => s.store.readSession(id), "WAITING_USER");
  assert.ok(held.pendingApproval);
  const done = await wait(() => s.store.readSession(id), "PAUSED");
  assert.match(done.statusReason!, /전체 실행 시간 예산/);
  assert.equal(done.pendingApproval, null);
  assert.equal(done.pendingAccess, null);
  assert.equal(done.visits.flatMap(v => v.attempts).length, held.visits.flatMap(v => v.attempts).length);
});

test("masked npm scripts return to implementation and repair autonomously without weakening the frozen tests", async t => {
  const s = await setup(); t.after(s.cleanup);
  const graph = await contracted(s), file = path.join(s.target, ".agent-graph/verification.json");
  const manifest = JSON.parse(await fs.readFile(file, "utf8"));
  manifest.checks.push({ id: "node", command: "npm test", requirements: ["REQ-001"] });
  await fs.writeFile(file, JSON.stringify(manifest));
  const id = await launch(s, graph, "fixture:contract-runner-repair");
  const done = await wait(() => s.store.readSession(id), "SUCCESS");
  assert.equal(done.processedRequests.length, 0);
  assert.deepEqual(done.visits.map(v => v.nodeId), ["planning","implementation","test","implementation","test","review","approval"]);
  assert.match(done.visits[2]!.output, /마스킹/);
  assert.equal(done.visits[2]!.attempts.length, 0, "a bad runner does not spend a test-agent call");
  assert.ok(done.visits[4]!.attempts[0]!.commands!.some(c => c.command === "npm test" && c.exitCode === 0));
});

test("same-target cd commands retain native receipts through JSON binding and the final success gate", async t => {
  const s = await setup(); t.after(s.cleanup);
  const id = await launch(s, await contracted(s), "fixture:contract-cwd");
  const done = await wait(() => s.store.readSession(id), "SUCCESS");
  assert.equal(done.processedRequests.length, 0);
  assert.ok(done.visits.find(v=>v.nodeId==="test")!.verifiedCommands!.every(c=>c.command.startsWith("cd ")&&c.exitCode===0));
  assert.match(done.visits.at(-1)!.output,/CHECK_COMMAND: cd /);
});

test("autonomous plans repair unrequested external paths before asking an operator for access", async t => {
 const s=await setup();t.after(s.cleanup);
 const id=await launch(s,await contracted(s),"fixture:plan-external-once",{maxAgentAttempts:2,phaseRecoveryBudgetMs:7000});
 const done=await wait(()=>s.store.readSession(id),"SUCCESS");
 assert.equal(done.pendingAccess,null);assert.equal(done.processedRequests.length,0);assert.equal(done.visits[0]!.attempts.length,2);assert.match(done.visits[0]!.attempts[0]!.message!,/목표가 요청하지 않은 외부 경로/);
});
test("unrequested external plans exhaust bounded recovery without granting access or starting implementation", async t => {
 const s=await setup();t.after(s.cleanup);
 const id=await launch(s,await contracted(s),"fixture:plan-external-always",{maxAgentAttempts:2,phaseRecoveryBudgetMs:7000});
 const done=await wait(()=>s.store.readSession(id),"PAUSED");assert.equal(done.pendingAccess,null);assert.equal(done.visits.length,1);assert.equal(done.visits[0]!.attempts.length,2);
});
test("an explicit original-goal external path retains its access approval gate in autonomous mode", async t => {
 const s=await setup();t.after(s.cleanup);
 let graph=await s.store.createGraph({template:"autonomous"});graph.automation!.verificationContract=false;graph.automation!.browserVerification=false;graph.defaultBinding=s.graph.defaultBinding;graph=await s.store.saveGraph(graph.id,graph,graph.revision);
 const id=await launch(s,graph,"Build an artifact using FILE_ACCESS: /tmp/requested-reference.txt");
 const held=await wait(()=>s.store.readSession(id),"WAITING_USER");assert.deepEqual(held.pendingAccess!.paths,["/tmp/requested-reference.txt"]);assert.equal(held.visits.find(v=>v.nodeId==="implementation")!.attempts.length,0);
});
