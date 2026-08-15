import { LoopState, StageActivationReservation, StageActivationStatus } from "./loop_state";
import { PipelineStage, PipelineStageExecutor } from "./pipeline";

export const LEGACY_WORKFLOW_STEPS_PER_CYCLE = 8;
export const LEGACY_WORKFLOW_STEP_BASE = 4;
export const MAX_ACTIVATION_HISTORY = 128;

const MUTATION_EXECUTORS = new Set<PipelineStageExecutor>(["implementation", "test"]);

export type BudgetDimension = "cycles" | "workflow_steps" | "agent_attempts";

export interface BudgetExhaustion {
  dimension: BudgetDimension;
  reason: string;
}

export type ActivationReservationResult =
  | { ok: true; reservation: StageActivationReservation; reused: boolean }
  | { ok: false; exhaustion: BudgetExhaustion };

export type AttemptReservationResult =
  | { ok: true; attemptNumber: number; activationId: string }
  | { ok: false; exhaustion: BudgetExhaustion };

export function deriveLegacyMaxWorkflowSteps(maxCycles: number): number {
  return Math.max(
    16,
    Math.max(1, Math.floor(maxCycles)) * LEGACY_WORKFLOW_STEPS_PER_CYCLE +
      LEGACY_WORKFLOW_STEP_BASE
  );
}

function nonNegativeInteger(value: unknown, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : fallback;
}

export function normalizeExecutionBudget(state: LoopState): boolean {
  let migrated = false;
  const legacyMaxCycles = Math.max(1, nonNegativeInteger(state.maxIterations, 20));
  if (!Number.isSafeInteger(state.maxCycles) || state.maxCycles < 1) {
    state.maxCycles = legacyMaxCycles;
    migrated = true;
  }
  if (!Number.isSafeInteger(state.cyclesStarted) || state.cyclesStarted < 0) {
    state.cyclesStarted = nonNegativeInteger(state.loopCount, 0);
    migrated = true;
  }
  if (!Number.isSafeInteger(state.cyclesCompleted) || state.cyclesCompleted < 0) {
    state.cyclesCompleted = nonNegativeInteger(state.completedIterations, 0);
    migrated = true;
  }
  if (!Number.isSafeInteger(state.workflowStepsConsumed) || state.workflowStepsConsumed < 0) {
    const completedStageCount = Object.keys(state.stageResults ?? {}).length;
    state.workflowStepsConsumed = Math.max(state.cyclesStarted, completedStageCount);
    migrated = true;
  }
  if (!Number.isSafeInteger(state.maxWorkflowSteps) || state.maxWorkflowSteps < 1) {
    state.maxWorkflowSteps = Math.max(
      deriveLegacyMaxWorkflowSteps(state.maxCycles),
      state.workflowStepsConsumed
    );
    migrated = true;
  }
  if (!Object.prototype.hasOwnProperty.call(state, "currentActivation")) {
    state.currentActivation = null;
    migrated = true;
  }
  if (!Array.isArray(state.activationHistory)) {
    state.activationHistory = [];
    migrated = true;
  } else if (state.activationHistory.length > MAX_ACTIVATION_HISTORY) {
    state.activationHistory = state.activationHistory.slice(-MAX_ACTIVATION_HISTORY);
    migrated = true;
  }

  // Keep v2 compatibility counters as projections of the durable cycle counters.
  if (state.maxIterations !== state.maxCycles) {
    state.maxIterations = state.maxCycles;
    migrated = true;
  }
  if (state.loopCount !== state.cyclesStarted) {
    state.loopCount = state.cyclesStarted;
    migrated = true;
  }
  if (state.completedIterations !== state.cyclesCompleted) {
    state.completedIterations = state.cyclesCompleted;
    migrated = true;
  }
  return migrated;
}

function archiveCurrentActivation(state: LoopState): void {
  if (!state.currentActivation) return;
  state.activationHistory = [
    ...state.activationHistory,
    { ...state.currentActivation },
  ].slice(-MAX_ACTIVATION_HISTORY);
  state.currentActivation = null;
}

