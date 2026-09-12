import assert from "node:assert/strict";
import test from "node:test";

import { createDefaultDefinitionRegistries } from "../../src/definitions/default-registries";
import { loadDefinitionSource } from "../../src/definitions/definition-loader";
import { compileWorkflow } from "../../src/definitions/workflow-compiler";
import { createRunAggregate } from "../../src/application/run-factory";
import { createDefaultEffectMapperRegistry } from "../../src/tasks/effects/default-effect-mappers";
import { createDefaultGuardrailRegistry } from "../../src/tasks/guardrails/default-guardrails";
import type { EffectMapperContext, GuardrailContext } from "../../src/definitions/registries";
import type { TaskResultEnvelopeV1 } from "../../src/domain/task-result";
import type { RequirementEvidence } from "../../src/domain/task-result";
import type { JsonObject } from "../../src/domain/json";
import type { RunAggregate } from "../../src/domain/run-aggregate";

const now = "2026-09-11T00:00:00.000Z";

async function fixture(): Promise<RunAggregate> {
  const bundle = compileWorkflow(
    await loadDefinitionSource(process.cwd()),
    createDefaultDefinitionRegistries()
  );
  return createRunAggregate({
    runId: "default-policies",
    definition: bundle,
    goal: "Exercise the default task policy registries.",
    requirements: [{ id: "REQ-001", text: "Exercise policy behavior." }],
    targetProjectPath: process.cwd(),
    now,
  });
}

function envelope(
  signal: string,
  payload: JsonObject = {},
  requirementEvidence: RequirementEvidence[] = [{ requirementId: "REQ-001", status: "satisfied", evidence: "observed" }]
): TaskResultEnvelopeV1 {
  return { schemaVersion: 1, signal, summary: `${signal} summary`, payload, requirementEvidence };
}

function output(signal = "success") {
  return {
    activationId: "activation-1",
    artifactId: `artifact_${"a".repeat(64)}`,
    schemaId: "task-result.v2",
    signal,
    summary: `${signal} output`,
  };
}

async function contexts(taskId: string, signal: string, payload: JsonObject = {}, evidence?: TaskResultEnvelopeV1["requirementEvidence"]) {
  const aggregate = await fixture();
  const task = aggregate.definition.tasks[taskId];
  const agentId = taskId === "produce_plan" ? "planner" : taskId === "implement_changes" ? "implementer" : taskId === "run_tests" ? "tester" : taskId === "audit_quality" ? "qa_lead" : taskId === "approve_completion" ? "master" : "interrupter";
  const agent = aggregate.definition.agents[agentId];
  const env = envelope(signal, payload, evidence);
  return {
    aggregate,
    effect: {
      aggregate,
      task,
      envelope: env,
      output: output(signal),
    } as EffectMapperContext,
    guard: {
      aggregate,
      agent,
      task,
      input: {},
      envelope: env,
      reference: { id: "signal_matches_payload", config: { field: "decision" } },
    } as GuardrailContext,
  };
}

async function rejects(fn: () => unknown | Promise<unknown>, pattern: RegExp): Promise<void> {
  await assert.rejects(async () => { await fn(); }, pattern);
}

