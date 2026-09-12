import assert from "node:assert/strict";
import test from "node:test";
import { resolveVerificationActivationScope } from "../../src/domain/verification-activation-scope";
import type { RunAggregate } from "../../src/domain/run-aggregate";

function aggregateWithTwoCycles(): RunAggregate {
  return {
    definition: {
      applicationPolicy: {
        implementationNodeId: "CHANGE_CODE",
        testNodeId: "PREPARE_CHECKS",
        verificationNodeId: "CORE_VERIFY",
      },
      nodes: {
        CHANGE_CODE: { id: "CHANGE_CODE", kind: "task", taskId: "change", agentId: "writer", inputs: [], sideEffect: "workspace_mutation" },
        PREPARE_CHECKS: { id: "PREPARE_CHECKS", kind: "task", taskId: "checks", agentId: "tester", inputs: [], sideEffect: "workspace_mutation" },
        CORE_VERIFY: { id: "CORE_VERIFY", kind: "verification", commands: [], inputs: [], sideEffect: "workspace_mutation" },
      },
    },
    nodeExecutions: {
      impl_one: { activationId: "impl_one", nodeId: "CHANGE_CODE", taskId: "change", agentId: "writer", workflowStep: 10, cycleNumber: 1, status: "completed", sideEffect: "workspace_mutation", attemptIds: [], reservedAt: "", startedAt: null, completedAt: "", output: null, signal: "success", failure: null },
      test_one: { activationId: "test_one", nodeId: "PREPARE_CHECKS", taskId: "checks", agentId: "tester", workflowStep: 11, cycleNumber: 1, status: "completed", sideEffect: "workspace_mutation", attemptIds: [], reservedAt: "", startedAt: null, completedAt: "", output: null, signal: "prepared", failure: null },
      verify_one: { activationId: "verify_one", nodeId: "CORE_VERIFY", taskId: null, agentId: null, workflowStep: 12, cycleNumber: 1, status: "completed", sideEffect: "workspace_mutation", attemptIds: [], reservedAt: "", startedAt: "", completedAt: "", output: null, signal: "fail", failure: null },
      impl_two: { activationId: "impl_two", nodeId: "CHANGE_CODE", taskId: "change", agentId: "writer", workflowStep: 20, cycleNumber: 2, status: "completed", sideEffect: "workspace_mutation", attemptIds: [], reservedAt: "", startedAt: null, completedAt: "", output: null, signal: "success", failure: null },
      test_two: { activationId: "test_two", nodeId: "PREPARE_CHECKS", taskId: "checks", agentId: "tester", workflowStep: 21, cycleNumber: 2, status: "completed", sideEffect: "workspace_mutation", attemptIds: [], reservedAt: "", startedAt: null, completedAt: "", output: null, signal: "prepared", failure: null },
      verify_two: { activationId: "verify_two", nodeId: "CORE_VERIFY", taskId: null, agentId: null, workflowStep: 22, cycleNumber: 2, status: "running", sideEffect: "workspace_mutation", attemptIds: [], reservedAt: "", startedAt: "", completedAt: null, output: null, signal: null, failure: null },
    },
  } as unknown as RunAggregate;
}

test("verification scope uses the matching verification cycle and configured role ids", () => {
  const scope = resolveVerificationActivationScope(aggregateWithTwoCycles(), "verify_two");
  assert.deepEqual(scope && {
    implementationActivationId: scope.implementationActivationId,
    testActivationId: scope.testActivationId,
    cycleNumber: scope.cycleNumber,
  }, {
    implementationActivationId: "impl_two",
    testActivationId: "test_two",
    cycleNumber: 2,
  });
});

test("verification scope rejects a non-verification activation", () => {
  assert.equal(
    resolveVerificationActivationScope(aggregateWithTwoCycles(), "test_two"),
    null
  );
});
