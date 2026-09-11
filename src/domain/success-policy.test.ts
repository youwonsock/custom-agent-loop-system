import assert from "node:assert/strict";
import test from "node:test";
import { assertSuccessEligible, SuccessEligibilityError } from "./success-policy";
import type { RunAggregate } from "./run-aggregate";

function freshAggregate(): RunAggregate {
  return {
    schemaVersion: 2,
    runId: "success-policy-test",
    definition: {
      schemaVersion: 2,
      definitionHash: "a".repeat(64),
      startNodeId: "VERIFY",
      nodes: {
        VERIFY: { id: "VERIFY", kind: "verification", commands: [], sideEffect: "workspace_mutation", inputs: [] },
      },
      transitions: {},
      terminals: [{ id: "SUCCESS", status: "succeeded" }],
      cyclePolicy: { startNodeId: "VERIFY", completionNodeIds: ["VERIFY"] },
      applicationPolicy: { interruptNodeId: "VERIFY", blockedTerminalId: "SUCCESS", implementationNodeId: "VERIFY", testNodeId: "VERIFY", verificationNodeId: "VERIFY", qaNodeId: "VERIFY", completionApprovalNodeId: "VERIFY" },
      budgets: { maxWorkflowSteps: 10, maxCycles: 2, maxArtifactInputBytes: 1000, maxEvents: 10, maxNodeExecutions: 10 },
      analysis: { reachableNodeIds: ["VERIFY"], terminalIds: ["SUCCESS"], requiredApprovalGateIds: [], cyclicComponents: [] },
      agents: {}, tasks: {},
    },
    context: {
      goal: "verify success invariants", requirements: [{ id: "REQ-001", text: "The invariant is enforced." }],
      approvedPlan: null, selectedPlanChoiceId: null, targetProjectPath: process.cwd(), additionalAllowedPaths: [], accessMode: "ask", planChoices: [], selectedVerificationDraft: null,
      requirementEvidence: [], failureSummary: null, recovery: null, convergence: { stagnantCycles: 0, history: [] }, interruptBriefing: null, humanResponses: {}, verificationContract: null, verificationRecords: [], verificationProof: null, verificationCandidate: null, verificationInvalidationReason: null, reviewApprovals: [], findings: [], verificationFeedback: [], latestWorkspaceFingerprint: null, verificationCriteriaChanges: [], verificationElapsedMs: 0, requestSequence: 0, resumeNodeId: null,
    },
    execution: { status: "RUNNING", currentNodeId: "VERIFY", activeActivationId: null, workflowStepsConsumed: 0, cyclesStarted: 0, cyclesCompleted: 0, activeCycleNumber: null, reason: null, lastFailure: null },
    nodeExecutions: {}, latestCompletedByNode: {}, pendingInput: null, artifacts: {}, events: [], eventSequence: 0, processedRequestIds: [], revision: 0, fencingEpoch: 0, checksum: "", createdAt: "2026-09-06T00:00:00.000Z", updatedAt: "2026-09-06T00:00:00.000Z",
  };
}

test("core verification rejects an aggregate with no proof", () => {
  const aggregate = freshAggregate();
  assert.throws(() => assertSuccessEligible(aggregate), SuccessEligibilityError);
});

