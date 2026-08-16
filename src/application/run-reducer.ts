import type { DomainEffect } from "../domain/domain-effect";
import type { JsonObject, JsonValue } from "../domain/json";
import type {
  DomainEvent,
  DomainEventType,
  NodeOutcome,
  RunAggregate,
  RunStatus,
} from "../domain/run-aggregate";
import type { HumanGateResponse } from "../domain/workflow";
import type { RunControlType } from "./ports/control-command";

export class WorkflowBudgetError extends Error {
  constructor(readonly budget: "workflow_steps" | "cycles" | "node_executions") {
    super(`Workflow ${budget.replaceAll("_", " ")} budget is exhausted.`);
    this.name = "WorkflowBudgetError";
  }
}

function cloneAggregate(aggregate: Readonly<RunAggregate>): RunAggregate {
  return JSON.parse(JSON.stringify(aggregate)) as RunAggregate;
}

function appendEvent(
  aggregate: RunAggregate,
  type: DomainEventType,
  summary: string,
  detail: JsonObject,
  recordedAt: string,
  identity: {
    nodeId?: string | null;
    activationId?: string | null;
    attemptId?: string | null;
  } = {}
): DomainEvent {
  aggregate.eventSequence += 1;
  const event: DomainEvent = {
    schemaVersion: 1,
    sequence: aggregate.eventSequence,
    eventId: `event_${String(aggregate.eventSequence).padStart(12, "0")}`,
    runId: aggregate.runId,
    nodeId: identity.nodeId ?? null,
    activationId: identity.activationId ?? null,
    attemptId: identity.attemptId ?? null,
    type,
    summary: summary.slice(0, 1_000),
    detail,
    recordedAt,
  };
  aggregate.events = [...aggregate.events, event].slice(
    -aggregate.definition.budgets.maxEvents
  );
  return event;
}

function isNodeTarget(aggregate: RunAggregate, targetId: string | null): targetId is string {
  return targetId !== null && aggregate.definition.nodes[targetId] !== undefined;
}

function applyEffect(
  aggregate: RunAggregate,
  effect: DomainEffect,
  activationId: string,
  recordedAt: string
): void {
  switch (effect.type) {
    case "record_plan_choices":
      aggregate.context.planChoices = effect.choices.map((choice) => ({ ...choice }));
      return;
    case "set_approved_plan": {
      const execution = aggregate.nodeExecutions[activationId];
      if (!execution.output) throw new Error("Approved-plan effect requires a task output.");
      aggregate.context.selectedPlanChoiceId = effect.choiceId;
      aggregate.context.approvedPlan = {
        ...execution.output,
        artifactId: effect.planArtifactId,
      };
      return;
    }
    case "add_requirement_evidence":
      aggregate.context.requirementEvidence = [
        ...aggregate.context.requirementEvidence,
        ...effect.evidence.map((item) => ({
          activationId,
          requirementId: item.requirementId,
          status: item.status,
          evidence: item.evidence,
          artifactIds: [...(item.artifactIds ?? [])],
        })),
      ].slice(-2_000);
      return;
    case "set_failure_summary":
      aggregate.context.failureSummary = effect.summary.slice(0, 20_000);
      return;
    case "clear_failure_summary":
      aggregate.context.failureSummary = null;
      return;
    case "update_convergence":
      aggregate.context.convergence.history = [
        ...aggregate.context.convergence.history,
        { signature: effect.signature.slice(0, 2_000), improved: effect.improved, recordedAt },
      ].slice(-100);
      aggregate.context.convergence.stagnantCycles = effect.improved
        ? 0
        : aggregate.context.convergence.stagnantCycles + 1;
      return;
    case "record_interrupt_briefing":
      aggregate.context.interruptBriefing = {
        artifactId: effect.artifactId,
        summary: effect.summary.slice(0, 4_096),
      };
      return;
    default: {
      const exhaustive: never = effect;
      throw new Error(`Unsupported domain effect: ${JSON.stringify(exhaustive)}`);
    }
  }
}

