import assert from "node:assert/strict";
import test from "node:test";
import type { PipelineCompletionContract, PipelineStageExecutor } from "./pipeline";
import {
  appendStageOutcome,
  createFailedStageOutcome,
  createStageOutcome,
  observeStructuredStageOutcome,
  structuredDecisionForCompletion,
} from "./stage_outcome";
import type { StageDecision } from "./workflow_contracts";

const cases: Array<{
  contract: PipelineCompletionContract;
  executor: PipelineStageExecutor;
  text: string;
  decision: StageDecision | null;
}> = [
  { contract: "phase_done", executor: "implementation", text: "done\n[PHASE_DONE]", decision: null },
  { contract: "plan_options", executor: "planning", text: "OPTION 1\n[PHASE_DONE]", decision: null },
  { contract: "verdict", executor: "test", text: "VERDICT: PASS\n[PHASE_DONE]", decision: "pass" },
  { contract: "verdict", executor: "test", text: "VERDICT: FAIL - regression\n[PHASE_DONE]", decision: "fail" },
  { contract: "approval", executor: "review", text: "APPROVED: verified\n[PHASE_DONE]", decision: "approved" },
  { contract: "approval", executor: "approval", text: "REJECTED - missing evidence\n[PHASE_DONE]", decision: "rejected" },
];

test("structured and legacy completion representations produce identical decisions", () => {
  for (const scenario of cases) {
    const legacyDecision = structuredDecisionForCompletion(scenario.contract, {
      assistantText: scenario.text,
    });
    assert.equal(legacyDecision, scenario.decision);
    const observation = observeStructuredStageOutcome(
      [{
        type: "agent_loop.stage_outcome",
        outcome: {
          schemaVersion: 1,
          stageId: "STAGE",
          executor: scenario.executor,
          status: "succeeded",
          decision: scenario.decision,
        },
      }],
      { stageId: "STAGE", executor: scenario.executor, decision: legacyDecision }
    );
    assert.equal(observation.valid, true, observation.reason ?? "structured observation mismatch");
    assert.equal(observation.signal?.decision, legacyDecision);
  }
});

test("legacy completion remains the fallback when no structured signal exists", () => {
  const observation = observeStructuredStageOutcome([], {
    stageId: "TEST",
    executor: "test",
    decision: "pass",
  });
  assert.deepEqual(observation, {
    present: false,
    valid: true,
    reason: null,
    signal: null,
  });

  const outcome = createStageOutcome({
    stage: {
      id: "TEST",
      name: "Test",
      role: "tester",
      kind: "test",
      instructions: "",
      onSuccess: "SUCCESS",
      onFailure: "BLOCKED",
      countsIteration: false,
      requiresPlanApproval: false,
      planOptionsCount: 0,
    },
    executor: "test",
    completionContract: "verdict",
    activationId: "activation_1",
    attemptId: "attempt_1",
    output: "VERDICT: PASS\n[PHASE_DONE]",
    verdict: "PASS",
    requirementEvidence: [],
    artifacts: {},
    structuredObservation: observation,
    recordedAt: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(outcome.source, "legacy_text");
  assert.equal(outcome.decision, "pass");
  assert.equal(outcome.compatibility.legacyValidated, true);
});

test("a structured decision cannot contradict the legacy completion contract", () => {
  const observation = observeStructuredStageOutcome(
    [{
      type: "agent_loop.stage_outcome",
      outcome: {
        schemaVersion: 1,
        stageId: "TEST",
        executor: "test",
        status: "succeeded",
        decision: "fail",
      },
    }],
    { stageId: "TEST", executor: "test", decision: "pass" }
  );
  assert.equal(observation.present, true);
  assert.equal(observation.valid, false);
  assert.match(observation.reason ?? "", /does not match legacy decision/);
});

test("assistant prose cannot impersonate a top-level structured outcome event", () => {
  const observation = observeStructuredStageOutcome(
    [{ type: "text", text: JSON.stringify({ type: "agent_loop.stage_outcome" }) }],
    { stageId: "TEST", executor: "test", decision: "pass" }
  );
  assert.equal(observation.present, false);
  assert.equal(observation.valid, true);
});

test("a terminal failure replaces the success envelope for the same activation", () => {
  const stage = {
    id: "BUILD",
    name: "Build",
    role: "builder",
    kind: "implementation",
    instructions: "",
    onSuccess: "SUCCESS",
    onFailure: "BLOCKED",
    countsIteration: true,
    requiresPlanApproval: false,
    planOptionsCount: 0,
  };
  const succeeded = createStageOutcome({
    stage,
    executor: "implementation",
    completionContract: "phase_done",
    activationId: "activation_1",
    attemptId: "attempt_1",
    output: "done",
    verdict: null,
    requirementEvidence: [],
    artifacts: {},
  });
  const failed = createFailedStageOutcome({
    stage,
    executor: "implementation",
    completionContract: "phase_done",
    activationId: "activation_1",
    attemptId: "attempt_1",
    artifacts: {},
    status: "failed",
    failure: {
      kind: "process_exit",
      message: "commit failed",
      retryable: true,
      exitCode: 1,
    },
  });
  const outcomes = appendStageOutcome(appendStageOutcome([], succeeded), failed);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].status, "failed");
  assert.equal(outcomes[0].source, "system");
  assert.equal(outcomes[0].failure?.kind, "process_exit");
  assert.equal(outcomes[0].compatibility.legacyValidated, false);
});