function eligibleSecondCycleAggregate(): RunAggregate {
  const aggregate = freshAggregate();
  const digest = "b".repeat(64);
  aggregate.definition.nodes = {
    CHANGE_CODE: { id: "CHANGE_CODE", kind: "task", taskId: "change", agentId: "writer", inputs: [], sideEffect: "workspace_mutation" },
    PREPARE_CHECKS: { id: "PREPARE_CHECKS", kind: "task", taskId: "checks", agentId: "tester", inputs: [], sideEffect: "workspace_mutation" },
    VERIFY: { id: "VERIFY", kind: "verification", commands: [], sideEffect: "workspace_mutation", inputs: [] },
    QA: { id: "QA", kind: "task", taskId: "qa", agentId: "reviewer", inputs: [], sideEffect: "none" },
    MASTER: { id: "MASTER", kind: "task", taskId: "master", agentId: "approver", inputs: [], sideEffect: "none" },
  };
  aggregate.definition.applicationPolicy = {
    interruptNodeId: "VERIFY",
    blockedTerminalId: "SUCCESS",
    implementationNodeId: "CHANGE_CODE",
    testNodeId: "PREPARE_CHECKS",
    verificationNodeId: "VERIFY",
    qaNodeId: "QA",
    completionApprovalNodeId: "MASTER",
  };
  aggregate.context.approvedPlan = {
    activationId: "plan",
    artifactId: "artifact_plan",
    schemaId: "plan.v2",
    signal: "success",
    summary: "approved",
  };
  aggregate.context.selectedPlanChoiceId = "choice";
  aggregate.context.verificationContract = {
    commands: [], totalTimeoutMs: 1, protectedPaths: [], testRoots: [], allowedNewTestRoots: [], generatedOutputPaths: [],
    revision: 2, contractHash: digest, approvedRequestId: "request", approvedAt: "2026-09-06T00:00:00.000Z",
    baselineArtifactId: "artifact_baseline", baselineFingerprint: digest,
    baselinePaths: [], baselineFileHashes: {}, baselineFileModes: {},
  };
  const execution = (activationId: string, nodeId: string, step: number, cycleNumber: number, status: "completed" | "running") => ({
    activationId, nodeId, taskId: nodeId === "VERIFY" ? null : nodeId, agentId: nodeId === "VERIFY" ? null : nodeId,
    workflowStep: step, cycleNumber, status, sideEffect: "workspace_mutation" as const,
    attemptIds: [], reservedAt: "2026-09-06T00:00:00.000Z", startedAt: null, completedAt: status === "completed" ? "2026-09-06T00:00:00.000Z" : null,
    output: null, signal: null, failure: null,
  });
  aggregate.nodeExecutions = {
    impl_one: execution("impl_one", "CHANGE_CODE", 1, 1, "completed"),
    test_one: execution("test_one", "PREPARE_CHECKS", 2, 1, "completed"),
    verify_one: execution("verify_one", "VERIFY", 3, 1, "completed"),
    impl_two: execution("impl_two", "CHANGE_CODE", 4, 2, "completed"),
    test_two: execution("test_two", "PREPARE_CHECKS", 5, 2, "completed"),
    verify_two: execution("verify_two", "VERIFY", 6, 2, "completed"),
  };
  aggregate.context.verificationProof = {
    proofId: "proof_two", verificationId: "verify_two_verification", contractRevision: 2, contractHash: digest,
    baselineFingerprint: digest, beforeFingerprint: digest, afterFingerprint: digest,
    implementationActivationId: "impl_two", testActivationId: "test_two", commands: [], passed: true,
    verifiedAt: "2026-09-06T00:00:00.000Z", watcherReliable: true,
  };
  aggregate.context.reviewApprovals = [
    { stage: "qa", activationId: "qa", proofId: "proof_two", contractRevision: 2, requirementIds: ["REQ-001"], resolvedFindingIds: [], rationale: "checked", recordedAt: "2026-09-06T00:00:00.000Z" },
    { stage: "master", activationId: "master", proofId: "proof_two", contractRevision: 2, requirementIds: ["REQ-001"], resolvedFindingIds: [], rationale: "approved", recordedAt: "2026-09-06T00:00:00.000Z" },
  ];
  aggregate.context.requirementEvidence = [{ activationId: "verify_two", requirementId: "REQ-001", status: "satisfied", evidence: "core verification", artifactIds: [] }];
  aggregate.context.latestWorkspaceFingerprint = digest;
  return aggregate;
}

test("success eligibility binds proof to the implementation and test activations in its own cycle", () => {
  const eligible = eligibleSecondCycleAggregate();
  assert.doesNotThrow(() => assertSuccessEligible(eligible));

  const staleTest = structuredClone(eligible);
  staleTest.context.verificationProof!.testActivationId = "test_one";
  assert.throws(() => assertSuccessEligible(staleTest), /latest implementation and test activations/u);
});