export class RunReducer {
  applyBoundaryControl(
    source: Readonly<RunAggregate>,
    requestId: string,
    type: RunControlType,
    message: string | null,
    recordedAt: string,
    permitRecordedAttempt = false
  ): RunAggregate {
    const aggregate = cloneAggregate(source);
    if (aggregate.processedRequestIds.includes(requestId)) return aggregate;
    const activationId = aggregate.execution.activeActivationId;
    const execution = activationId ? aggregate.nodeExecutions[activationId] : null;
    if (execution?.status === "running" && !permitRecordedAttempt) {
      throw new Error(`Control ${type} must be delivered through the active provider boundary.`);
    }
    if (execution) {
      execution.status = "cancelled";
      execution.completedAt = recordedAt;
    }
    aggregate.execution.activeActivationId = null;
    aggregate.pendingInput = null;
    aggregate.processedRequestIds = [
      ...aggregate.processedRequestIds,
      requestId,
    ].slice(-256);
    const reason = message?.trim() || (
      type === "stop" ? "Operator stopped the run." : "Operator interrupted the run."
    );
    if (type === "stop") {
      aggregate.execution.status = "STOPPED";
      aggregate.execution.reason = reason;
      appendEvent(
        aggregate,
        "run.paused",
        reason,
        { control: "stop", requestId },
        recordedAt,
        {
          nodeId: execution?.nodeId ?? aggregate.execution.currentNodeId,
          activationId,
        }
      );
    } else {
      const failure = {
        kind: "interrupted" as const,
        message: reason,
        retryable: false,
        ambiguousMutation: false,
        attemptId: null,
      };
      aggregate.execution.lastFailure = failure;
      aggregate.context.failureSummary = reason;
      aggregate.context.recovery = {
        source: "operator_interrupt",
        message: reason,
        interruptedNodeId: execution?.nodeId ?? aggregate.execution.currentNodeId,
        recordedAt,
      };
      aggregate.execution.currentNodeId = aggregate.definition.applicationPolicy.interruptNodeId;
      aggregate.execution.status = "RUNNING";
      aggregate.execution.reason = null;
      appendEvent(
        aggregate,
        "run.resumed",
        `Interrupt analysis requested: ${reason}`,
        { control: "interrupt", requestId },
        recordedAt,
        {
          nodeId: execution?.nodeId ?? null,
          activationId,
        }
      );
    }
    aggregate.updatedAt = recordedAt;
    return aggregate;
  }

  resumeRun(
    source: Readonly<RunAggregate>,
    reason: string,
    recordedAt: string
  ): RunAggregate {
    const unresolvedMutation = Object.values(source.nodeExecutions).find(
      (execution) => execution.status === "unknown_mutation"
    );
    if (unresolvedMutation) {
      throw new Error(
        `Mutation activation ${unresolvedMutation.activationId} has an unknown outcome; ` +
        "operator reconciliation is required before any replay."
      );
    }
    if (source.execution.status === "BLOCKED") {
      throw new Error(source.execution.reason ?? "Blocked runs cannot be resumed automatically.");
    }
    const aggregate = cloneAggregate(source);
    if (
      aggregate.execution.status === "PAUSED" &&
      aggregate.execution.currentNodeId === aggregate.definition.applicationPolicy.interruptNodeId
    ) {
      aggregate.execution.currentNodeId = aggregate.context.approvedPlan
        ? aggregate.definition.cyclePolicy.startNodeId
        : aggregate.definition.startNodeId;
    }
    aggregate.execution.status = "RUNNING";
    aggregate.execution.reason = reason;
    appendEvent(
      aggregate,
      "run.resumed",
      reason,
      { fromStatus: source.execution.status },
      recordedAt
    );
    aggregate.updatedAt = recordedAt;
    return aggregate;
  }

