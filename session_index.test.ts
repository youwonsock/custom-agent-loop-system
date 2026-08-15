import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import * as fsp from "node:fs/promises";
import test from "node:test";
import { AuthoritativeSessionRepository } from "./authoritative_session_repository";
import { rebuildSessionsIndex } from "./session_index";
import { LoopState } from "./loop_state";
import { defaultPipelineDefinition } from "./pipeline";
import { compilePipeline } from "./pipeline_compiler";
import { validateToolAccess } from "./provider_runtime";
import { getDefaultConfig } from "./runtime_config";
import { LoopStatus } from "./workflow_contracts";

function indexState(sessionId: string, sessionDir: string): LoopState {
  const compiled = compilePipeline(defaultPipelineDefinition());
  const pipeline = compiled.pipeline;
  const now = new Date().toISOString();
  return {
    stateVersion: 2,
    aggregateFormatVersion: 1,
    aggregateRevision: 0,
    fencingEpoch: 0,
    aggregateChecksum: "",
    processedRequestIds: [],
    artifactRefs: {},
    sessionId,
    status: LoopStatus.PAUSED,
    phase: pipeline.startStageId,
    loopCount: 0,
    completedIterations: 0,
    maxCycles: 1, cyclesStarted: 0, cyclesCompleted: 0,
    maxWorkflowSteps: 16, workflowStepsConsumed: 0,
    currentActivation: null, activationHistory: [],
    goal: `Goal ${sessionId}`,
    targetProjectPath: sessionDir,
    additionalAllowedPaths: [],
    accessMode: "ask",
    pendingAccessRequest: null,
    modelMapping: { planner: "m", implementer: "m", tester: "m", qa_lead: "m", master: "m", interrupter: "m" },
    providerMapping: {}, providerConfigs: {}, errorQueue: [], agentStates: {},
    refinedGoal: null, referenceIdentity: null, planningComplete: false,
    masterApproved: false, awaitingPlanApproval: false, planApproved: false,
    planPath: null, planOverviewPath: null, selectedPlanChoiceId: null,
    createdAt: now, updatedAt: now, maxIterations: 1, phaseTimeoutMs: 1000,
    idleTimeoutMs: 1000, cliBinary: "test", cliProfile: "test", variantMapping: {},
    toolAccess: validateToolAccess(getDefaultConfig().toolAccess), lastFailureDigest: null,
    activeAttempt: null, lastFailure: null, recoveryCount: 0, totalAgentAttempts: 0,
    statusReason: null, automaticRecovery: null,
    resilience: { transportTimeoutMs: 1, toolTimeoutMs: 1, maxAgentAttempts: 1,
      maxCompletionRecoveryAttempts: 0, maxAutomaticRecoveryCycles: 0,
      automaticRecoveryBackoffMs: [1], retryBackoffMs: [1], phaseRecoveryBudgetMs: 10,
      terminationGraceMs: 1, killTimeoutMs: 1, heartbeatIntervalMs: 1,
      leaseTtlMs: 2, maxInMemoryOutputBytes: 1024 },
    pipeline, pipelineCompilation: compiled.compilation, pipelineConfigPath: null, stageResults: {},
    stageOutcomes: [], domainEventSequence: 0, domainEvents: [],
    requirements: { version: 1, derivedAt: now, items: [], evidence: [] },
    convergence: { stagnantCycles: 0, history: [] },
  };
}

test("sessions index is fully rebuilt from authoritative aggregates", async (context) => {
  const dataRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "sessions-index-"));
  context.after(() => fsp.rm(dataRoot, { recursive: true, force: true }));
  for (const sessionId of ["s2", "s1"]) {
    const sessionDir = path.join(dataRoot, "sessions", sessionId);
    await new AuthoritativeSessionRepository({
      sessionDir,
      stateFileName: "state.json",
      stateLockFileName: "state.lock",
    }).initialize(indexState(sessionId, sessionDir));
  }

  const index = await rebuildSessionsIndex(dataRoot, {
    sessionsRoot: "sessions",
    stateFileName: "state.json",
    stateLockFileName: "state.lock",
    indexFileName: "sessions_index.json",
  });
  assert.deepEqual(index.activeSessionIds, ["s1", "s2"]);
  assert.deepEqual(index.sessionMetas.map((meta) => meta.goal), ["Goal s1", "Goal s2"]);
  assert.equal(index.source, "session-aggregates");
});
