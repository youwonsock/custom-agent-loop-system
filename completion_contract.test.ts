import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  boundedAttemptTimeoutMs,
  automaticRecoveryDelayMs,
  classifyExhaustedFailureDisposition,
  classifyAgentFailure,
  cleanupRecoveredChildProcesses,
  findAbsolutePathsOutsideAllowedRoots,
  findAbsolutePathsOutsideTarget,
  materializePlanChoiceMarkdown,
  normalizeLoopState,
  normalizeAdditionalAllowedPaths,
  parseApprovalVerdict,
  parseTesterVerdict,
  shouldStartManualRecoveryCycle,
  summarizeAttemptEvents,
  validateAgentCompletion,
} from "./loop_orchestrator";

function result(assistantText: string, output = assistantText, exitCode = 0): any {
  return {
    pid: 1,
    exitCode,
    output,
    events: [],
    timedOut: false,
    cancelled: false,
    autoInjected: [],
    assistantText,
  };
}

test("completion token must be in assistant text on its own line", () => {
  assert.equal(validateAgentCompletion("implementation", result("done\n[PHASE_DONE]")).valid, true);
  assert.equal(validateAgentCompletion("implementation", result("done", "prompt [PHASE_DONE]")).valid, false);
  assert.equal(validateAgentCompletion("implementation", result("done [PHASE_DONE]")).valid, false);
});

test("supervisor timeout classifications are not overwritten by completion validation", () => {
  const timedOut = result("", "", -1);
  timedOut.failureKind = "transport_timeout";
  timedOut.failureMessage = "No PTY transport output for 120000ms";
  const failure = classifyAgentFailure(timedOut, timedOut.failureMessage);
  assert.equal(failure.kind, "transport_timeout");
  assert.equal(failure.retryable, true);

  const productivePhaseTimeout = result("", "debug coordinates 401 and authentication helper", 1);
  productivePhaseTimeout.failureKind = "phase_timeout";
  productivePhaseTimeout.failureMessage = "Role recovery budget deadline reached";
  const phaseFailure = classifyAgentFailure(
    productivePhaseTimeout,
    productivePhaseTimeout.failureMessage
  );
  assert.equal(phaseFailure.kind, "phase_timeout");
  assert.equal(phaseFailure.retryable, true);

  const completedWithoutSentinel = classifyAgentFailure(
    result("implementation text"),
    "Assistant response did not contain [PHASE_DONE] on its own line."
  );
  assert.equal(completedWithoutSentinel.kind, "incomplete_response");

  const cleanOutputWithStatusNumber = classifyAgentFailure(
    result("implementation text", "UI handles HTTP 401 and 429 states"),
    "Assistant response did not contain [PHASE_DONE] on its own line."
  );
  assert.equal(cleanOutputWithStatusNumber.kind, "incomplete_response");
});

test("attempt evidence retains terminal step reason and peak token usage", () => {
  const attempt = result("");
  attempt.events = [
    { type: "step_finish", part: { reason: "tool-calls", tokens: { total: 100327 } } },
    { type: "step_finish", part: { reason: "unknown", tokens: { input: 0, output: 0 } } },
  ];
  assert.deepEqual(summarizeAttemptEvents(attempt), {
    lastEventType: "step_finish",
    lastToolName: null,
    lastToolStatus: null,
    lastToolCommand: null,
    lastStepFinishReason: "unknown",
    lastStepFinishTotalTokens: null,
    maxObservedTotalTokens: 100327,
  });
});

test("implementation preflight detects absolute paths outside the target project", () => {
  assert.deepEqual(
    findAbsolutePathsOutsideTarget(
      "Write `C:\\Users\\a\\Downloads\\Test\\index.html` and update `C:\\GitRepo\\Haven\\src\\game.ts`.",
      "C:\\GitRepo\\Haven"
    ),
    ["C:\\Users\\a\\Downloads\\Test\\index.html"]
  );
  assert.deepEqual(
    findAbsolutePathsOutsideTarget(
      "Only edit `C:\\GitRepo\\Haven\\src\\game.ts`; it may be opened via file:// or https://localhost.",
      "C:\\GitRepo\\Haven"
    ),
    []
  );
});

test("additional access roots are canonicalized and honored by implementation preflight", () => {
  const target = "C:\\GitRepo\\Haven";
  const additional = normalizeAdditionalAllowedPaths(
    [
      "C:\\Users\\a\\Downloads\\Test\\",
      "c:\\users\\a\\downloads\\test",
      "C:\\GitRepo\\Haven\\generated",
    ],
    target
  );
  assert.deepEqual(additional, ["C:\\Users\\a\\Downloads\\Test"]);
  assert.deepEqual(
    findAbsolutePathsOutsideAllowedRoots(
      "Write `C:\\Users\\a\\Downloads\\Test\\index.html` and `D:\\private\\secret.txt`.",
      target,
      additional
    ),
    ["D:\\private\\secret.txt"]
  );
});