  reserveNode(
    source: Readonly<RunAggregate>,
    activationId: string,
    recordedAt: string
  ): RunAggregate {
    const aggregate = cloneAggregate(source);
    if (aggregate.execution.status !== "RUNNING") {
      throw new Error(`Cannot reserve a node while run is ${aggregate.execution.status}.`);
    }
    if (aggregate.execution.activeActivationId) {
      throw new Error(`Activation ${aggregate.execution.activeActivationId} is already active.`);
    }
    if (
      aggregate.execution.workflowStepsConsumed >=
      aggregate.definition.budgets.maxWorkflowSteps
    ) {
      throw new WorkflowBudgetError("workflow_steps");
    }
    if (
      Object.keys(aggregate.nodeExecutions).length >=
      aggregate.definition.budgets.maxNodeExecutions
    ) {
      throw new WorkflowBudgetError("node_executions");
    }
    const nodeId = aggregate.execution.currentNodeId;
    const node = aggregate.definition.nodes[nodeId];
    if (!node) throw new Error(`Current node ${nodeId} is not in the compiled definition.`);
    let cycleNumber = aggregate.execution.activeCycleNumber;
    if (nodeId === aggregate.definition.cyclePolicy.startNodeId && cycleNumber === null) {
      if (aggregate.execution.cyclesStarted >= aggregate.definition.budgets.maxCycles) {
        throw new WorkflowBudgetError("cycles");
      }
      aggregate.execution.cyclesStarted += 1;
      cycleNumber = aggregate.execution.cyclesStarted;
      aggregate.execution.activeCycleNumber = cycleNumber;
    }
    const task = node.kind === "task" ? aggregate.definition.tasks[node.taskId!] : null;
    aggregate.execution.workflowStepsConsumed += 1;
    aggregate.execution.activeActivationId = activationId;
    aggregate.nodeExecutions[activationId] = {
      activationId,
      nodeId,
      taskId: node.taskId ?? null,
      agentId: node.agentId ?? null,
      workflowStep: aggregate.execution.workflowStepsConsumed,
      cycleNumber,
      status: "reserved",
      sideEffect: task?.sideEffect ?? "none",
      attemptIds: [],
      reservedAt: recordedAt,
      startedAt: null,
      completedAt: null,
      output: null,
      signal: null,
      failure: null,
    };
    appendEvent(
      aggregate,
      "node.reserved",
      `Node ${nodeId} activation reserved.`,
      {
        workflowStep: aggregate.execution.workflowStepsConsumed,
        cycleNumber,
        sideEffect: task?.sideEffect ?? "none",
      },
      recordedAt,
      { nodeId, activationId }
    );
    aggregate.updatedAt = recordedAt;
    return aggregate;
  }

  startAttempt(
    source: Readonly<RunAggregate>,
    activationId: string,
    attemptId: string,
    recordedAt: string
  ): RunAggregate {
    const aggregate = cloneAggregate(source);
    if (aggregate.execution.activeActivationId !== activationId) {
      throw new Error(`Activation ${activationId} is not active.`);
    }
    const execution = aggregate.nodeExecutions[activationId];
    if (!execution || !["reserved", "running"].includes(execution.status)) {
      throw new Error(`Activation ${activationId} cannot start an attempt.`);
    }
    if (execution.attemptIds.includes(attemptId)) {
      throw new Error(`Attempt ${attemptId} is already recorded.`);
    }
    execution.attemptIds.push(attemptId);
    execution.status = "running";
    execution.startedAt ??= recordedAt;
    appendEvent(
      aggregate,
      "node.started",
      `Node ${execution.nodeId} attempt ${execution.attemptIds.length} started.`,
      { attemptNumber: execution.attemptIds.length },
      recordedAt,
      { nodeId: execution.nodeId, activationId, attemptId }
    );
    aggregate.updatedAt = recordedAt;
    return aggregate;
  }

