import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import type { AgentRuntime } from "../../agent_runtime";
import type { LoopState, StageActivationReservation } from "../../loop_state";
import { executorForStage, stageById } from "../../pipeline";
import type { SessionRepository } from "../../session_repository";
import { StageExecutorRegistry } from "../../stage_executor_registry";
import {
  LoopStatus,
  TransitionDecision,
  WorkflowEngine,
} from "../../workflow_contracts";
import { CurrentWorkflowEngine } from "../../workflow_engine";

export const LANGGRAPH_SPIKE_VERSION = 1;

export type LangGraphSpikeInvariantCode =
  | "SESSION_CHANGED"
  | "REVISION_CHANGED"
  | "FENCING_CHANGED"
  | "STAGE_CHANGED"
  | "ACTIVATION_CHANGED"
  | "ACTIVATION_NOT_EXECUTABLE"
  | "UNKNOWN_MUTATION_OUTCOME"
  | "WORKFLOW_NOT_RUNNING";

export class LangGraphSpikeInvariantError extends Error {
  constructor(
    readonly code: LangGraphSpikeInvariantCode,
    message: string
  ) {
    super(message);
    this.name = "LangGraphSpikeInvariantError";
  }
}

export interface LangGraphAdapterDependencies {
  stageExecutors: StageExecutorRegistry;
  agentRuntime: Pick<AgentRuntime, "launch">;
  sessionRepository: Pick<SessionRepository, "load">;
}

export interface ReservedStageInvocation {
  sessionId: string;
  stageId: string;
  activationId: string;
  expectedAggregateRevision: number;
  expectedFencingEpoch: number;
}

export interface ReservedStageInvocationResult {
  stageId: string;
  activationId: string;
  checkedAggregateRevision: number;
  checkedFencingEpoch: number;
  executed: boolean;
}

export interface LangGraphAdapterInspection {
  productionEligible: false;
  persistenceAuthority: "session_repository";
  langGraphCheckpointer: "disabled";
  automaticNodeRetries: false;
  providerLaunchBoundary: "agent_runtime_via_existing_stage_executor";
  transitionAuthority: "current_workflow_engine";
}

interface EvaluationGraphState {
  request: ReservedStageInvocation;
  checkedAggregateRevision: number;
  checkedFencingEpoch: number;
  executed: boolean;
}

const EvaluationState = Annotation.Root({
  request: Annotation<ReservedStageInvocation>(),
  checkedAggregateRevision: Annotation<number>(),
  checkedFencingEpoch: Annotation<number>(),
  executed: Annotation<boolean>({
    reducer: (_left, right) => right,
    default: () => false,
  }),
});

function assertExecutableActivation(
  activation: StageActivationReservation | null,
  request: ReservedStageInvocation
): asserts activation is StageActivationReservation {
  if (activation?.status === "unknown_mutation") {
    throw new LangGraphSpikeInvariantError(
      "UNKNOWN_MUTATION_OUTCOME",
      `Activation ${activation.activationId} has an unknown mutation outcome and requires operator reconciliation.`
    );
  }
  if (!activation || activation.activationId !== request.activationId) {
    throw new LangGraphSpikeInvariantError(
      "ACTIVATION_CHANGED",
      `Expected activation ${request.activationId}, but the authoritative activation changed.`
    );
  }
  if (activation.stageId !== request.stageId) {
    throw new LangGraphSpikeInvariantError(
      "STAGE_CHANGED",
      `Activation ${activation.activationId} belongs to stage ${activation.stageId}, not ${request.stageId}.`
    );
  }
  if (activation.status !== "reserved" && activation.status !== "running") {
    throw new LangGraphSpikeInvariantError(
      "ACTIVATION_NOT_EXECUTABLE",
      `Activation ${activation.activationId} is ${activation.status}; only reserved or running activations may execute.`
    );
  }
}

