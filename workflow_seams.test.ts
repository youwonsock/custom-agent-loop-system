import assert from "node:assert/strict";
import test from "node:test";
import {
  PIPELINE_STAGE_EXECUTORS,
  PipelineStageExecutor,
  defaultPipelineDefinition,
  stageById,
  stageTypeForStage,
} from "./pipeline";
import { StageExecutorMap, StageExecutorRegistry } from "./stage_executor_registry";
import { LoopStatus } from "./workflow_contracts";
import { applyPipelineTarget } from "./workflow_engine";

function executorMap(
  execute: (executor: PipelineStageExecutor) => Promise<void>
): StageExecutorMap {
  return {
    planning: { execute: () => execute("planning") },
    implementation: { execute: () => execute("implementation") },
    test: { execute: () => execute("test") },
    review: { execute: () => execute("review") },
    approval: { execute: () => execute("approval") },
    interrupt: { execute: () => execute("interrupt") },
  };
}

test("workflow engine preserves current stage and terminal target semantics", () => {
  const pipeline = defaultPipelineDefinition();
  const state = {
    status: LoopStatus.RUNNING,
    phase: pipeline.startStageId,
    pipeline,
  };

  const nextStage = stageById(pipeline, pipeline.startStageId).onSuccess;
  const transition = applyPipelineTarget(state, nextStage);
  assert.deepEqual(transition, {
    sourceStageId: pipeline.startStageId,
    target: nextStage,
  });
  assert.equal(state.phase, nextStage);
  assert.equal(state.status, LoopStatus.RUNNING);

  const paused = applyPipelineTarget(state, "PAUSED");
  assert.equal(paused.terminalStatus, LoopStatus.PAUSED);
  assert.equal(state.status, LoopStatus.PAUSED);

  state.status = LoopStatus.RUNNING;
  const succeeded = applyPipelineTarget(state, "SUCCESS");
  assert.equal(succeeded.terminalStatus, LoopStatus.SUCCESS);
  assert.equal(state.status, LoopStatus.SUCCESS);
});

test("workflow engine validates a stage target before mutating the cursor", () => {
  const pipeline = defaultPipelineDefinition();
  const state = {
    status: LoopStatus.RUNNING,
    phase: pipeline.startStageId,
    pipeline,
  };

  assert.throws(() => applyPipelineTarget(state, "missing-stage"), /Unknown pipeline stage/);
  assert.equal(state.phase, pipeline.startStageId);
  assert.equal(state.status, LoopStatus.RUNNING);
});

test("stage executor registry dispatches all six built-in executors", async () => {
  const called: PipelineStageExecutor[] = [];
  const registry = new StageExecutorRegistry(executorMap(async (executor) => {
    called.push(executor);
  }));
  const pipeline = defaultPipelineDefinition();

  for (const executor of PIPELINE_STAGE_EXECUTORS) {
    const stage = pipeline.stages.find(
      (candidate) => stageTypeForStage(pipeline, candidate).executor === executor
    );
    assert.ok(stage, `expected a built-in stage for executor '${executor}'`);
    await registry.execute(executor, stage);
  }

  assert.deepEqual(called, PIPELINE_STAGE_EXECUTORS);
});

test("stage executor registry rejects an unknown runtime executor", () => {
  const registry = new StageExecutorRegistry(executorMap(async () => undefined));
  const pipeline = defaultPipelineDefinition();

  assert.throws(
    () => registry.execute("unknown" as PipelineStageExecutor, pipeline.stages[0]),
    /Unknown pipeline stage executor/
  );
});
