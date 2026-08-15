import type { LoopState } from "./loop_state";

export const MAX_DOMAIN_EVENTS = 256;
const MAX_EVENT_SUMMARY_LENGTH = 1_000;
const MAX_EVENT_DETAIL_KEYS = 16;
const MAX_EVENT_DETAIL_STRING_LENGTH = 500;

export type DomainEventType =
  | "workflow.started"
  | "workflow.resumed"
  | "workflow.paused"
  | "workflow.completed"
  | "workflow.failed"
  | "stage.started"
  | "stage.completed"
  | "stage.failed"
  | "stage.paused"
  | "attempt.started"
  | "attempt.progressed"
  | "attempt.completed"
  | "attempt.failed";

export type DomainEventDetailValue = string | number | boolean | null;

export interface DomainEvent {
  schemaVersion: 1;
  sequence: number;
  eventId: string;
  type: DomainEventType;
  recordedAt: string;
  stageId: string | null;
  activationId: string | null;
  attemptId: string | null;
  role: string | null;
  summary: string;
  detail: Record<string, DomainEventDetailValue>;
}

export interface RemainingExecutionBudgets {
  cycles: { remaining: number; consumed: number; limit: number };
  workflowSteps: { remaining: number; consumed: number; limit: number };
  stageAttempts: { remaining: number | null; consumed: number | null; limit: number | null };
  completionRecoveryAttempts: { remaining: number; consumed: number; limit: number };
  automaticRecoveryCycles: { remaining: number; consumed: number; limit: number };
  phaseRecoveryMs: { remaining: number | null; limit: number };
}

export type NextPermittedAction =
  | "wait_for_attempt"
  | "execute_next_stage"
  | "wait_for_recovery"
  | "approve_filesystem_access"
  | "approve_plan"
  | "reconcile_unknown_mutation"
  | "resume_session"
  | "inspect_failure"
  | "none_complete";

export interface OperatorSnapshot {
  schemaVersion: 1;
  sessionId: string;
  status: LoopState["status"];
  currentStage: string;
  currentRole: string | null;
  activeAttempt: {
    attemptId: string;
    number: number;
    status: string;
    activity: string;
  } | null;
  nextPermittedAction: NextPermittedAction;
  pauseReason: string | null;
  progressSummary: string;
  budgets: RemainingExecutionBudgets;
  latestEvent: DomainEvent | null;
}

function boundedDetail(
  detail: Readonly<Record<string, DomainEventDetailValue>> | undefined
): Record<string, DomainEventDetailValue> {
  const entries = Object.entries(detail ?? {}).slice(0, MAX_EVENT_DETAIL_KEYS);
  return Object.fromEntries(entries.map(([key, value]) => [
    key.slice(0, 100),
    typeof value === "string" ? value.slice(0, MAX_EVENT_DETAIL_STRING_LENGTH) : value,
  ]));
}

export function appendDomainEvent(
  state: Pick<LoopState, "domainEventSequence" | "domainEvents">,
  input: {
    type: DomainEventType;
    summary: string;
    stageId?: string | null;
    activationId?: string | null;
    attemptId?: string | null;
    role?: string | null;
    detail?: Readonly<Record<string, DomainEventDetailValue>>;
  },
  recordedAt = new Date().toISOString()
): DomainEvent {
  const sequence = Math.max(0, Number.isSafeInteger(state.domainEventSequence)
    ? state.domainEventSequence
    : 0) + 1;
  const event: DomainEvent = {
    schemaVersion: 1,
    sequence,
    eventId: `event_${String(sequence).padStart(10, "0")}`,
    type: input.type,
    recordedAt,
    stageId: input.stageId ?? null,
    activationId: input.activationId ?? null,
    attemptId: input.attemptId ?? null,
    role: input.role ?? null,
    summary: input.summary.trim().slice(0, MAX_EVENT_SUMMARY_LENGTH),
    detail: boundedDetail(input.detail),
  };
  state.domainEventSequence = sequence;
  state.domainEvents = [...(state.domainEvents ?? []), event].slice(-MAX_DOMAIN_EVENTS);
  return event;
}

function isDomainEventType(value: unknown): value is DomainEventType {
  return [
    "workflow.started", "workflow.resumed", "workflow.paused", "workflow.completed",
    "workflow.failed", "stage.started", "stage.completed", "stage.failed", "stage.paused",
    "attempt.started", "attempt.progressed", "attempt.completed", "attempt.failed",
  ].includes(String(value));
}

