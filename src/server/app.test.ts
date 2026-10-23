import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "./app";
import { AgentGraphDocument, SessionState } from "../shared/domain";
import { delay } from "../core/resilience";
const origin = "http://127.0.0.1:4317",
  host = "127.0.0.1:4317",
  binary = path.resolve(__dirname, "../../../test/fixture_cli.cjs");
// ConPTY drains output for about a second per role before reporting process exit.
const sessionWaitMs = process.platform === "win32" ? 20_000 : 10_000;
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
  let g = s.graph;
  g.nodes = g.nodes.filter((n) =>
    ["implementation", "interrupt"].includes(n.id),
  );
  g.edges = g.edges
    .filter((e) => g.nodes.some((n) => n.id === e.source))
    .map((e) =>
      e.source === "implementation" && e.outcome === "success"
        ? { ...e, target: "SUCCESS" }
        : e,
    );
  g.entrypoints = {
    start: "implementation",
    reentry: "implementation",
    interrupt: "interrupt",
    cycleCompletion: "implementation",
  };
  g = await s.store.saveGraph(g.id, g, g.revision);
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
    ["implementation", "interrupt"].includes(n.id),
  );
  g.edges = g.edges
    .filter((e) => g.nodes.some((n) => n.id === e.source))
    .map((e) =>
      e.source === "implementation" && e.outcome === "success"
        ? { ...e, target: "SUCCESS" }
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
  const id = await launch(s, graph, "fixture:evidence-typo-once", { maxAgentAttempts: 2, phaseRecoveryBudgetMs: 7000 });
  const state = await wait(() => s.store.readSession(id), "SUCCESS");
  assert.equal(state.visits.filter(v => v.nodeId === "implementation").length, 1);
  for (const nodeId of ["test", "review", "approval"]) {
    const visit = state.visits.find(v => v.nodeId === nodeId)!;
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
  assert.equal(state.visits.filter(v => v.nodeId === "implementation").length, 1);
  assert.equal(state.visits.find(v => v.id === visit.id)!.attempts.length, 2);
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
  assert.equal(state.visits.length, 1);
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
  await s.store.saveConnection({ id: "fixture", label: "Fixture Kilo", type: "kilo", binary });
  const graph = await minimal(s);
  graph.defaultBinding = { connectionId: "fixture", modelId: "fixture/fixture-model" };
  const saved = await s.store.saveGraph(graph.id, graph, graph.revision);
  const id = await launch(s, saved, "fixture:tool-arguments-once", { maxAgentAttempts: 2, phaseRecoveryBudgetMs: 7000 });
  const state = await wait(() => s.store.readSession(id), "SUCCESS");
  const attempts = state.visits[0]!.attempts;
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0]!.failureKind, "tool_arguments");
  assert.equal(attempts[1]!.reconnectUsed, false);
  assert.ok(attempts.every(a => a.requestedModelId === "fixture/fixture-model"));
});
test("token-free transport exhaustion schedules recovery then resumes automatically", async (t) => {
  const s = await setup(true);
  t.after(s.cleanup);
  const graph = await minimal(s),
    id = await launch(s, graph, "fixture:network-once", {
      maxAutomaticRecoveryCycles: 1,
      automaticRecoveryBackoffMs: [100],
    });
  const recovering = await wait(() => s.store.readSession(id), "RECOVERING");
  assert.equal(recovering.automaticRecovery?.count, 1);
  const state = await wait(() => s.store.readSession(id), "SUCCESS");
  assert.equal(state.visits.length, 1);
  assert.equal(state.visits[0]!.attempts.length, 2);
});
test("observed model spend pauses instead of scheduling a new automatic cycle", async (t) => {
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
  assert.equal(state.visits.length, 1);
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
  assert.equal(state.visits.length, 1);
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
