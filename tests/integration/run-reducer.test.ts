import assert from "node:assert/strict";
import * as path from "node:path";
import test from "node:test";

import { createDefaultDefinitionRegistries } from "../../src/definitions/default-registries";
import { loadDefinitionSource } from "../../src/definitions/definition-loader";
import { compileWorkflow } from "../../src/definitions/workflow-compiler";
import { createRunAggregate } from "../../src/application/run-factory";
import { RunReducer, WorkflowBudgetError } from "../../src/application/run-reducer";
import { createVerificationContract } from "../../src/application/verification-runner";
import type { RunAggregate } from "../../src/domain/run-aggregate";
import type { ArtifactReference, TaskExecutionResult } from "../../src/domain/task-result";
import type { VerificationApprovalCandidate, VerificationCommandRecord, VerificationProof } from "../../src/domain/verification";
import { hashVerificationCandidate } from "../../src/domain/verification";
import { hashVerificationContract } from "../../src/application/verification-runner";

const root = process.cwd();
const digest = "a".repeat(64);
const now = "2026-09-09T00:00:00.000Z";

function artifact(
  sha256: string,
  mediaType = "application/vnd.custom-agent-loop.verification-log+json;version=1"
): ArtifactReference {
  return {
    artifactId: `artifact_${sha256}`,
    sha256,
    mediaType,
    bytes: 1,
    createdAt: now,
  };
}

async function fixture(): Promise<{ aggregate: RunAggregate; reducer: RunReducer }> {
  const definition = compileWorkflow(
    await loadDefinitionSource(root),
    createDefaultDefinitionRegistries()
  );
  const aggregate = createRunAggregate({
    runId: "reducer",
    definition,
    goal: "Exercise reducer boundaries.",
    requirements: [{ id: "REQ-001", text: "Exercise reducer boundaries." }],
    targetProjectPath: root,
    now,
  });
  return { aggregate, reducer: new RunReducer() };
}

const success = (signal: string): TaskExecutionResult => ({
  status: "succeeded",
  signal,
  output: null,
  effects: [],
  artifacts: [],
  failure: null,
  pendingInput: null,
});

function complete(
  reducer: RunReducer,
  aggregate: RunAggregate,
  nodeId: string,
  activationId: string,
  signal: string,
  targetId: string,
  result: TaskExecutionResult = success(signal)
): RunAggregate {
  return reducer.completeNode(aggregate, {
    nodeId,
    activationId,
    result,
    targetId,
    terminalStatus: null,
    effects: result.effects,
    completedAt: now,
  });
}

async function verificationFixture(): Promise<{
  aggregate: RunAggregate;
  reducer: RunReducer;
  command: VerificationCommandRecord;
}> {
  const { aggregate: initial, reducer } = await fixture();
  let aggregate = initial;
  aggregate.execution.currentNodeId = "IMPLEMENTATION";
  aggregate.execution.cyclesStarted = 1;
  aggregate.execution.activeCycleNumber = 1;
  aggregate = reducer.reserveNode(aggregate, "impl", now);
  aggregate = reducer.startAttempt(aggregate, "impl", "impl-attempt", now);
  aggregate = complete(reducer, aggregate, "IMPLEMENTATION", "impl", "success", "TEST");
  aggregate = reducer.reserveNode(aggregate, "test", now);
  aggregate = reducer.startAttempt(aggregate, "test", "test-attempt", now);
  aggregate = complete(reducer, aggregate, "TEST", "test", "prepared", "VERIFY");
  aggregate = reducer.reserveNode(aggregate, "verify", now);
  const contract = createVerificationContract(
    [{ id: "unit", label: "unit", executable: "node", args: ["--version"], cwd: ".", timeoutMs: 1_000, requirementIds: ["REQ-001"] }],
    digest,
    "plan-approval",
    { paths: [], fileHashes: {} }
  );
  const baseline = artifact(digest, "application/vnd.custom-agent-loop.workspace-fingerprint+json;version=1");
  contract.baselineArtifactId = baseline.artifactId;
  aggregate.context.verificationContract = contract;
  aggregate.artifacts[baseline.artifactId] = baseline;
  aggregate = reducer.startVerification(aggregate, "verify", now);
  const log = artifact("b".repeat(64));
  const command: VerificationCommandRecord = {
    verificationId: "verify_verification",
    commandId: "unit",
    status: "completed",
    executable: "node",
    args: ["--version"],
    cwd: path.resolve(root),
    approvedExecutable: "node",
    approvedArgs: ["--version"],
    approvedCwd: ".",
    startedAt: now,
    completedAt: now,
    exitCode: 0,
    signal: null,
    timedOut: false,
    processTreeClean: true,
    logArtifactId: log.artifactId,
    summary: "ok",
    elapsedMs: 1,
  };
  const reservedCommand: VerificationCommandRecord = {
    ...command,
    status: "reserved",
    startedAt: null,
    completedAt: null,
    exitCode: null,
    signal: null,
    processTreeClean: null,
    logArtifactId: null,
    summary: "",
  };
  aggregate = reducer.recordVerificationCommand({ ...aggregate, context: { ...aggregate.context, verificationRecords: [] } }, reservedCommand, now);
  aggregate = reducer.recordVerificationCommand(aggregate, { ...reservedCommand, status: "running", startedAt: now }, now);
  aggregate = reducer.recordVerificationCommand(aggregate, command, now, log);
  return { aggregate, reducer, command };
}