test("planner, tester, and reviewer enforce their contracts", () => {
  const plans =
    "=== PLAN OPTIONS ===\n## OPTION 1: A\nA\n## OPTION 2: B\nB\n## OPTION 3: C\nC\n[PHASE_DONE]";
  assert.equal(validateAgentCompletion("planning", result(plans), 3).valid, true);
  assert.equal(validateAgentCompletion("planning", result(plans), 4).valid, false);
  assert.equal(validateAgentCompletion("test", result("VERDICT: PASS\n[PHASE_DONE]")).valid, true);
  assert.equal(
    validateAgentCompletion(
      "test",
      result("VERDICT: FAIL — Restitution and friction controls are not wired.\n[PHASE_DONE]")
    ).valid,
    true
  );
  assert.equal(
    validateAgentCompletion("test", result("VERDICT: PASS: all checks passed\n[PHASE_DONE]")).valid,
    true
  );
  assert.equal(
    validateAgentCompletion("test", result("VERDICT: FAILURE\n[PHASE_DONE]")).valid,
    false
  );
  assert.equal(validateAgentCompletion("test", result("PASS\n[PHASE_DONE]")).valid, false);
  assert.equal(validateAgentCompletion("review", result("APPROVED\n[PHASE_DONE]")).valid, true);
  assert.equal(
    validateAgentCompletion("review", result("REJECTED — two requirements remain.\n[PHASE_DONE]")).valid,
    true
  );
  assert.equal(validateAgentCompletion("approval", result("APPROVEDNESS\n[PHASE_DONE]")).valid, false);
});

test("tester verdict parser uses the last independent verdict line and permits a rationale", () => {
  assert.equal(
    parseTesterVerdict(
      "VERDICT: PASS\nInterim result changed after focused tests.\nVERDICT: FAIL — two live controls are disconnected."
    ),
    "FAIL"
  );
  assert.equal(parseTesterVerdict("The tester wrote VERDICT: PASS in prose."), null);
  assert.equal(parseTesterVerdict("VERDICT: PASSING"), null);
});

test("approval parser uses the last independent decision line and permits a rationale", () => {
  assert.equal(
    parseApprovalVerdict("APPROVED: provisional\nEvidence changed.\nREJECTED — acceptance test failed."),
    "REJECTED"
  );
  assert.equal(parseApprovalVerdict("The reviewer said APPROVED in prose."), null);
  assert.equal(parseApprovalVerdict("REJECTEDNESS"), null);
});