export function normalizeDomainEvents(state: LoopState): boolean {
  const originalEvents = state.domainEvents as unknown;
  const events = Array.isArray(originalEvents)
    ? originalEvents.filter((candidate): candidate is DomainEvent => {
        if (!candidate || typeof candidate !== "object") return false;
        const event = candidate as Partial<DomainEvent>;
        return (
          event.schemaVersion === 1 &&
          Number.isSafeInteger(event.sequence) &&
          Number(event.sequence) > 0 &&
          typeof event.eventId === "string" &&
          isDomainEventType(event.type) &&
          typeof event.recordedAt === "string" &&
          typeof event.summary === "string"
        );
      })
      .sort((left, right) => left.sequence - right.sequence)
      .slice(-MAX_DOMAIN_EVENTS)
    : [];
  const maximumSequence = events.reduce((maximum, event) => Math.max(maximum, event.sequence), 0);
  const normalizedSequence = Math.max(
    maximumSequence,
    Number.isSafeInteger(state.domainEventSequence) && state.domainEventSequence >= 0
      ? state.domainEventSequence
      : 0
  );
  const changed =
    JSON.stringify(events) !== JSON.stringify(originalEvents) ||
    normalizedSequence !== state.domainEventSequence;
  state.domainEvents = events;
  state.domainEventSequence = normalizedSequence;
  return changed;
}

export function remainingExecutionBudgets(
  state: LoopState,
  nowMs = Date.now()
): RemainingExecutionBudgets {
  const activation = state.currentActivation;
  const completionRecoveryConsumed = state.activeAttempt?.mode === "completion_recovery"
    ? Math.max(0, state.activeAttempt.completionRecoveryNumber)
    : 0;
  const automaticRecoveryConsumed = Math.max(0, state.automaticRecovery?.cycle ?? 0);
  const cycleStartedAt = Date.parse(state.activeAttempt?.cycleStartedAt ?? "");
  const phaseRemaining = Number.isFinite(cycleStartedAt)
    ? Math.max(0, cycleStartedAt + state.resilience.phaseRecoveryBudgetMs - nowMs)
    : null;
  return {
    cycles: {
      remaining: Math.max(0, state.maxCycles - state.cyclesStarted),
      consumed: state.cyclesStarted,
      limit: state.maxCycles,
    },
    workflowSteps: {
      remaining: Math.max(0, state.maxWorkflowSteps - state.workflowStepsConsumed),
      consumed: state.workflowStepsConsumed,
      limit: state.maxWorkflowSteps,
    },
    stageAttempts: {
      remaining: activation
        ? Math.max(0, activation.maxAgentAttempts - activation.attemptsReserved)
        : null,
      consumed: activation?.attemptsReserved ?? null,
      limit: activation?.maxAgentAttempts ?? null,
    },
    completionRecoveryAttempts: {
      remaining: Math.max(
        0,
        state.resilience.maxCompletionRecoveryAttempts - completionRecoveryConsumed
      ),
      consumed: completionRecoveryConsumed,
      limit: state.resilience.maxCompletionRecoveryAttempts,
    },
    automaticRecoveryCycles: {
      remaining: Math.max(
        0,
        state.resilience.maxAutomaticRecoveryCycles - automaticRecoveryConsumed
      ),
      consumed: automaticRecoveryConsumed,
      limit: state.resilience.maxAutomaticRecoveryCycles,
    },
    phaseRecoveryMs: {
      remaining: phaseRemaining,
      limit: state.resilience.phaseRecoveryBudgetMs,
    },
  };
}

export function deriveNextPermittedAction(state: LoopState): NextPermittedAction {
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
  if (state.status === "RECOVERING") return "wait_for_recovery";
  if (state.status === "RUNNING") {
    return state.activeAttempt && ["starting", "running", "retry_wait"].includes(state.activeAttempt.status)
      ? "wait_for_attempt"
      : "execute_next_stage";
  }
  if (state.status === "FAILED" || state.status === "BLOCKED") return "inspect_failure";
  return "resume_session";
}

