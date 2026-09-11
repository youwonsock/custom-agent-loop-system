import assert from "node:assert/strict";
import test from "node:test";

import { CommandService } from "./command-service";
import { createDefaultDefinitionRegistries } from "../definitions/default-registries";
import { loadDefinitionSource } from "../definitions/definition-loader";
import { compileWorkflow } from "../definitions/workflow-compiler";
import { createRunAggregate } from "./run-factory";
import { RunReducer } from "./run-reducer";
import { createVerificationContract } from "./verification-runner";
import type { RunAggregate } from "../domain/run-aggregate";
import type { ProjectionPort } from "./ports/projection";
import type { RunRepositoryPort } from "./ports/run-repository";
import type { RunControlCommand, RunControlCommandPort } from "./ports/control-command";
import type { VerificationContractService } from "./verification-contract-service";
import { hashVerificationCandidate } from "../domain/verification";

const now = "2026-09-10T00:00:00.000Z";
const root = process.cwd();
const digest = "a".repeat(64);

class MemoryRepository implements RunRepositoryPort {
  constructor(public aggregate: RunAggregate) {}
  async init(aggregate: RunAggregate): Promise<RunAggregate> { this.aggregate = structuredClone(aggregate); return structuredClone(this.aggregate); }
  async load(_runId?: string): Promise<RunAggregate> { return structuredClone(this.aggregate); }
  async acquireFencingEpoch(): Promise<RunAggregate> { return structuredClone(this.aggregate); }
  async commit(aggregate: RunAggregate, expectedRevision: number): Promise<RunAggregate> {
    return this.commitOffline(aggregate, expectedRevision, "commit");
  }
  async commitOffline(aggregate: RunAggregate, expectedRevision: number, _requestId?: string): Promise<RunAggregate> {
    if (this.aggregate.revision !== expectedRevision) throw new Error("revision conflict");
    this.aggregate = structuredClone({ ...aggregate, revision: expectedRevision + 1 });
    return structuredClone(this.aggregate);
  }
}

class RecordingProjection implements ProjectionPort {
  readonly updates: RunAggregate[] = [];
  async update(aggregate: Readonly<RunAggregate>): Promise<void> { this.updates.push(structuredClone(aggregate)); }
}

class Controls implements RunControlCommandPort {
  readonly queued: RunControlCommand[] = [];
  async enqueue(runId: string, type: "stop" | "interrupt", message: string | null): Promise<RunControlCommand> {
    const command: RunControlCommand = { schemaVersion: 1, requestId: `queued_${this.queued.length + 1}`, runId, type, message, createdAt: now };
    this.queued.push(command);
    return command;
  }
  async recover(): Promise<void> {}
  async claim(): Promise<RunControlCommand | null> { return this.queued.shift() ?? null; }
  async complete(): Promise<void> {}
}

async function fixture(): Promise<{ aggregate: RunAggregate; reducer: RunReducer }> {
  const definition = compileWorkflow(await loadDefinitionSource(root), createDefaultDefinitionRegistries());
  return {
    aggregate: createRunAggregate({
      runId: "command-service",
      definition,
      goal: "Exercise command service boundaries.",
      requirements: [{ id: "REQ-001", text: "Exercise command service boundaries." }],
      targetProjectPath: root,
      now,
    }),
    reducer: new RunReducer(),
  };
}

function artifact(id: string, mediaType = "application/vnd.custom-agent-loop.plan+json;version=1") {
  const sha256 = id === "plan-artifact" ? "b".repeat(64) : id === "baseline" ? "c".repeat(64) : id === "log" ? "d".repeat(64) : "e".repeat(64);
  return { artifactId: `artifact_${sha256}`, sha256, mediaType, bytes: 1, createdAt: now };
}

