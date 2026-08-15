import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_DOMAIN_EVENTS,
  appendDomainEvent,
  appendWorkflowStatusEventIfChanged,
  deriveOperatorSnapshot,
  normalizeDomainEvents,
} from "./domain_events";
import type { LoopState } from "./loop_state";
import { defaultPipelineDefinition } from "./pipeline";
import { LoopStatus } from "./workflow_contracts";

function operatorState(): LoopState {
  return {
    sessionId: "operator",
    status: LoopStatus.RUNNING,
    statusReason: null,
    phase: "IMPLEMENTATION",
    pipeline: defaultPipelineDefinition(),
    activeAttempt: null,
    pendingAccessRequest: null,
    awaitingPlanApproval: false,
    planApproved: true,
    currentActivation: null,
    maxCycles: 5,
    cyclesStarted: 2,
    maxWorkflowSteps: 30,
    workflowStepsConsumed: 7,
    automaticRecovery: null,
    resilience: {
      transportTimeoutMs: 1,
      toolTimeoutMs: 1,
      maxAgentAttempts: 3,
      maxCompletionRecoveryAttempts: 1,
      maxAutomaticRecoveryCycles: 3,
      automaticRecoveryBackoffMs: [1],
      retryBackoffMs: [1],
      phaseRecoveryBudgetMs: 10_000,
      terminationGraceMs: 1,
      killTimeoutMs: 1,
      heartbeatIntervalMs: 1,
      leaseTtlMs: 2,
      maxInMemoryOutputBytes: 1_024,
    },
    domainEventSequence: 0,
    domainEvents: [],
  } as unknown as LoopState;
}

test("domain event retention is bounded and never mutates workflow authority", () => {
  const state = operatorState();
  const originalPhase = state.phase;
  const originalStatus = state.status;
  for (let index = 1; index <= 300; index++) {
    appendDomainEvent(state, {
      type: "attempt.progressed",
      summary: `progress ${index}`,
      stageId: state.phase,
    });
  }
  assert.equal(state.domainEventSequence, 300);
  assert.equal(state.domainEvents.length, MAX_DOMAIN_EVENTS);
  assert.equal(state.domainEvents[0].sequence, 45);
  assert.equal(state.domainEvents[state.domainEvents.length - 1]?.sequence, 300);
  assert.equal(state.phase, originalPhase);
  assert.equal(state.status, originalStatus);
});

test("operator snapshot exposes current stage, next action, pause reason, and all budgets", () => {
  const state = operatorState();
  state.currentActivation = {
    activationId: "activation_1",
    sequence: 7,
    stageId: state.phase,
    executor: "implementation",
    mutationCapable: true,
    workflowStep: 7,
    cycleNumber: 2,
    attemptsReserved: 1,
    maxAgentAttempts: 3,
    status: "running",
    reservedAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
  };
  appendDomainEvent(state, {
    type: "stage.started",
    stageId: state.phase,
    activationId: "activation_1",
    summary: "Implementation stage started.",
  });
  const snapshot = deriveOperatorSnapshot(state, Date.parse("2026-01-01T00:00:00.000Z"));
  assert.equal(snapshot.currentStage, "IMPLEMENTATION");
  assert.equal(snapshot.currentRole, "implementer");
  assert.equal(snapshot.nextPermittedAction, "execute_next_stage");
  assert.equal(snapshot.progressSummary, "Implementation stage started.");
  assert.deepEqual(snapshot.budgets.cycles, { remaining: 3, consumed: 2, limit: 5 });
  assert.deepEqual(snapshot.budgets.workflowSteps, { remaining: 23, consumed: 7, limit: 30 });
  assert.deepEqual(snapshot.budgets.stageAttempts, { remaining: 2, consumed: 1, limit: 3 });
  assert.equal(snapshot.budgets.completionRecoveryAttempts.remaining, 1);
  assert.equal(snapshot.budgets.automaticRecoveryCycles.remaining, 3);

  state.status = LoopStatus.WAITING_USER;
  state.pendingAccessRequest = {
    requestId: "access_1",
    requestedPaths: ["C:\\outside"],
    requestedAt: "2026-01-01T00:00:00.000Z",
    sourcePhase: state.phase,
    reason: "outside root",
  };
  state.statusReason = "Filesystem approval required.";
  appendWorkflowStatusEventIfChanged(state);
  const held = deriveOperatorSnapshot(state);
  assert.equal(held.nextPermittedAction, "approve_filesystem_access");
  assert.equal(held.pauseReason, "Filesystem approval required.");
});

test("event normalization drops malformed observations but preserves monotonic sequence", () => {
  const state = operatorState();
  state.domainEventSequence = 12;
  state.domainEvents = [{ bad: true } as never];
  assert.equal(normalizeDomainEvents(state), true);
  assert.deepEqual(state.domainEvents, []);
  assert.equal(state.domainEventSequence, 12);
  const next = appendDomainEvent(state, { type: "workflow.resumed", summary: "resumed" });
  assert.equal(next.sequence, 13);
});
