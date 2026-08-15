import {
  PIPELINE_STAGE_EXECUTORS,
  PipelineStage,
  PipelineStageExecutor,
} from "./pipeline";
import { StageExecutor } from "./workflow_contracts";

export type StageExecutorMap = Record<PipelineStageExecutor, StageExecutor>;

export class StageExecutorRegistry {
  constructor(private readonly executors: StageExecutorMap) {
    for (const executor of PIPELINE_STAGE_EXECUTORS) {
      if (!executors[executor]) {
        throw new Error(`Missing pipeline stage executor registration: ${executor}`);
      }
    }
  }

  execute(executor: PipelineStageExecutor, stage: PipelineStage): Promise<void> {
    const registered = this.executors[executor];
    if (!registered) {
      throw new Error(`Unknown pipeline stage executor: ${String(executor)}`);
    }
    return registered.execute(stage);
  }
}

