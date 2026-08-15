import assert from "node:assert/strict";
import test from "node:test";
import { AgentRunResult } from "./agent_runtime";
import { ApprovalStageExecutor } from "./approval_stage_executor";
import { ImplementationStageExecutor } from "./implementation_stage_executor";
import { InterruptStageExecutor } from "./interrupt_stage_executor";
import { LoopState } from "./loop_state";
import { defaultPipelineDefinition, stageById } from "./pipeline";
import { compilePipeline } from "./pipeline_compiler";
import { PlanningStageExecutor } from "./planning_stage_executor";
import { validateToolAccess } from "./provider_runtime";
import { ReviewStageExecutor } from "./review_stage_executor";
import { getDefaultConfig } from "./runtime_config";
import { StageExecutionServices } from "./stage_execution_contracts";
import { ImplementationPreflightError } from "./stage_execution_errors";
import { TestStageExecutor } from "./test_stage_executor";
import { LoopStatus } from "./workflow_contracts";

function testState(): LoopState {
  const compiled = compilePipeline(defaultPipelineDefinition());
  const pipeline = compiled.pipeline;
  const now = "2026-08-16T00:00:00.000Z";
  return {
    stateVersion: 2,
    aggregateFormatVersion: 1,
    aggregateRevision: 0,
    fencingEpoch: 0,
    aggregateChecksum: "test",
    processedRequestIds: [],
    artifactRefs: {},
    sessionId: "executor-test",
    status: LoopStatus.RUNNING,
    phase: pipeline.startStageId,
    loopCount: 0,
    completedIterations: 0,
    maxCycles: 3,
    cyclesStarted: 0,
    cyclesCompleted: 0,
    maxWorkflowSteps: 28,
    workflowStepsConsumed: 0,
    currentActivation: null,
    activationHistory: [],
    goal: "Complete the test goal.",
    targetProjectPath: process.cwd(),
    additionalAllowedPaths: [],
    accessMode: "ask",
    pendingAccessRequest: null,
    modelMapping: {
      planner: "test/model",
      implementer: "test/model",
      tester: "test/model",
      qa_lead: "test/model",
      master: "test/model",
      interrupter: "test/model",
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
    idleTimeoutMs: 10_000,
    cliBinary: "fake-cli",
    cliProfile: "fake",
    variantMapping: {},
    toolAccess: validateToolAccess(getDefaultConfig().toolAccess),
    lastFailureDigest: null,
    activeAttempt: null,
    lastFailure: null,
    recoveryCount: 0,
    totalAgentAttempts: 0,
    statusReason: null,
    automaticRecovery: null,
    resilience: {
      transportTimeoutMs: 1_000,
      toolTimeoutMs: 1_000,
      maxAgentAttempts: 1,
      maxCompletionRecoveryAttempts: 0,
      maxAutomaticRecoveryCycles: 0,
      automaticRecoveryBackoffMs: [0],
      retryBackoffMs: [0],
      phaseRecoveryBudgetMs: 10_000,
      terminationGraceMs: 100,
      killTimeoutMs: 100,
      heartbeatIntervalMs: 1_000,
      leaseTtlMs: 3_000,
      maxInMemoryOutputBytes: 1024,
    },
    pipeline,
    pipelineCompilation: compiled.compilation,
    pipelineConfigPath: null,
    stageResults: {},
    stageOutcomes: [],
    domainEventSequence: 0,
    domainEvents: [],
    requirements: { version: 1, derivedAt: now, items: [], evidence: [] },
    convergence: { stagnantCycles: 0, history: [] },
  };
}

function agentResult(output: string): AgentRunResult {
  return {
    pid: 1,
    exitCode: 0,
    output,
    assistantText: output,
    events: [],
    timedOut: false,
    cancelled: false,
    autoInjected: [],
  };
}

function commonServices(
  state: LoopState,
  output: string,
  recorded: Array<{ stageId: string; verdict: string | null }>
): StageExecutionServices {
  const result = agentResult(output);
  return {
    state,
    executeAgent: async () => result,
    buildPrompt: () => "prompt",
    extractOutput: (value) => value.assistantText ?? value.output,
    appendProgressNote: async () => undefined,
    commitPhaseResult: async (patch) => {
      Object.assign(state, patch);
    },
    archiveLoop: async () => undefined,
    recordStageResult: (stage, _stageOutput, verdict) => {
      recorded.push({ stageId: stage.id, verdict });
    },
  };
}

test("planning executor independently replays an already-completed stage", async () => {
  const state = testState();
  const stage = stageById(state.pipeline, "PLANNING");
  state.planningComplete = true;
  state.stageResults.PLANNING = {
    stageId: "PLANNING",
    role: "planner",
    kind: "planning",
    completedAt: state.updatedAt,
    output: "done",
    verdict: null,
    attemptId: null,
  };
  const executor = new PlanningStageExecutor({
    ...commonServices(state, "", []),
    sessionDir: process.cwd(),
    planFileNames: {
      plan: "plan.md",
      planChoices: "choices.json",
      planOverview: "overview.md",
      planOptionsDir: "options",
    },
    goalRequiresExternalResearch: () => false,
    goalRequiresNamedReferenceVerification: () => false,
    isResearchBlockedResponse: () => false,
    parseReferenceIdentity: () => null,
    parsePlanChoices: () => [],
    materializePlanChoiceMarkdown: async () => ({ choices: [], overviewPath: "" }),
    writeJson: async () => undefined,
    writeText: async () => undefined,
    storeArtifact: async () => undefined,
  });

  await executor.execute(stage);
  assert.equal(state.phase, stage.onSuccess);
});

test("implementation executor blocks disallowed roots before model execution", async () => {
  const state = testState();
  const stage = stageById(state.pipeline, "IMPLEMENTATION");
  let executed = false;
  const executor = new ImplementationStageExecutor({
    ...commonServices(state, "", []),
    executeAgent: async () => {
      executed = true;
      return agentResult("");
    },
    findAbsolutePathsOutsideAllowedRoots: () => ["C:\\outside"],
    readProgressNotes: async () => "",
  });

  await assert.rejects(() => executor.execute(stage), ImplementationPreflightError);
  assert.equal(executed, false);
});

test("test executor records and routes a failing verdict", async () => {
  const state = testState();
  const source = stageById(state.pipeline, "TEST_GENERATION");
  const stage = { ...source, onFailure: "IMPLEMENTATION" };
  const recorded: Array<{ stageId: string; verdict: string | null }> = [];
  const executor = new TestStageExecutor({
    ...commonServices(state, "VERDICT: FAIL", recorded),
    rooms: {
      tester: {
        role: "tester",
        statePath: "state.json",
        skillsPath: "skills.json",
        inputPayloadPath: "input.json",
        outputPayloadPath: "output.json",
      },
    },
    readProgressNotes: async () => "",
    parseTesterVerdict: () => "FAIL",
    writeJson: async () => undefined,
  });

  await executor.execute(stage);
  assert.equal(state.phase, "IMPLEMENTATION");
  assert.deepEqual(recorded, [{ stageId: stage.id, verdict: "FAIL" }]);
});

test("review executor can approve independently and advance", async () => {
  const state = testState();
  const stage = stageById(state.pipeline, "VERIFICATION");
  const executor = new ReviewStageExecutor({
    ...commonServices(state, "APPROVED", []),
    readProgressNotes: async () => "",
    stripAnsi: (value) => value,
    isResearchBlockedResponse: () => false,
    parseMasterVerdict: () => "approved",
    extractFailureDigest: (value) => value,
    normalizeSignature: (value) => value,
    pushAndCheckOscillation: (queue) => ({ queue, oscillation: false }),
    enterInterruptPhase: () => {
      state.phase = state.pipeline.interruptStageId;
    },
  });

  await executor.execute(stage);
  assert.equal(state.phase, stage.onSuccess);
});

test("approval executor owns the terminal success transition", async () => {
  const state = testState();
  const stage = stageById(state.pipeline, "MASTER_APPROVAL");
  let summaries = 0;
  let registrySaves = 0;
  const executor = new ApprovalStageExecutor({
    ...commonServices(state, "APPROVED", []),
    readProgressNotes: async () => "",
    isResearchBlockedResponse: () => false,
    extractVerdictFromOutput: () => "APPROVED",
    parseMasterVerdict: () => "approved",
    approvalDecisionSignature: (value) => value,
    stripAnsi: (value) => value,
    pushAndCheckOscillation: (queue) => ({ queue, oscillation: false }),
    enterInterruptPhase: () => {
      state.phase = state.pipeline.interruptStageId;
    },
    emitFinalSummary: async () => {
      summaries++;
    },
    saveRegistry: async () => {
      registrySaves++;
    },
  });

  await executor.execute(stage);
  assert.equal(state.status, LoopStatus.SUCCESS);
  assert.equal(state.masterApproved, true);
  assert.equal(summaries, 1);
  assert.equal(registrySaves, 1);
});

test("interrupt executor pauses autonomous recovery and records its briefing", async () => {
  const state = testState();
  const stage = stageById(state.pipeline, "INTERRUPT");
  state.phase = stage.id;
  const executor = new InterruptStageExecutor({
    ...commonServices(state, "briefing", []),
    rootDir: process.cwd(),
    readProgressNotes: async () => "",
    collectFailureEvidence: async () => ({
      sourcePhase: null,
      targetProjectPath: state.targetProjectPath,
      additionalAllowedPaths: [],
      accessMode: "ask",
      pendingAccessRequest: null,
      detectedAbsolutePathsOutsideTarget: [],
      detectedAbsolutePathsOutsideAllowedRoots: [],
      lastFailure: null,
      attempts: [],
    }),
  });

  await executor.execute(stage);
  assert.equal(state.status, LoopStatus.PAUSED);
  assert.equal(state.interruptBriefing, "briefing");
});
