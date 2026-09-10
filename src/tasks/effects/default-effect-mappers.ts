import type { DomainEffect } from "../../domain/domain-effect";
import type { JsonObject } from "../../domain/json";
import {
  EffectMapperRegistry,
  type EffectMapperContext,
} from "../../definitions/registries";

function payloadObject(context: EffectMapperContext): JsonObject {
  const payload = context.envelope.payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`Task ${context.task.id} payload must be an object.`);
  }
  return payload;
}

function evidenceEffect(context: EffectMapperContext): DomainEffect[] {
  return context.envelope.requirementEvidence.length > 0
    ? [{ type: "add_requirement_evidence", evidence: context.envelope.requirementEvidence }]
    : [];
}

function planningEffects(context: EffectMapperContext): DomainEffect[] {
  const payload = payloadObject(context);
  const choices = payload.choices;
  if (!Array.isArray(choices)) throw new Error("Planning choices are missing after validation.");
  return [
    {
      type: "record_plan_choices",
      choices: choices.map((choice) => {
        if (choice === null || typeof choice !== "object" || Array.isArray(choice)) {
          throw new Error("Planning choice is not an object after validation.");
        }
        return {
          id: String(choice.id),
          title: String(choice.title),
          planArtifactId: context.output.artifactId,
          ...(choice.verification && typeof choice.verification === "object" && !Array.isArray(choice.verification)
            ? (() => {
                const verification = choice.verification as JsonObject;
                const commands = Array.isArray(verification.commands)
                  ? verification.commands
                      .filter((command): command is JsonObject =>
                        Boolean(command && typeof command === "object" && !Array.isArray(command))
                      )
                      .map((command) => ({
                        id: String(command.id ?? ""),
                        label: String(command.label ?? ""),
                        executable: String(command.executable ?? ""),
                        args: Array.isArray(command.args) ? command.args.map(String) : [],
                        cwd: String(command.cwd ?? "."),
                        timeoutMs: Number(command.timeoutMs),
                        requirementIds: Array.isArray(command.requirementIds)
                          ? command.requirementIds.map(String)
                          : [],
                      }))
                  : [];
                return {
                  verification: {
                    commands,
                    totalTimeoutMs: Number(verification.totalTimeoutMs),
                    protectedPaths: Array.isArray(verification.protectedPaths)
                      ? verification.protectedPaths.map(String)
                      : [],
                    testRoots: Array.isArray(verification.testRoots)
                      ? verification.testRoots.map(String)
                      : [],
                    allowedNewTestRoots: Array.isArray(verification.allowedNewTestRoots)
                      ? verification.allowedNewTestRoots.map(String)
                      : [],
                    generatedOutputPaths: Array.isArray(verification.generatedOutputPaths)
                      ? verification.generatedOutputPaths.map(String)
                      : [],
                  },
                };
              })()
            : {}),
        };
      }),
    },
    ...evidenceEffect(context),
  ];
}

function implementationEffects(context: EffectMapperContext): DomainEffect[] {
  return [{ type: "clear_failure_summary" }, ...evidenceEffect(context)];
}

function testEffects(context: EffectMapperContext): DomainEffect[] {
  const payload = payloadObject(context);
  const effects = evidenceEffect(context);
  if (context.envelope.signal === "fail") {
    const failures = Array.isArray(payload.failures)
      ? payload.failures.map((value) => String(value)).join("; ")
      : context.envelope.summary;
    effects.push({ type: "set_failure_summary", summary: failures || context.envelope.summary });
  }
  if (context.envelope.signal === "prepared") {
    const issues = Array.isArray(payload.issues)
      ? payload.issues.map((value) => String(value)).filter((value) => value.trim())
      : [];
    if (issues.length > 0) {
      effects.push({
        type: "record_findings",
        source: "test",
        findings: issues,
        artifactIds: [context.output.artifactId],
      });
    }
    const criteriaChanges = Array.isArray(payload.verificationCriteriaChanges)
      ? payload.verificationCriteriaChanges
          .map((value) => String(value))
          .filter((value) => value.trim())
      : [];
    if (criteriaChanges.length > 0) {
      effects.push({
        type: "record_verification_criteria_changes",
        changes: criteriaChanges,
        artifactId: context.output.artifactId,
      });
    }
  }
  return effects;
}

function auditEffects(context: EffectMapperContext): DomainEffect[] {
  const payload = payloadObject(context);
  const findingValues = Array.isArray(payload.findings)
    ? payload.findings.map((value) => String(value)).filter((value) => value.trim())
    : [];
  const findings = findingValues.join("; ") || context.envelope.summary;
  const effects: DomainEffect[] = [
    ...evidenceEffect(context),
    context.envelope.signal === "approved"
      ? { type: "clear_failure_summary" as const }
      : { type: "set_failure_summary" as const, summary: findings || context.envelope.summary },
    // An approved review may include an informational note, but only a
    // rejected review creates an unresolved finding.  Otherwise an approval
    // would immediately poison the success invariant with its own summary.
    ...(findingValues.length > 0 && context.envelope.signal !== "approved"
      ? [{
          type: "record_findings" as const,
          source: context.task.id === "approve_completion" ? "master" as const : "qa" as const,
          findings: findingValues,
          artifactIds: [context.output.artifactId],
        }]
      : []),
  ];
  if (context.envelope.signal === "approved" && context.aggregate.context.verificationProof) {
    const proofId = payload.proofId;
    const contractRevisionValue = payload.contractRevision;
    if (typeof proofId !== "string" || !Number.isSafeInteger(contractRevisionValue)) {
      throw new Error("Verification-backed approval must include proofId and contractRevision.");
    }
    const contractRevision = Number(contractRevisionValue);
    const resolvedFindingIds = Array.isArray(payload.resolvedFindingIds)
      ? payload.resolvedFindingIds.filter((value): value is string => typeof value === "string")
      : [];
    effects.push({
      type: "record_review_approval",
      stage: context.task.id === "approve_completion" ? "master" : "qa",
      proofId,
      contractRevision,
      requirementIds: context.envelope.requirementEvidence
        .filter((item) => item.status === "satisfied")
        .map((item) => item.requirementId),
      resolvedFindingIds,
      rationale: typeof payload.rationale === "string" ? payload.rationale : context.envelope.summary,
    });
  }
  return effects;
}

function approvalEffects(context: EffectMapperContext): DomainEffect[] {
  return auditEffects(context);
}

function interruptEffects(context: EffectMapperContext): DomainEffect[] {
  return [
    {
      type: "record_interrupt_briefing",
      artifactId: context.output.artifactId,
      summary: context.envelope.summary,
    },
  ];
}

export function createDefaultEffectMapperRegistry(): EffectMapperRegistry {
  return new EffectMapperRegistry()
    .register("record_plan_choices", planningEffects)
    .register("record_implementation", implementationEffects)
    .register("record_test_result", testEffects)
    .register("record_quality_audit", auditEffects)
    .register("record_completion_approval", approvalEffects)
    .register("record_interrupt_briefing", interruptEffects);
}