function pendingPlan(aggregate: RunAggregate, reducer: RunReducer): RunAggregate {
  let current = aggregate;
  current.execution.currentNodeId = "PLAN_APPROVAL";
  const planArtifact = artifact("plan-artifact");
  current.artifacts[planArtifact.artifactId] = planArtifact;
  current.context.planChoices = [{
    id: "choice-1",
    title: "Safe plan",
    planArtifactId: planArtifact.artifactId,
    verification: {
      commands: [{ id: "unit", label: "unit", executable: "node", args: ["--version"], cwd: ".", timeoutMs: 1000, requirementIds: ["REQ-001"] }],
      totalTimeoutMs: 30000,
      protectedPaths: [],
      testRoots: [],
      allowedNewTestRoots: [],
      generatedOutputPaths: [],
    },
  }];
  current.latestCompletedByNode.PLANNING = "planning-activation";
  current.nodeExecutions["planning-activation"] = {
    activationId: "planning-activation", nodeId: "PLANNING", taskId: "produce_plan", agentId: "planner",
    workflowStep: 1, cycleNumber: null, status: "completed", sideEffect: "none", attemptIds: ["planning-attempt"],
    reservedAt: now, startedAt: now, completedAt: now,
    output: { activationId: "planning-activation", artifactId: planArtifact.artifactId, schemaId: "plan.v2", signal: "success", summary: "plan" },
    signal: "success", failure: null,
  };
  current = reducer.reserveNode(current, "plan-gate", now);
  return reducer.requestHumanInput(current, { choices: ["choice-1"] }, now);
}

test("command service responds to plan approval and captures an initial verification contract", async () => {
  const { aggregate, reducer } = await fixture();
  const repository = new MemoryRepository(pendingPlan(aggregate, reducer));
  const projection = new RecordingProjection();
  let createCalls = 0;
  const verificationContracts = {
    createInitial: async (commands: unknown[], _projectRoot: string, _additional: string[], requestId: string) => {
      createCalls += 1;
      const contract = createVerificationContract(commands as never[], digest, requestId, { paths: [], fileHashes: {} });
      const baseline = artifact("baseline", "application/vnd.custom-agent-loop.workspace-fingerprint+json;version=1");
      contract.baselineArtifactId = baseline.artifactId;
      return { contract, baseline };
    },
  } as unknown as VerificationContractService;
  const service = new CommandService(repository, reducer, projection, undefined, verificationContracts);
  const waiting = await repository.load("ignored");
  const result = await service.respondToHumanGate(waiting.runId, {
    requestId: waiting.pendingInput!.requestId,
    nodeId: "PLAN_APPROVAL",
    signal: "approved",
    choiceId: "choice-1",
    respondedAt: now,
  });
  assert.equal(createCalls, 1);
  assert.equal(result.context.verificationContract?.approvedRequestId, waiting.pendingInput!.requestId);
  assert.equal(result.context.verificationContract?.baselineArtifactId, "artifact_" + "c".repeat(64));
  assert.equal(projection.updates.length, 1);
});

