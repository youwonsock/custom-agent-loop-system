import type { NodeOutcome, RunAggregate } from "../domain/run-aggregate";
import type { TaskExecutionResult } from "../domain/task-result";
import type { AgentTaskRunner } from "./agent-task-runner";
import type { NodeExecutionContext } from "./node-execution-context";
import type { ProjectionPort } from "./ports/projection";
import type { RunRepositoryPort } from "./ports/run-repository";
import type { RunControlCommandPort } from "./ports/control-command";
import { RunReducer, WorkflowBudgetError } from "./run-reducer";
import { TaskInputAssembler } from "./task-input-assembler";
import { TransitionRouter } from "./transition-router";

export interface WorkflowRunnerClock {
  now(): string;
  delay(milliseconds: number): Promise<void>;
}

export interface WorkflowRunnerIds {
  activation(runId: string, sequence: number): string;
  attempt(activationId: string, sequence: number): string;
  request(activationId: string): string;
}

const DEFAULT_CLOCK: WorkflowRunnerClock = {
  now: () => new Date().toISOString(),
  delay: (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, Math.max(0, milliseconds))),
};

const DEFAULT_IDS: WorkflowRunnerIds = {
  activation: (_runId, sequence) =>
    `activation_${String(sequence).padStart(8, "0")}`,
  attempt: (activationId, sequence) =>
    `attempt_${activationId}_${String(sequence).padStart(3, "0")}`,
  request: (activationId) => `request_${activationId}`,
};

const NOOP_CONTROLS: RunControlCommandPort = {
  enqueue: async () => {
    throw new Error("Run control commands are not configured.");
  },
  recover: async () => undefined,
  claim: async () => null,
  complete: async () => undefined,
};

export interface WorkflowRunnerOptions {
  maxStepsPerInvocation?: number;
}

export class WorkflowRunner {
  constructor(
    private readonly repository: RunRepositoryPort,
    private readonly reducer: RunReducer,
    private readonly router: TransitionRouter,
    private readonly taskRunner: AgentTaskRunner,
    private readonly inputAssembler: TaskInputAssembler,
    private readonly projection: ProjectionPort,
    private readonly clock: WorkflowRunnerClock = DEFAULT_CLOCK,
    private readonly ids: WorkflowRunnerIds = DEFAULT_IDS,
    private readonly controls: RunControlCommandPort = NOOP_CONTROLS
  ) {}

  async runUntilBoundary(
    runId: string,
    options: WorkflowRunnerOptions = {}
  ): Promise<RunAggregate> {
    const maxSteps = options.maxStepsPerInvocation ?? Number.MAX_SAFE_INTEGER;
    let completedSteps = 0;
    let aggregate = await this.repository.load(runId);
    await this.controls.recover(runId);
    while (aggregate.execution.status === "RUNNING" && completedSteps < maxSteps) {
      const control = await this.controls.claim(runId);
      if (control) {
        try {
          if (!aggregate.processedRequestIds.includes(control.requestId)) {
            const controlled = this.reducer.applyBoundaryControl(
              aggregate,
              control.requestId,
              control.type,
              control.message,
              this.clock.now(),
              true
            );
            aggregate = await this.commit(controlled, aggregate);
            await this.projection.update(aggregate);
          }
          await this.controls.complete(
            control,
            "completed",
            `Run control '${control.type}' was applied at a workflow boundary.`
          );
        } catch (error) {
          await this.controls.complete(
            control,
            "failed",
            error instanceof Error ? error.message : String(error)
          ).catch(() => undefined);
          throw error;
        }
        if (aggregate.execution.status !== "RUNNING") return aggregate;
        continue;
      }
      if (!aggregate.execution.activeActivationId) {
        try {
          const activationId = this.ids.activation(
            aggregate.runId,
            Object.keys(aggregate.nodeExecutions).length + 1
          );
          const reserved = this.reducer.reserveNode(aggregate, activationId, this.clock.now());
          aggregate = await this.commit(reserved, aggregate);
        } catch (error) {
          if (!(error instanceof WorkflowBudgetError)) throw error;
          const blocked = this.reducer.blockForBudget(aggregate, error, this.clock.now());
          aggregate = await this.commit(blocked, aggregate);
          await this.projection.update(aggregate);
          return aggregate;
        }
      }
      const activationId = aggregate.execution.activeActivationId!;
      const execution = aggregate.nodeExecutions[activationId];
      const node = aggregate.definition.nodes[execution.nodeId];
      if (node.kind === "human_gate") {
        if (execution.status === "reserved") {
          const context: NodeExecutionContext = {
            aggregate,
            node,
            activationId,
            attemptId: "",
            attemptNumber: 0,
          };
          const input = await this.inputAssembler.assemble(context);
          const waiting = this.reducer.requestHumanInput(
            aggregate,
            this.ids.request(activationId),
            input.value,
            this.clock.now()
          );
          aggregate = await this.commit(waiting, aggregate);
          await this.projection.update(aggregate);
          return aggregate;
        }
        const response = aggregate.context.humanResponses[node.id];
        if (!response) {
          throw new Error(`Human gate ${node.id} is active without a recorded response.`);
        }
        const route = this.router.route(aggregate.definition, node.id, response.signal);
        const result: TaskExecutionResult = {
          status: "succeeded",
          signal: response.signal,
          output: null,
          effects: [],
          artifacts: [],
          failure: null,
          pendingInput: null,
        };
        const outcome: NodeOutcome = {
          nodeId: node.id,
          activationId,
          result,
          targetId: route.targetId,
          terminalStatus: route.terminalStatus,
          effects: [],
          completedAt: this.clock.now(),
        };
        const completed = this.reducer.completeNode(aggregate, outcome);
        aggregate = await this.commit(completed, aggregate);
        completedSteps += 1;
        await this.projection.update(aggregate);
        continue;
      }

      const task = aggregate.definition.tasks[node.taskId!];
      const agent = aggregate.definition.agents[node.agentId!];
      const attemptNumber = execution.attemptIds.length + 1;
      if (attemptNumber > task.retryPolicy.maxAttempts) {
        const exhausted = this.retryExhaustedResult(
          execution.attemptIds[execution.attemptIds.length - 1] ?? null
        );
        aggregate = await this.commitTaskResult(aggregate, node.id, activationId, exhausted);
        completedSteps += 1;
        await this.projection.update(aggregate);
        continue;
      }
      const attemptId = this.ids.attempt(activationId, attemptNumber);
      const started = this.reducer.startAttempt(
        aggregate,
        activationId,
        attemptId,
        this.clock.now()
      );
      aggregate = await this.commit(started, aggregate);
      const context: NodeExecutionContext = {
        aggregate,
        node,
        activationId,
        attemptId,
        attemptNumber,
      };
      let result: TaskExecutionResult;
      try {
        result = await this.taskRunner.run(context, agent, task);
      } catch (error) {
        result = {
          status: "failed",
          signal: "error",
          output: null,
          effects: [],
          artifacts: [],
          failure: {
            kind: "internal",
            message: error instanceof Error ? error.message : String(error),
            retryable: false,
            ambiguousMutation: task.sideEffect === "workspace_mutation",
            attemptId,
          },
          pendingInput: null,
        };
      }
      if (result.status === "waiting_user" && result.pendingInput) {
        const waiting = this.reducer.requestTaskHumanInput(
          aggregate,
          result,
          this.clock.now()
        );
        aggregate = await this.commit(waiting, aggregate);
        await this.projection.update(aggregate);
        return aggregate;
      }
      if (
        result.status === "failed" &&
        result.failure?.retryable &&
        !result.failure.ambiguousMutation &&
        attemptNumber < task.retryPolicy.maxAttempts
      ) {
        const retryRecorded = this.reducer.recordRetryableFailure(
          aggregate,
          activationId,
          result,
          this.clock.now()
        );
        aggregate = await this.commit(retryRecorded, aggregate);
        const delay = task.retryPolicy.backoffMs[
          Math.min(attemptNumber - 1, Math.max(0, task.retryPolicy.backoffMs.length - 1))
        ] ?? 0;
        await this.projection.update(aggregate);
        if (delay > 0) await this.clock.delay(delay);
        continue;
      }
      aggregate = await this.commitTaskResult(
        aggregate,
        node.id,
        activationId,
        result
      );
      if (result.failure?.controlCommand) {
        await this.controls.complete(
          result.failure.controlCommand,
          "completed",
          `Run control '${result.failure.controlCommand.type}' was applied after provider termination.`
        );
      }
      completedSteps += 1;
      await this.projection.update(aggregate);
    }
    return aggregate;
  }

