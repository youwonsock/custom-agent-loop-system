import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import * as fsp from "node:fs/promises";
import test from "node:test";
import {
  AuthoritativeSessionRepository,
  CorruptAggregateError,
  FencingConflictError,
  ImmutableArtifactStore,
  RevisionConflictError,
  isValidAggregateState,
} from "./authoritative_session_repository";
import { LoopState } from "./loop_state";
import { defaultPipelineDefinition } from "./pipeline";
import { compilePipeline } from "./pipeline_compiler";
import { validateToolAccess } from "./provider_runtime";
import { getDefaultConfig } from "./runtime_config";
import { LoopStatus } from "./workflow_contracts";

function repositoryState(sessionDir: string): LoopState {
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
    sessionId: path.basename(sessionDir),
    status: LoopStatus.RUNNING,
    phase: pipeline.startStageId,
    loopCount: 0,
    completedIterations: 0,
    maxCycles: 1,
    cyclesStarted: 0,
    cyclesCompleted: 0,
    maxWorkflowSteps: 16,
    workflowStepsConsumed: 0,
    currentActivation: null,
    activationHistory: [],
    goal: "Repository test",
    targetProjectPath: process.cwd(),
    additionalAllowedPaths: [],
    accessMode: "ask",
    pendingAccessRequest: null,
    modelMapping: {
      planner: "test",
      implementer: "test",
      tester: "test",
      qa_lead: "test",
      master: "test",
      interrupter: "test",
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
    maxIterations: 1,
    phaseTimeoutMs: 1_000,
    idleTimeoutMs: 1_000,
    cliBinary: "test",
    cliProfile: "test",
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
      transportTimeoutMs: 100,
      toolTimeoutMs: 100,
      maxAgentAttempts: 1,
      maxCompletionRecoveryAttempts: 0,
      maxAutomaticRecoveryCycles: 0,
      automaticRecoveryBackoffMs: [1],
      retryBackoffMs: [1],
      phaseRecoveryBudgetMs: 1_000,
      terminationGraceMs: 1,
      killTimeoutMs: 1,
      heartbeatIntervalMs: 10,
      leaseTtlMs: 30,
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

function repository(sessionDir: string, faultInjector?: () => void): AuthoritativeSessionRepository {
  return new AuthoritativeSessionRepository({
    sessionDir,
    stateFileName: "state.json",
    stateLockFileName: "state.lock",
    faultInjector: faultInjector ? () => faultInjector() : undefined,
  });
}

test("aggregate commits use revision CAS and owner fencing", async (context) => {
  const sessionDir = await fsp.mkdtemp(path.join(os.tmpdir(), "aggregate-cas-"));
  context.after(() => fsp.rm(sessionDir, { recursive: true, force: true }));
  const store = repository(sessionDir);
  const initial = await store.initialize(repositoryState(sessionDir));
  const owned = await store.acquireFencingEpoch(initial);
  owned.goal = "revision one";
  const committed = await store.commit(owned, owned.aggregateRevision, owned.fencingEpoch);

  assert.equal(committed.aggregateRevision, 2);
  assert.equal(committed.fencingEpoch, 1);
  assert.equal(isValidAggregateState(committed), true);
  await assert.rejects(
    () => store.commit(committed, 0, committed.fencingEpoch),
    RevisionConflictError
  );

  const newerOwner = await store.acquireFencingEpoch(committed);
  await assert.rejects(
    () => store.commit(committed, newerOwner.aggregateRevision, 1),
    FencingConflictError
  );
});

test("highest complete WAL record survives a crash before snapshot replacement", async (context) => {
  const sessionDir = await fsp.mkdtemp(path.join(os.tmpdir(), "aggregate-wal-"));
  context.after(() => fsp.rm(sessionDir, { recursive: true, force: true }));
  const normal = repository(sessionDir);
  const initial = await normal.initialize(repositoryState(sessionDir));
  const owned = await normal.acquireFencingEpoch(initial);
  let injected = false;
  const crashing = repository(sessionDir, () => {
    if (!injected) {
      injected = true;
      throw new Error("simulated crash");
    }
  });
  owned.goal = "durable in WAL";
  await assert.rejects(
    () => crashing.commit(owned, owned.aggregateRevision, owned.fencingEpoch),
    /simulated crash/
  );

  const recovered = await normal.load();
  assert.equal(recovered.goal, "durable in WAL");
  assert.equal(recovered.aggregateRevision, owned.aggregateRevision + 1);
});

test("corrupt snapshot and WAL are quarantined and marked blocked", async (context) => {
  const sessionDir = await fsp.mkdtemp(path.join(os.tmpdir(), "aggregate-corrupt-"));
  context.after(() => fsp.rm(sessionDir, { recursive: true, force: true }));
  await fsp.writeFile(path.join(sessionDir, "state.json"), "{broken");
  await fsp.mkdir(path.join(sessionDir, "aggregate_wal"));
  await fsp.writeFile(path.join(sessionDir, "aggregate_wal", "revision_000000000001.json"), "{}");

  await assert.rejects(() => repository(sessionDir).load(), CorruptAggregateError);
  const marker = JSON.parse(
    await fsp.readFile(path.join(sessionDir, "aggregate.blocked.json"), "utf8")
  );
  assert.equal(marker.status, "BLOCKED");
});

test("immutable artifact store deduplicates content by hash", async (context) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "artifact-store-"));
  context.after(() => fsp.rm(root, { recursive: true, force: true }));
  const store = new ImmutableArtifactStore(root);
  const first = await store.put("plan body", "text/markdown");
  const second = await store.put("plan body", "text/markdown");
  assert.deepEqual(second, first);
  assert.equal((await store.read(first)).toString("utf8"), "plan body");
});
