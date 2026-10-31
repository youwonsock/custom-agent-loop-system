import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { delay } from "../core/resilience";
import { nodeTestVerificationCommand } from "../core/node_test_command";
import {
  sessionWaitMs,
  quickSettings,
  setup,
  wait,
  minimal,
  launch,
  setModelPricing,
  contracted,
} from "./app_harness.test";

test("supplied frozen contract executes a real protected assertion and JSON reports through final approval", async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const graph = await contracted(s),
    id = await launch(s, graph, "fixture:contract-workflow");
  const done = await wait(() => s.store.readSession(id), "SUCCESS");
  assert.equal(done.verificationContract!.origin, "supplied");
  assert.equal(done.verificationContract!.status, "locked");
  assert.equal(done.pendingApproval, null);
  assert.equal(done.processedRequests.length, 0);
  assert.deepEqual(
    done.visits.map((v) => v.nodeId),
    ["planning", "implementation", "test", "review", "approval"],
  );
  assert.ok(
    done.visits
      .slice(2)
      .every((v) => v.output.includes("[REPORT_PROTOCOL: json-v1]")),
  );
  assert.equal(done.visits[2]!.attempts[0]!.commands![0]!.exitCode, 0);
  assert.equal(done.visits.at(-1)!.verdict, "APPROVED");
});
test("redirected HTTP permission failure waits once without product repair and resumes a fresh check after environment recovery", async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const graph = await contracted(s),
    file = path.join(s.target, ".agent-graph/verification.json"),
    manifest = JSON.parse(await fs.readFile(file, "utf8"));
  manifest.checks[0].command =
    "node tests/verify-acceptance.mjs > verification/model-tests.txt 2>&1";
  await fs.writeFile(file, JSON.stringify(manifest));
  const check =
    "import fs from 'node:fs';import assert from 'node:assert/strict';if(!fs.existsSync('verification/environment-ready')){console.error('Error: listen EPERM: synthetic native bind denial');process.exit(1)}assert.equal(fs.readFileSync('artifact.txt','utf8'),'implemented goal\\n');";
  await fs.writeFile(path.join(s.target, "tests/verify-acceptance.mjs"), check);
  const id = await launch(s, graph, "fixture:contract-captured-environment"),
    blocked = await wait(() => s.store.readSession(id), "WAITING_USER");
  assert.equal(
    blocked.visits.filter((v) => v.nodeId === "implementation").length,
    1,
  );
  assert.equal(blocked.visits.filter((v) => v.nodeId === "test").length, 1);
  assert.equal(blocked.automaticRecovery, null);
  assert.match(blocked.statusReason!, /listen EPERM/);
  const testVisit = blocked.visits.at(-1)!,
    attempt = testVisit.attempts[0]!;
  assert.equal(attempt.commands![0]!.exitCode, 1);
  assert.match(
    attempt.commands![0]!.environmentError!,
    /capture verification\/model-tests.txt; sha256/,
  );
  assert.equal(attempt.failureKind, "permission");
  assert.equal(attempt.completionAccepted, false);
  assert.deepEqual(testVisit.verifiedCommands, []);
  await delay(150);
  assert.equal(
    (await s.store.readSession(id)).visits.length,
    blocked.visits.length,
  );
  await fs.writeFile(
    path.join(s.target, "verification/environment-ready"),
    "external fixture recovered",
  );
  await delay(150);
  const resumed = await s.request("POST", `/api/sessions/${id}/actions`, {
    requestId: randomUUID(),
    type: "resume",
  });
  assert.equal(resumed.statusCode, 200);
  const done = await wait(() => s.store.readSession(id), "SUCCESS"),
    tests = done.visits.filter((v) => v.nodeId === "test");
  assert.equal(tests.length, 1);
  assert.equal(tests[0]!.id, testVisit.id);
  assert.equal(tests[0]!.attempts.length, 2);
  assert.equal(tests[0]!.attempts[1]!.commands![0]!.exitCode, 0);
  assert.equal(
    done.executionBudget!.deadlineAt,
    blocked.executionBudget!.deadlineAt,
  );
  assert.equal(
    await fs.readFile(
      path.join(s.target, "tests/verify-acceptance.mjs"),
      "utf8",
    ),
    check,
  );
  const archive = attempt.logPath.replace(/\.log$/, "-captures"),
    entry = JSON.parse(
      (await fs.readFile(path.join(archive, "index.jsonl"), "utf8")).trim(),
    );
  assert.equal(entry.exitCode, 1);
  assert.match(
    await fs.readFile(path.join(archive, entry.file), "utf8"),
    /listen EPERM/,
  );
});
test("an implementation JSON external BLOCKED with PHASE_DONE never advances into repeated testing", async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const id = await launch(
      s,
      await contracted(s),
      "fixture:contract-implementation-external",
    ),
    done = await wait(() => s.store.readSession(id), "WAITING_USER");
  assert.equal(
    done.visits.filter((v) => v.nodeId === "implementation").length,
    1,
  );
  assert.equal(
    done.visits.some((v) => v.nodeId === "test"),
    false,
  );
  assert.equal(done.visits.at(-1)!.attempts[0]!.completionAccepted, false);
  assert.equal(done.automaticRecovery, null);
  assert.match(done.statusReason!, /listen EPERM/);
});
for (const startAtTest of [false, true])
  test(`missing README is repaired only in implementation before a fresh test/review/approval cycle (test entry ${startAtTest})`, async (t) => {
    const s = await setup();
    t.after(s.cleanup);
    let graph = await contracted(s);
    const file = path.join(s.target, ".agent-graph/verification.json"),
      manifest = JSON.parse(await fs.readFile(file, "utf8"));
    manifest.requiredFiles = [{ path: "README.md", requirements: ["REQ-001"] }];
    const frozen = JSON.stringify(manifest);
    await fs.writeFile(file, frozen);
    if (startAtTest) {
      graph.entrypoints.start = "test";
      graph.edges.find(
        (e) => e.source === "test" && e.outcome === "failure",
      )!.target = "planning";
      graph = await s.store.saveGraph(graph.id, graph, graph.revision);
    }
    const id = await launch(s, graph, "fixture:contract-required-files");
    const done = await wait(() => s.store.readSession(id), "SUCCESS");
    const implementation = done.visits.find(
      (v) => v.nodeId === "implementation",
    )!;
    assert.equal(implementation.attempts.length, 2);
    assert.equal(implementation.attempts[0]!.completionAccepted, false);
    assert.match(implementation.attempts[0]!.message!, /README.md.*REQ-001/);
    assert.equal(implementation.attempts[1]!.completionAccepted, true);
    const tests = done.visits.filter((v) => v.nodeId === "test");
    assert.equal(tests.length, startAtTest ? 2 : 1);
    if (startAtTest) {
      assert.equal(tests[0]!.attempts.length, 0);
      assert.equal(tests[0]!.verdict, "FAIL");
      assert.match(tests[0]!.output, /Implementation must create/);
    }
    assert.equal(tests.at(-1)!.verdict, "PASS");
    assert.equal(done.visits.at(-1)!.verdict, "APPROVED");
    assert.ok(
      done.visits.some(
        (v) => v.nodeId === "review" && v.verdict === "APPROVED",
      ),
    );
    assert.deepEqual(done.processedRequests, []);
    assert.equal(await fs.readFile(file, "utf8"), frozen);
    assert.match(
      await fs.readFile(path.join(s.target, "README.md"), "utf8"),
      /Launch.*Rules.*Tests/,
    );
  });
