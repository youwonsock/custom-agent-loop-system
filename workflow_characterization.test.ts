import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultPipelineDefinition,
  executorForStage,
  stageTypeForStage,
  validatePipeline,
} from "./pipeline";
import { normalizeLoopState } from "./loop_orchestrator";

function normalizeCharacterizationState(overrides: Record<string, unknown>): any {
  return normalizeLoopState({
    stateVersion: 2,
    sessionId: "characterization-session",
    status: "PAUSED",
    phase: "PLANNING",
    goal: "Characterize the existing workflow.",
    targetProjectPath: process.cwd(),
    additionalAllowedPaths: [],
    accessMode: "ask",
    pendingAccessRequest: null,
    cliBinary: "opencode",
    cliProfile: "opencode",
    modelMapping: {
      planner: "fake/model",
      implementer: "fake/model",
      tester: "fake/model",
      qa_lead: "fake/model",
      master: "fake/model",
      interrupter: "fake/model",
    },
    agentStates: {},
    awaitingPlanApproval: false,
    activeAttempt: null,
    lastFailure: null,
    ...overrides,
  } as any).state;
}

test("built-in workflow topology and completion contracts remain stable", () => {
  const pipeline = validatePipeline(defaultPipelineDefinition());
  const actual = pipeline.stages.map((stage) => ({
    id: stage.id,
    role: stage.role,
    executor: executorForStage(pipeline, stage),
    contract: stageTypeForStage(pipeline, stage).completionContract,
    onSuccess: stage.onSuccess,
    onFailure: stage.onFailure,
    countsIteration: stage.countsIteration,
    requiresPlanApproval: stage.requiresPlanApproval,
  }));

  assert.deepEqual(actual, [
    {
      id: "PLANNING",
      role: "planner",
      executor: "planning",
      contract: "plan_options",
      onSuccess: "IMPLEMENTATION",
      onFailure: "INTERRUPT",
      countsIteration: false,
      requiresPlanApproval: true,
    },
    {
      id: "IMPLEMENTATION",
      role: "implementer",
      executor: "implementation",
      contract: "phase_done",
      onSuccess: "TEST_GENERATION",
      onFailure: "INTERRUPT",
      countsIteration: true,
      requiresPlanApproval: false,
    },
    {
      id: "TEST_GENERATION",
      role: "tester",
      executor: "test",
      contract: "verdict",
      onSuccess: "VERIFICATION",
      onFailure: "VERIFICATION",
      countsIteration: false,
      requiresPlanApproval: false,
    },
    {
      id: "VERIFICATION",
      role: "qa_lead",
      executor: "review",
      contract: "approval",
      onSuccess: "MASTER_APPROVAL",
      onFailure: "IMPLEMENTATION",
      countsIteration: false,
      requiresPlanApproval: false,
    },
    {
      id: "MASTER_APPROVAL",
      role: "master",
      executor: "approval",
      contract: "approval",
      onSuccess: "SUCCESS",
      onFailure: "IMPLEMENTATION",
      countsIteration: false,
      requiresPlanApproval: false,
    },
    {
      id: "INTERRUPT",
      role: "interrupter",
      executor: "interrupt",
      contract: "phase_done",
      onSuccess: "PAUSED",
      onFailure: "PAUSED",
      countsIteration: false,
      requiresPlanApproval: false,
    },
  ]);
});

test("paused sessions normalize to the established operator-action states", () => {
  const planApproval = normalizeCharacterizationState({
    awaitingPlanApproval: true,
    planApproved: false,
  });
  assert.equal(planApproval.status, "WAITING_USER");
  assert.match(planApproval.statusReason, /Plan approval is required/);

  const accessApproval = normalizeCharacterizationState({
    phase: "IMPLEMENTATION",
    pendingAccessRequest: {
      requestId: "access-1",
      requestedPaths: [process.cwd()],
      requestedAt: "2026-08-16T00:00:00.000Z",
      sourcePhase: "IMPLEMENTATION",
      reason: "Additional access is required.",
    },
  });
  assert.equal(accessApproval.status, "WAITING_USER");
  assert.match(accessApproval.statusReason, /Filesystem access approval is required/);

  const orphaned = normalizeCharacterizationState({
    phase: "IMPLEMENTATION",
    lastFailure: {
      kind: "orphaned_process",
      message: "The previous child process may still be alive.",
      retryable: false,
      occurredAt: "2026-08-16T00:00:00.000Z",
      attemptId: "attempt-orphaned",
      role: "implementer",
      phase: "IMPLEMENTATION",
      exitCode: null,
      cliSessionId: null,
    },
  });
  assert.equal(orphaned.status, "BLOCKED");
  assert.equal(orphaned.statusReason, "The previous child process may still be alive.");

  const cancelled = normalizeCharacterizationState({
    phase: "IMPLEMENTATION",
    activeAttempt: {
      status: "cancelled",
      failureKind: "cancelled",
      failureMessage: "The operator stopped the attempt.",
    },
  });
  assert.equal(cancelled.status, "STOPPED");
  assert.equal(cancelled.statusReason, "The operator stopped the attempt.");
});

test("version 2 RUNNING attempts remain intact for owner-mediated recovery", () => {
  const state = normalizeCharacterizationState({
    status: "RUNNING",
    phase: "IMPLEMENTATION",
    activeAttempt: {
      attemptId: "attempt-running",
      role: "implementer",
      phase: "IMPLEMENTATION",
      status: "running",
      ownerPid: 1234,
      childPid: 5678,
      cliSessionId: "provider-session",
      attemptNumber: 1,
      maxAttempts: 3,
      reconnectUsed: false,
      cycleStartedAt: "2026-08-16T00:00:00.000Z",
      startedAt: "2026-08-16T00:00:00.000Z",
      lastOutputAt: "2026-08-16T00:00:01.000Z",
      lastProgressAt: "2026-08-16T00:00:01.000Z",
      deadlineAt: "2026-08-16T00:15:00.000Z",
      nextRetryAt: null,
      endedAt: null,
      exitCode: null,
      failureKind: null,
      failureMessage: null,
      outputLogPath: "attempt.log",
      activity: "model_generation",
      mode: "standard",
      completionRecoveryNumber: 0,
    },
    agentStates: {
      implementer: {
        status: "running",
        lastExitCode: null,
        lastRunAt: "2026-08-16T00:00:00.000Z",
      },
    },
  });

  assert.equal(state.status, "RUNNING");
  assert.equal(state.activeAttempt.attemptId, "attempt-running");
  assert.equal(state.activeAttempt.status, "running");
  assert.equal(state.activeAttempt.childPid, 5678);
  assert.equal(state.agentStates.implementer.status, "running");
});
