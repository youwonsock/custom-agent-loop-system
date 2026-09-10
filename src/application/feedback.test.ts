import assert from "node:assert/strict";
import test from "node:test";
import { TaskInputAssembler } from "./task-input-assembler";
import { createRunAggregate } from "./run-factory";
import { createDefaultDefinitionRegistries } from "../definitions/default-registries";
import { loadDefinitionSource } from "../definitions/definition-loader";
import { compileWorkflow } from "../definitions/workflow-compiler";
import type { ArtifactStorePort } from "./ports/artifact-store";
import { createVerificationContract } from "./verification-runner";

const noArtifacts: ArtifactStorePort = {
  put: async () => { throw new Error("not used"); },
  read: async () => Buffer.from(""),
};

test("task input assembly carries plan feedback and only prior-cycle verification feedback", async () => {
  const source = await loadDefinitionSource(process.cwd());
  const definition = compileWorkflow(source, createDefaultDefinitionRegistries());
  const aggregate = createRunAggregate({
    runId: "feedback-test",
    definition,
    goal: "feed reliable diagnostics into the next cycle",
    requirements: [{ id: "REQ-001", text: "Diagnostics are carried forward." }],
    targetProjectPath: process.cwd(),
  });
  aggregate.execution.activeCycleNumber = 2;
  // TEST now requires the core-owned contract.  This fixture focuses on
  // feedback routing, so provide a minimal approved contract without running
  // a verification process.
  aggregate.context.verificationContract = createVerificationContract(
    [{
      id: "tests",
      label: "unit tests",
      executable: "npm",
      args: ["test"],
      cwd: ".",
      timeoutMs: 900_000,
      requirementIds: ["REQ-001"],
    }],
    "a".repeat(64),
    "request_fixture",
    undefined,
    {
      totalTimeoutMs: 1_800_000,
      protectedPaths: [],
      testRoots: ["tests"],
      allowedNewTestRoots: ["tests"],
      generatedOutputPaths: ["dist"],
    }
  );
  aggregate.context.humanResponses.PLAN_APPROVAL = {
    requestId: "request_plan",
    nodeId: "PLAN_APPROVAL",
    signal: "revision_requested",
    value: { summary: "Please include a regression test.", requirementEvidence: [] },
    respondedAt: "2026-09-06T00:00:00.000Z",
  };
  aggregate.context.verificationFeedback = [
    {
      verificationId: "old",
      proofId: "proof-old",
      passed: false,
      failedCommandIds: ["tests"],
      diagnostics: ["old failure"],
      requirementIds: ["REQ-001"],
      sourceActivationId: "verify-old",
      cycleNumber: 1,
    },
    {
      verificationId: "current",
      proofId: "proof-current",
      passed: false,
      failedCommandIds: ["tests"],
      diagnostics: ["current cycle failure"],
      requirementIds: ["REQ-001"],
      sourceActivationId: "verify-current",
      cycleNumber: 2,
    },
  ];
  aggregate.execution.currentNodeId = "TEST";
  const testNode = definition.nodes.TEST;
  assert.equal(testNode.kind, "task");
  const node = { ...testNode, inputs: testNode.inputs.filter((binding) => binding.source.kind !== "node_output") };
  const input = await new TaskInputAssembler(noArtifacts, createDefaultDefinitionRegistries().schemas).assemble({
    aggregate,
    node,
    activationId: "test-activation",
    attemptId: "test-attempt",
    attemptNumber: 1,
  });
  assert.equal((input.value.verification_feedback as Array<{ verificationId: string }>).some((item) => item.verificationId === "old"), true);
  assert.equal((input.value.previous_cycle_feedback as Array<{ verificationId: string }>).some((item) => item.verificationId === "old"), true);
  assert.equal((input.value.previous_cycle_feedback as Array<{ verificationId: string }>).some((item) => item.verificationId === "current"), false);
  assert.equal((input.value as Record<string, unknown>).verification_criteria_changes !== undefined, true);
});