test("an unrepaired README exhausts bounded completion recovery without invoking test or approval", async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const graph = await contracted(s);
  const file = path.join(s.target, ".agent-graph/verification.json"),
    manifest = JSON.parse(await fs.readFile(file, "utf8"));
  manifest.requiredFiles = [{ path: "README.md", requirements: ["REQ-001"] }];
  await fs.writeFile(file, JSON.stringify(manifest));
  const id = await launch(s, graph, "fixture:contract-required-files-never"),
    done = await wait(() => s.store.readSession(id), "PAUSED");
  assert.equal(
    done.visits.some((v) => ["test", "review", "approval"].includes(v.nodeId)),
    false,
  );
  assert.ok(
    done.visits
      .find((v) => v.nodeId === "implementation")!
      .attempts.every((a) => a.completionAccepted === false),
  );
  await assert.rejects(fs.access(path.join(s.target, "README.md")));
  assert.deepEqual(done.processedRequests, []);
});
test("review and final approval cannot claim to inspect README without native read evidence", async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const graph = await contracted(s);
  const file = path.join(s.target, ".agent-graph/verification.json"),
    manifest = JSON.parse(await fs.readFile(file, "utf8"));
  manifest.requiredFiles = [{ path: "README.md", requirements: ["REQ-001"] }];
  await fs.writeFile(file, JSON.stringify(manifest));
  const id = await launch(s, graph, "fixture:contract-required-files-unread"),
    done = await wait(() => s.store.readSession(id), "SUCCESS");
  for (const type of ["review", "approval"]) {
    const visit = done.visits.find((v) => v.nodeId === type)!;
    assert.equal(visit.attempts.length, 2);
    assert.match(visit.attempts[0]!.message!, /README.md/);
    assert.equal(visit.attempts[0]!.completionAccepted, false);
    assert.ok(visit.attempts[1]!.readFiles!.includes("README.md"));
  }
  assert.equal(done.visits.filter((v) => v.nodeId === "test").length, 1);
  assert.deepEqual(done.processedRequests, []);
});
test("autonomous HTTP root mapping plans proceed without a false outside-root recovery or operator access", async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const graph = await contracted(s),
    id = await launch(
      s,
      graph,
      "fixture:contract-workflow fixture:plan-http-root",
    );
  const done = await wait(() => s.store.readSession(id), "SUCCESS"),
    planning = done.visits.find((v) => v.nodeId === "planning")!;
  assert.equal(planning.attempts.length, 1);
  assert.equal(planning.status, "succeeded");
  assert.equal(done.pendingAccess, null);
  assert.deepEqual(done.processedRequests, []);
});
test("own Node quality rejects empty assertions despite claimed PASS and repairs before independent final approval", async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  let graph = await s.store.createGraph({ template: "autonomous" });
  graph.automation!.browserVerification = false;
  graph.automation!.maxRepairCycles = 1;
  graph.defaultBinding = s.graph.defaultBinding;
  graph = await s.store.saveGraph(graph.id, graph, graph.revision);
  await fs.mkdir(path.join(s.target, ".agent-graph"));
  await fs.mkdir(path.join(s.target, "probes"));
  await fs.writeFile(
    path.join(s.target, "value.mjs"),
    "export const value=1;\n",
  );
  await fs.writeFile(
    path.join(s.target, "package.json"),
    JSON.stringify({
      type: "module",
      scripts: { test: "node --test --test-concurrency=1 test/value.test.mjs" },
    }),
  );
  await fs.writeFile(
    path.join(s.target, "probes/verify-value.mjs"),
    "export async function mutate({enabled}){return {'value.mjs':'export const value='+(enabled?2:1)+';'}}",
  );
  const manifest = {
    version: 1,
    protectedFiles: ["probes/verify-value.mjs"],
    checks: [
      { id: "node", command: "npm test", requirements: ["REQ-001"] },
      {
        id: "quality",
        command: nodeTestVerificationCommand(),
        requirements: ["REQ-001"],
      },
    ],
    nodeTests: {
      checkId: "quality",
      suiteCheckId: "node",
      scopes: [
        {
          id: "value",
          file: "test/value.test.mjs",
          requirements: ["REQ-001"],
          cases: ["value:correct"],
          challenges: [
            {
              id: "wrong-value",
              adapter: "probes/verify-value.mjs",
              targets: ["value.mjs"],
            },
          ],
        },
      ],
    },
  };
  await fs.writeFile(
    path.join(s.target, ".agent-graph/verification.json"),
    JSON.stringify(manifest),
  );
  const id = await launch(s, graph, "fixture:contract-own-node", {
    phaseTimeoutMs: 15000,
    idleTimeoutMs: 10000,
    toolTimeoutMs: 10000,
    phaseRecoveryBudgetMs: 30000,
  });
  const done = await wait(() => s.store.readSession(id), "SUCCESS", 45000),
    tests = done.visits.filter((v) => v.nodeId === "test");
  assert.equal(tests.length, 2);
  assert.equal(tests[0]!.verdict, "FAIL");
  assert.equal(tests[1]!.verdict, "PASS");
  assert.equal(tests[0]!.nodeTestProof, undefined);
  assert.deepEqual(tests[1]!.nodeTestProof!.scopes[0]!.challenges, [
    "wrong-value",
  ]);
  assert.equal(
    tests[0]!.attempts
      .at(-1)!
      .commands!.find((c) => c.command === nodeTestVerificationCommand())!
      .exitCode,
    1,
  );
  assert.equal(
    tests[1]!.attempts
      .at(-1)!
      .commands!.find((c) => c.command === nodeTestVerificationCommand())!
      .exitCode,
    0,
  );
  assert.deepEqual(done.processedRequests, []);
  assert.equal(done.visits.at(-1)!.verdict, "APPROVED");
});
test("a model-authored contract freezes before test and reaches final approval without operator actions", async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const id = await launch(
    s,
    await contracted(s, false),
    "fixture:contract-create",
  );
  const done = await wait(() => s.store.readSession(id), "SUCCESS");
  assert.equal(done.verificationContract!.origin, "implementation");
  assert.equal(done.processedRequests.length, 0);
});
test("a claimed JSON PASS cannot hide an actual failing protected assertion", async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const id = await launch(
    s,
    await contracted(s, true, true),
    "fixture:contract-workflow",
  );
  const done = await wait(() => s.store.readSession(id), "PAUSED");
  assert.ok(
    done.visits.some((v) => v.nodeId === "test" && v.verdict === "FAIL"),
  );
  assert.equal(
    done.visits.some((v) => v.nodeId === "approval"),
    false,
  );
  assert.ok(
    done.visits
      .filter((v) => v.nodeId === "test")
      .every((v) => v.attempts[0]!.commands![0]!.exitCode === 1),
  );
});
test("every registered check is mandatory even if another check covers all requirement IDs", async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const id = await launch(
    s,
    await contracted(s, true, false, true),
    "fixture:contract-omit-check",
  );
  const done = await wait(() => s.store.readSession(id), "PAUSED");
  assert.equal(
    done.visits.some((v) => v.nodeId === "approval"),
    false,
  );
  assert.match(done.statusReason!, /second|한도|예산/);
});
for (const mode of [
  "fixture:contract-tamper",
  "fixture:contract-tamper-restore",
])
  test(`${mode} blocks protected writes before test execution`, async (t) => {
    const s = await setup();
    t.after(s.cleanup);
    const id = await launch(s, await contracted(s), mode);
    let done = await s.store.readSession(id);
    const until = Date.now() + sessionWaitMs;
    while (done.status !== "BLOCKED" && Date.now() < until) {
      await delay(30);
      done = await s.store.readSession(id);
    }
    assert.equal(done.status, "BLOCKED", done.statusReason!);
    assert.match(done.statusReason!, /고정 검증 파일/);
    assert.equal(
      done.visits.some((v) => v.nodeId === "test"),
      false,
    );
  });