test("command service handles verification approval, idempotent replay, stale candidate, and rejection", async () => {
  const { aggregate, reducer } = await fixture();
  let current = structuredClone(aggregate);
  current.execution.currentNodeId = "VERIFY";
  current.execution.activeActivationId = "verify-activation";
  current.nodeExecutions["verify-activation"] = {
    activationId: "verify-activation", nodeId: "VERIFY", taskId: null, agentId: null, workflowStep: 1, cycleNumber: 1,
    status: "reserved", sideEffect: "workspace_mutation", attemptIds: [], reservedAt: now, startedAt: null, completedAt: null,
    output: null, signal: null, failure: null,
  };
  current.context.verificationContract = createVerificationContract(
    [{ id: "unit", label: "unit", executable: "node", args: ["--version"], cwd: ".", timeoutMs: 1000, requirementIds: ["REQ-001"] }],
    digest,
    "initial",
    { paths: [], fileHashes: {} }
  );
  const candidate = {
    candidateHash: "",
    baseRevision: 1,
    baselineFingerprint: digest,
    baselineArtifactId: null,
    diffArtifactId: null,
    commands: current.context.verificationContract.commands,
    totalTimeoutMs: current.context.verificationContract.totalTimeoutMs,
    protectedPaths: current.context.verificationContract.protectedPaths,
    testRoots: current.context.verificationContract.testRoots,
    allowedNewTestRoots: current.context.verificationContract.allowedNewTestRoots,
    generatedOutputPaths: current.context.verificationContract.generatedOutputPaths,
    changedFiles: [],
    addedFiles: [],
    removedFiles: [],
    changedPaths: [],
    addedPaths: [],
    modifiedPaths: [],
    deletedPaths: [],
    baselinePaths: [],
    baselineFileHashes: {},
    baselineFileModes: {},
  };
  candidate.candidateHash = hashVerificationCandidate(candidate);
  assert.equal(hashVerificationCandidate(candidate), candidate.candidateHash);
  current = reducer.requestVerificationApproval(current, candidate, now);
  const repository = new MemoryRepository(current);
  const projection = new RecordingProjection();
  const service = new CommandService(repository, reducer, projection);
  const requestId = current.pendingInput!.requestId;
  const approved = await service.approveVerification(current.runId, requestId, candidate.candidateHash);
  assert.equal(approved.context.verificationContract?.revision, 2);
  const replay = await service.approveVerification(current.runId, requestId, candidate.candidateHash);
  assert.equal(replay.revision, approved.revision);
  await assert.rejects(() => service.approveVerification(current.runId, requestId, "f".repeat(64)), /stale/u);

  const rejectedCandidate = { ...candidate, baseRevision: 2, candidateHash: "" };
  rejectedCandidate.candidateHash = hashVerificationCandidate(rejectedCandidate);
  let rejectedSource = structuredClone(approved);
  rejectedSource.execution.activeActivationId = "verify-2";
  rejectedSource.nodeExecutions["verify-2"] = { ...rejectedSource.nodeExecutions["verify-activation"], activationId: "verify-2", status: "reserved" };
  rejectedSource.context.verificationContract = { ...rejectedSource.context.verificationContract!, revision: 2 };
  rejectedSource = reducer.requestVerificationApproval(rejectedSource, rejectedCandidate, now);
  repository.aggregate = rejectedSource;
  const rejected = await service.rejectVerification(rejectedSource.runId, rejectedSource.pendingInput!.requestId, rejectedCandidate.candidateHash, "change the command");
  assert.equal(rejected.context.verificationProof, null);
  assert.match(rejected.context.verificationInvalidationReason!, /change the command/u);
});

test("command service applies status, access, resume, and control requests", async () => {
  const { aggregate, reducer } = await fixture();
  const repository = new MemoryRepository(aggregate);
  const projection = new RecordingProjection();
  const controls = new Controls();
  const service = new CommandService(repository, reducer, projection, controls);
  const paused = await service.setRunStatus(aggregate.runId, "status-1", "PAUSED", "pause");
  assert.equal(paused.execution.status, "PAUSED");
  const access = await service.setAccessMode(aggregate.runId, "access-1", "full_access");
  assert.equal(access.context.accessMode, "full_access");
  const resumed = await service.resumeRun(aggregate.runId, "resume-1", "continue");
  assert.equal(resumed.execution.status, "RUNNING");
  const queuedActivation = structuredClone(resumed);
  queuedActivation.execution.activeActivationId = "running";
  queuedActivation.nodeExecutions.running = {
    activationId: "running", nodeId: "PLANNING", taskId: "produce_plan", agentId: "planner", workflowStep: 1,
    cycleNumber: null, status: "running", sideEffect: "none", attemptIds: ["attempt"], reservedAt: now,
    startedAt: now, completedAt: null, output: null, signal: null, failure: null,
  };
  repository.aggregate = queuedActivation;
  const queued = await service.requestControl(aggregate.runId, "control-1", "stop", "stop after attempt");
  assert.ok(queued.queuedRequestId);
  assert.equal(controls.queued.length, 1);
  repository.aggregate = { ...queuedActivation, execution: { ...queuedActivation.execution, activeActivationId: null, status: "RUNNING" } };
  const stopped = await service.requestControl(aggregate.runId, "control-2", "stop", "stop now");
  assert.equal(stopped.aggregate.execution.status, "STOPPED");
  const alreadyStopped = await service.requestControl(aggregate.runId, "control-3", "stop", null);
  assert.equal(alreadyStopped.queuedRequestId, null);
  await assert.rejects(() => service.requestControl(aggregate.runId, "control-4", "interrupt", "no"), /Cannot interrupt/u);
});
