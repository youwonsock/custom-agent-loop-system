import type { RunAggregate, WorkflowRequirement } from "../domain/run-aggregate";
import type { CompiledWorkflowBundle } from "../domain/workflow";

export interface CreateRunOptions {
  runId: string;
  definition: CompiledWorkflowBundle;
  goal: string;
  requirements: WorkflowRequirement[];
  targetProjectPath: string;
  additionalAllowedPaths?: string[];
  accessMode?: "ask" | "full_access";
  now?: string;
}

export function createRunAggregate(options: CreateRunOptions): RunAggregate {
  const now = options.now ?? new Date().toISOString();
  if (!options.goal.trim()) throw new Error("Run goal must not be empty.");
  if (options.requirements.length === 0) {
    throw new Error("A run must contain at least one fixed requirement.");
  }
  const requirementIds = options.requirements.map((item) => item.id);
  if (new Set(requirementIds).size !== requirementIds.length) {
    throw new Error("Run requirement ids must be unique.");
  }
  return {
    schemaVersion: 1,
    runId: options.runId,
    definition: JSON.parse(JSON.stringify(options.definition)) as CompiledWorkflowBundle,
    context: {
      goal: options.goal.trim(),
      requirements: options.requirements.map((item) => ({ ...item })),
      approvedPlan: null,
      selectedPlanChoiceId: null,
      targetProjectPath: options.targetProjectPath,
      additionalAllowedPaths: [...(options.additionalAllowedPaths ?? [])],
      accessMode: options.accessMode ?? "ask",
      planChoices: [],
      requirementEvidence: [],
      failureSummary: null,
      recovery: null,
      convergence: { stagnantCycles: 0, history: [] },
      interruptBriefing: null,
      humanResponses: {},
    },
    execution: {
      status: "RUNNING",
      currentNodeId: options.definition.startNodeId,
      activeActivationId: null,
      workflowStepsConsumed: 0,
      cyclesStarted: 0,
      cyclesCompleted: 0,
      activeCycleNumber: null,
      reason: null,
      lastFailure: null,
    },
    nodeExecutions: {},
    latestCompletedByNode: {},
    pendingInput: null,
    artifacts: {},
    events: [],
    eventSequence: 0,
    processedRequestIds: [],
    revision: 0,
    fencingEpoch: 0,
    checksum: "",
    createdAt: now,
    updatedAt: now,
  };
}

export function deriveWorkflowRequirements(goal: string): WorkflowRequirement[] {
  const candidates = goal
    .split(/(?:\r?\n)+|(?<=[.!?。！？])\s+/u)
    .map((part) => part.replace(/^[-*\d.)\s]+/u, "").trim())
    .filter((part) => part.length > 0);
  const statements = candidates.length > 0 ? candidates : [goal.trim()];
  return statements.slice(0, 200).map((text, index) => ({
    id: `REQ-${String(index + 1).padStart(3, "0")}`,
    text,
  }));
}
