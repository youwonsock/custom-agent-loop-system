import assert from "node:assert/strict";
import test from "node:test";
import { createRunAggregate } from "./run-factory";
import { RunReducer } from "./run-reducer";
import { createVerificationContract } from "./verification-runner";
import { createDefaultDefinitionRegistries } from "../definitions/default-registries";
import { loadDefinitionSource } from "../definitions/definition-loader";
import { compileWorkflow } from "../definitions/workflow-compiler";
import { candidateNeedsVerificationApproval, hashVerificationCandidate, type VerificationApprovalCandidate } from "../domain/verification";
import type { ArtifactReference } from "../domain/task-result";

const digest = "b".repeat(64);
const baseline: ArtifactReference = {
  artifactId: `artifact_${digest}`,
  sha256: digest,
  mediaType: "application/vnd.custom-agent-loop.workspace-fingerprint+json;version=1",
  bytes: 0,
  createdAt: "2026-09-06T00:00:00.000Z",
};

async function verificationAggregate() {
  const source = await loadDefinitionSource(process.cwd());
  const definition = compileWorkflow(source, createDefaultDefinitionRegistries());
  const aggregate = createRunAggregate({
    runId: "verification-approval-test",
    definition,
    goal: "reapprove verification safely",
    requirements: [{ id: "REQ-001", text: "The verification contract is approved." }],
    targetProjectPath: process.cwd(),
  });
  const contract = createVerificationContract(
    [{ id: "tests", label: "tests", executable: "node", args: ["test.js"], cwd: ".", timeoutMs: 1000, requirementIds: ["REQ-001"] }],
    digest,
    "initial",
    { paths: [], fileHashes: {} }
  );
  aggregate.context.verificationContract = { ...contract, baselineArtifactId: baseline.artifactId };
  aggregate.artifacts[baseline.artifactId] = baseline;
  aggregate.execution.currentNodeId = "VERIFY";
  const reducer = new RunReducer();
  return { aggregate: reducer.reserveNode(aggregate, "verify_activation", "2026-09-06T00:00:00.000Z"), reducer };
}

function candidate(contractRevision: number): VerificationApprovalCandidate {
  const body = {
    baseRevision: contractRevision,
    commands: [{ id: "tests", label: "tests", executable: "node", args: ["test.js"], cwd: ".", timeoutMs: 1000, requirementIds: ["REQ-001"] }],
    changedPaths: [], addedPaths: [], modifiedPaths: [], deletedPaths: [],
    baselineFingerprint: digest,
    baselinePaths: [], baselineFileHashes: {},
    totalTimeoutMs: 2000,
    protectedPaths: [], testRoots: [], allowedNewTestRoots: [], generatedOutputPaths: [],
    diffArtifactId: null,
    baselineArtifactId: null,
  };
  return { ...body, candidateHash: hashVerificationCandidate(body) };
}

test("verification approval requests are idempotent and reject stale candidates", async () => {
  const { aggregate: reserved, reducer } = await verificationAggregate();
  const first = reducer.requestVerificationApproval(reserved, candidate(1), "2026-09-06T00:00:00.000Z");
  const repeated = reducer.requestVerificationApproval(first, candidate(1), "2026-09-06T00:00:01.000Z");
  assert.equal(repeated.context.requestSequence, first.context.requestSequence);
  assert.equal(repeated.pendingInput?.requestId, first.pendingInput?.requestId);
  const changed = candidate(1);
  changed.commands[0].args = ["different.js"];
  changed.candidateHash = hashVerificationCandidate(changed);
  assert.throws(() => reducer.requestVerificationApproval(first, changed, "2026-09-06T00:00:02.000Z"), /different verification approval candidate/u);
});

test("approving a current candidate advances the contract and invalidates old proof", async () => {
  const { aggregate: reserved, reducer } = await verificationAggregate();
  const waiting = reducer.requestVerificationApproval(reserved, candidate(1), "2026-09-06T00:00:00.000Z");
  const response = reducer.applyHumanResponse(waiting, {
    requestId: waiting.pendingInput!.requestId,
    nodeId: "VERIFY",
    signal: "approved",
    value: { candidateHash: waiting.context.verificationCandidate!.candidateHash },
    respondedAt: "2026-09-06T00:00:01.000Z",
  });
  assert.equal(response.context.verificationContract?.revision, 2);
  assert.equal(response.context.verificationProof, null);
  assert.equal(response.pendingInput, null);
  assert.equal(response.execution.activeActivationId, "verify_activation");
});

