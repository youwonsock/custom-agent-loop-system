import assert from "node:assert/strict";
import test from "node:test";
import { createRunAggregate } from "../../src/application/run-factory";
import { createDefaultDefinitionRegistries } from "../../src/definitions/default-registries";
import { loadDefinitionSource } from "../../src/definitions/definition-loader";
import { compileWorkflow } from "../../src/definitions/workflow-compiler";
import { runChecksum, validateRunAggregateV2 } from "../../src/infrastructure/file-run-repository";

test("RunAggregate v2 validation requires the complete verification contract shape", async () => {
  const source = await loadDefinitionSource(process.cwd());
  const definition = compileWorkflow(source, createDefaultDefinitionRegistries());
  const aggregate = createRunAggregate({
    runId: "aggregate-validation",
    definition,
    goal: "validate the current aggregate contract",
    requirements: [{ id: "REQ-001", text: "The current aggregate contract is validated." }],
    targetProjectPath: process.cwd(),
  }) as any;
  const command = {
    id: "check",
    label: "Check",
    executable: "node",
    args: ["--version"],
    cwd: ".",
    timeoutMs: 1_000,
    requirementIds: ["REQ-001"],
  };
  const record = {
    verificationId: "verification-1",
    commandId: "check",
    status: "completed",
    executable: "node",
    args: ["--version"],
    cwd: ".",
    approvedExecutable: "node",
    approvedArgs: ["--version"],
    approvedCwd: ".",
    startedAt: "2026-09-12T00:00:00.000Z",
    completedAt: "2026-09-12T00:00:01.000Z",
    exitCode: 0,
    signal: null,
    timedOut: false,
    processTreeClean: true,
    logArtifactId: null,
    summary: "ok",
  };
  const contract = {
    ...command,
    commands: [command],
    revision: 1,
    contractHash: "a".repeat(64),
    approvedRequestId: "request-1",
    approvedAt: "2026-09-12T00:00:00.000Z",
    baselineArtifactId: "baseline-1",
    baselineFingerprint: "b".repeat(64),
    baselinePaths: ["package.json"],
    baselineFileHashes: { "package.json": "c".repeat(64) },
    baselineFileModes: { "package.json": 0o644 },
    totalTimeoutMs: 1_000,
    protectedPaths: [],
    testRoots: ["tests"],
    allowedNewTestRoots: ["tests"],
    generatedOutputPaths: ["dist"],
  };
  const candidate = {
    candidateHash: "d".repeat(64),
    baseRevision: 1,
    commands: [command],
    baselineFingerprint: contract.baselineFingerprint,
    changedPaths: ["tests/new.test.ts"],
    addedPaths: ["tests/new.test.ts"],
    modifiedPaths: [],
    deletedPaths: [],
    diffArtifactId: null,
    baselineArtifactId: contract.baselineArtifactId,
    baselinePaths: contract.baselinePaths,
    baselineFileHashes: contract.baselineFileHashes,
    baselineFileModes: contract.baselineFileModes,
    totalTimeoutMs: contract.totalTimeoutMs,
    protectedPaths: contract.protectedPaths,
    testRoots: contract.testRoots,
    allowedNewTestRoots: contract.allowedNewTestRoots,
    generatedOutputPaths: contract.generatedOutputPaths,
  };
  aggregate.context.verificationContract = contract;
  aggregate.context.verificationRecords = [record];
  aggregate.context.verificationProof = {
    proofId: "proof-1",
    verificationId: "verification-1",
    contractRevision: 1,
    contractHash: contract.contractHash,
    baselineFingerprint: contract.baselineFingerprint,
    beforeFingerprint: "e".repeat(64),
    afterFingerprint: "f".repeat(64),
    implementationActivationId: null,
    testActivationId: null,
    commands: [record],
    passed: true,
    verifiedAt: "2026-09-12T00:00:01.000Z",
    watcherReliable: true,
  };
  aggregate.context.verificationCandidate = candidate;
  aggregate.context.reviewApprovals = [{
    stage: "qa",
    activationId: "qa-1",
    proofId: "proof-1",
    contractRevision: 1,
    requirementIds: ["REQ-001"],
    resolvedFindingIds: [],
    rationale: "The proof is complete.",
    recordedAt: "2026-09-12T00:00:02.000Z",
  }];
  aggregate.context.latestWorkspaceFingerprint = "f".repeat(64);
  aggregate.checksum = runChecksum(aggregate);

  assert.equal(validateRunAggregateV2(aggregate), true);
  assert.equal(validateRunAggregateV2({ ...aggregate, context: { ...aggregate.context, requestSequence: -1 } }), false);
  assert.equal(validateRunAggregateV2({
    ...aggregate,
    context: {
      ...aggregate.context,
      verificationContract: { ...contract, baselineFileHashes: undefined },
    },
  }), false);
  assert.equal(validateRunAggregateV2({
    ...aggregate,
    context: {
      ...aggregate.context,
      verificationRecords: [{ ...record, approvedExecutable: undefined }],
    },
  }), false);
  assert.equal(validateRunAggregateV2({
    ...aggregate,
    context: {
      ...aggregate.context,
      reviewApprovals: [{ ...aggregate.context.reviewApprovals[0], proofId: undefined }],
    },
  }), false);
});