test("reducer records a durable passing proof and routes VERIFY to QA", async () => {
  const { aggregate: source, reducer, command } = await verificationFixture();
  const result = artifact("c".repeat(64), "application/vnd.custom-agent-loop.verification-result+json;version=1");
  const proof: VerificationProof = {
    proofId: "proof",
    verificationId: "verify_verification",
    contractRevision: 1,
    contractHash: source.context.verificationContract!.contractHash,
    baselineFingerprint: digest,
    beforeFingerprint: digest,
    afterFingerprint: digest,
    implementationActivationId: "impl",
    testActivationId: "test",
    commands: [command],
    passed: true,
    verifiedAt: now,
    watcherReliable: true,
    elapsedMs: 1,
    executionError: false,
    resultArtifactId: result.artifactId,
  };
  const withProof = reducer.recordVerificationProof(source, proof, now, result);
  assert.equal(withProof.context.verificationProof?.proofId, "proof");
  assert.equal(withProof.context.verificationFeedback[0]?.passed, true);
  const completed = complete(reducer, withProof, "VERIFY", "verify", "pass", "QA_REVIEW");
  assert.equal(completed.execution.currentNodeId, "QA_REVIEW");
  assert.equal(completed.execution.activeActivationId, null);
});

test("reducer covers retry, failure, findings, approvals, and stale recovery boundaries", async () => {
  const { aggregate: initial, reducer } = await fixture();
  let aggregate = initial;
  aggregate.execution.currentNodeId = "PLANNING";
  aggregate = reducer.reserveNode(aggregate, "plan", now);
  aggregate = reducer.startAttempt(aggregate, "plan", "plan-1", now);
  const retry = reducer.recordRetryableFailure(aggregate, "plan", {
    status: "failed", signal: "error", output: null, effects: [], artifacts: [], pendingInput: null,
    failure: { kind: "provider", message: "temporary", retryable: true, ambiguousMutation: false, attemptId: "plan-1" },
  }, now);
  assert.equal(retry.nodeExecutions.plan.status, "running");
  const failed = complete(reducer, retry, "PLANNING", "plan", "error", "INTERRUPT", {
    status: "failed", signal: "error", output: null, effects: [], artifacts: [], pendingInput: null,
    failure: { kind: "provider", message: "permanent", retryable: false, ambiguousMutation: false, attemptId: "plan-1" },
  });
  assert.equal(failed.execution.currentNodeId, "INTERRUPT");
  const finding = reducer.recordFindings(failed, [{ text: "needs review", source: "qa" }, { text: " ", source: "qa" }], "qa", now);
  const withFeedback = reducer.recordReviewFeedback(finding, "qa", "qa", "Rejected", ["diagnostic"], now);
  assert.equal(withFeedback.context.findings.length, 2);
  const paused = reducer.setStatus(withFeedback, "PAUSED", "operator pause", now);
  assert.equal(reducer.resumeRun(paused, "continue", now).execution.status, "RUNNING");
  const access = reducer.setAccessMode(paused, "full_access", now);
  assert.equal(access.context.accessMode, "full_access");
  const budget = reducer.blockForBudget(paused, new WorkflowBudgetError("cycles"), now);
  assert.equal(budget.execution.status, "BLOCKED");

  const staleReadOnly = structuredClone(initial);
  staleReadOnly.execution.currentNodeId = "QA_REVIEW";
  const reserved = reducer.reserveNode(staleReadOnly, "qa", now);
  const running = { ...reserved, nodeExecutions: { ...reserved.nodeExecutions, qa: { ...reserved.nodeExecutions.qa, status: "running" as const } } };
  const recovered = reducer.recoverStaleActivation(running, now);
  assert.equal(recovered.nodeExecutions.qa.status, "reserved");

  const staleMutation = structuredClone(initial);
  staleMutation.execution.currentNodeId = "IMPLEMENTATION";
  const mutationReserved = reducer.reserveNode(staleMutation, "mutation", now);
  const mutationRunning = { ...mutationReserved, nodeExecutions: { ...mutationReserved.nodeExecutions, mutation: { ...mutationReserved.nodeExecutions.mutation, status: "running" as const } } };
  const blocked = reducer.recoverStaleActivation(mutationRunning, now);
  assert.equal(blocked.execution.status, "BLOCKED");
});

