import * as fs from "node:fs";
import * as path from "node:path";
import type { LoopState } from "../../loop_state";
import {
  PIPELINE_STAGE_EXECUTORS,
  PipelineStageExecutor,
  defaultPipelineDefinition,
  executorForStage,
  stageById,
} from "../../pipeline";
import { StageExecutorMap, StageExecutorRegistry } from "../../stage_executor_registry";
import { LoopStatus } from "../../workflow_contracts";

export function findWorkspaceRoot(startDirectory = __dirname): string {
  let current = path.resolve(startDirectory);
  for (;;) {
    const packagePath = path.join(current, "package.json");
    if (fs.existsSync(packagePath)) {
      const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8")) as { name?: string };
      if (packageJson.name === "custom-agent-loop-system") return current;
    }
    const parent = path.dirname(current);
    if (parent === current) throw new Error("Could not locate the Agent Loop workspace root.");
    current = parent;
  }
}

export function createEvaluationState(stageId = "PLANNING"): LoopState {
  const pipeline = defaultPipelineDefinition();
  const stage = stageById(pipeline, stageId);
  const executor = executorForStage(pipeline, stage);
  const now = "2026-08-16T00:00:00.000Z";
  return {
    stateVersion: 2,
    aggregateFormatVersion: 1,
    aggregateRevision: 7,
    fencingEpoch: 3,
    aggregateChecksum: "evaluation",
    processedRequestIds: [],
    artifactRefs: {},
    sessionId: "langgraph-evaluation",
    status: LoopStatus.RUNNING,
    phase: stageId,
    loopCount: 0,
    completedIterations: 0,
    maxCycles: 3,
    cyclesStarted: 0,
    cyclesCompleted: 0,
    maxWorkflowSteps: 24,
    workflowStepsConsumed: 1,
    currentActivation: {
      activationId: `activation_00000001_${stageId}`,
      sequence: 1,
      stageId,
      executor,
      mutationCapable: executor === "implementation" || executor === "test",
      workflowStep: 1,
      cycleNumber: null,
      attemptsReserved: 0,
      maxAgentAttempts: 3,
      status: "reserved",
      reservedAt: now,
      completedAt: null,
    },
    activationHistory: [],
    goal: "Evaluate a workflow adapter.",
    targetProjectPath: process.cwd(),
    additionalAllowedPaths: [],
    accessMode: "ask",
    pendingAccessRequest: null,
    modelMapping: {
      planner: "fake/model",
      implementer: "fake/model",
      tester: "fake/model",
      qa_lead: "fake/model",
      master: "fake/model",
      interrupter: "fake/model",
    },
    providerMapping: {},
    providerConfigs: {},
    errorQueue: [],
    agentStates: {},
    refinedGoal: null,
    referenceIdentity: null,
    planningComplete: false,
    masterApproved: false,
    awaitingPlanApproval: false,
    planApproved: false,
    planPath: null,
    planOverviewPath: null,
    selectedPlanChoiceId: null,
    createdAt: now,
    updatedAt: now,
    maxIterations: 3,
    phaseTimeoutMs: 60_000,
    idleTimeoutMs: 30_000,
    cliBinary: "fake-cli",
    cliProfile: "opencode",
    variantMapping: {},
    toolAccess: { webSearch: { enabled: false, mode: "cached" }, mcpServers: [] },
    lastFailureDigest: null,
    activeAttempt: null,
    lastFailure: null,
    recoveryCount: 0,
    totalAgentAttempts: 0,
    statusReason: null,
    automaticRecovery: null,
    resilience: {
      transportTimeoutMs: 10_000,
      toolTimeoutMs: 10_000,
      maxAgentAttempts: 3,
      maxCompletionRecoveryAttempts: 1,
      maxAutomaticRecoveryCycles: 1,
      automaticRecoveryBackoffMs: [100],
      retryBackoffMs: [100],
      phaseRecoveryBudgetMs: 60_000,
      terminationGraceMs: 1_000,
      killTimeoutMs: 2_000,
      heartbeatIntervalMs: 5_000,
      leaseTtlMs: 15_000,
      maxInMemoryOutputBytes: 1_000_000,
    },
    pipeline,
    pipelineCompilation: {
      compilerVersion: 1,
      pipelineHash: "evaluation",
      compiledAt: now,
      reachableStageIds: pipeline.stages.map((candidate) => candidate.id),
      approvalGateStageIds: ["MASTER_APPROVAL"],
      terminalTargets: ["SUCCESS", "PAUSED", "BLOCKED"],
      cyclicComponents: [],
    },
    pipelineConfigPath: null,
    stageResults: {},
    stageOutcomes: [],
    domainEventSequence: 0,
    domainEvents: [],
    requirements: {
      version: 1,
      derivedAt: now,
      items: [],
      evidence: [],
    },
    convergence: {
      stagnantCycles: 0,
      history: [],
    },
  };
}

export function cloneEvaluationState(state: LoopState): LoopState {
  return structuredClone(state);
}

export function createEvaluationRegistry(
  execute: (executor: PipelineStageExecutor) => Promise<void>
): StageExecutorRegistry {
  const entries = PIPELINE_STAGE_EXECUTORS.map((executor) => [
    executor,
    { execute: () => execute(executor) },
  ] as const);
  return new StageExecutorRegistry(
    Object.fromEntries(entries) as unknown as StageExecutorMap
  );
}