test("a missing verification contract returns a bounded implementation repair rather than SUCCESS", async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const id = await launch(
    s,
    await contracted(s, false),
    "fixture:contract-missing",
  );
  const done = await wait(() => s.store.readSession(id), "PAUSED");
  assert.equal(
    done.visits.filter((v) => v.nodeId === "implementation").length,
    2,
  );
  assert.equal(
    done.visits.some((v) => v.nodeId === "approval"),
    false,
  );
  assert.ok(done.visits.some((v) => /검증 계약/.test(v.output)));
});
test("whole-session attempts stop before another call and cannot be renewed by manual resume", async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const id = await launch(s, await contracted(s), "fixture:contract-workflow", {
    maxSessionAttempts: 2,
  });
  const done = await wait(() => s.store.readSession(id), "PAUSED");
  assert.equal(
    done.visits.reduce((n, v) => n + v.attempts.length, 0),
    2,
  );
  assert.match(done.statusReason!, /전체 네이티브 시도 2회/);
  await delay(200);
  const resume = await s.request("POST", `/api/sessions/${id}/actions`, {
    requestId: randomUUID(),
    type: "resume",
  });
  assert.equal(resume.statusCode, 409);
  assert.equal(
    (await s.store.readSession(id)).executionBudget!.deadlineAt,
    done.executionBudget!.deadlineAt,
  );
});
test("whole-session wall time terminates continuous native progress and persists across automatic reconciliation", async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const id = await launch(s, await minimal(s), "fixture:progress-budget-once", {
    sessionTimeoutMs: process.platform === "win32" ? 4500 : 1200,
    phaseTimeoutMs: 10000,
    phaseRecoveryBudgetMs: 12000,
    idleTimeoutMs: 5000,
    maxAutomaticRecoveryCycles: 1,
  });
  const done = await wait(() => s.store.readSession(id), "PAUSED");
  assert.match(done.statusReason!, /전체 실행 시간 예산/);
  assert.equal(done.automaticRecovery, null);
  assert.equal(
    done.visits.flatMap((v) => v.attempts).some((a) => a.pid !== null),
    false,
  );
  const attempts = done.visits.flatMap((v) => v.attempts).length;
  await s.store.mutateSession(id, (state) => {
    state.status = "RECOVERING";
    state.automaticRecovery = { count: 1, resumeAt: new Date(0).toISOString() };
  });
  await delay(100);
  await (
    s.coordinator as unknown as { reconcile(): Promise<void> }
  ).reconcile();
  const reconciled = await s.store.readSession(id);
  assert.equal(reconciled.status, "PAUSED");
  assert.equal(reconciled.visits.flatMap((v) => v.attempts).length, attempts);
  assert.equal(reconciled.automaticRecovery, null);
});