  requestHumanInput(
    source: Readonly<RunAggregate>,
    requestId: string,
    context: JsonValue,
    recordedAt: string
  ): RunAggregate {
    const aggregate = cloneAggregate(source);
    const activationId = aggregate.execution.activeActivationId;
    if (!activationId) throw new Error("A human gate requires an active activation.");
    const execution = aggregate.nodeExecutions[activationId];
    const node = aggregate.definition.nodes[execution.nodeId];
    if (!node || node.kind !== "human_gate" || !node.gate) {
      throw new Error(`Activation ${activationId} is not a human gate.`);
    }
    if (execution.status !== "reserved") {
      throw new Error(`Human gate activation ${activationId} is not reserved.`);
    }
    execution.status = "waiting_user";
    aggregate.pendingInput = {
      requestId,
      kind: node.gate.type,
      nodeId: node.id,
      activationId,
      prompt: node.gate.prompt,
      allowedSignals: [...node.gate.allowedSignals],
      context,
      createdAt: recordedAt,
    };
    aggregate.execution.status = "WAITING_USER";
    aggregate.execution.reason = node.gate.prompt;
    appendEvent(
      aggregate,
      "human_input.requested",
      `Human input requested for ${node.id}.`,
      { requestId, kind: node.gate.type },
      recordedAt,
      { nodeId: node.id, activationId }
    );
    aggregate.updatedAt = recordedAt;
    return aggregate;
  }

  requestTaskHumanInput(
    source: Readonly<RunAggregate>,
    result: import("../domain/task-result").TaskExecutionResult,
    recordedAt: string
  ): RunAggregate {
    const aggregate = cloneAggregate(source);
    const pending = result.pendingInput;
    const activationId = aggregate.execution.activeActivationId;
    if (result.status !== "waiting_user" || !pending || !activationId) {
      throw new Error("Task human-input request is incomplete.");
    }
    if (pending.activationId !== activationId) {
      throw new Error(`Pending input activation ${pending.activationId} is not active.`);
    }
    const execution = aggregate.nodeExecutions[activationId];
    const node = execution ? aggregate.definition.nodes[execution.nodeId] : null;
    if (!execution || node?.kind !== "task" || execution.status !== "running") {
      throw new Error(`Activation ${activationId} cannot wait for task human input.`);
    }
    for (const artifact of result.artifacts) {
      aggregate.artifacts[artifact.artifactId] = { ...artifact };
    }
    execution.status = "waiting_user";
    aggregate.pendingInput = {
      ...pending,
      allowedSignals: [...pending.allowedSignals],
    };
    aggregate.execution.status = "WAITING_USER";
    aggregate.execution.reason = pending.prompt;
    appendEvent(
      aggregate,
      "human_input.requested",
      `Human input requested for ${execution.nodeId}.`,
      { requestId: pending.requestId, kind: pending.kind },
      recordedAt,
      {
        nodeId: execution.nodeId,
        activationId,
        attemptId: execution.attemptIds[execution.attemptIds.length - 1] ?? null,
      }
    );
    aggregate.updatedAt = recordedAt;
    return aggregate;
  }