  private async commitTaskResult(
    aggregate: RunAggregate,
    nodeId: string,
    activationId: string,
    result: TaskExecutionResult
  ): Promise<RunAggregate> {
    let targetId: string | null = null;
    let terminalStatus: RunAggregate["execution"]["status"] | null = null;
    if (result.status === "succeeded" && result.signal) {
      const route = this.router.route(aggregate.definition, nodeId, result.signal);
      targetId = route.targetId;
      terminalStatus = route.terminalStatus;
      const convergenceEffect = result.effects.find(
        (effect) => effect.type === "update_convergence" && !effect.improved
      );
      if (
        convergenceEffect &&
        aggregate.context.convergence.stagnantCycles + 1 >= 2
      ) {
        targetId = aggregate.definition.applicationPolicy.interruptNodeId;
        terminalStatus = null;
      }
    } else if (result.failure) {
      if (result.failure.kind === "stopped") {
        targetId = "STOPPED";
        terminalStatus = "STOPPED";
      } else if (result.failure.kind === "interrupted") {
        targetId = aggregate.definition.applicationPolicy.interruptNodeId;
      } else if (
        result.failure.ambiguousMutation ||
        ["security", "budget", "unknown_mutation"].includes(result.failure.kind)
      ) {
        targetId = aggregate.definition.applicationPolicy.blockedTerminalId;
        terminalStatus = "BLOCKED";
      } else if (nodeId === aggregate.definition.applicationPolicy.interruptNodeId) {
        const paused = aggregate.definition.terminals.find(
          (terminal) => terminal.status === "paused"
        );
        targetId = paused?.id ?? null;
        terminalStatus = "PAUSED";
      } else {
        targetId = aggregate.definition.applicationPolicy.interruptNodeId;
      }
    }
    const outcome: NodeOutcome = {
      nodeId,
      activationId,
      result,
      targetId,
      terminalStatus,
      effects: result.effects,
      completedAt: this.clock.now(),
    };
    return this.commit(this.reducer.completeNode(aggregate, outcome), aggregate);
  }

  private retryExhaustedResult(attemptId: string | null): TaskExecutionResult {
    return {
      status: "failed",
      signal: "error",
      output: null,
      effects: [],
      artifacts: [],
      failure: {
        kind: "provider",
        message: "Task retry policy was exhausted.",
        retryable: false,
        ambiguousMutation: false,
        attemptId,
      },
      pendingInput: null,
    };
  }

  private commit(
    candidate: RunAggregate,
    previous: RunAggregate
  ): Promise<RunAggregate> {
    return this.repository.commit(
      candidate,
      previous.revision,
      previous.fencingEpoch
    );
  }
}