test("a free provider cannot schedule another recovery after the global native-attempt cap", async (t) => {
  const s = await setup(true);
  t.after(s.cleanup);
  await setModelPricing(s, { isFree: true });
  const id = await launch(s, await minimal(s), "fixture:network", {
    maxSessionAttempts: 1,
    maxAutomaticRecoveryCycles: 3,
  });
  const done = await wait(() => s.store.readSession(id), "PAUSED");
  assert.match(done.statusReason!, /전체 네이티브 시도 1회/);
  assert.equal(done.automaticRecovery, null);
  assert.equal(done.visits.flatMap((v) => v.attempts).length, 1);
  await delay(1100);
  assert.equal(
    (await s.store.readSession(id)).visits.flatMap((v) => v.attempts).length,
    1,
  );
});
test("an invalid supplied contract is rejected before any agent CLI is invoked", async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const graph = await contracted(s);
  await fs.writeFile(
    path.join(s.target, ".agent-graph/verification.json"),
    "{invalid",
  );
  const response = await s.request("POST", "/api/sessions", {
    requestId: randomUUID(),
    graphId: graph.id,
    expectedRevision: graph.revision,
    goal: "fixture:contract-workflow",
    targetProjectPath: s.target,
    settings: quickSettings,
  });
  assert.equal(response.statusCode, 400, response.body);
  assert.match(response.body, /검증 계약/);
  assert.equal((await s.store.sessions()).length, 0);
  await assert.rejects(fs.access(path.join(s.target, "artifact.txt")));
});