  applyHumanResponse(
    source: Readonly<RunAggregate>,
    response: HumanGateResponse
  ): RunAggregate {
    const aggregate = cloneAggregate(source);
    if (aggregate.processedRequestIds.includes(response.requestId)) return aggregate;
    const pending = aggregate.pendingInput;
    if (!pending || pending.requestId !== response.requestId) {
      throw new Error(`Human input request ${response.requestId} is not pending.`);
    }
    if (pending.nodeId !== response.nodeId || !pending.allowedSignals.includes(response.signal)) {
      throw new Error(`Invalid human response for ${pending.nodeId}: ${response.signal}.`);
    }
    if (pending.kind === "plan_approval" && response.signal === "approved") {
      if (!response.choiceId) throw new Error("Plan approval requires a plan choice id.");
      const choice = aggregate.context.planChoices.find(
        (candidate) => candidate.id === response.choiceId
      );
      if (!choice) throw new Error(`Unknown plan choice id: ${response.choiceId}.`);
      const planningActivationId = aggregate.latestCompletedByNode["PLANNING"];
      const planningOutput = aggregate.nodeExecutions[planningActivationId]?.output;
      if (!planningOutput) throw new Error("Plan approval has no completed planning output.");
      aggregate.context.selectedPlanChoiceId = choice.id;
      aggregate.context.approvedPlan = { ...planningOutput };
    } else if (pending.kind === "plan_approval" && response.signal === "revision_requested") {
      aggregate.context.selectedPlanChoiceId = null;
      aggregate.context.approvedPlan = null;
    } else if (pending.kind === "access_approval") {
      if (response.signal === "full_access") {
        aggregate.context.accessMode = "full_access";
      } else if (response.signal === "retry") {
        const pendingContext = pending.context && typeof pending.context === "object" &&
          !Array.isArray(pending.context)
          ? pending.context as Record<string, unknown>
          : null;
        const approvedPaths = Array.isArray(pendingContext?.requestedPaths)
          ? pendingContext.requestedPaths.filter((value): value is string =>
              typeof value === "string" &&
              (/^[A-Za-z]:[\\/]/u.test(value) || /^\/(?!\/)/u.test(value))
            )
          : [];
        aggregate.context.additionalAllowedPaths = [
          ...new Set([...aggregate.context.additionalAllowedPaths, ...approvedPaths]),
        ];
      }
    }
    aggregate.context.humanResponses[pending.nodeId] = { ...response };
    aggregate.processedRequestIds = [
      ...aggregate.processedRequestIds,
      response.requestId,
    ].slice(-256);
    aggregate.pendingInput = null;
    aggregate.execution.status = "RUNNING";
    aggregate.execution.reason = null;
    const execution = aggregate.nodeExecutions[pending.activationId];
    execution.status = pending.kind === "access_approval" ? "reserved" : "running";
    appendEvent(
      aggregate,
      "human_input.received",
      `Human response ${response.signal} received for ${pending.nodeId}.`,
      { requestId: response.requestId, signal: response.signal, choiceId: response.choiceId ?? null },
      response.respondedAt,
      { nodeId: pending.nodeId, activationId: pending.activationId }
    );
    aggregate.updatedAt = response.respondedAt;
    return aggregate;
  }

