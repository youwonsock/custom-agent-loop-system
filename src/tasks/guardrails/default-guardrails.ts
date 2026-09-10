import type { JsonObject, JsonValue } from "../../domain/json";
import { GuardrailRegistry, type GuardrailContext } from "../../definitions/registries";
import { requiresCoreVerification } from "../../domain/success-policy";

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
    if (context.task.resultSchemaId.endsWith(".v2")) {
      const verification = rawChoice.verification;
      if (!verification || typeof verification !== "object" || Array.isArray(verification)) {
        throw new Error(`Planning choice ${index + 1} must include a verification contract draft.`);
      }
      const commands = verification.commands;
      if (!Array.isArray(commands) || commands.length < 1 || commands.length > 10) {
        throw new Error(`Planning choice ${index + 1} verification must contain 1-10 commands.`);
      }
      const commandIds = new Set<string>();
      for (const [commandIndex, command] of commands.entries()) {
        if (!command || typeof command !== "object" || Array.isArray(command)) {
          throw new Error(`Planning choice ${index + 1} verification command ${commandIndex + 1} is invalid.`);
        }
        if (typeof command.id !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/u.test(command.id) || commandIds.has(command.id)) {
          throw new Error(`Planning choice ${index + 1} has a duplicate or unsafe verification command id.`);
        }
        commandIds.add(command.id);
        if (typeof command.executable !== "string" || !command.executable.trim() || typeof command.label !== "string" || !command.label.trim()) {
          throw new Error(`Planning choice ${index + 1} verification command ${command.id} needs label and executable.`);
        }
        const timeoutMs = typeof command.timeoutMs === "number" ? command.timeoutMs : NaN;
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 24 * 60 * 60 * 1000) {
          throw new Error(`Planning choice ${index + 1} verification command ${command.id} has an invalid timeout.`);
        }
        if (typeof command.cwd !== "string" || command.cwd.split(/[\\/]+/u).some((part) => part === "..") || /^[A-Za-z]:[\\/]/u.test(command.cwd) || command.cwd.startsWith("/")) {
          throw new Error(`Planning choice ${index + 1} verification command ${command.id} cwd must be project-relative.`);
        }
        if (!Array.isArray(command.requirementIds) || command.requirementIds.length === 0 || command.requirementIds.some((id) => typeof id !== "string" || !requirementIds.has(id))) {
          throw new Error(`Planning choice ${index + 1} verification command ${command.id} references an unknown requirement.`);
        }
      }
      const totalTimeoutMs = typeof verification.totalTimeoutMs === "number" ? verification.totalTimeoutMs : NaN;
      if (!Number.isSafeInteger(totalTimeoutMs) || totalTimeoutMs < 1 || totalTimeoutMs > 24 * 60 * 60 * 1000) {
        throw new Error(`Planning choice ${index + 1} verification total timeout is invalid.`);
      }
      for (const field of ["protectedPaths", "testRoots", "allowedNewTestRoots", "generatedOutputPaths"] as const) {
        const values = verification[field];
        if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || !value.trim() || value.split(/[\\/]+/u).includes("..") || /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith("/"))) {
          throw new Error(`Planning choice ${index + 1} verification ${field} must contain relative paths.`);
        }
      }
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

function assertVerificationApproval(context: GuardrailContext): void {
  if (context.envelope.signal !== "approved") return;
  const proof = context.aggregate.context.verificationProof;
  if (requiresCoreVerification(context.aggregate) && (!proof || !proof.passed)) {
    throw new Error("Approval requires a passing core verification proof.");
  }
  if (!proof) return;
  const payload = payloadObject(context);
  if (payload.proofId !== proof.proofId) {
    throw new Error("Approval proofId must match the latest core verification proof.");
  }
  const revision = payload.contractRevision;
  if (!Number.isSafeInteger(revision) || revision !== context.aggregate.context.verificationContract?.revision) {
    throw new Error("Approval contractRevision must match the latest verification contract.");
  }
  const resolved = new Set(
    Array.isArray(payload.resolvedFindingIds)
      ? payload.resolvedFindingIds.filter((value): value is string => typeof value === "string")
      : []
  );
  const open = context.aggregate.context.findings.filter((finding) => finding.status === "open");
  const omitted = open.filter((finding) => !resolved.has(finding.id));
  if (omitted.length > 0) {
    throw new Error(`Approval must resolve every open finding: ${omitted.map((finding) => finding.id).join(", ")}.`);
  }
}

export function createDefaultGuardrailRegistry(): GuardrailRegistry {
  return new GuardrailRegistry()
    .register("known_requirement_ids", assertKnownRequirementIds)
    .register("complete_requirement_evidence", assertCompleteRequirementEvidence)
    .register("plan_choices", assertPlanChoices)
    .register("signal_matches_payload", assertSignalMatchesPayload)
    .register("approval_requires_satisfied_evidence", assertApprovalEvidence)
    .register("verification_approval_matches_proof", assertVerificationApproval);
}