export function reserveStageActivation(
  state: LoopState,
  stage: PipelineStage,
  executor: PipelineStageExecutor,
  maxAgentAttempts: number,
  now = new Date().toISOString()
): ActivationReservationResult {
  const current = state.currentActivation;
  if (
    current &&
    current.stageId === stage.id &&
    (current.status === "reserved" || current.status === "running")
  ) {
    return { ok: true, reservation: current, reused: true };
  }
  if (current) {
    if (current.status === "unknown_mutation") {
      return {
        ok: false,
        exhaustion: {
          dimension: "agent_attempts",
          reason:
            `Stage ${current.stageId} has an unknown mutation outcome and requires explicit reconciliation.`,
        },
      };
    }
    if (current.status === "reserved" || current.status === "running") {
      throw new Error(
        `Cannot reserve stage ${stage.id}; activation ${current.activationId} for ` +
          `${current.stageId} is still ${current.status}.`
      );
    }
    archiveCurrentActivation(state);
  }

  if (state.workflowStepsConsumed >= state.maxWorkflowSteps) {
    return {
      ok: false,
      exhaustion: {
        dimension: "workflow_steps",
        reason:
          `Workflow-step budget exhausted (${state.workflowStepsConsumed}/${state.maxWorkflowSteps}).`,
      },
    };
  }
  if (stage.countsIteration && state.cyclesStarted >= state.maxCycles) {
    return {
      ok: false,
      exhaustion: {
        dimension: "cycles",
        reason: `Cycle budget exhausted (${state.cyclesStarted}/${state.maxCycles}).`,
      },
    };
  }

  state.workflowStepsConsumed += 1;
  let cycleNumber: number | null = null;
  if (stage.countsIteration) {
    state.cyclesStarted += 1;
    state.loopCount = state.cyclesStarted;
    cycleNumber = state.cyclesStarted;
  }
  const reservation: StageActivationReservation = {
    activationId: `activation_${String(state.workflowStepsConsumed).padStart(8, "0")}_${stage.id}`,
    sequence: state.workflowStepsConsumed,
    stageId: stage.id,
    executor,
    mutationCapable: MUTATION_EXECUTORS.has(executor),
    workflowStep: state.workflowStepsConsumed,
    cycleNumber,
    attemptsReserved: 0,
    maxAgentAttempts: Math.max(1, Math.floor(maxAgentAttempts)),
    status: "reserved",
    reservedAt: now,
    completedAt: null,
  };
  state.currentActivation = reservation;
  return { ok: true, reservation, reused: false };
}

export function reserveAgentAttempt(state: LoopState): AttemptReservationResult {
  const activation = state.currentActivation;
  if (!activation || (activation.status !== "reserved" && activation.status !== "running")) {
    throw new Error("Cannot reserve an agent attempt without an active stage reservation.");
  }
  if (activation.attemptsReserved >= activation.maxAgentAttempts) {
    return {
      ok: false,
      exhaustion: {
        dimension: "agent_attempts",
        reason:
          `Agent-attempt budget exhausted for ${activation.stageId} ` +
          `(${activation.attemptsReserved}/${activation.maxAgentAttempts}).`,
      },
    };
  }
  activation.attemptsReserved += 1;
  activation.status = "running";
  return {
    ok: true,
    attemptNumber: activation.attemptsReserved,
    activationId: activation.activationId,
  };
}

export function markCurrentActivationCompleted(
  state: LoopState,
  now = new Date().toISOString()
): void {
  if (!state.currentActivation) return;
  state.currentActivation.status = "completed";
  state.currentActivation.completedAt = now;
}

export function finishCurrentActivation(
  state: LoopState,
  status: Exclude<StageActivationStatus, "reserved" | "running">,
  now = new Date().toISOString()
): void {
  if (!state.currentActivation) return;
  state.currentActivation.status = status;
  state.currentActivation.completedAt = state.currentActivation.completedAt ?? now;
  archiveCurrentActivation(state);
}

export function markUnknownMutationOutcome(
  state: LoopState,
  now = new Date().toISOString()
): boolean {
  const activation = state.currentActivation;
  if (!activation?.mutationCapable) return false;
  if (!state.activeAttempt || !["starting", "running"].includes(state.activeAttempt.status)) {
    return false;
  }
  activation.status = "unknown_mutation";
  activation.completedAt = now;
  state.activeAttempt.status = "unknown_outcome";
  state.activeAttempt.endedAt = now;
  state.activeAttempt.failureKind = "unknown";
  state.activeAttempt.failureMessage =
    "The prior owner exited after a mutation-capable attempt was reserved; its side effects are unknown.";
  state.lastFailure = {
    kind: "unknown",
    message: state.activeAttempt.failureMessage,
    retryable: false,
    occurredAt: now,
    attemptId: state.activeAttempt.attemptId,
    role: state.activeAttempt.role,
    phase: state.activeAttempt.phase,
    exitCode: state.activeAttempt.exitCode,
    cliSessionId: state.activeAttempt.cliSessionId,
  };
  state.status = "PAUSED" as LoopState["status"];
  state.statusReason =
    "UNKNOWN_MUTATION_OUTCOME: inspect the target project, then resume with " +
    "--reconcile-mutation retry to explicitly permit a newly charged activation.";
  return true;
}

export function completeCycleObservation(state: LoopState): void {
  if (state.cyclesCompleted < state.cyclesStarted) state.cyclesCompleted += 1;
  state.completedIterations = state.cyclesCompleted;
}
