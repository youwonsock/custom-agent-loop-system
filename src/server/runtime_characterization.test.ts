import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "./app";
import { AgentGraphDocument, SessionState } from "../shared/domain";
import { delay } from "../core/resilience";

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
//   evidenceGates   product hash diff for automation without testSourceGuard            this file
//   classifyFailure still names orphaned_process, but no failure reaches it: the supervisor
//                   sets outcome and failureKind together, and evidenceGates stops on that outcome
const origin = "http://127.0.0.1:4317";
const binary = path.resolve(__dirname, "../../../test/fixture_cli.cjs");
const sessionWaitMs = process.platform === "win32" ? 45_000 : 10_000;
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
async function setup(t: { after(fn: () => Promise<unknown>): void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-char-")),
    target = path.join(root, "project");
  await fs.mkdir(target);
  const server = await createServer({
    root,
    origin,
    defaultTarget: target,
    monitor: false,
  });
  t.after(async () => {
    await server.app.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  await server.store.saveConnection({
    id: "fixture",
    label: "Fixture CLI",
    type: "codex",
    binary,
  });
  return { ...server, target };
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
    maxRepairCycles: 1,
    nativeApprovalReview: false,
    browserVerification: true,
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

test("without the test source guard, a hidden test-role product edit is found by hash diff and rejected back to implementation", async (t) => {
  const s = await setup(t);
  const graph = await s.store.createGraph({ template: "autonomous" });
  graph.automation!.verificationContract = false;
  graph.automation!.authoredNodeTests = false;
  graph.automation!.browserVerification = false;
  graph.automation!.testSourceGuard = false;
  const state = await settle(
    s,
    await start(s, graph, "fixture:auto-source-edit build the app"),
  );
  const tests = state.visits.filter((v) => v.nodeId === "test");
  assert.ok(tests.length >= 1);
  const first = tests[0]!;
  assert.equal(first.attempts.length, 1);
  assert.equal(
    first.attempts[0]!.fileMutation,
    true,
    "the product hash diff must mark the attempt as mutating",
  );
  assert.ok(
    (await fs.readFile(path.join(s.target, "styles.css"), "utf8")).includes(
      "unexpected test-role production edit",
    ),
  );
  assert.match(
    first.output,
    /\[ORCHESTRATOR\] 테스트 역할의 제품 파일 변경을 반려했습니다: styles\.css/,
  );
  // Observed on the current runtime; a change here is a behaviour change, not a refactor.
  // The rejected visit keeps its own receipt; the following implementation visit invalidates it.
  assert.deepEqual(
    {
      status: state.status,
      visits: state.visits.map((v) => ({
        node: v.nodeId,
        status: v.status,
        verdict: v.verdict,
        mutation: v.attempts.map((a) => a.fileMutation ?? false),
        receipts: (v.verifiedCommands ?? []).map((c) => c.command),
      })),
    },
    {
      status: "SUCCESS",
      visits: [
        {
          node: "planning",
          status: "succeeded",
          verdict: null,
          mutation: [false],
          receipts: [],
        },
        {
          node: "implementation",
          status: "succeeded",
          verdict: null,
          mutation: [false],
          receipts: [],
        },
        {
          node: "test",
          status: "failed",
          verdict: "FAIL",
          mutation: [true],
          receipts: ["node --test acceptance.test.cjs"],
        },
        {
          node: "implementation",
          status: "succeeded",
          verdict: null,
          mutation: [false],
          receipts: [],
        },
        {
          node: "test",
          status: "succeeded",
          verdict: "PASS",
          mutation: [false],
          receipts: ["node --test acceptance.test.cjs"],
        },
        {
          node: "review",
          status: "succeeded",
          verdict: "APPROVED",
          mutation: [false],
          receipts: [],
        },
        {
          node: "approval",
          status: "succeeded",
          verdict: "APPROVED",
          mutation: [false],
          receipts: [],
        },
      ],
    },
  );
});

function lightAutonomous(graph: AgentGraphDocument, sourceGuard: boolean) {
  graph.automation!.verificationContract = false;
  graph.automation!.authoredNodeTests = false;
  graph.automation!.browserVerification = false;
  graph.automation!.testSourceGuard = sourceGuard;
}
const attemptsOf = (state: SessionState, node: string) =>
  state.visits
    .filter((v) => v.nodeId === node)
    .flatMap((v) => v.attempts)
    .map((a) => ({
      mutation: a.fileMutation ?? false,
      failure: a.failureKind ?? null,
    }));

for (const [role, sourceGuard] of [
  ["planning", true],
  ["planning", false],
  ["review", false],
  ["approval", false],
] as const)
  test(`${role} with the source guard ${sourceGuard ? "on" : "off"} is rejected for a file change no event shows`, async (t) => {
    const s = await setup(t);
    const graph = await s.store.createGraph({ template: "autonomous" });
    lightAutonomous(graph, sourceGuard);
    const state = await settle(
      s,
      await start(s, graph, `fixture:${role}-hidden-edit build the app`),
    );
    assert.deepEqual(attemptsOf(state, role)[0], {
      mutation: true,
      failure: "role_violation",
    });
  });

test("a read-only role without a hidden change is not flagged", async (t) => {
  const s = await setup(t);
  const graph = await s.store.createGraph({ template: "autonomous" });
  lightAutonomous(graph, false);
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
    const graph = await s.store.createGraph({ template: "autonomous" });
    lightAutonomous(graph, true);
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
