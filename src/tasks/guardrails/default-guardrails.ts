import type { JsonObject, JsonValue } from "../../domain/json";
import { GuardrailRegistry, type GuardrailContext } from "../../definitions/registries";

function payloadObject(context: GuardrailContext): JsonObject {
  const payload = context.envelope.payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`Task ${context.task.id} payload must be an object.`);
  }
  return payload;
}

function stringValue(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  return value;
}

function assertKnownRequirementIds(context: GuardrailContext): void {
  const known = new Set(context.aggregate.context.requirements.map((item) => item.id));
  const unknown = context.envelope.requirementEvidence
    .map((item) => item.requirementId)
    .filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new Error(`Result contains unknown requirement ids: ${[...new Set(unknown)].join(", ")}.`);
  }
}

function assertCompleteRequirementEvidence(context: GuardrailContext): void {
  assertKnownRequirementIds(context);
  const observed = new Set(context.envelope.requirementEvidence.map((item) => item.requirementId));
  const missing = context.aggregate.context.requirements
    .map((item) => item.id)
    .filter((id) => !observed.has(id));
  if (missing.length > 0) {
    throw new Error(`Result is missing requirement evidence for: ${missing.join(", ")}.`);
  }
}

function assertPlanChoices(context: GuardrailContext): void {
  const payload = payloadObject(context);
  const choices = payload.choices;
  if (!Array.isArray(choices)) throw new Error("Planning payload choices must be an array.");
  const expectedCount = Number(context.reference.config?.expectedCount ?? 3);
  if (choices.length !== expectedCount) {
    throw new Error(`Planning must return exactly ${expectedCount} choices.`);
  }
  const requirementIds = new Set(context.aggregate.context.requirements.map((item) => item.id));
  const choiceIds = new Set<string>();
  for (const [index, rawChoice] of choices.entries()) {
    if (rawChoice === null || typeof rawChoice !== "object" || Array.isArray(rawChoice)) {
      throw new Error(`Planning choice ${index + 1} must be an object.`);
    }
    const coverage = rawChoice.requirementCoverage;
    if (typeof rawChoice.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(rawChoice.id)) {
      throw new Error(`Planning choice ${index + 1} has an unsafe id.`);
    }
    if (choiceIds.has(rawChoice.id)) {
      throw new Error(`Planning choice id ${rawChoice.id} is duplicated.`);
    }
    choiceIds.add(rawChoice.id);
    if (!Array.isArray(coverage)) {
      throw new Error(`Planning choice ${index + 1} must declare requirementCoverage.`);
    }
    const covered = new Set(coverage.filter((id): id is string => typeof id === "string"));
    const missing = [...requirementIds].filter((id) => !covered.has(id));
    if (missing.length > 0) {
      throw new Error(`Planning choice ${index + 1} omits requirements: ${missing.join(", ")}.`);
    }
  }
}

function assertSignalMatchesPayload(context: GuardrailContext): void {
  const payload = payloadObject(context);
  const field = String(context.reference.config?.field ?? "decision");
  const value = stringValue(payload[field], `payload.${field}`);
  if (value !== context.envelope.signal) {
    throw new Error(
      `Envelope signal '${context.envelope.signal}' does not match payload.${field} '${value}'.`
    );
  }
}

function assertApprovalEvidence(context: GuardrailContext): void {
  if (context.envelope.signal !== "approved") return;
  assertCompleteRequirementEvidence(context);
  const unsatisfied = context.envelope.requirementEvidence.filter(
    (item) => item.status !== "satisfied"
  );
  if (unsatisfied.length > 0) {
    throw new Error(
      `Approval requires satisfied evidence for every requirement: ` +
        unsatisfied.map((item) => item.requirementId).join(", ") +
        "."
    );
  }
}

export function createDefaultGuardrailRegistry(): GuardrailRegistry {
  return new GuardrailRegistry()
    .register("known_requirement_ids", assertKnownRequirementIds)
    .register("complete_requirement_evidence", assertCompleteRequirementEvidence)
    .register("plan_choices", assertPlanChoices)
    .register("signal_matches_payload", assertSignalMatchesPayload)
    .register("approval_requires_satisfied_evidence", assertApprovalEvidence);
}