  completeNode(source: Readonly<RunAggregate>, outcome: NodeOutcome): RunAggregate {
    const aggregate = cloneAggregate(source);
    if (aggregate.execution.activeActivationId !== outcome.activationId) {
      throw new Error(`Outcome activation ${outcome.activationId} is not active.`);
    }
    const execution = aggregate.nodeExecutions[outcome.activationId];
    if (!execution || execution.nodeId !== outcome.nodeId) {
      throw new Error(`Outcome node ${outcome.nodeId} does not match the activation.`);
    }
    for (const artifact of outcome.result.artifacts) {
      const existing = aggregate.artifacts[artifact.artifactId];
      if (existing && existing.sha256 !== artifact.sha256) {
        throw new Error(`Artifact id collision for ${artifact.artifactId}.`);
      }
      aggregate.artifacts[artifact.artifactId] = { ...artifact };
    }
    execution.output = outcome.result.output ? { ...outcome.result.output } : null;
    execution.signal = outcome.result.signal;
    execution.failure = outcome.result.failure ? { ...outcome.result.failure } : null;
    execution.completedAt = outcome.completedAt;
    if (outcome.result.status === "succeeded") {
      if (!outcome.result.signal || !outcome.targetId) {
        throw new Error("Successful node outcome requires a signal and target.");
      }
      execution.status = "completed";
      aggregate.latestCompletedByNode[outcome.nodeId] = outcome.activationId;
      for (const effect of outcome.effects) {
        applyEffect(aggregate, effect, outcome.activationId, outcome.completedAt);
      }
      if (
        outcome.nodeId === aggregate.definition.cyclePolicy.completionNodeId &&
        aggregate.execution.activeCycleNumber !== null
      ) {
        aggregate.execution.cyclesCompleted += 1;
        aggregate.execution.activeCycleNumber = null;
      }
      if (isNodeTarget(aggregate, outcome.targetId)) {
        aggregate.execution.currentNodeId = outcome.targetId;
        aggregate.execution.status = "RUNNING";
        aggregate.execution.reason = null;
      } else if (outcome.terminalStatus) {
        aggregate.execution.status = outcome.terminalStatus;
        aggregate.execution.reason = execution.output?.summary ?? null;
      } else {
        throw new Error(`Outcome target ${outcome.targetId} is neither a node nor terminal.`);
      }
      appendEvent(
        aggregate,
        outcome.terminalStatus === "SUCCESS" ? "run.completed" : "node.completed",
        execution.output?.summary ?? `Node ${outcome.nodeId} completed with ${outcome.result.signal}.`,
        { signal: outcome.result.signal, targetId: outcome.targetId },
        outcome.completedAt,
        {
          nodeId: outcome.nodeId,
          activationId: outcome.activationId,
          attemptId: execution.attemptIds[execution.attemptIds.length - 1] ?? null,
        }
      );
    } else {
      const failure = outcome.result.failure;
      if (!failure) throw new Error("Unsuccessful node outcome requires a failure.");
      if (failure.controlCommand) {
        aggregate.processedRequestIds = [
          ...aggregate.processedRequestIds.filter(
            (requestId) => requestId !== failure.controlCommand!.requestId
          ),
          failure.controlCommand.requestId,
        ].slice(-256);
        if (failure.controlCommand.type === "interrupt") {
          aggregate.context.recovery = {
            source: "operator_interrupt",
            requestId: failure.controlCommand.requestId,
            message: failure.controlCommand.message ?? failure.message,
            interruptedNodeId: outcome.nodeId,
            activationId: outcome.activationId,
            recordedAt: outcome.completedAt,
          };
        }
      }
      execution.status = failure.ambiguousMutation ? "unknown_mutation" : "failed";
      aggregate.execution.lastFailure = { ...failure };
      aggregate.context.failureSummary = failure.message;
      if (outcome.terminalStatus) {
        aggregate.execution.status = outcome.terminalStatus;
      } else if (isNodeTarget(aggregate, outcome.targetId)) {
        aggregate.execution.currentNodeId = outcome.targetId;
        aggregate.execution.status = "RUNNING";
      } else {
        aggregate.execution.status = failure.ambiguousMutation ? "BLOCKED" : "FAILED";
      }
      aggregate.execution.reason = failure.message;
      appendEvent(
        aggregate,
        "node.failed",
        failure.message,
        {
          kind: failure.kind,
          retryable: failure.retryable,
          ambiguousMutation: failure.ambiguousMutation,
          targetId: outcome.targetId,
        },
        outcome.completedAt,
        {
          nodeId: outcome.nodeId,
          activationId: outcome.activationId,
          attemptId: failure.attemptId,
        }
      );
    }
    aggregate.execution.activeActivationId = null;
    aggregate.updatedAt = outcome.completedAt;
    return aggregate;
  }

  recordRetryableFailure(
    source: Readonly<RunAggregate>,
    activationId: string,
    result: import("../domain/task-result").TaskExecutionResult,
    recordedAt: string
  ): RunAggregate {
    const aggregate = cloneAggregate(source);
    if (aggregate.execution.activeActivationId !== activationId) {
      throw new Error(`Activation ${activationId} is not active.`);
    }
    const execution = aggregate.nodeExecutions[activationId];
    if (!result.failure || !result.failure.retryable || result.failure.ambiguousMutation) {
      throw new Error("Only unambiguous retryable failures can be recorded for another attempt.");
    }
    for (const artifact of result.artifacts) {
      aggregate.artifacts[artifact.artifactId] = { ...artifact };
    }
    execution.failure = { ...result.failure };
    execution.status = "running";
    appendEvent(
      aggregate,
      "node.failed",
      `Retryable attempt failed: ${result.failure.message}`,
      { kind: result.failure.kind, retryable: true, willRetry: true },
      recordedAt,
      {
        nodeId: execution.nodeId,
        activationId,
        attemptId: result.failure.attemptId,
      }
    );
    aggregate.updatedAt = recordedAt;
    return aggregate;
  }

