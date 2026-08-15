import assert from "node:assert/strict";
import test from "node:test";
import {
  completeCycleObservation,
  deriveLegacyMaxWorkflowSteps,
  finishCurrentActivation,
  markUnknownMutationOutcome,
  normalizeExecutionBudget,
  reserveAgentAttempt,
  reserveStageActivation,
} from "./execution_budget";
import { LoopState } from "./loop_state";
import { defaultPipelineDefinition, stageById } from "./pipeline";

function budgetState(overrides: Partial<LoopState> = {}): LoopState {
  return {
    maxIterations: 2,
    maxCycles: 2,
    cyclesStarted: 0,
    cyclesCompleted: 0,
    loopCount: 0,
    completedIterations: 0,
    maxWorkflowSteps: 3,
    workflowStepsConsumed: 0,
    currentActivation: null,
    activationHistory: [],
    stageResults: {},
    activeAttempt: null,
    lastFailure: null,
    status: "RUNNING",
    statusReason: null,
    ...overrides,
  } as LoopState;
}

test("legacy maxIterations migrates deterministically into separate durable budgets", () => {
  const state = budgetState({
    maxIterations: 7,
    maxCycles: Number.NaN,
    cyclesStarted: Number.NaN,
    cyclesCompleted: Number.NaN,
    maxWorkflowSteps: Number.NaN,
    workflowStepsConsumed: Number.NaN,
    loopCount: 2,
    completedIterations: 1,
  });
  assert.equal(normalizeExecutionBudget(state), true);
  assert.equal(state.maxCycles, 7);
  assert.equal(state.cyclesStarted, 2);
  assert.equal(state.cyclesCompleted, 1);
  assert.equal(state.maxWorkflowSteps, deriveLegacyMaxWorkflowSteps(7));
});

test("workflow steps and cycles are reserved before attempts and never overdrawn", () => {
  const state = budgetState({ maxCycles: 1, maxWorkflowSteps: 2 });
  const pipeline = defaultPipelineDefinition();
  const implementation = stageById(pipeline, "IMPLEMENTATION");
  const first = reserveStageActivation(state, implementation, "implementation", 2);
  assert.equal(first.ok, true);
  assert.equal(state.cyclesStarted, 1);
  assert.equal(state.workflowStepsConsumed, 1);

  assert.deepEqual(reserveAgentAttempt(state), {
    ok: true,
    attemptNumber: 1,
    activationId: "activation_00000001_IMPLEMENTATION",
  });
  assert.equal(reserveAgentAttempt(state).ok, true);
  assert.equal(reserveAgentAttempt(state).ok, false);
  finishCurrentActivation(state, "failed");
  const cycleExhausted = reserveStageActivation(
    state,
    implementation,
    "implementation",
    2
  );
  assert.equal(cycleExhausted.ok, false);
  if (!cycleExhausted.ok) assert.equal(cycleExhausted.exhaustion.dimension, "cycles");
});

test("non-counting graph cycles are stopped by the workflow-step hard fuse", () => {
  const state = budgetState({ maxCycles: 100, maxWorkflowSteps: 2 });
  const stage = stageById(defaultPipelineDefinition(), "TEST_GENERATION");
  for (let index = 0; index < 2; index += 1) {
    assert.equal(reserveStageActivation(state, stage, "test", 1).ok, true);
    finishCurrentActivation(state, "completed");
  }
  const exhausted = reserveStageActivation(state, stage, "test", 1);
  assert.equal(exhausted.ok, false);
  if (!exhausted.ok) assert.equal(exhausted.exhaustion.dimension, "workflow_steps");
});

test("uncertain mutation attempts stay charged and require reconciliation", () => {
  const state = budgetState();
  const stage = stageById(defaultPipelineDefinition(), "IMPLEMENTATION");
  assert.equal(reserveStageActivation(state, stage, "implementation", 2).ok, true);
  const attempt = reserveAgentAttempt(state);
  assert.equal(attempt.ok, true);
  state.activeAttempt = {
    attemptId: "attempt-1",
    activationId: state.currentActivation!.activationId,
    role: "implementer",
    phase: stage.id,
    status: "running",
    ownerPid: 1,
    childPid: 2,
    cliSessionId: null,
    attemptNumber: 1,
    maxAttempts: 2,
    reconnectUsed: false,
    cycleStartedAt: new Date(0).toISOString(),
    startedAt: new Date(0).toISOString(),
    lastOutputAt: null,
    lastProgressAt: null,
    deadlineAt: new Date(1).toISOString(),
    nextRetryAt: null,
    endedAt: null,
    exitCode: null,
    failureKind: null,
    failureMessage: null,
    outputLogPath: null,
    activity: "model_generation",
    mode: "standard",
    completionRecoveryNumber: 0,
  };
  assert.equal(markUnknownMutationOutcome(state), true);
  assert.equal(state.workflowStepsConsumed, 1);
  assert.equal(state.currentActivation?.attemptsReserved, 1);
  assert.equal(state.currentActivation?.status, "unknown_mutation");
  assert.match(state.statusReason ?? "", /UNKNOWN_MUTATION_OUTCOME/);
});

test("cycle completion is an observation bounded by cycles started", () => {
  const state = budgetState({ cyclesStarted: 1 });
  completeCycleObservation(state);
  completeCycleObservation(state);
  assert.equal(state.cyclesCompleted, 1);
  assert.equal(state.completedIterations, 1);
});