test("the whole-session deadline also cancels model-catalog preflight without an agent call", async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  await fs.writeFile(
    path.join(s.target, ".fixture-slow-query"),
    "hold metadata request",
  );
  const id = await launch(s, await minimal(s), "preflight global deadline", {
    sessionTimeoutMs: process.platform === "win32" ? 4500 : 1200,
  });
  const done = await wait(() => s.store.readSession(id), "PAUSED");
  assert.match(done.statusReason!, /전체 실행 시간 예산/);
  assert.equal(done.visits.length, 0);
  const pid = Number(
    await fs.readFile(path.join(s.target, ".fixture-query-pid"), "utf8"),
  );
  const { checkProcessLiveness } = await import("../core/resilience.js");
  assert.equal(checkProcessLiveness(pid), "dead");
});

test("unchanged approval waits expire under the original wall-clock budget without another agent call", async (t) => {
  const s = await setup(true);
  t.after(s.cleanup);
  const id = await launch(s, s.graph, "approval wait global deadline", {
    sessionTimeoutMs: process.platform === "win32" ? 4500 : 1200,
  });
  const held = await wait(() => s.store.readSession(id), "WAITING_USER");
  assert.ok(held.pendingApproval);
  const done = await wait(() => s.store.readSession(id), "PAUSED");
  assert.match(done.statusReason!, /전체 실행 시간 예산/);
  assert.equal(done.pendingApproval, null);
  assert.equal(done.pendingAccess, null);
  assert.equal(
    done.visits.flatMap((v) => v.attempts).length,
    held.visits.flatMap((v) => v.attempts).length,
  );
});

