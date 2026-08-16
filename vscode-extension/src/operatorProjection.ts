import {
  LoopState,
  NextPermittedAction,
  OperatorSnapshot,
  RemainingExecutionBudgets,
} from "./types";

function nonNegative(value: number): number {
  return Math.max(0, Number.isFinite(value) ? Math.floor(value) : 0);
}

export function remainingExtensionBudgets(
  state: LoopState,
  _nowMs = Date.now()
): RemainingExecutionBudgets {
  const maxCycles = nonNegative(state.maxCycles ?? 0);
  const cyclesStarted = nonNegative(state.cyclesStarted ?? state.loopCount);
  const maxWorkflowSteps = nonNegative(state.maxWorkflowSteps ?? 0);
  const workflowStepsConsumed = nonNegative(state.workflowStepsConsumed ?? 0);
  const activation = state.currentActivation ?? null;
  return {
    cycles: {
      remaining: Math.max(0, maxCycles - cyclesStarted),
      consumed: cyclesStarted,
      limit: maxCycles,
    },
    workflowSteps: {
      remaining: Math.max(0, maxWorkflowSteps - workflowStepsConsumed),
      consumed: workflowStepsConsumed,
      limit: maxWorkflowSteps,
    },
    stageAttempts: {
      remaining: activation
        ? Math.max(0, activation.maxAgentAttempts - activation.attemptsReserved)
        : null,
      consumed: activation?.attemptsReserved ?? null,
      limit: activation?.maxAgentAttempts ?? null,
    },
  };
}

export function extensionNextPermittedAction(state: LoopState): NextPermittedAction {
  if (state.status === "SUCCESS") return "none_complete";
  if (state.currentActivation?.status === "unknown_mutation") {
    return "reconcile_unknown_mutation";
  }
  if (state.status === "WAITING_USER" && state.pendingAccessRequest) {
    return "approve_filesystem_access";
  }
  if (state.status === "WAITING_USER" && state.awaitingPlanApproval && !state.planApproved) {
    return "approve_plan";
  }
  if (state.status === "RUNNING") {
    return state.activeAttempt && ["starting", "running", "retry_wait"].includes(state.activeAttempt.status)
      ? "wait_for_attempt"
      : "execute_next_stage";
  }
  if (state.status === "FAILED" || state.status === "BLOCKED") return "inspect_failure";
  return "resume_session";
}

export function deriveExtensionOperatorSnapshot(
  state: LoopState,
  nowMs = Date.now()
): OperatorSnapshot {
  const latestEvent = state.domainEvents?.[state.domainEvents.length - 1] ?? null;
  const stage = state.pipeline.stages.find((candidate) => candidate.id === state.phase);
  return {
    schemaVersion: 1,
    sessionId: state.sessionId,
    status: state.status,
    currentStage: state.phase,
    currentRole: stage?.role ?? null,
    activeAttempt: state.activeAttempt
      ? {
          attemptId: state.activeAttempt.attemptId,
          number: state.activeAttempt.attemptNumber,
          status: state.activeAttempt.status,
          activity: state.activeAttempt.activity,
        }
      : null,
    nextPermittedAction: extensionNextPermittedAction(state),
    pauseReason: state.status === "RUNNING" ? null : state.statusReason,
    progressSummary: latestEvent?.summary ?? (
      state.activeAttempt
        ? `${state.phase}: attempt ${state.activeAttempt.attemptNumber} is ${state.activeAttempt.status}.`
        : `${state.phase}: workflow is ${state.status}.`
    ),
    budgets: remainingExtensionBudgets(state, nowMs),
    latestEvent,
  };
}
