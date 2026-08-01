import * as fsp from "node:fs/promises";
import * as path from "node:path";

export const BUILTIN_MODEL_ROLES = [
  "planner",
  "implementer",
  "tester",
  "qa_lead",
  "master",
  "interrupter",
] as const;

export type BuiltinModelRole = (typeof BUILTIN_MODEL_ROLES)[number];
export type PipelineStageKind =
  | "planning"
  | "implementation"
  | "test"
  | "review"
  | "approval"
  | "interrupt";

export interface PipelineRole {
  id: string;
  modelRole: BuiltinModelRole;
  description: string;
  instructions: string;
  model?: string;
  variant?: string;
}

export interface PipelineStage {
  id: string;
  name: string;
  role: string;
  kind: PipelineStageKind;
  instructions: string;
  onSuccess: string;
  onFailure: string;
  countsIteration: boolean;
  requiresPlanApproval: boolean;
  planOptionsCount: number;
}

export interface PipelineDefinition {
  version: 1;
  name: string;
  startStageId: string;
  interruptStageId: string;
  reentryStageId: string;
  iterationCompletionStageId: string;
  roles: PipelineRole[];
  stages: PipelineStage[];
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const TERMINAL_TARGETS = new Set(["SUCCESS", "PAUSED"]);

export function defaultPipelineDefinition(): PipelineDefinition {
  return {
    version: 1,
    name: "autonomous-mutual-verification",
    startStageId: "PLANNING",
    interruptStageId: "INTERRUPT",
    reentryStageId: "IMPLEMENTATION",
    iterationCompletionStageId: "VERIFICATION",
    roles: [
      {
        id: "planner",
        modelRole: "planner",
        description: "Produces competing implementation plans and clarifies the goal.",
        instructions: "Generate exactly three materially distinct plan options.",
      },
      {
        id: "implementer",
        modelRole: "implementer",
        description: "Implements the approved plan.",
        instructions: "Inspect existing work first, implement cumulatively, and keep the workspace runnable.",
      },
      {
        id: "tester",
        modelRole: "tester",
        description: "Creates and runs tests independently from the implementer.",
        instructions: "Run relevant tests and finish with VERDICT: PASS or VERDICT: FAIL.",
      },
      {
        id: "qa_lead",
        modelRole: "qa_lead",
        description: "Reviews implementation and test evidence.",
        instructions: "Independently verify the result and finish with APPROVED or REJECTED.",
      },
      {
        id: "master",
        modelRole: "master",
        description: "Makes the final goal-completion decision.",
        instructions: "Audit the complete goal and finish with APPROVED or REJECTED.",
      },
      {
        id: "interrupter",
        modelRole: "interrupter",
        description: "Produces a bounded local failure briefing.",
        instructions: "Explain the failure, evidence, and concrete operator recovery actions.",
      },
    ],
    stages: [
      {
        id: "PLANNING",
        name: "Planning",
        role: "planner",
        kind: "planning",
        instructions: "",
        onSuccess: "IMPLEMENTATION",
        onFailure: "INTERRUPT",
        countsIteration: false,
        requiresPlanApproval: true,
        planOptionsCount: 3,
      },
      {
        id: "IMPLEMENTATION",
        name: "Implementation",
        role: "implementer",
        kind: "implementation",
        instructions: "",
        onSuccess: "TEST_GENERATION",
        onFailure: "INTERRUPT",
        countsIteration: true,
        requiresPlanApproval: false,
        planOptionsCount: 0,
      },
      {
        id: "TEST_GENERATION",
        name: "Test generation and execution",
        role: "tester",
        kind: "test",
        instructions: "",
        onSuccess: "VERIFICATION",
        onFailure: "VERIFICATION",
        countsIteration: false,
        requiresPlanApproval: false,
        planOptionsCount: 0,
      },
      {
        id: "VERIFICATION",
        name: "Independent QA verification",
        role: "qa_lead",
        kind: "review",
        instructions: "",
        onSuccess: "MASTER_APPROVAL",
        onFailure: "IMPLEMENTATION",
        countsIteration: false,
        requiresPlanApproval: false,
        planOptionsCount: 0,
      },
      {
        id: "MASTER_APPROVAL",
        name: "Final approval",
        role: "master",
        kind: "approval",
        instructions: "",
        onSuccess: "SUCCESS",
        onFailure: "IMPLEMENTATION",
        countsIteration: false,
        requiresPlanApproval: false,
        planOptionsCount: 0,
      },
      {
        id: "INTERRUPT",
        name: "Failure briefing",
        role: "interrupter",
        kind: "interrupt",
        instructions: "",
        onSuccess: "PAUSED",
        onFailure: "PAUSED",
        countsIteration: false,
        requiresPlanApproval: false,
        planOptionsCount: 0,
      },
    ],
  };
}

export function validatePipeline(input: PipelineDefinition): PipelineDefinition {
  if (!input || input.version !== 1) throw new Error("Pipeline version must be 1.");
  if (!Array.isArray(input.roles) || input.roles.length === 0) {
    throw new Error("Pipeline must define at least one role.");
  }
  if (!Array.isArray(input.stages) || input.stages.length === 0) {
    throw new Error("Pipeline must define at least one stage.");
  }

  const roleIds = new Set<string>();
  for (const role of input.roles) {
    if (!SAFE_ID.test(role.id)) throw new Error(`Unsafe pipeline role id: ${role.id}`);
    if (roleIds.has(role.id)) throw new Error(`Duplicate pipeline role id: ${role.id}`);
    if (!BUILTIN_MODEL_ROLES.includes(role.modelRole)) {
      throw new Error(`Unknown modelRole for ${role.id}: ${role.modelRole}`);
    }
    roleIds.add(role.id);
    role.description = role.description ?? "";
    role.instructions = role.instructions ?? "";
    if (role.model !== undefined && !role.model.trim()) delete role.model;
    if (role.variant !== undefined && !role.variant.trim()) delete role.variant;
  }

  const stageIds = new Set<string>();
  const validKinds = new Set<PipelineStageKind>([
    "planning", "implementation", "test", "review", "approval", "interrupt",
  ]);
  for (const stage of input.stages) {
    if (!SAFE_ID.test(stage.id)) throw new Error(`Unsafe pipeline stage id: ${stage.id}`);
    if (stageIds.has(stage.id)) throw new Error(`Duplicate pipeline stage id: ${stage.id}`);
    if (!roleIds.has(stage.role)) throw new Error(`Stage ${stage.id} references unknown role ${stage.role}.`);
    if (!validKinds.has(stage.kind)) throw new Error(`Stage ${stage.id} has unknown kind ${stage.kind}.`);
    stageIds.add(stage.id);
    stage.name = stage.name || stage.id;
    stage.instructions = stage.instructions ?? "";
    stage.countsIteration = Boolean(stage.countsIteration);
    stage.requiresPlanApproval = Boolean(stage.requiresPlanApproval);
    stage.planOptionsCount =
      stage.kind === "planning"
        ? Math.max(1, Number.isSafeInteger(stage.planOptionsCount) ? stage.planOptionsCount : 3)
        : 0;
  }

  for (const required of [
    input.startStageId,
    input.interruptStageId,
    input.reentryStageId,
    input.iterationCompletionStageId,
  ]) {
    if (!stageIds.has(required)) throw new Error(`Pipeline references unknown required stage ${required}.`);
  }
  const interrupt = input.stages.find((stage) => stage.id === input.interruptStageId);
  if (interrupt?.kind !== "interrupt") {
    throw new Error("interruptStageId must reference an interrupt stage.");
  }
  if (!input.stages.some((stage) => stage.countsIteration)) {
    throw new Error("At least one pipeline stage must set countsIteration=true.");
  }
  for (const stage of input.stages) {
    for (const target of [stage.onSuccess, stage.onFailure]) {
      if (!stageIds.has(target) && !TERMINAL_TARGETS.has(target)) {
        throw new Error(`Stage ${stage.id} references unknown transition target ${target}.`);
      }
    }
  }
  return input;
}

export async function loadPipelineDefinition(filePath?: string | null): Promise<PipelineDefinition> {
  if (!filePath) return validatePipeline(defaultPipelineDefinition());
  const resolved = path.resolve(filePath);
  const parsed = JSON.parse(await fsp.readFile(resolved, "utf8")) as PipelineDefinition;
  return validatePipeline(parsed);
}

export function roleForStage(
  pipeline: PipelineDefinition,
  stage: PipelineStage
): PipelineRole {
  const role = pipeline.roles.find((candidate) => candidate.id === stage.role);
  if (!role) throw new Error(`Missing role ${stage.role} for stage ${stage.id}.`);
  return role;
}

export function stageById(
  pipeline: PipelineDefinition,
  stageId: string
): PipelineStage {
  const stage = pipeline.stages.find((candidate) => candidate.id === stageId);
  if (!stage) throw new Error(`Unknown pipeline stage: ${stageId}`);
  return stage;
}
