import test from "node:test";
import assert from "node:assert/strict";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  defaultAgentLoopDefinition,
  defaultAgentRolesDefinition,
  defaultPipelineDefinition,
  executorForStage,
  loadSeparatedPipelineDefinition,
  roleForStage,
  stageById,
  validatePipeline,
} from "./pipeline";

test("separate role and loop files compose a validated custom pipeline", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-loop-split-config-"));
  try {
    const roles = defaultAgentRolesDefinition();
    roles.roles.push({
      id: "security_reviewer",
      modelRole: "qa_lead",
      description: "Security specialist",
      instructions: "Audit trust boundaries.",
    });
    const loop = defaultAgentLoopDefinition();
    loop.stageTypes!.push({
      id: "security_review",
      label: "Security review",
      executor: "review",
      completionContract: "approval",
      description: "Security-specific review.",
    });
    loop.stages.splice(4, 0, {
      id: "SECURITY_REVIEW",
      name: "Security review",
      role: "security_reviewer",
      kind: "security_review",
      instructions: "Reject exploitable behavior.",
      onSuccess: "MASTER_APPROVAL",
      onFailure: "IMPLEMENTATION",
      countsIteration: false,
      requiresPlanApproval: false,
      planOptionsCount: 0,
    });
    stageById({ ...defaultPipelineDefinition(), stages: loop.stages }, "VERIFICATION").onSuccess = "SECURITY_REVIEW";
    const rolesPath = path.join(root, "roles.json");
    const loopPath = path.join(root, "loop.json");
    await fsp.writeFile(rolesPath, JSON.stringify(roles), "utf8");
    await fsp.writeFile(loopPath, JSON.stringify(loop), "utf8");

    const pipeline = await loadSeparatedPipelineDefinition(rolesPath, loopPath);
    const stage = stageById(pipeline, "SECURITY_REVIEW");
    assert.equal(roleForStage(pipeline, stage).id, "security_reviewer");
    assert.equal(executorForStage(pipeline, stage), "review");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

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
    provider: "claude",
    model: "sonnet",
  });
  pipeline.stageTypes!.push({
    id: "security_review",
    label: "Security Review",
    executor: "review",
    completionContract: "approval",
    description: "Security-specific review backed by the review executor.",
  });
  pipeline.stages.splice(4, 0, {
    id: "SECURITY_REVIEW",
    name: "Security review",
    role: "security_reviewer",
    kind: "security_review",
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
  assert.equal(roleForStage(validated, stageById(validated, "SECURITY_REVIEW")).provider, "claude");
  assert.equal(executorForStage(validated, stageById(validated, "SECURITY_REVIEW")), "review");
});

test("legacy pipelines receive built-in stage types during normalization", () => {
  const pipeline = defaultPipelineDefinition();
  delete pipeline.stageTypes;
  const normalized = validatePipeline(pipeline);
  assert.equal(normalized.stageTypes?.length, 6);
  assert.equal(executorForStage(normalized, stageById(normalized, "IMPLEMENTATION")), "implementation");
});

test("stage type completion contracts must match their selected executor", () => {
  const pipeline = defaultPipelineDefinition();
  pipeline.stageTypes!.push({
    id: "broken_review",
    label: "Broken review",
    executor: "review",
    completionContract: "phase_done",
    description: "Invalid on purpose.",
  });
  assert.throws(() => validatePipeline(pipeline), /requires completion contract approval/i);
});

test("legacy per-role tool overrides are removed in favor of global tool access", () => {
  const pipeline = defaultPipelineDefinition();
  const legacyRole = pipeline.roles[0] as typeof pipeline.roles[number] & {
    webSearch?: boolean;
    mcpServers?: string[];
  };
  legacyRole.webSearch = false;
  legacyRole.mcpServers = ["private_docs"];
  const normalized = validatePipeline(pipeline);
  assert.equal("webSearch" in normalized.roles[0], false);
  assert.equal("mcpServers" in normalized.roles[0], false);
});

test("invalid transitions are rejected", () => {
  const pipeline = defaultPipelineDefinition();
  pipeline.stages[0].onSuccess = "MISSING";
  assert.throws(() => validatePipeline(pipeline), /unknown transition target/i);
});

test("closed stage cycles fail validation while cycles with an exit are allowed", () => {
  const pipeline = defaultPipelineDefinition();
  const stage = stageById(pipeline, "VERIFICATION");
  stage.onSuccess = stage.id;
  stage.onFailure = stage.id;
  assert.throws(() => validatePipeline(pipeline), /no path to SUCCESS or PAUSED/);
  stage.onFailure = "IMPLEMENTATION";
  assert.doesNotThrow(() => validatePipeline(pipeline));
});

test("custom role mappings override inherited models and file defaults consistently", async () => {
  const { resolveRoleExecutionSettings } = await import("./pipeline.js");
  const role = { id: "security", modelRole: "qa_lead" as const, description: "", instructions: "", provider: "claude", model: "file-model", variant: "high" };
  const settings = { cliProfile: "opencode", providerMapping: { security: "codex", qa_lead: "opencode" }, modelMapping: { security: "chosen-model", qa_lead: "inherited-model" }, variantMapping: { security: "" } };
  assert.deepEqual(resolveRoleExecutionSettings(role, settings), { providerId: "codex", model: "chosen-model", variant: "" });
  assert.equal(resolveRoleExecutionSettings({ ...role, model: undefined }, { ...settings, modelMapping: { qa_lead: "fallback" } }).model, "fallback");
});

test("stage execution budget persists and bounds a cycle without iteration stages", async () => {
  const { consumeStageExecutionBudget, stageExecutionBudget } = await import("./pipeline.js");
  const pipeline = defaultPipelineDefinition();
  const state = { pipeline, maxIterations: 1, stageExecutions: 0, stageExecutionLimit: stageExecutionBudget(pipeline, 1) };
  for (let i = 0; i < state.stageExecutionLimit; i++) assert.equal(consumeStageExecutionBudget(state), true);
  const restored = JSON.parse(JSON.stringify(state));
  assert.equal(consumeStageExecutionBudget(restored), false);
  assert.equal(restored.stageExecutions, state.stageExecutionLimit);
});
