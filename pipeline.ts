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
export const PIPELINE_STAGE_EXECUTORS = [
  "planning",
  "implementation",
  "test",
  "review",
  "approval",
  "interrupt",
] as const;
export const PIPELINE_COMPLETION_CONTRACTS = [
  "phase_done",
  "plan_options",
  "verdict",
  "approval",
] as const;

export type PipelineStageExecutor = (typeof PIPELINE_STAGE_EXECUTORS)[number];
export type PipelineCompletionContract = (typeof PIPELINE_COMPLETION_CONTRACTS)[number];

export interface PipelineStageType {
  id: string;
  label: string;
  executor: PipelineStageExecutor;
  completionContract: PipelineCompletionContract;
  description: string;
}

export interface PipelineRole {
  id: string;
  modelRole: BuiltinModelRole;
  description: string;
  instructions: string;
  provider?: string;
  model?: string;
  variant?: string;
}

export interface PipelineStage {
  id: string;
  name: string;
  role: string;
  kind: string;
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
  stageTypes?: PipelineStageType[];
  roles: PipelineRole[];
  stages: PipelineStage[];
}

export interface AgentRolesDefinition {
  version: 1;
  roles: PipelineRole[];
}

export interface AgentLoopDefinition {
  version: 1;
  name: string;
  startStageId: string;
  interruptStageId: string;
  reentryStageId: string;
  iterationCompletionStageId: string;
  stageTypes?: PipelineStageType[];
  stages: PipelineStage[];
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const TERMINAL_TARGETS = new Set(["SUCCESS", "PAUSED"]);

export function completionContractForExecutor(
  executor: PipelineStageExecutor
): PipelineCompletionContract {
  if (executor === "planning") return "plan_options";
  if (executor === "test") return "verdict";
  if (executor === "review" || executor === "approval") return "approval";
  return "phase_done";
}

export function defaultPipelineStageTypes(): PipelineStageType[] {
  return PIPELINE_STAGE_EXECUTORS.map((executor) => ({
    id: executor,
    label: executor.replace(/(^|_)([a-z])/g, (_match, prefix, letter: string) =>
      `${prefix ? " " : ""}${letter.toUpperCase()}`
    ),
    executor,
    completionContract: completionContractForExecutor(executor),
    description: `Built-in ${executor} stage behavior.`,
  }));
}

export function defaultPipelineDefinition(): PipelineDefinition {
  return {
    version: 1,
    name: "autonomous-mutual-verification",
    startStageId: "PLANNING",
    interruptStageId: "INTERRUPT",
    reentryStageId: "IMPLEMENTATION",
    iterationCompletionStageId: "VERIFICATION",
    stageTypes: defaultPipelineStageTypes(),
    roles: [
      {
        id: "planner",
        modelRole: "planner",
        description: "Read-only requirements analyst who produces three complete implementation strategies.",
        instructions: "Use the fixed REQ IDs as the acceptance contract, resolve required research without guessing, and produce exactly three materially distinct options. Every option must cover every REQ ID with files, ordered steps, verification, and risks. Never implement.",
      },
      {
        id: "implementer",
        modelRole: "implementer",
        description: "Production-code owner who implements the original goal through the approved strategy.",
        instructions: "Inspect existing work first, implement cumulatively, preserve test integrity, and run focused checks. Emit concrete REQUIREMENT_EVIDENCE for every fixed REQ ID and never mark unsupported work SATISFIED. Do not make approval decisions.",
      },
      {
        id: "tester",
        modelRole: "tester",
        description: "Independent test owner who validates user-visible acceptance behavior without editing production code.",
        instructions: "Run existing tests first, add only missing test coverage, and execute representative acceptance and edge checks. Emit observed REQUIREMENT_EVIDENCE for every fixed REQ ID; PASS requires all SATISFIED.",
      },
      {
        id: "qa_lead",
        modelRole: "qa_lead",
        description: "Read-only QA auditor who checks requirement coverage and test integrity.",
        instructions: "Inspect code, rerun non-mutating critical checks, and emit independent REQUIREMENT_EVIDENCE for every fixed REQ ID. Reject weak, missing, or contradictory evidence. Never repair files.",
      },
      {
        id: "master",
        modelRole: "master",
        description: "Read-only final acceptance gate for the complete original user goal.",
        instructions: "Freshly audit every fixed REQ ID and the critical user-visible path. Emit independent REQUIREMENT_EVIDENCE for every REQ; approve only when all are concretely SATISFIED, otherwise reject and never edit files.",
      },
      {
        id: "interrupter",
        modelRole: "interrupter",
        description: "Read-only failure analyst who stops token-wasting oscillation.",
        instructions: "Separate verified facts from hypotheses, identify the repeated stagnation signature, and give the smallest concrete operator recovery action. Never continue the work or declare completion.",
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

export function defaultAgentRolesDefinition(): AgentRolesDefinition {
  const pipeline = defaultPipelineDefinition();
  return { version: 1, roles: pipeline.roles.map((role) => ({ ...role })) };
}

export function defaultAgentLoopDefinition(): AgentLoopDefinition {
  const pipeline = defaultPipelineDefinition();
  return {
    version: 1,
    name: pipeline.name,
    startStageId: pipeline.startStageId,
    interruptStageId: pipeline.interruptStageId,
    reentryStageId: pipeline.reentryStageId,
    iterationCompletionStageId: pipeline.iterationCompletionStageId,
    stageTypes: pipeline.stageTypes?.map((stageType) => ({ ...stageType })),
    stages: pipeline.stages.map((stage) => ({ ...stage })),
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

  if (!Array.isArray(input.stageTypes) || input.stageTypes.length === 0) {
    input.stageTypes = defaultPipelineStageTypes();
  }
  const stageTypeIds = new Set<string>();
  for (const stageType of input.stageTypes) {
    if (!SAFE_ID.test(stageType.id)) throw new Error(`Unsafe pipeline stage type id: ${stageType.id}`);
    if (stageTypeIds.has(stageType.id)) throw new Error(`Duplicate pipeline stage type id: ${stageType.id}`);
    if (!PIPELINE_STAGE_EXECUTORS.includes(stageType.executor)) {
      throw new Error(`Stage type ${stageType.id} has unknown executor ${stageType.executor}.`);
    }
    if (!PIPELINE_COMPLETION_CONTRACTS.includes(stageType.completionContract)) {
      throw new Error(`Stage type ${stageType.id} has unknown completion contract ${stageType.completionContract}.`);
    }
    const expectedContract = completionContractForExecutor(stageType.executor);
    if (stageType.completionContract !== expectedContract) {
      throw new Error(
        `Stage type ${stageType.id} executor ${stageType.executor} requires completion contract ${expectedContract}.`
      );
    }
    stageType.label = stageType.label?.trim() || stageType.id;
    stageType.description = stageType.description ?? "";
    stageTypeIds.add(stageType.id);
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
    if (role.provider !== undefined && !SAFE_ID.test(role.provider)) {
      throw new Error(`Unsafe provider id for ${role.id}: ${role.provider}`);
    }
    if (role.model !== undefined && !role.model.trim()) delete role.model;
    if (role.variant !== undefined && !role.variant.trim()) delete role.variant;
    // v1 briefly supported per-role tool overrides. Tool access is now global;
    // remove legacy fields during normalization so hidden overrides cannot survive.
    const legacyRole = role as PipelineRole & { webSearch?: boolean; mcpServers?: string[] };
    if (legacyRole.webSearch !== undefined) delete legacyRole.webSearch;
    if (legacyRole.mcpServers !== undefined) delete legacyRole.mcpServers;
  }

  const stageIds = new Set<string>();
  for (const stage of input.stages) {
    if (!SAFE_ID.test(stage.id)) throw new Error(`Unsafe pipeline stage id: ${stage.id}`);
    if (stageIds.has(stage.id)) throw new Error(`Duplicate pipeline stage id: ${stage.id}`);
    if (!roleIds.has(stage.role)) throw new Error(`Stage ${stage.id} references unknown role ${stage.role}.`);
    if (!stageTypeIds.has(stage.kind)) throw new Error(`Stage ${stage.id} has unknown stage type ${stage.kind}.`);
    stageIds.add(stage.id);
    stage.name = stage.name || stage.id;
    stage.instructions = stage.instructions ?? "";
    stage.countsIteration = Boolean(stage.countsIteration);
    stage.requiresPlanApproval = Boolean(stage.requiresPlanApproval);
    stage.planOptionsCount =
      stageTypeForStage(input, stage).executor === "planning"
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
  if (!interrupt || stageTypeForStage(input, interrupt).executor !== "interrupt") {
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

export function stageTypeForStage(
  pipeline: PipelineDefinition,
  stage: PipelineStage
): PipelineStageType {
  const stageType = pipeline.stageTypes?.find((candidate) => candidate.id === stage.kind);
  if (!stageType) throw new Error(`Missing stage type ${stage.kind} for stage ${stage.id}.`);
  return stageType;
}

export function executorForStage(
  pipeline: PipelineDefinition,
  stage: PipelineStage
): PipelineStageExecutor {
  return stageTypeForStage(pipeline, stage).executor;
}

export async function loadPipelineDefinition(filePath?: string | null): Promise<PipelineDefinition> {
  if (!filePath) return validatePipeline(defaultPipelineDefinition());
  const resolved = path.resolve(filePath);
  const parsed = JSON.parse(await fsp.readFile(resolved, "utf8")) as PipelineDefinition;
  return validatePipeline(parsed);
}

export async function loadSeparatedPipelineDefinition(
  rolesFilePath?: string | null,
  loopFilePath?: string | null
): Promise<PipelineDefinition> {
  const defaultRoles = defaultAgentRolesDefinition();
  const defaultLoop = defaultAgentLoopDefinition();
  const rolesDefinition = rolesFilePath
    ? JSON.parse(await fsp.readFile(path.resolve(rolesFilePath), "utf8")) as AgentRolesDefinition
    : defaultRoles;
  const loopDefinition = loopFilePath
    ? JSON.parse(await fsp.readFile(path.resolve(loopFilePath), "utf8")) as AgentLoopDefinition
    : defaultLoop;
  if (rolesDefinition.version !== 1) throw new Error("Agent roles version must be 1.");
  if (loopDefinition.version !== 1) throw new Error("Agent loop version must be 1.");
  return validatePipeline({
    version: 1,
    name: loopDefinition.name,
    startStageId: loopDefinition.startStageId,
    interruptStageId: loopDefinition.interruptStageId,
    reentryStageId: loopDefinition.reentryStageId,
    iterationCompletionStageId: loopDefinition.iterationCompletionStageId,
    stageTypes: loopDefinition.stageTypes,
    roles: rolesDefinition.roles,
    stages: loopDefinition.stages,
  });
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