test("success eligibility rejects every stale or incomplete verification boundary", () => {
  const cases: Array<[string, (aggregate: RunAggregate) => void, RegExp]> = [
    ["missing approved plan", (aggregate) => { aggregate.context.approvedPlan = null; }, /approved plan/u],
    ["missing plan choice", (aggregate) => { aggregate.context.selectedPlanChoiceId = null; }, /approved plan/u],
    ["failed proof", (aggregate) => { aggregate.context.verificationProof!.passed = false; }, /valid core verification proof/u],
    ["unreliable watcher", (aggregate) => { aggregate.context.verificationProof!.watcherReliable = false; }, /valid core verification proof/u],
    ["execution error", (aggregate) => { aggregate.context.verificationProof!.executionError = true; }, /valid core verification proof/u],
    ["obsolete revision", (aggregate) => { aggregate.context.verificationProof!.contractRevision = 1; }, /obsolete contract revision/u],
    ["obsolete hash", (aggregate) => { aggregate.context.verificationProof!.contractHash = "c".repeat(64); }, /obsolete contract hash/u],
    ["changed baseline", (aggregate) => { aggregate.context.verificationProof!.baselineFingerprint = "c".repeat(64); }, /approved file baseline/u],
    ["changed workspace during proof", (aggregate) => { aggregate.context.verificationProof!.afterFingerprint = "c".repeat(64); }, /approved file baseline/u],
    ["invalidated proof", (aggregate) => { aggregate.context.verificationInvalidationReason = "watcher became unreliable"; }, /invalidated/u],
    ["pending criteria change", (aggregate) => { aggregate.context.verificationCriteriaChanges.push("new command"); }, /criteria changes/u],
    ["missing approval", (aggregate) => { aggregate.context.reviewApprovals.pop(); }, /QA and master approvals/u],
    ["different approval proof", (aggregate) => { aggregate.context.reviewApprovals[1].proofId = "other"; }, /current proof/u],
    ["open finding", (aggregate) => { aggregate.context.findings.push({ id: "finding_open", text: "unresolved", status: "open", source: "qa", artifactIds: [], firstSeenAt: "2026-09-06T00:00:00.000Z", resolvedAt: null }); }, /unresolved findings/u],
    ["pending decision", (aggregate) => { aggregate.pendingInput = { requestId: "request", kind: "verification_approval", nodeId: "VERIFY", activationId: "verify_two", prompt: "approve", allowedSignals: ["approved", "rejected"], context: null, createdAt: "2026-09-06T00:00:00.000Z" }; }, /pending verification decision/u],
    ["unknown mutation", (aggregate) => { aggregate.nodeExecutions.unknown = { ...aggregate.nodeExecutions.impl_two, activationId: "unknown", workflowStep: 0, status: "unknown_mutation" }; }, /unknown mutation/u],
    ["unsatisfied requirement", (aggregate) => { aggregate.context.requirementEvidence = []; }, /Every requirement/u],
    ["stale latest fingerprint", (aggregate) => { aggregate.context.latestWorkspaceFingerprint = "c".repeat(64); }, /latest core workspace fingerprint/u],
  ];
  for (const [label, mutate, expected] of cases) {
    const aggregate = eligibleSecondCycleAggregate();
    mutate(aggregate);
    assert.throws(() => assertSuccessEligible(aggregate), expected, label);
  }
});

test("success eligibility rejects proof from a non-configured verification node", () => {
  const aggregate = eligibleSecondCycleAggregate();
  aggregate.definition.nodes.OTHER_VERIFY = {
    id: "OTHER_VERIFY",
    kind: "verification",
    commands: [],
    sideEffect: "workspace_mutation",
    inputs: [],
  };
  aggregate.nodeExecutions.other_verify = {
    ...aggregate.nodeExecutions.verify_two,
    activationId: "other_verify",
    nodeId: "OTHER_VERIFY",
    workflowStep: 7,
  };
  aggregate.context.verificationProof!.verificationId = "other_verify_verification";
  assert.throws(() => assertSuccessEligible(aggregate), /configured verification node/u);
});

test("definitions without the core verification policy cannot become successful", () => {
  const aggregate = freshAggregate();
  aggregate.definition = {
    ...aggregate.definition,
    nodes: { IMPLEMENTATION: { id: "IMPLEMENTATION", kind: "task", taskId: "task", agentId: "agent", inputs: [], sideEffect: "workspace_mutation" } },
    applicationPolicy: { interruptNodeId: "IMPLEMENTATION", blockedTerminalId: "SUCCESS", implementationNodeId: "IMPLEMENTATION", testNodeId: "IMPLEMENTATION", verificationNodeId: "IMPLEMENTATION", qaNodeId: "IMPLEMENTATION", completionApprovalNodeId: "IMPLEMENTATION" },
  };
  assert.throws(() => assertSuccessEligible(aggregate), SuccessEligibilityError);
});