test("reducer preserves verification checkpoint ordering and invalidation semantics", async () => {
  const { aggregate: source, reducer, command } = await verificationFixture();
  assert.throws(() => reducer.recordVerificationCommand(source, { ...command, commandId: "missing" }, now), /not in the active contract/u);
  const invalidated = reducer.invalidateVerificationProof(source, "workspace changed", now);
  assert.match(invalidated.context.verificationInvalidationReason!, /workspace changed/u);
  const paused = reducer.pauseForVerificationInvalidation(source, "watcher failed", now);
  assert.equal(paused.execution.status, "PAUSED");
  assert.equal(paused.execution.currentNodeId, "TEST");
  assert.throws(() => reducer.confirmWorkspaceFingerprint(source, "bad", now), /SHA-256/u);
  const confirmed = reducer.confirmWorkspaceFingerprint(source, digest, now);
  assert.equal(confirmed.context.latestWorkspaceFingerprint, digest);
});

test("reducer binds QA and master approvals to the same proof", async () => {
  const { aggregate: source, reducer, command } = await verificationFixture();
  const result = artifact("c".repeat(64), "application/vnd.custom-agent-loop.verification-result+json;version=1");
  const proof: VerificationProof = {
    proofId: "proof-review",
    verificationId: "verify_verification",
    contractRevision: 1,
    contractHash: source.context.verificationContract!.contractHash,
    baselineFingerprint: digest,
    beforeFingerprint: digest,
    afterFingerprint: digest,
    implementationActivationId: "impl",
    testActivationId: "test",
    commands: [command],
    passed: true,
    verifiedAt: now,
    watcherReliable: true,
    executionError: false,
    resultArtifactId: result.artifactId,
  };
  let aggregate = reducer.recordVerificationProof(source, proof, now, result);
  aggregate = complete(reducer, aggregate, "VERIFY", "verify", "pass", "QA_REVIEW");
  aggregate = reducer.reserveNode(aggregate, "qa-review", now);
  aggregate = reducer.startAttempt(aggregate, "qa-review", "qa-attempt", now);
  const qaApproval = {
    type: "record_review_approval" as const,
    stage: "qa" as const,
    proofId: proof.proofId,
    contractRevision: 1,
    requirementIds: ["REQ-001"],
    resolvedFindingIds: [],
    rationale: "The core proof and requirement evidence are complete.",
  };
  aggregate = complete(
    reducer,
    aggregate,
    "QA_REVIEW",
    "qa-review",
    "approved",
    "MASTER_APPROVAL",
    { ...success("approved"), effects: [qaApproval] }
  );
  assert.equal(aggregate.context.reviewApprovals[0]?.stage, "qa");
  aggregate = reducer.reserveNode(aggregate, "master-review", now);
  aggregate = reducer.startAttempt(aggregate, "master-review", "master-attempt", now);
  aggregate = reducer.recordReviewApproval({
    ...aggregate,
    context: {
      ...aggregate.context,
      latestWorkspaceFingerprint: proof.afterFingerprint,
    },
  }, {
    stage: "master",
    activationId: "master-review",
    proofId: proof.proofId,
    contractRevision: 1,
    requirementIds: ["REQ-001"],
    resolvedFindingIds: [],
    rationale: "The final approval matches the QA proof.",
    recordedAt: now,
  }, now);
  assert.equal(aggregate.context.reviewApprovals[aggregate.context.reviewApprovals.length - 1]?.stage, "master");
});

