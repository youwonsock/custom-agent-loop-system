import assert from "node:assert/strict";
import test from "node:test";
import { deriveExtensionOperatorSnapshot } from "./operatorProjection";
import type { LoopState } from "./types";

function state(overrides: Partial<LoopState> = {}): LoopState {
  return {
    sessionId: "extension",
    status: "RUNNING",
    statusReason: null,
    phase: "TEST",
    maxIterations: 4,
    maxCycles: 4,
    cyclesStarted: 1,
    loopCount: 1,
    maxWorkflowSteps: 20,
    workflowStepsConsumed: 5,
    currentActivation: null,
    activeAttempt: null,
    automaticRecovery: null,
    pendingAccessRequest: null,
    awaitingPlanApproval: false,
    planApproved: true,
    pipeline: {
      version: 1,
      name: "test",
      startStageId: "TEST",
      interruptStageId: "TEST",
      reentryStageId: "TEST",
      iterationCompletionStageId: "TEST",
      roles: [],
      stages: [{
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
      }],
    },
    resilience: {
      transportTimeoutMs: 1,
      toolTimeoutMs: 1,
      maxAgentAttempts: 3,
      maxCompletionRecoveryAttempts: 1,
      maxAutomaticRecoveryCycles: 2,
      automaticRecoveryBackoffMs: [1],
      retryBackoffMs: [1],
      phaseRecoveryBudgetMs: 10_000,
      terminationGraceMs: 1,
      killTimeoutMs: 1,
      heartbeatIntervalMs: 1,
      leaseTtlMs: 2,
      maxInMemoryOutputBytes: 1_024,
    },
    domainEvents: [{
      schemaVersion: 1,
      sequence: 1,
      eventId: "event_1",
      type: "stage.started",
      recordedAt: "2026-01-01T00:00:00.000Z",
      stageId: "TEST",
      activationId: null,
      attemptId: null,
      role: "tester",
      summary: "Test stage started.",
      detail: {},
    }],
    ...overrides,
  } as unknown as LoopState;
}

test("extension operator projection is derived only from aggregate state and events", () => {
  const snapshot = deriveExtensionOperatorSnapshot(state());
  assert.equal(snapshot.currentStage, "TEST");
  assert.equal(snapshot.currentRole, "tester");
  assert.equal(snapshot.progressSummary, "Test stage started.");
  assert.equal(snapshot.nextPermittedAction, "execute_next_stage");
  assert.deepEqual(snapshot.budgets.cycles, { remaining: 3, consumed: 1, limit: 4 });
  assert.deepEqual(snapshot.budgets.workflowSteps, { remaining: 15, consumed: 5, limit: 20 });
});

test("extension projection exposes access, plan, recovery, mutation, and terminal actions", () => {
  const access = state({
    status: "WAITING_USER",
    statusReason: "approval required",
    pendingAccessRequest: {
      requestId: "access",
      requestedPaths: ["C:\\outside"],
      requestedAt: "2026-01-01T00:00:00.000Z",
      sourcePhase: "TEST",
      reason: "outside",
    },
  });
  assert.equal(deriveExtensionOperatorSnapshot(access).nextPermittedAction, "approve_filesystem_access");
  assert.equal(deriveExtensionOperatorSnapshot(access).pauseReason, "approval required");
  assert.equal(deriveExtensionOperatorSnapshot(state({
    status: "WAITING_USER",
    awaitingPlanApproval: true,
    planApproved: false,
  })).nextPermittedAction, "approve_plan");
  assert.equal(deriveExtensionOperatorSnapshot(state({ status: "RECOVERING" })).nextPermittedAction, "wait_for_recovery");
  assert.equal(deriveExtensionOperatorSnapshot(state({
    status: "PAUSED",
    currentActivation: {
      activationId: "unknown",
      sequence: 1,
      stageId: "TEST",
      executor: "test",
      mutationCapable: true,
      workflowStep: 1,
      cycleNumber: null,
      attemptsReserved: 1,
      maxAgentAttempts: 1,
      status: "unknown_mutation",
      reservedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:01.000Z",
    },
  })).nextPermittedAction, "reconcile_unknown_mutation");
  assert.equal(deriveExtensionOperatorSnapshot(state({ status: "SUCCESS" })).nextPermittedAction, "none_complete");
});
