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
  return effects;
}

function auditEffects(context: EffectMapperContext): DomainEffect[] {
  const payload = payloadObject(context);
  const findings = Array.isArray(payload.findings)
    ? payload.findings.map((value) => String(value)).join("; ")
    : context.envelope.summary;
  return [
    ...evidenceEffect(context),
    context.envelope.signal === "approved"
      ? { type: "clear_failure_summary" as const }
      : { type: "set_failure_summary" as const, summary: findings || context.envelope.summary },
    {
      type: "update_convergence",
      signature: `${context.task.id}:${context.envelope.signal}:${context.envelope.summary}`,
      improved: context.envelope.signal === "approved",
    },
  ];
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
