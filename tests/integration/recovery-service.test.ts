import assert from "node:assert/strict";
import test from "node:test";

import { createDefaultDefinitionRegistries } from "../../src/definitions/default-registries";
import { loadDefinitionSource } from "../../src/definitions/definition-loader";
import { compileWorkflow } from "../../src/definitions/workflow-compiler";
import { createRunAggregate } from "../../src/application/run-factory";
import { RecoveryService } from "../../src/application/recovery-service";
import { RunReducer } from "../../src/application/run-reducer";
import type { RunAggregate } from "../../src/domain/run-aggregate";
import type { RunRepositoryPort } from "../../src/application/ports/run-repository";
import type { ProjectionPort } from "../../src/application/ports/projection";
import type { WorkspaceIntegrityPort } from "../../src/application/ports/workspace-integrity-port";

const now = "2026-09-11T00:00:00.000Z";
const digest = "a".repeat(64);

async function fixture(): Promise<RunAggregate> {
  const definition = compileWorkflow(await loadDefinitionSource(process.cwd()), createDefaultDefinitionRegistries());
  return createRunAggregate({
    runId: "recovery",
    definition,
    goal: "Exercise ownership recovery.",
    requirements: [{ id: "REQ-001", text: "Recover safely." }],
    targetProjectPath: process.cwd(),
    now,
  });
}

class Repository implements RunRepositoryPort {
  commits = 0;
  constructor(public aggregate: RunAggregate) {}
  async init(value: RunAggregate): Promise<RunAggregate> { this.aggregate = structuredClone(value); return structuredClone(value); }
  async load(): Promise<RunAggregate> { return structuredClone(this.aggregate); }
  async acquireFencingEpoch(): Promise<RunAggregate> { return structuredClone(this.aggregate); }
  async commit(value: RunAggregate, expectedRevision: number): Promise<RunAggregate> {
    assert.equal(this.aggregate.revision, expectedRevision);
    this.commits += 1;
    this.aggregate = structuredClone({ ...value, revision: expectedRevision + 1 });
    return structuredClone(this.aggregate);
  }
  async commitOffline(value: RunAggregate, expectedRevision: number): Promise<RunAggregate> {
    return this.commit(value, expectedRevision);
  }
}

class Projection implements ProjectionPort {
  updates = 0;
  async update(): Promise<void> { this.updates += 1; }
}

test("recovery leaves human gates untouched and avoids unnecessary commits", async () => {
  const source = await fixture();
  source.execution.currentNodeId = "PLAN_APPROVAL";
  source.execution.activeActivationId = "gate";
  source.nodeExecutions.gate = {
    activationId: "gate", nodeId: "PLAN_APPROVAL", taskId: null, agentId: null, workflowStep: 1,
    cycleNumber: null, status: "waiting_user", sideEffect: "none", attemptIds: [], reservedAt: now,
    startedAt: null, completedAt: null, output: null, signal: null, failure: null,
  };
  const repository = new Repository(source);
  const projection = new Projection();
  const recovered = await new RecoveryService(repository, new RunReducer(), projection).recoverAfterOwnershipChange(source.runId);
  assert.equal(recovered.revision, source.revision);
  assert.equal(repository.commits, 0);
  assert.equal(projection.updates, 0);
});

test("recovery invalidates changed proof fingerprints and handles integrity errors", async () => {
  const source = await fixture();
  source.context.verificationProof = { proofId: "proof", afterFingerprint: digest, passed: true } as never;
  source.context.verificationContract = { generatedOutputPaths: [] } as never;
  source.execution.currentNodeId = "QA_REVIEW";
  source.execution.activeActivationId = "qa";
  source.nodeExecutions.qa = {
    activationId: "qa", nodeId: "QA_REVIEW", taskId: "audit_quality", agentId: "qa_lead", workflowStep: 1,
    cycleNumber: 1, status: "running", sideEffect: "none", attemptIds: ["attempt"], reservedAt: now,
    startedAt: now, completedAt: null, output: null, signal: null, failure: null,
  };
  const mismatchIntegrity: WorkspaceIntegrityPort = {
    fingerprint: async () => ({ digest: "b".repeat(64), files: 1, paths: [], fileHashes: {}, fileModes: {} }),
    watch: () => ({ dirty: () => false, reliable: true, close: () => undefined }),
  };
  const repository = new Repository(source);
  const projection = new Projection();
  const mismatch = await new RecoveryService(repository, new RunReducer(), projection, mismatchIntegrity).recoverAfterOwnershipChange(source.runId);
  assert.equal(repository.commits, 1);
  assert.equal(projection.updates, 1);
  assert.equal(mismatch.execution.status, "PAUSED");
  assert.match(mismatch.context.verificationInvalidationReason ?? "", /fingerprint changed/u);

  const errorSource = await fixture();
  errorSource.context.verificationProof = { proofId: "proof", afterFingerprint: digest, passed: true } as never;
  errorSource.context.verificationContract = { generatedOutputPaths: [] } as never;
  const errorRepository = new Repository(errorSource);
  const errorIntegrity: WorkspaceIntegrityPort = {
    fingerprint: async () => { throw new Error("watch unavailable"); },
    watch: () => ({ dirty: () => false, reliable: false, close: () => undefined }),
  };
  const errored = await new RecoveryService(errorRepository, new RunReducer(), new Projection(), errorIntegrity).recoverAfterOwnershipChange(errorSource.runId);
  assert.equal(errored.execution.status, "PAUSED");
  assert.match(errored.context.verificationInvalidationReason ?? "", /watch unavailable/u);
});

test("recovery resumes stale read-only activations and returns unchanged state when no work is needed", async () => {
  const source = await fixture();
  source.execution.currentNodeId = "QA_REVIEW";
  source.execution.activeActivationId = "qa";
  source.nodeExecutions.qa = {
    activationId: "qa", nodeId: "QA_REVIEW", taskId: "audit_quality", agentId: "qa_lead", workflowStep: 1,
    cycleNumber: 1, status: "running", sideEffect: "none", attemptIds: [], reservedAt: now,
    startedAt: now, completedAt: null, output: null, signal: null, failure: null,
  };
  const repository = new Repository(source);
  const recovered = await new RecoveryService(repository, new RunReducer(), new Projection()).recoverAfterOwnershipChange(source.runId);
  assert.equal(recovered.nodeExecutions.qa.status, "reserved");
  assert.equal(repository.commits, 1);

  const clean = await fixture();
  const cleanRepository = new Repository(clean);
  const unchanged = await new RecoveryService(cleanRepository, new RunReducer(), new Projection()).recoverAfterOwnershipChange(clean.runId);
  assert.equal(unchanged.revision, clean.revision);
  assert.equal(cleanRepository.commits, 0);
});
