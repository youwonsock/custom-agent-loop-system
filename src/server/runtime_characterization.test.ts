import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import {
  contracted,
  sessionWaitMs,
  setup as startStudio,
} from "./app_harness.test";
import { AgentGraphDocument, SessionState } from "../shared/domain";
import { autonomousDefaults } from "../shared/graph_defaults";
import { delay } from "../core/session/resilience";

// Characterization of GraphRuntime.execute() exits that the scenario suite in
// app_*.test.ts does not reach. Each case pins the whole resulting session state
// (status, reason, recovery, visit and attempt), not only the status, so a
// halt's side effects cannot change silently. docs/ARCHITECTURE.md lists them.
//
// Exit inventory (GraphRuntime, win32). Measured by injecting probes into the
// built runtime and running the full suite: V8 coverage undercounts worker-process code
// and reported the hash-diff branch as unreached although it runs.
//   preflight       source snapshot, contract lock, runner, deliverables, source read   covered
//   attemptGuards   poll / contract / session budget / stage budget                     poll, stage uncovered
//   execute loop    phase deadline or attempt limit reached before a call               uncovered (time-only)
//   execute loop    IO_UNAVAILABLE -> BLOCKED, visit paused, recovery untouched         this file
//   evidenceGates   orphaned process (uncovered), control request, VM receipts (macOS only),
//                   scope, protected writes, frozen-test policy, stage budget (uncovered)
//   classifyFailure still names orphaned_process, but no failure reaches it: the supervisor
//                   sets outcome and failureKind together, and evidenceGates stops on that outcome
const quickSettings = {
  maxAgentAttempts: 1,
  maxCompletionRecoveryAttempts: 1,
  maxAutomaticRecoveryCycles: 0,
  phaseTimeoutMs: 3000,
  // Stays below phaseTimeoutMs: a slow Windows runner can stall a fixture for a second.
  idleTimeoutMs: process.platform === "win32" ? 2500 : 1000,
  toolTimeoutMs: 1000,
  // A loaded Windows runner can take over a second to get ConPTY and Node talking.
  transportTimeoutMs: process.platform === "win32" ? 3000 : 1000,
  phaseRecoveryBudgetMs: 6000,
  retryBackoffMs: [10, 20],
  terminationGraceMs: 50,
  killTimeoutMs: 1000,
  heartbeatIntervalMs: 100,
  leaseTtlMs: 500,
};
async function setup(t: { after(fn: () => Promise<unknown>): void }) {
  const s = await startStudio();
  t.after(s.cleanup);
  return s;
}
type Server = Awaited<ReturnType<typeof setup>>;
async function start(
  s: Server,
  graph: AgentGraphDocument,
  goal: string,
): Promise<string> {
  graph.defaultBinding = { connectionId: "fixture", modelId: "fixture-model" };
  const saved = await s.store.saveGraph(graph.id, graph, graph.revision);
  const started = await s.coordinator.start({
    requestId: randomUUID(),
    graphId: saved.id,
    expectedRevision: saved.revision,
    goal,
    targetProjectPath: s.target,
    settings: quickSettings,
  });
  return started.id;
}
const settled: SessionState["status"][] = [
  "WAITING_USER",
  "PAUSED",
  "STOPPED",
  "BLOCKED",
  "SUCCESS",
  "FAILED",
];
async function settle(s: Server, id: string): Promise<SessionState> {
  const end = Date.now() + sessionWaitMs;
  for (;;) {
    const state = await s.store.readSession(id);
    if (settled.includes(state.status)) return state;
    if (Date.now() > end)
      throw new Error(`session still ${state.status}: ${state.statusReason}`);
    await delay(30);
  }
}
// Start at implementation, as the scenario suite's minimal graph does.
async function implementationFirst(s: Server): Promise<AgentGraphDocument> {
  const g = (await s.store.graphs())[0]!;
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
  return g;
}