test("planning materializes a full overview and one markdown document per option", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-loop-plan-docs-"));
  try {
    const materialized = await materializePlanChoiceMarkdown(tempRoot, [
      { id: 1, title: "Safe migration", body: "## Steps\n\n1. Preserve behavior." },
      { id: 2, title: "Focused rewrite", body: "## Steps\n\n1. Replace the module." },
      { id: 3, title: "Incremental split", body: "## Steps\n\n1. Extract boundaries." },
    ]);

    assert.equal(materialized.choices.length, 3);
    assert.equal(materialized.choices[0].markdownPath, path.join("plan_options", "option_1.md"));
    const overview = await fs.readFile(materialized.overviewPath, "utf8");
    assert.match(overview, /# Plan Options/);
    assert.match(overview, /## Option 1: Safe migration/);
    assert.match(overview, /## Option 2: Focused rewrite/);
    assert.match(overview, /## Option 3: Incremental split/);
    assert.match(overview, /\.\/plan_options\/option_1\.md/);
    const option = await fs.readFile(
      path.join(tempRoot, materialized.choices[2].markdownPath!),
      "utf8"
    );
    assert.match(option, /^# Plan Option 3: Incremental split/m);
    assert.match(option, /Extract boundaries/);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("planning rejects Markdown output paths outside the session directory", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-loop-plan-paths-"));
  try {
    await assert.rejects(
      materializePlanChoiceMarkdown(
        tempRoot,
        [{ id: 1, title: "Unsafe", body: "Do not write this." }],
        path.join("..", "escaped.md")
      ),
      /escapes the session directory/
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("legacy RUNNING state migration is idempotent and blocks without a lease", () => {
  const legacy: any = {
    stateVersion: 1,
    sessionId: "legacy",
    status: "RUNNING",
    phase: "IMPLEMENTATION",
    loopCount: 2,
    cliBinary: "opencode",
    agentStates: {
      planner: { status: "idle", lastExitCode: null, lastRunAt: null },
      implementer: { status: "running", lastExitCode: null, lastRunAt: null },
      tester: { status: "idle", lastExitCode: null, lastRunAt: null },
      qa_lead: { status: "idle", lastExitCode: null, lastRunAt: null },
      master: { status: "idle", lastExitCode: null, lastRunAt: null },
      interrupter: { status: "idle", lastExitCode: null, lastRunAt: null },
    },
  };
  const first = normalizeLoopState(legacy);
  assert.equal(first.migrated, true);
  assert.equal(first.state.status, "BLOCKED");
  assert.equal(first.state.stateVersion, 2);
  assert.deepEqual(first.state.additionalAllowedPaths, []);
  assert.equal(first.state.accessMode, "ask");
  assert.equal(first.state.pendingAccessRequest, null);
  assert.equal(first.state.agentStates.implementer.status, "idle");
  const second = normalizeLoopState(first.state);
  assert.equal(second.migrated, false);
});

test("exhausted failures pause only after observable model spend", () => {
  const failure = (kind: any, retryable = true): any => ({
    kind,
    message: kind,
    retryable,
    occurredAt: new Date().toISOString(),
    attemptId: "attempt-1",
    role: "implementer",
    phase: "IMPLEMENTATION",
    exitCode: 1,
    cliSessionId: null,
  });
  assert.equal(
    classifyExhaustedFailureDisposition(failure("transport_timeout"), [
      { assistantTextBytes: 200, maxObservedTotalTokens: 50 },
    ]),
    "recover_transport"
  );
  assert.equal(
    classifyExhaustedFailureDisposition(failure("idle_timeout"), [
      { assistantTextBytes: 0, maxObservedTotalTokens: null },
    ]),
    "recover_transport"
  );
  assert.equal(
    classifyExhaustedFailureDisposition(failure("incomplete_response"), [
      { assistantTextBytes: 200, maxObservedTotalTokens: 50 },
    ]),
    "pause_stagnation"
  );
  assert.equal(
    classifyExhaustedFailureDisposition(failure("auth", false), []),
    "wait_for_user"
  );
  assert.equal(
    classifyExhaustedFailureDisposition(failure("orphaned_process", false), []),
    "blocked"
  );
});

test("automatic recovery backoff reuses the final configured delay", () => {
  assert.equal(automaticRecoveryDelayMs(1, [60_000, 300_000]), 60_000);
  assert.equal(automaticRecoveryDelayMs(2, [60_000, 300_000]), 300_000);
  assert.equal(automaticRecoveryDelayMs(4, [60_000, 300_000]), 300_000);
});

test("persisted timeout failures mislabeled as auth are normalized on resume", () => {
  const normalized = normalizeLoopState({
    stateVersion: 2,
    sessionId: "timeout-migration",
    status: "PAUSED",
    phase: "INTERRUPT",
    targetProjectPath: process.cwd(),
    lastFailure: {
      kind: "auth",
      message: "Phase exceeded 900000ms",
      retryable: false,
      occurredAt: new Date().toISOString(),
      attemptId: "attempt-1",
      role: "implementer",
      phase: "IMPLEMENTATION",
      exitCode: 1,
      cliSessionId: "session-1",
    },
    agentStates: {},
  } as any);
  assert.equal(normalized.state.lastFailure?.kind, "phase_timeout");
  assert.equal(normalized.state.lastFailure?.retryable, true);
  assert.match(normalized.state.lastFailureDigest ?? "", /classifier error/);
});

test("attempt hard timeout never extends beyond the recovery deadline", () => {
  assert.equal(boundedAttemptTimeoutMs(600_000, 1_000_000, 990_000), 10_000);
  assert.equal(boundedAttemptTimeoutMs(600_000, 2_000_000, 1_000_000), 600_000);
  assert.equal(boundedAttemptTimeoutMs(600_000, 1_000_000, 1_000_001), 0);
});

test("recovery blocks when any persisted child PID cannot be confirmed dead", async () => {
  const terminated: number[] = [];
  const result = await cleanupRecoveredChildProcesses(
    [101, 202],
    5_000,
    {
      currentPid: 999,
      check: (pid) => pid === 101 ? "dead" : "alive",
      terminate: async (pid) => {
        terminated.push(pid);
        return "unknown";
      },
    }
  );
  assert.deepEqual(terminated, [202]);
  assert.equal(result.orphanedPid, 202);
});

test("only manual resume starts a new recovery cycle after an interrupter briefing", () => {
  const state = normalizeLoopState({
    stateVersion: 2,
    status: "PAUSED",
    interruptBriefing: "Attempts exhausted.",
    activeAttempt: {
      status: "succeeded",
    },
  } as any).state;
  assert.equal(shouldStartManualRecoveryCycle(state, false), true);
  assert.equal(shouldStartManualRecoveryCycle(state, true), false);
  state.interruptBriefing = null;
  assert.equal(shouldStartManualRecoveryCycle(state, false), false);
});
