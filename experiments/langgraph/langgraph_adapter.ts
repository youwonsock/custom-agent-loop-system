import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import type { CompiledWorkflowBundle } from "../../src/domain/workflow";

export const LANGGRAPH_STRUCTURE_SPIKE_VERSION = 2;

export interface GraphTransitionRequest {
  nodeId: string;
  signal: string;
}

export interface GraphTransitionResult extends GraphTransitionRequest {
  targetId: string;
  terminalStatus: string | null;
}

export interface LangGraphStructureInspection {
  productionEligible: false;
  definitionHash: string;
  persistenceAuthority: "v4_run_repository";
  langGraphCheckpointer: "disabled";
  providerExecution: "disabled";
  stateMutation: "disabled";
  automaticNodeRetries: false;
  nodeCount: number;
  transitionCount: number;
}

interface EvaluationGraphState {
  request: GraphTransitionRequest;
  result: GraphTransitionResult | null;
}

const EvaluationState = Annotation.Root({
  request: Annotation<GraphTransitionRequest>(),
  result: Annotation<GraphTransitionResult | null>({
    reducer: (_left, right) => right,
    default: () => null,
  }),
});

const TERMINAL_STATUS: Record<string, string> = {
  succeeded: "SUCCESS",
  paused: "PAUSED",
  blocked: "BLOCKED",
  stopped: "STOPPED",
};

/**
 * Development-only structural comparison. It routes one already-validated
 * signal through LangGraph but owns no provider, checkpoint, retry, effect, or
 * aggregate mutation. Production continues to use WorkflowRunner.
 */
export class LangGraphStructureAdapter {
  private readonly invokeGraph: (
    input: Pick<EvaluationGraphState, "request">
  ) => Promise<EvaluationGraphState>;

  constructor(private readonly bundle: Readonly<CompiledWorkflowBundle>) {
    const graph = new StateGraph(EvaluationState)
      .addNode(
        "route_compiled_signal",
        (state: typeof EvaluationState.State) => {
          const targetId = bundle.transitions[state.request.nodeId]?.[state.request.signal];
          if (!targetId) {
            throw new Error(
              `No compiled transition for ${state.request.nodeId}.${state.request.signal}.`
            );
          }
          const terminal = bundle.terminals.find((candidate) => candidate.id === targetId);
          return {
            result: {
              ...state.request,
              targetId,
              terminalStatus: terminal ? TERMINAL_STATUS[terminal.status] ?? null : null,
            },
          };
        },
        { retryPolicy: { maxAttempts: 1 } }
      )
      .addEdge(START, "route_compiled_signal")
      .addEdge("route_compiled_signal", END)
      // Deliberately no checkpointer: this experiment cannot become state authority.
      .compile();
    this.invokeGraph = (input) => graph.invoke(input);
  }

  async route(request: GraphTransitionRequest): Promise<GraphTransitionResult> {
    const state = await this.invokeGraph({ request });
    if (!state.result) throw new Error("LangGraph structural route produced no result.");
    return state.result;
  }

  inspect(): LangGraphStructureInspection {
    return {
      productionEligible: false,
      definitionHash: this.bundle.definitionHash,
      persistenceAuthority: "v4_run_repository",
      langGraphCheckpointer: "disabled",
      providerExecution: "disabled",
      stateMutation: "disabled",
      automaticNodeRetries: false,
      nodeCount: Object.keys(this.bundle.nodes).length,
      transitionCount: Object.values(this.bundle.transitions)
        .reduce((count, transitions) => count + Object.keys(transitions).length, 0),
    };
  }
}
