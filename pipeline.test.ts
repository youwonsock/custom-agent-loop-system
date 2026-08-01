import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultPipelineDefinition,
  roleForStage,
  stageById,
  validatePipeline,
} from "./pipeline";

test("default pipeline preserves autonomous mutual verification stages", () => {
  const pipeline = validatePipeline(defaultPipelineDefinition());
  assert.equal(pipeline.stages.length, 6);
  assert.equal(stageById(pipeline, pipeline.startStageId).kind, "planning");
  assert.equal(stageById(pipeline, pipeline.startStageId).requiresPlanApproval, true);
  assert.equal(stageById(pipeline, pipeline.interruptStageId).kind, "interrupt");
});

test("custom stages and specialized role assignments are accepted", () => {
  const pipeline = defaultPipelineDefinition();
  pipeline.roles.push({
    id: "security_reviewer",
    modelRole: "qa_lead",
    description: "Security specialist",
    instructions: "Inspect trust boundaries and injection risks.",
  });
  pipeline.stages.splice(4, 0, {
    id: "SECURITY_REVIEW",
    name: "Security review",
    role: "security_reviewer",
    kind: "review",
    instructions: "Reject exploitable behavior.",
    onSuccess: "MASTER_APPROVAL",
    onFailure: "IMPLEMENTATION",
    countsIteration: false,
    requiresPlanApproval: false,
    planOptionsCount: 0,
  });
  stageById(pipeline, "VERIFICATION").onSuccess = "SECURITY_REVIEW";
  const validated = validatePipeline(pipeline);
  assert.equal(roleForStage(validated, stageById(validated, "SECURITY_REVIEW")).modelRole, "qa_lead");
});

test("invalid transitions are rejected", () => {
  const pipeline = defaultPipelineDefinition();
  pipeline.stages[0].onSuccess = "MISSING";
  assert.throws(() => validatePipeline(pipeline), /unknown transition target/i);
});