test("reducer rejects stale proof metadata and invalid command checkpoints", async () => {
  const { aggregate: source, reducer, command } = await verificationFixture();
  const result = artifact("d".repeat(64), "application/vnd.custom-agent-loop.verification-result+json;version=1");
  const base: VerificationProof = {
    proofId: "proof-invalid",
    verificationId: "verify_verification",
    contractRevision: 1,
    contractHash: source.context.verificationContract!.contractHash,
    baselineFingerprint: digest,
    beforeFingerprint: digest,
    afterFingerprint: digest,
    implementationActivationId: "impl",
    testActivationId: "test",
    commands: [command],
    passed: true,
    verifiedAt: now,
    watcherReliable: true,
    executionError: false,
    resultArtifactId: result.artifactId,
  };
  for (const [name, change] of [
    ["wrong activation", { verificationId: "other_verification" }],
    ["wrong contract", { contractRevision: 2 }],
    ["wrong baseline", { baselineFingerprint: "b".repeat(64) }],
    ["bad metadata", { verifiedAt: "invalid" }],
    ["bad order", { commands: [{ ...command, commandId: "unknown" }] as VerificationCommandRecord[] }],
    ["wrong result", { resultArtifactId: "artifact_" + "e".repeat(64) }],
  ] as const) {
    assert.throws(
      () => reducer.recordVerificationProof(source, { ...base, ...change }, now, result),
      name === "wrong activation" ? /active verification activation/u : /Verification/u
    );
  }
  const cleanCheckpointSource = {
    ...source,
    context: { ...source.context, verificationRecords: [] },
  };
  assert.throws(
    () => reducer.recordVerificationCommand(cleanCheckpointSource, { ...command, status: "running", startedAt: null }, now),
    /running verification command requires/u
  );
  assert.throws(
    () => reducer.recordVerificationCommand(cleanCheckpointSource, { ...command, status: "completed", completedAt: null }, now),
    /completed verification command has invalid/u
  );
});

test("reducer handles human input and contract replacement without reusing request ids", async () => {
  const { aggregate: initial, reducer } = await fixture();
  let aggregate = initial;
  aggregate.execution.currentNodeId = "PLAN_APPROVAL";
  const reserved = reducer.reserveNode(aggregate, "gate", now);
  const waiting = reducer.requestHumanInput(reserved, { prompt: "choose" }, now);
  assert.match(waiting.pendingInput!.requestId, /^request_gate_plan_approval_1$/u);
  const revised = reducer.applyHumanResponse(waiting, {
    requestId: waiting.pendingInput!.requestId,
    nodeId: "PLAN_APPROVAL",
    signal: "revision_requested",
    respondedAt: now,
  });
  assert.equal(revised.context.selectedPlanChoiceId, null);
  assert.equal(revised.execution.status, "RUNNING");

  const contract = createVerificationContract(
    [{ id: "unit", label: "unit", executable: "node", args: ["--version"], cwd: ".", timeoutMs: 1_000, requirementIds: ["REQ-001"] }],
    digest,
    "approval",
    { paths: [], fileHashes: {} }
  );
  const baseline = artifact(digest, "application/vnd.custom-agent-loop.workspace-fingerprint+json;version=1");
  contract.baselineArtifactId = baseline.artifactId;
  const withContract = reducer.setVerificationContract({ ...revised, artifacts: { [baseline.artifactId]: baseline } }, contract, now, baseline);
  assert.equal(withContract.context.verificationContract?.revision, 1);
  assert.throws(
    () => reducer.setVerificationContract(withContract, { ...contract, revision: 1, contractHash: "0".repeat(64) }, now, baseline),
    /hash does not match/u
  );
});