test("rejecting a verification candidate is delivered as durable feedback to TEST", async () => {
  const { aggregate: reserved, reducer } = await verificationAggregate();
  const waiting = reducer.requestVerificationApproval(
    reserved,
    candidate(1),
    "2026-09-06T00:00:00.000Z"
  );
  const response = reducer.applyHumanResponse(waiting, {
    requestId: waiting.pendingInput!.requestId,
    nodeId: "VERIFY",
    signal: "rejected",
    value: {
      candidateHash: waiting.context.verificationCandidate!.candidateHash,
      message: "Do not modify the existing test harness.",
    },
    respondedAt: "2026-09-06T00:00:01.000Z",
  });
  const feedback = response.context.verificationFeedback[0];
  assert.equal(feedback?.passed, false);
  assert.equal(feedback?.sourceActivationId, "verify_activation");
  assert.deepEqual(feedback?.diagnostics, ["Do not modify the existing test harness."]);
  assert.equal(response.execution.currentNodeId, "TEST");
});

test("SUCCESS cannot be injected through a generic status mutation", async () => {
  const { aggregate, reducer } = await verificationAggregate();
  assert.throws(
    () => reducer.setStatus(aggregate, "SUCCESS" as any, "forged", "2026-09-06T00:00:00.000Z"),
    /validated workflow transition/u
  );
});

test("cancelling an active verification resumes from TEST instead of replaying VERIFY", async () => {
  const { aggregate, reducer } = await verificationAggregate();
  const started = reducer.startVerification(
    aggregate,
    "verify_activation",
    "2026-09-06T00:00:01.000Z"
  );
  const stopped = reducer.applyBoundaryControl(
    started,
    "stop-verification",
    "stop",
    "Operator cancelled verification.",
    "2026-09-06T00:00:02.000Z",
    true
  );
  assert.equal(stopped.execution.status, "STOPPED");
  assert.equal(stopped.context.resumeNodeId, "TEST");
  assert.equal(stopped.context.verificationProof, null);
  const resumed = reducer.resumeRun(
    stopped,
    "Operator resumed after verification cancellation.",
    "2026-09-06T00:00:03.000Z"
  );
  assert.equal(resumed.execution.currentNodeId, "TEST");
  assert.equal(resumed.context.resumeNodeId, null);
});

test("an uncertain verification cleanup blocks STOP instead of claiming a clean stop", async () => {
  const { aggregate, reducer } = await verificationAggregate();
  const started = reducer.startVerification(
    aggregate,
    "verify_activation",
    "2026-09-06T00:00:01.000Z"
  );
  started.context.verificationRecords = [{
    verificationId: "verify_activation_verification",
    commandId: "tests",
    status: "completed",
    executable: "node",
    args: ["test.js"],
    cwd: process.cwd(),
    approvedExecutable: "node",
    approvedArgs: ["test.js"],
    approvedCwd: ".",
    startedAt: "2026-09-06T00:00:01.000Z",
    completedAt: "2026-09-06T00:00:02.000Z",
    exitCode: null,
    signal: "SIGTERM",
    timedOut: false,
    processTreeClean: false,
    logArtifactId: null,
    summary: "cleanup could not be confirmed",
  }];
  const blocked = reducer.applyBoundaryControl(
    started,
    "stop-uncertain-verification",
    "stop",
    "Operator stopped verification.",
    "2026-09-06T00:00:03.000Z",
    true
  );
  assert.equal(blocked.execution.status, "BLOCKED");
  assert.equal(blocked.nodeExecutions.verify_activation.status, "unknown_mutation");
  assert.match(blocked.execution.reason ?? "", /could not be confirmed/u);
});

test("changes to a declared verification entrypoint require reapproval", () => {
  const entrypoint = `${process.cwd()}\\custom-check.mjs`;
  const contract = createVerificationContract(
    [{ id: "check", label: "check", executable: "node", args: ["custom-check.mjs"], cwd: ".", timeoutMs: 1000, requirementIds: ["REQ-001"] }],
    digest,
    "initial",
    { paths: [entrypoint], fileHashes: { [entrypoint]: "a".repeat(64) } }
  );
  const changed: VerificationApprovalCandidate = {
    ...candidate(contract.revision),
    changedPaths: [entrypoint],
    modifiedPaths: [entrypoint],
  };
  changed.candidateHash = hashVerificationCandidate(changed);
  assert.equal(candidateNeedsVerificationApproval(contract, changed, process.cwd()), true);
});