test("default effect mappers cover planning, implementation, test, review, and interrupt effects", async () => {
  const registry = createDefaultEffectMapperRegistry();
  const plan = {
    choices: [
      {
        id: "safe-plan",
        title: "Safe plan",
        verification: {
          commands: [{ id: "unit", label: "unit", executable: "node", args: ["--version"], cwd: ".", timeoutMs: 1000, requirementIds: ["REQ-001"] }],
          totalTimeoutMs: 5000,
          protectedPaths: ["src"],
          testRoots: ["test"],
          allowedNewTestRoots: ["test"],
          generatedOutputPaths: ["coverage"],
        },
      },
      { id: "plan-two", title: "Second" },
    ],
  };
  const planContext = await contexts("produce_plan", "success", plan as unknown as JsonObject);
  const planEffects = await registry.get("record_plan_choices")(planContext.effect);
  assert.equal(planEffects[0].type, "record_plan_choices");
  assert.equal((planEffects[0] as { choices: unknown[] }).choices.length, 2);
  assert.equal(planEffects[1].type, "add_requirement_evidence");
  await rejects(() => registry.get("record_plan_choices")({ ...planContext.effect, envelope: envelope("success", { choices: "bad" }) }), /choices are missing/u);

  const implementation = await contexts("implement_changes", "success");
  assert.deepEqual(await registry.get("record_implementation")(implementation.effect), [
    { type: "clear_failure_summary" },
    { type: "add_requirement_evidence", evidence: implementation.effect.envelope.requirementEvidence },
  ]);
  const implementationEmpty = await contexts("implement_changes", "success", {}, []);
  assert.deepEqual(await registry.get("record_implementation")(implementationEmpty.effect), [{ type: "clear_failure_summary" }]);

  const failedTest = await contexts("run_tests", "fail", { failures: ["unit failed", 42] });
  const failedEffects = await registry.get("record_test_result")(failedTest.effect);
  assert.equal(failedEffects.some((effect) => effect.type === "set_failure_summary"), true);
  const preparedTest = await contexts("run_tests", "prepared", {
    issues: ["issue-1", " ", 2],
    verificationCriteriaChanges: ["command changed", " "],
  });
  const preparedEffects = await registry.get("record_test_result")(preparedTest.effect);
  assert.equal(preparedEffects.some((effect) => effect.type === "record_findings"), true);
  assert.equal(preparedEffects.some((effect) => effect.type === "record_verification_criteria_changes"), true);
  const cleanPrepared = await contexts("run_tests", "prepared");
  assert.equal((await registry.get("record_test_result")(cleanPrepared.effect)).length, 1);

  const rejectedReview = await contexts("audit_quality", "rejected", { findings: ["bad output", " ", 2] });
  const rejectedEffects = await registry.get("record_quality_audit")(rejectedReview.effect);
  assert.equal(rejectedEffects.some((effect) => effect.type === "set_failure_summary"), true);
  assert.equal(rejectedEffects.some((effect) => effect.type === "record_findings"), true);
  const approvedReview = await contexts("audit_quality", "approved", {
    proofId: "proof-1",
    contractRevision: 2,
    resolvedFindingIds: ["finding-1", 4],
    rationale: "verified",
  });
  approvedReview.aggregate.context.verificationProof = { proofId: "proof-1", passed: true } as never;
  approvedReview.aggregate.context.verificationContract = { revision: 2 } as never;
  const approvalEffects = await registry.get("record_quality_audit")(approvedReview.effect);
  assert.equal(approvalEffects.some((effect) => effect.type === "record_review_approval"), true);
  const completion = await contexts("approve_completion", "approved", { proofId: "proof-1", contractRevision: 2 });
  completion.aggregate.context.verificationProof = { proofId: "proof-1", passed: true } as never;
  completion.aggregate.context.verificationContract = { revision: 2 } as never;
  const completionEffects = await registry.get("record_completion_approval")(completion.effect);
  assert.equal(completionEffects.some((effect) => effect.type === "record_review_approval"), true);
  await rejects(() => registry.get("record_quality_audit")({ ...approvedReview.effect, envelope: envelope("approved", { contractRevision: 2 }) }), /proofId and contractRevision/u);
  const interrupt = await contexts("analyze_interrupt", "success", {});
  const interruptEffects = await registry.get("record_interrupt_briefing")(interrupt.effect);
  assert.deepEqual(interruptEffects[0], { type: "record_interrupt_briefing", artifactId: interrupt.effect.output.artifactId, summary: interrupt.effect.envelope.summary });
});