test("reducer records and refreshes verification approval candidates atomically", async () => {
  const { aggregate: source, reducer } = await verificationFixture();
  const reserved = structuredClone(source);
  reserved.execution.activeActivationId = "verify";
  reserved.nodeExecutions.verify.status = "reserved";
  reserved.context.verificationRecords = [];
  const candidate: VerificationApprovalCandidate = {
    candidateHash: "",
    baseRevision: reserved.context.verificationContract!.revision,
    baselineFingerprint: digest,
    baselineArtifactId: null,
    diffArtifactId: null,
    commands: [...reserved.context.verificationContract!.commands],
    totalTimeoutMs: reserved.context.verificationContract!.totalTimeoutMs,
    protectedPaths: [], testRoots: [], allowedNewTestRoots: [], generatedOutputPaths: [],
    changedPaths: ["src/new-test.ts"], addedPaths: ["src/new-test.ts"], modifiedPaths: [], deletedPaths: [],
    baselinePaths: [], baselineFileHashes: {}, baselineFileModes: {},
  };
  candidate.candidateHash = hashVerificationCandidate(candidate);
  const waiting = reducer.requestVerificationApproval(reserved, candidate, now, "approve candidate");
  assert.equal(waiting.execution.status, "WAITING_USER");
  assert.equal(waiting.pendingInput?.kind, "verification_approval");
  const replay = reducer.requestVerificationApproval(waiting, candidate, now);
  assert.equal(replay.pendingInput?.requestId, waiting.pendingInput?.requestId);
  const changed: VerificationApprovalCandidate = {
    ...candidate,
    commands: candidate.commands.map((command) => ({ ...command, args: ["--help"] })),
    changedPaths: ["src/changed-test.ts"], addedPaths: [], modifiedPaths: ["src/changed-test.ts"],
    candidateHash: "",
  };
  changed.candidateHash = hashVerificationCandidate(changed);
  const refreshed = reducer.refreshVerificationApprovalCandidate(waiting, changed, now, "review the changed candidate");
  assert.notEqual(refreshed.pendingInput?.requestId, waiting.pendingInput?.requestId);
  assert.equal(refreshed.context.verificationCandidate?.candidateHash, changed.candidateHash);
  assert.equal(reducer.refreshVerificationApprovalCandidate(refreshed, changed, now).pendingInput?.requestId, refreshed.pendingInput?.requestId);
  assert.throws(() => reducer.refreshVerificationApprovalCandidate(reserved, changed, now), /pending verification approval/u);
});

test("reducer replaces verification contracts and enforces sequential command checkpoints", async () => {
  const { aggregate: initial, reducer } = await fixture();
  const baseline = artifact(digest, "application/vnd.custom-agent-loop.workspace-fingerprint+json;version=1");
  const contract = createVerificationContract(
    [
      { id: "one", label: "one", executable: "node", args: ["--version"], cwd: ".", timeoutMs: 1000, requirementIds: ["REQ-001"] },
      { id: "two", label: "two", executable: "node", args: ["--version"], cwd: ".", timeoutMs: 1000, requirementIds: ["REQ-001"] },
    ], digest, "request-2", { paths: [], fileHashes: {} }
  );
  contract.revision = 2;
  contract.baselineArtifactId = baseline.artifactId;
  contract.contractHash = hashVerificationContract(contract);
  let aggregate = reducer.setVerificationContract({ ...initial, artifacts: { [baseline.artifactId]: baseline } }, contract, now, baseline);
  assert.equal(aggregate.context.verificationContract?.revision, 2);
  assert.equal(aggregate.context.verificationProof, null);
  assert.equal(reducer.setVerificationContract(aggregate, contract, now).revision, aggregate.revision);
  aggregate.execution.currentNodeId = "VERIFY";
  aggregate = reducer.reserveNode(aggregate, "verify-checkpoints", now);
  aggregate = reducer.startVerification(aggregate, "verify-checkpoints", now);
  const make = (commandId: string, status: VerificationCommandRecord["status"]): VerificationCommandRecord => ({
    verificationId: "verify-checkpoints_verification", commandId, status, executable: "node", args: ["--version"], cwd: process.cwd(),
    approvedExecutable: "node", approvedArgs: ["--version"], approvedCwd: ".", startedAt: status === "reserved" ? null : now,
    completedAt: status === "completed" ? now : null, exitCode: status === "completed" ? 0 : null, signal: null,
    timedOut: false, processTreeClean: status === "completed" ? true : null, logArtifactId: null, summary: status, elapsedMs: 1,
  });
  assert.throws(() => reducer.recordVerificationCommand(aggregate, make("two", "reserved"), now), /out of execution order/u);
  aggregate = reducer.recordVerificationCommand(aggregate, make("one", "reserved"), now);
  aggregate = reducer.recordVerificationCommand(aggregate, make("one", "running"), now);
  aggregate = reducer.recordVerificationCommand(aggregate, make("one", "completed"), now);
  aggregate = reducer.recordVerificationCommand(aggregate, make("two", "reserved"), now);
  assert.equal(aggregate.context.verificationRecords.filter((record) => record.status === "completed").length, 1);
  assert.throws(() => reducer.recordVerificationCommand(aggregate, { ...make("two", "completed"), processTreeClean: false }, now), /Invalid verification command state transition/u);
});
