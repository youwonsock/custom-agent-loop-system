import assert from "node:assert/strict";
import test from "node:test";
import {
  compilePipeline,
  pipelineHash,
  verifyCompiledPipeline,
} from "./pipeline_compiler";
import { defaultPipelineDefinition, stageById } from "./pipeline";

test("pipeline compiler freezes a stable validated default graph snapshot", () => {
  const compiled = compilePipeline(
    defaultPipelineDefinition(),
    "2026-08-16T00:00:00.000Z"
  );
  assert.equal(Object.isFrozen(compiled.pipeline), true);
  assert.equal(Object.isFrozen(compiled.pipeline.stages), true);
  assert.equal(compiled.compilation.pipelineHash, pipelineHash(compiled.pipeline));
  assert.deepEqual(compiled.compilation.approvalGateStageIds, ["MASTER_APPROVAL"]);
  assert.ok(compiled.compilation.terminalTargets.includes("SUCCESS"));
  assert.doesNotThrow(() => verifyCompiledPipeline(compiled.pipeline, compiled.compilation));
});

test("pipeline compiler rejects unreachable and terminal-free reachable stages", () => {
  const unreachable = defaultPipelineDefinition();
  unreachable.stages.push({
    id: "UNREACHABLE",
    name: "Unreachable",
    role: "qa_lead",
    kind: "review",
    instructions: "",
    onSuccess: "PAUSED",
    onFailure: "PAUSED",
    countsIteration: false,
    requiresPlanApproval: false,
    planOptionsCount: 0,
  });
  assert.throws(() => compilePipeline(unreachable), /unreachable stage/i);

  const terminalFree = defaultPipelineDefinition();
  const interrupt = stageById(terminalFree, "INTERRUPT");
  interrupt.onSuccess = "INTERRUPT";
  interrupt.onFailure = "INTERRUPT";
  assert.throws(() => compilePipeline(terminalFree), /no bounded route/i);
});

test("pipeline compiler rejects SUCCESS paths that bypass a configured approval gate", () => {
  const pipeline = defaultPipelineDefinition();
  stageById(pipeline, "IMPLEMENTATION").onFailure = "SUCCESS";
  assert.throws(() => compilePipeline(pipeline), /without an approval executor/i);
});

test("pipeline compiler rejects mutation executors assigned to read-only roles", () => {
  const pipeline = defaultPipelineDefinition();
  stageById(pipeline, "IMPLEMENTATION").role = "planner";
  assert.throws(() => compilePipeline(pipeline), /cannot use read-only role/i);
});

test("pipeline compiler analyzes non-counting cycles as workflow-step-consuming", () => {
  const pipeline = defaultPipelineDefinition();
  stageById(pipeline, "TEST_GENERATION").onFailure = "TEST_GENERATION";
  stageById(pipeline, "VERIFICATION").onFailure = "PAUSED";
  stageById(pipeline, "MASTER_APPROVAL").onFailure = "PAUSED";
  const compiled = compilePipeline(pipeline);
  const component = compiled.compilation.cyclicComponents.find(
    (candidate) => candidate.stageIds.length === 1 && candidate.stageIds[0] === "TEST_GENERATION"
  );
  assert.deepEqual(component, {
    stageIds: ["TEST_GENERATION"],
    consumesCycle: false,
    consumesWorkflowStep: true,
  });
});

test("compiled pipeline verification rejects a changed live-session graph", () => {
  const compiled = compilePipeline(defaultPipelineDefinition());
  const changed = JSON.parse(JSON.stringify(compiled.pipeline));
  stageById(changed, "IMPLEMENTATION").instructions = "changed after creation";
  assert.throws(
    () => verifyCompiledPipeline(changed, compiled.compilation),
    /pipeline hash mismatch/i
  );
});