  blockForBudget(
    source: Readonly<RunAggregate>,
    error: WorkflowBudgetError,
    recordedAt: string
  ): RunAggregate {
    const aggregate = cloneAggregate(source);
    aggregate.execution.status = "BLOCKED";
    aggregate.execution.reason = error.message;
    aggregate.execution.lastFailure = {
      kind: "budget",
      message: error.message,
      retryable: false,
      ambiguousMutation: false,
      attemptId: null,
    };
    appendEvent(
      aggregate,
      "run.paused",
      error.message,
      { budget: error.budget },
      recordedAt
    );
    aggregate.updatedAt = recordedAt;
    return aggregate;
  }

  recoverStaleActivation(source: Readonly<RunAggregate>, recordedAt: string): RunAggregate {
    const aggregate = cloneAggregate(source);
    const activationId = aggregate.execution.activeActivationId;
    if (!activationId) return aggregate;
    const execution = aggregate.nodeExecutions[activationId];
    if (!execution || execution.status === "reserved" || execution.status === "waiting_user") {
      return aggregate;
    }
    if (execution.status !== "running") return aggregate;
    if (execution.sideEffect === "workspace_mutation") {
      execution.status = "unknown_mutation";
      const message =
        `Mutation activation ${activationId} lost its owner after provider execution began; ` +
        "automatic replay is prohibited.";
      execution.failure = {
        kind: "unknown_mutation",
        message,
        retryable: false,
        ambiguousMutation: true,
        attemptId: execution.attemptIds[execution.attemptIds.length - 1] ?? null,
      };
      aggregate.execution.lastFailure = { ...execution.failure };
      aggregate.execution.status = "BLOCKED";
      aggregate.execution.reason = message;
      appendEvent(
        aggregate,
        "node.failed",
        message,
        { ambiguousMutation: true },
        recordedAt,
        { nodeId: execution.nodeId, activationId, attemptId: execution.failure.attemptId }
      );
    } else {
      execution.status = "reserved";
      aggregate.execution.status = "RUNNING";
      aggregate.execution.reason = "Recovered a stale read-only activation for a bounded retry.";
      appendEvent(
        aggregate,
        "run.resumed",
        aggregate.execution.reason,
        { replaySafe: true },
        recordedAt,
        { nodeId: execution.nodeId, activationId }
      );
    }
    aggregate.updatedAt = recordedAt;
    return aggregate;
  }

  setStatus(
    source: Readonly<RunAggregate>,
    status: RunStatus,
    reason: string | null,
    recordedAt: string
  ): RunAggregate {
    const aggregate = cloneAggregate(source);
    aggregate.execution.status = status;
    aggregate.execution.reason = reason;
    appendEvent(
      aggregate,
      status === "RUNNING" ? "run.resumed" : status === "SUCCESS" ? "run.completed" : "run.paused",
      reason ?? `Run status changed to ${status}.`,
      { status },
      recordedAt
    );
    aggregate.updatedAt = recordedAt;
    return aggregate;
  }

  setAccessMode(
    source: Readonly<RunAggregate>,
    accessMode: "ask" | "full_access",
    recordedAt: string
  ): RunAggregate {
    const aggregate = cloneAggregate(source);
    aggregate.context.accessMode = accessMode;
    aggregate.updatedAt = recordedAt;
    return aggregate;
  }
}