function assertAuthoritativeState(
  state: LoopState,
  request: ReservedStageInvocation,
  checked?: Pick<EvaluationGraphState, "checkedAggregateRevision" | "checkedFencingEpoch">
): void {
  if (state.sessionId !== request.sessionId) {
    throw new LangGraphSpikeInvariantError(
      "SESSION_CHANGED",
      `Expected session ${request.sessionId}, but repository loaded ${state.sessionId}.`
    );
  }
  // Preserve the most safety-specific recovery diagnosis even though recovery
  // also pauses the workflow aggregate.
  assertExecutableActivation(state.currentActivation, request);
  if (state.status !== LoopStatus.RUNNING) {
    throw new LangGraphSpikeInvariantError(
      "WORKFLOW_NOT_RUNNING",
      `Session ${state.sessionId} is ${state.status}, not RUNNING.`
    );
  }
  if (state.phase !== request.stageId) {
    throw new LangGraphSpikeInvariantError(
      "STAGE_CHANGED",
      `Expected stage ${request.stageId}, but authoritative stage is ${state.phase}.`
    );
  }
  if (state.aggregateRevision !== request.expectedAggregateRevision) {
    throw new LangGraphSpikeInvariantError(
      "REVISION_CHANGED",
      `Expected aggregate revision ${request.expectedAggregateRevision}, but loaded ${state.aggregateRevision}.`
    );
  }
  if (state.fencingEpoch !== request.expectedFencingEpoch) {
    throw new LangGraphSpikeInvariantError(
      "FENCING_CHANGED",
      `Expected fencing epoch ${request.expectedFencingEpoch}, but loaded ${state.fencingEpoch}.`
    );
  }
  if (
    checked &&
    (checked.checkedAggregateRevision !== state.aggregateRevision ||
      checked.checkedFencingEpoch !== state.fencingEpoch)
  ) {
    throw new LangGraphSpikeInvariantError(
      checked.checkedAggregateRevision !== state.aggregateRevision
        ? "REVISION_CHANGED"
        : "FENCING_CHANGED",
      "The authoritative aggregate changed between LangGraph super-steps."
    );
  }
}

/**
 * Development-only evaluation adapter. It deliberately compiles without a
 * LangGraph checkpointer: the existing repository remains the sole authority.
 * Existing stage executors continue to own provider execution, transitions,
 * budgets, and commits, so this graph is a wrapper rather than a replacement.
 */
export class LangGraphWorkflowEngineAdapter implements WorkflowEngine<LoopState> {
  private readonly transitionEngine = new CurrentWorkflowEngine<LoopState>();
  private readonly invokeGraph: (
    input: Pick<EvaluationGraphState, "request">
  ) => Promise<EvaluationGraphState>;

  constructor(dependencies: LangGraphAdapterDependencies) {
    if (typeof dependencies.agentRuntime.launch !== "function") {
      throw new TypeError("The existing AgentRuntime launch boundary is required.");
    }

    const graph = new StateGraph(EvaluationState)
      .addNode(
        "authoritative_preflight",
        async (graphState: typeof EvaluationState.State) => {
          const authoritative = await dependencies.sessionRepository.load();
          assertAuthoritativeState(authoritative, graphState.request);
          return {
            checkedAggregateRevision: authoritative.aggregateRevision,
            checkedFencingEpoch: authoritative.fencingEpoch,
          };
        },
        { retryPolicy: { maxAttempts: 1 } }
      )
      .addNode(
        "execute_existing_stage",
        async (graphState: typeof EvaluationState.State) => {
          const authoritative = await dependencies.sessionRepository.load();
          assertAuthoritativeState(authoritative, graphState.request, graphState);
          const stage = stageById(authoritative.pipeline, graphState.request.stageId);
          await dependencies.stageExecutors.execute(
            executorForStage(authoritative.pipeline, stage),
            stage
          );
          return { executed: true };
        },
        { retryPolicy: { maxAttempts: 1 } }
      )
      .addEdge(START, "authoritative_preflight")
      .addEdge("authoritative_preflight", "execute_existing_stage")
      .addEdge("execute_existing_stage", END)
      // Intentionally no checkpointer: duplicate state authority is a hard stop.
      .compile();

    this.invokeGraph = (input) => graph.invoke(input);
  }

  applyTarget(state: LoopState, target: string): TransitionDecision {
    return this.transitionEngine.applyTarget(state, target);
  }

  async executeReservedStage(
    request: ReservedStageInvocation
  ): Promise<ReservedStageInvocationResult> {
    const result = await this.invokeGraph({ request });
    return {
      stageId: request.stageId,
      activationId: request.activationId,
      checkedAggregateRevision: result.checkedAggregateRevision,
      checkedFencingEpoch: result.checkedFencingEpoch,
      executed: result.executed,
    };
  }

  inspect(): LangGraphAdapterInspection {
    return {
      productionEligible: false,
      persistenceAuthority: "session_repository",
      langGraphCheckpointer: "disabled",
      automaticNodeRetries: false,
      providerLaunchBoundary: "agent_runtime_via_existing_stage_executor",
      transitionAuthority: "current_workflow_engine",
    };
  }
}