test("masked npm scripts return to implementation and repair autonomously without weakening the frozen tests", async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const graph = await contracted(s),
    file = path.join(s.target, ".agent-graph/verification.json");
  const manifest = JSON.parse(await fs.readFile(file, "utf8"));
  manifest.checks.push({
    id: "node",
    command: "npm test",
    requirements: ["REQ-001"],
  });
  await fs.writeFile(file, JSON.stringify(manifest));
  const id = await launch(s, graph, "fixture:contract-runner-repair");
  const done = await wait(() => s.store.readSession(id), "SUCCESS");
  assert.equal(done.processedRequests.length, 0);
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
  assert.match(done.visits[2]!.output, /마스킹/);
  assert.equal(
    done.visits[2]!.attempts.length,
    0,
    "a bad runner does not spend a test-agent call",
  );
  assert.ok(
    done.visits[4]!.attempts[0]!.commands!.some(
      (c) => c.command === "npm test" && c.exitCode === 0,
    ),
  );
});

test("same-target cd commands retain native receipts through JSON binding and the final success gate", async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const id = await launch(s, await contracted(s), "fixture:contract-cwd");
  const done = await wait(() => s.store.readSession(id), "SUCCESS");
  assert.equal(done.processedRequests.length, 0);
  assert.ok(
    done.visits
      .find((v) => v.nodeId === "test")!
      .verifiedCommands!.every(
        (c) => c.command.startsWith("cd ") && c.exitCode === 0,
      ),
  );
  assert.match(done.visits.at(-1)!.output, /CHECK_COMMAND: cd /);
});

test("autonomous plans repair unrequested external paths before asking an operator for access", async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const id = await launch(
    s,
    await contracted(s),
    "fixture:plan-external-once",
    { maxAgentAttempts: 2, phaseRecoveryBudgetMs: 7000 },
  );
  const done = await wait(() => s.store.readSession(id), "SUCCESS");
  assert.equal(done.pendingAccess, null);
  assert.equal(done.processedRequests.length, 0);
  assert.equal(done.visits[0]!.attempts.length, 2);
  assert.match(
    done.visits[0]!.attempts[0]!.message!,
    /목표가 요청하지 않은 외부 경로/,
  );
});
test("unrequested external plans exhaust bounded recovery without granting access or starting implementation", async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  const id = await launch(
    s,
    await contracted(s),
    "fixture:plan-external-always",
    { maxAgentAttempts: 2, phaseRecoveryBudgetMs: 7000 },
  );
  const done = await wait(() => s.store.readSession(id), "PAUSED");
  assert.equal(done.pendingAccess, null);
  assert.equal(done.visits.length, 1);
  assert.equal(done.visits[0]!.attempts.length, 2);
});
test("an explicit original-goal external path retains its access approval gate in autonomous mode", async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  let graph = await s.store.createGraph({ template: "autonomous" });
  graph.automation!.verificationContract = false;
  graph.automation!.authoredNodeTests = false;
  graph.automation!.browserVerification = false;
  graph.defaultBinding = s.graph.defaultBinding;
  graph = await s.store.saveGraph(graph.id, graph, graph.revision);
  const id = await launch(
    s,
    graph,
    "Build an artifact using FILE_ACCESS: /tmp/requested-reference.txt",
  );
  const held = await wait(() => s.store.readSession(id), "WAITING_USER");
  assert.deepEqual(held.pendingAccess!.paths, ["/tmp/requested-reference.txt"]);
  assert.equal(
    held.visits.find((v) => v.nodeId === "implementation")!.attempts.length,
    0,
  );
});