export function deriveOperatorSnapshot(
  state: LoopState,
  nowMs = Date.now()
): OperatorSnapshot {
  const currentStage = state.pipeline.stages.find((stage) => stage.id === state.phase);
  const latestEvent = state.domainEvents[state.domainEvents.length - 1] ?? null;
  const nextPermittedAction = deriveNextPermittedAction(state);
  const progressSummary = latestEvent?.summary || (
    state.activeAttempt
      ? `${state.phase}: attempt ${state.activeAttempt.attemptNumber} is ${state.activeAttempt.status}.`
      : `${state.phase}: workflow is ${state.status}.`
  );
  return {
    schemaVersion: 1,
    sessionId: state.sessionId,
    status: state.status,
    currentStage: state.phase,
    currentRole: currentStage?.role ?? null,
    activeAttempt: state.activeAttempt
      ? {
          attemptId: state.activeAttempt.attemptId,
          number: state.activeAttempt.attemptNumber,
          status: state.activeAttempt.status,
          activity: state.activeAttempt.activity,
        }
      : null,
    nextPermittedAction,
    pauseReason: state.status === "RUNNING" ? null : state.statusReason,
    progressSummary,
    budgets: remainingExecutionBudgets(state, nowMs),
    latestEvent,
  };
}

function budgetLine(
  label: string,
  budget: { remaining: number | null; consumed?: number | null; limit: number }
): string {
  const remaining = budget.remaining === null ? "n/a" : String(budget.remaining);
  const consumed = budget.consumed === undefined || budget.consumed === null
    ? "n/a"
    : String(budget.consumed);
  return `  ${label}: ${remaining} remaining (${consumed}/${budget.limit} consumed)`;
}

export function formatOperatorSnapshot(snapshot: OperatorSnapshot): string {
  const attempt = snapshot.activeAttempt
    ? `${snapshot.activeAttempt.number} ${snapshot.activeAttempt.status}/${snapshot.activeAttempt.activity} ` +
      `(${snapshot.activeAttempt.attemptId})`
    : "none";
  const phaseRecovery = snapshot.budgets.phaseRecoveryMs.remaining === null
    ? "n/a"
    : `${snapshot.budgets.phaseRecoveryMs.remaining}ms remaining ` +
      `(limit ${snapshot.budgets.phaseRecoveryMs.limit}ms)`;
  return [
    `Session: ${snapshot.sessionId}`,
    `Status: ${snapshot.status}`,
    `Stage: ${snapshot.currentStage} (role: ${snapshot.currentRole ?? "unknown"})`,
    `Attempt: ${attempt}`,
    `Progress: ${snapshot.progressSummary}`,
    `Next permitted action: ${snapshot.nextPermittedAction}`,
    ...(snapshot.pauseReason ? [`Pause reason: ${snapshot.pauseReason}`] : []),
    "Remaining budgets:",
    budgetLine("cycles", snapshot.budgets.cycles),
    budgetLine("workflow steps", snapshot.budgets.workflowSteps),
    budgetLine("stage attempts", {
      ...snapshot.budgets.stageAttempts,
      limit: snapshot.budgets.stageAttempts.limit ?? 0,
    }),
    budgetLine("completion recovery", snapshot.budgets.completionRecoveryAttempts),
    budgetLine("automatic recovery", snapshot.budgets.automaticRecoveryCycles),
    `  phase recovery: ${phaseRecovery}`,
  ].join("\n");
}

export function appendWorkflowStatusEventIfChanged(state: LoopState): DomainEvent | null {
  const latestStatusEvent = [...state.domainEvents].reverse().find(
    (event) => event.type.startsWith("workflow.") && typeof event.detail.status === "string"
  );
  if (latestStatusEvent?.detail.status === state.status) return null;
  const type: DomainEventType = state.status === "RUNNING"
    ? "workflow.resumed"
    : state.status === "SUCCESS"
      ? "workflow.completed"
      : state.status === "FAILED" || state.status === "BLOCKED"
        ? "workflow.failed"
        : "workflow.paused";
  return appendDomainEvent(state, {
    type,
    stageId: state.phase,
    activationId: state.currentActivation?.activationId ?? null,
    attemptId: state.activeAttempt?.attemptId ?? null,
    role: state.activeAttempt?.role ?? null,
    summary: state.statusReason
      ? `${state.status}: ${state.statusReason}`
      : `Workflow status changed to ${state.status}.`,
    detail: { status: state.status, reason: state.statusReason },
  });
}
