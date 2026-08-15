import { stageById } from "./pipeline";
import {
  LoopStatus,
  TransitionDecision,
  WorkflowCursor,
  WorkflowEngine,
} from "./workflow_contracts";

export class CurrentWorkflowEngine<TState extends WorkflowCursor = WorkflowCursor>
  implements WorkflowEngine<TState>
{
  applyTarget(state: TState, target: string): TransitionDecision {
    const sourceStageId = state.phase;
    if (target === "SUCCESS") {
      state.status = LoopStatus.SUCCESS;
      return { sourceStageId, target, terminalStatus: LoopStatus.SUCCESS };
    }
    if (target === "PAUSED") {
      state.status = LoopStatus.PAUSED;
      return { sourceStageId, target, terminalStatus: LoopStatus.PAUSED };
    }
    if (target === "BLOCKED") {
      state.status = LoopStatus.BLOCKED;
      return { sourceStageId, target, terminalStatus: LoopStatus.BLOCKED };
    }
    stageById(state.pipeline, target);
    state.phase = target;
    return { sourceStageId, target };
  }
}

export const currentWorkflowEngine = new CurrentWorkflowEngine();

export function applyPipelineTarget(state: WorkflowCursor, target: string): TransitionDecision {
  return currentWorkflowEngine.applyTarget(state, target);
}