test("an unavailable invocation adapter blocks the session before any attempt is recorded", async (t) => {
  const s = await setup(t);
  // The Codex local HTTP adapter requires a verified CLI version; the fixture reports this one.
  await fs.writeFile(path.join(s.target, ".fixture-codex-version"), "0.100.0");
  const graph = await implementationFirst(s);
  graph.automation = {
    ...autonomousDefaults(false),
    maxRepairCycles: 1,
    authoredNodeTests: false,
    targetScopeGuard: false,
    programIoGuard: false,
  };
  const state = await settle(s, await start(s, graph, "build the app"));
  assert.equal(state.status, "BLOCKED");
  assert.match(
    state.statusReason ?? "",
    /AGENT_GRAPH_IO_UNAVAILABLE.*0\.162\.1/,
  );
  assert.equal(state.automaticRecovery, null);
  assert.equal(state.currentNodeId, "implementation");
  assert.equal(state.visits.length, 1);
  const visit = state.visits[0]!;
  assert.equal(visit.id, state.activeVisitId);
  assert.equal(visit.nodeId, "implementation");
  assert.equal(visit.status, "paused");
  assert.equal(visit.verdict, null);
  assert.equal(visit.completedAt, null);
  assert.deepEqual(
    visit.attempts,
    [],
    "the adapter refusal happens before an attempt record exists",
  );
  await assert.rejects(
    fs.access(path.join(s.target, "artifact.txt")),
    "no model invocation may run",
  );
});

// Autonomous with a supplied contract, so roles report in the frozen JSON format.
async function lightAutonomous(s: Server) {
  const graph = await contracted(s);
  graph.automation!.maxRepairCycles = 5;
  return graph;
}
const attemptsOf = (state: SessionState, node: string) =>
  state.visits
    .filter((v) => v.nodeId === node)
    .flatMap((v) => v.attempts)
    .map((a) => ({
      mutation: a.fileMutation ?? false,
      failure: a.failureKind ?? null,
    }));

test("planning is rejected for a file change no event shows", async (t) => {
  const s = await setup(t);
  const graph = await lightAutonomous(s);
  const state = await settle(
    s,
    await start(s, graph, "fixture:planning-hidden-edit build the app"),
  );
  assert.deepEqual(attemptsOf(state, "planning")[0], {
    mutation: true,
    failure: "role_violation",
  });
});

test("a read-only role without a hidden change is not flagged", async (t) => {
  const s = await setup(t);
  const graph = await lightAutonomous(s);
  const state = await settle(s, await start(s, graph, "build the app"));
  assert.equal(state.status, "SUCCESS", state.statusReason ?? "");
  for (const role of ["planning", "review", "approval"])
    assert.deepEqual(
      attemptsOf(state, role).map((a) => a.mutation),
      [false],
    );
});

test(
  "an unreadable source tree before review returns to verification instead of failing the run",
  { skip: process.platform === "win32" ? "symlinks need a privilege" : false },
  async (t) => {
    const s = await setup(t);
    const graph = await lightAutonomous(s);
    const state = await settle(
      s,
      await start(s, graph, "fixture:review-symlink build the app"),
    );
    assert.notEqual(state.status, "FAILED", state.statusReason ?? "");
    const review = state.visits.find((v) => v.nodeId === "review")!;
    assert.equal(review.verdict, "REJECTED");
    assert.match(review.output, /소스 snapshot 읽기 실패/);
    // The link is still there, so the next test visit stops and asks the user.
    assert.equal(state.status, "WAITING_USER");
    assert.match(state.statusReason ?? "", /소스 읽기가 차단/);
  },
);

test("a command refused by the CLI is named in the failure without changing its kind", async (t) => {
  const s = await setup(t);
  const graph = await implementationFirst(s);
  const state = await settle(
    s,
    await start(s, graph, "fixture:denied-command build the app"),
  );
  const attempt = state.visits.at(-1)!.attempts[0]!;
  assert.equal(attempt.failureKind, "incomplete_response");
  assert.match(attempt.message ?? "", /다음 명령을 거부.*cargo test/);
});
test("a write refused by the CLI waits for the user and says so instead of asking for the format again", async (t) => {
  const s = await setup(t);
  const graph = await implementationFirst(s);
  const state = await settle(
    s,
    await start(s, graph, "fixture:denied-write build the app"),
  );
  assert.equal(state.status, "WAITING_USER");
  assert.match(state.statusReason ?? "", /쓰기 권한을 거부.*artifact\.txt/);
  const [attempt, ...rest] = state.visits.at(-1)!.attempts;
  assert.equal(attempt!.failureKind, "permission");
  assert.deepEqual(rest, []);
});