test("default guardrails accept valid envelopes and reject malformed plans, evidence, signals, and approvals", async () => {
  const registry = createDefaultGuardrailRegistry();
  const known = await contexts("implement_changes", "success");
  await registry.get("known_requirement_ids")(known.guard);
  await rejects(() => registry.get("known_requirement_ids")({ ...known.guard, envelope: envelope("success", {}, [{ requirementId: "UNKNOWN", status: "satisfied", evidence: "x" }]) }), /unknown requirement/u);
  await registry.get("complete_requirement_evidence")(known.guard);
  await rejects(() => registry.get("complete_requirement_evidence")({ ...known.guard, envelope: envelope("success", {}, []) }), /missing requirement evidence/u);

  const plan = await contexts("produce_plan", "success", {
    choices: [1, 2, 3].map((n) => ({
      id: `choice-${n}`,
      requirementCoverage: ["REQ-001"],
      verification: {
        commands: [{ id: `cmd-${n}`, label: "unit", executable: "node", timeoutMs: 1000, cwd: ".", requirementIds: ["REQ-001"] }],
        totalTimeoutMs: 5000,
        protectedPaths: [], testRoots: [], allowedNewTestRoots: [], generatedOutputPaths: [],
      },
    })),
  });
  await registry.get("plan_choices")(plan.guard);
  await rejects(() => registry.get("plan_choices")({ ...plan.guard, envelope: envelope("success", { choices: [] }) }), /exactly 3/u);
  await rejects(() => registry.get("plan_choices")({ ...plan.guard, envelope: envelope("success", { choices: [{ id: "bad id", requirementCoverage: ["REQ-001"] }, { id: "b", requirementCoverage: ["REQ-001"] }, { id: "c", requirementCoverage: ["REQ-001"] }] }) }), /unsafe id/u);
  const duplicateVerification = { commands: [{ id: "cmd", label: "unit", executable: "node", timeoutMs: 1000, cwd: ".", requirementIds: ["REQ-001"] }], totalTimeoutMs: 5000, protectedPaths: [], testRoots: [], allowedNewTestRoots: [], generatedOutputPaths: [] };
  await rejects(() => registry.get("plan_choices")({ ...plan.guard, envelope: envelope("success", { choices: [{ id: "a", requirementCoverage: ["REQ-001"], verification: duplicateVerification }, { id: "a", requirementCoverage: ["REQ-001"], verification: duplicateVerification }, { id: "c", requirementCoverage: ["REQ-001"], verification: duplicateVerification }] }) }), /duplicated/u);
  await rejects(() => registry.get("plan_choices")({ ...plan.guard, envelope: envelope("success", { choices: [{ id: "a" }, { id: "b" }, { id: "c" }] }) }), /requirementCoverage/u);

  const signal = await contexts("audit_quality", "approved", { decision: "approved" });
  await registry.get("signal_matches_payload")(signal.guard);
  await rejects(() => registry.get("signal_matches_payload")({ ...signal.guard, envelope: envelope("rejected", { decision: "approved" }) }), /does not match/u);
  const approval = await contexts("audit_quality", "approved", { decision: "approved" });
  await registry.get("approval_requires_satisfied_evidence")(approval.guard);
  await rejects(() => registry.get("approval_requires_satisfied_evidence")({ ...approval.guard, envelope: envelope("approved", { decision: "approved" }, [{ requirementId: "REQ-001", status: "unsatisfied", evidence: "missing" }]) }), /satisfied evidence/u);

  approval.aggregate.context.verificationProof = { proofId: "proof-1", passed: true } as never;
  approval.aggregate.context.verificationContract = { revision: 3 } as never;
  approval.guard.envelope = envelope("approved", { decision: "approved", proofId: "proof-1", contractRevision: 3, resolvedFindingIds: [] });
  await registry.get("verification_approval_matches_proof")(approval.guard);
  await rejects(() => registry.get("verification_approval_matches_proof")({ ...approval.guard, envelope: envelope("approved", { decision: "approved", proofId: "wrong", contractRevision: 3, resolvedFindingIds: [] }) }), /proofId/u);
});
