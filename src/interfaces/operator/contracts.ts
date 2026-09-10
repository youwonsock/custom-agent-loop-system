import type { RunAggregate } from "../../domain/run-aggregate";
import { validateVerificationContractDraft, type VerificationContractDraft } from "../../domain/verification";
import type {
  RunProjectionV2,
  SessionIndexProjectionV4,
} from "./run-projection-impl";

/** The stable projection contract consumed by CLI and desktop operators. */
export type { RunProjectionV2, SessionIndexProjectionV4 } from "./run-projection-impl";

/** The v4 session index is intentionally kept wire-compatible with the CLI. */

export interface ProviderDiscoveryResultV2 {
  schemaVersion: 2;
  providerId: string;
  label: string;
  adapter: string;
  binary: string;
  enabled: boolean;
  available: boolean;
  models: string[];
  discoveredAt: string;
  command: string | null;
  catalogSource: "command" | "configured";
  error: { code: string; message: string } | null;
}

export interface OperatorSnapshotV3 {
  schemaVersion: 3;
  capturedAt: string;
  projection: RunProjectionV2 | null;
  sessionIndex: SessionIndexProjectionV4;
  settings: Record<string, unknown> | null;
  providerDiscovery: ProviderDiscoveryResultV2[];
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected an object.");
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string.`);
  return value;
}

function arrayValue(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array.`);
  return value;
}

function objectOrNull(value: unknown, field: string): void {
  if (value !== null && (typeof value !== "object" || Array.isArray(value))) {
    throw new Error(`${field} must be an object or null.`);
  }
}

function nullableString(value: unknown, field: string): void {
  if (value !== null && typeof value !== "string") throw new Error(`${field} must be a string or null.`);
}

function nonNegativeInteger(value: unknown, field: string): void {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${field} must be a non-negative integer.`);
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

/** Runtime validation at the desktop/core boundary. Unknown fields are tolerated for forward compatibility. */
export function validateRunProjectionV2(value: unknown): RunProjectionV2 {
  const candidate = objectValue(value);
  if (candidate.projectionSchemaVersion !== 2 || candidate.stateVersion !== 5) {
    throw new Error("Run projection must use projection schema 2 and state schema 5.");
  }
  for (const field of ["sessionId", "runId", "definitionHash", "goal", "targetProjectPath"] as const) {
    stringValue(candidate[field], field);
  }
  if (!SAFE_ID.test(String(candidate.sessionId)) || candidate.sessionId !== candidate.runId) {
    throw new Error("Run projection session identity is invalid.");
  }
  nonNegativeInteger(candidate.revision, "revision");
  nonNegativeInteger(candidate.fencingEpoch, "fencingEpoch");
  if (!["RUNNING", "WAITING_USER", "PAUSED", "SUCCESS", "FAILED", "STOPPED", "BLOCKED"].includes(String(candidate.status))) throw new Error("Run projection status is invalid.");
  for (const field of ["statusReason", "currentAgentId", "selectedPlanChoiceId", "interruptBriefing"] as const) nullableString(candidate[field], field);
  const paths = arrayValue(candidate.additionalAllowedPaths, "additionalAllowedPaths");
  for (const [index, item] of paths.entries()) stringValue(item, `additionalAllowedPaths[${index}]`);
  for (const field of ["requirements", "requirementEvidence", "events"] as const) {
    const items = arrayValue(candidate[field], field);
    for (const item of items) objectValue(item);
  }
  if (candidate.accessMode !== "ask" && candidate.accessMode !== "full_access") throw new Error("Run projection accessMode is invalid.");
  if (typeof candidate.awaitingPlanApproval !== "boolean" || typeof candidate.planApproved !== "boolean") throw new Error("Run projection plan flags must be boolean.");
  objectOrNull(candidate.pendingInput, "pendingInput");
  objectOrNull(candidate.latestEvent, "latestEvent");
  if (candidate.verification !== undefined) {
    const verification = objectValue(candidate.verification);
    if (verification.contract !== undefined && verification.contract !== null) {
      const contract = objectValue(verification.contract);
      if (!Number.isSafeInteger(contract.revision) || Number(contract.revision) < 1) {
        throw new Error("verification.contract.revision is invalid.");
      }
      if (typeof contract.contractHash !== "string" || !/^[a-f0-9]{64}$/u.test(contract.contractHash)) {
        throw new Error("verification.contract.contractHash is invalid.");
      }
      if (typeof contract.baselineArtifactId !== "string" || !contract.baselineArtifactId.trim()) {
        throw new Error("verification.contract.baselineArtifactId is invalid.");
      }
      if (typeof contract.baselineFingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(contract.baselineFingerprint)) {
        throw new Error("verification.contract.baselineFingerprint is invalid.");
      }
      const requirementIds = new Set(
        (candidate.requirements as Array<{ id?: unknown }>).map((requirement) => String(requirement.id ?? ""))
      );
      validateVerificationContractDraft({
        commands: contract.commands,
        totalTimeoutMs: contract.totalTimeoutMs,
        protectedPaths: contract.protectedPaths,
        testRoots: contract.testRoots,
        allowedNewTestRoots: contract.allowedNewTestRoots,
        generatedOutputPaths: contract.generatedOutputPaths,
      } as VerificationContractDraft, requirementIds);
    }
    if (verification.elapsedMs !== undefined) {
      nonNegativeInteger(verification.elapsedMs, "verification.elapsedMs");
    }
    if (verification.contractRevision !== null && !Number.isSafeInteger(verification.contractRevision)) {
      throw new Error("verification.contractRevision is invalid.");
    }
    if (verification.contractHash !== null && typeof verification.contractHash !== "string") {
      throw new Error("verification.contractHash is invalid.");
    }
    if (typeof verification.proofValid !== "boolean") throw new Error("verification.proofValid is invalid.");
    if (verification.criteriaChanges !== undefined) {
      const criteriaChanges = arrayValue(verification.criteriaChanges, "verification.criteriaChanges");
      for (const [index, change] of criteriaChanges.entries()) {
        stringValue(change, `verification.criteriaChanges[${index}]`);
        if (!String(change).trim()) throw new Error(`verification.criteriaChanges[${index}] must not be empty.`);
      }
    }
    if (verification.resultArtifactId !== undefined && verification.resultArtifactId !== null && typeof verification.resultArtifactId !== "string") {
      throw new Error("verification.resultArtifactId is invalid.");
    }
    if (!Array.isArray(verification.commands)) throw new Error("verification.commands is invalid.");
    for (const command of verification.commands) {
      const item = objectValue(command);
      stringValue(item.commandId, "verification.commands.commandId");
      stringValue(item.status, "verification.commands.status");
      if (item.executable !== undefined) stringValue(item.executable, "verification.commands.executable");
      if (item.args !== undefined && (!Array.isArray(item.args) || item.args.some((arg) => typeof arg !== "string"))) throw new Error("verification.commands.args is invalid.");
      if (item.cwd !== undefined) stringValue(item.cwd, "verification.commands.cwd");
      if (item.exitCode !== null && !Number.isSafeInteger(item.exitCode)) throw new Error("verification.commands.exitCode is invalid.");
      nullableString(item.signal, "verification.commands.signal");
      if (typeof item.timedOut !== "boolean" || (item.processTreeClean !== null && typeof item.processTreeClean !== "boolean")) throw new Error("verification.commands process state is invalid.");
      stringValue(item.summary, "verification.commands.summary");
      if (item.elapsedMs !== undefined && (!Number.isSafeInteger(item.elapsedMs) || Number(item.elapsedMs) < 0)) throw new Error("verification.commands.elapsedMs is invalid.");
      if (item.outputTruncated !== undefined && typeof item.outputTruncated !== "boolean") throw new Error("verification.commands.outputTruncated is invalid.");
    }
  }
  const active = candidate.activeActivation;
  if (active !== null) {
    const activation = objectValue(active);
    for (const field of ["activationId", "nodeId", "status"] as const) stringValue(activation[field], `activeActivation.${field}`);
    nonNegativeInteger(activation.workflowStep, "activeActivation.workflowStep");
    const attempts = arrayValue(activation.attemptIds, "activeActivation.attemptIds");
    for (const [index, attempt] of attempts.entries()) stringValue(attempt, `activeActivation.attemptIds[${index}]`);
    if (activation.sideEffect !== "none" && activation.sideEffect !== "workspace_mutation") throw new Error("activeActivation.sideEffect is invalid.");
  }
  const choices = arrayValue(candidate.planChoices, "planChoices");
  for (const [index, choice] of choices.entries()) {
    const item = objectValue(choice);
    for (const field of ["id", "title", "body"] as const) stringValue(item[field], `planChoices[${index}].${field}`);
    if (item.verification !== undefined) {
      const verification = item.verification as VerificationContractDraft;
      validateVerificationContractDraft(verification, new Set(
        (candidate.requirements as Array<{ id: string }>).map((requirement) => requirement.id)
      ));
    }
  }
  const budgets = objectValue(candidate.budgets);
  for (const field of ["workflowSteps", "cycles"] as const) {
    const budget = objectValue(budgets[field]);
    for (const numberField of ["consumed", "limit", "remaining"] as const) {
      nonNegativeInteger(budget[numberField], `budgets.${field}.${numberField}`);
    }
    if (field === "cycles") nonNegativeInteger(budget.completed, "budgets.cycles.completed");
  }
  for (const field of ["createdAt", "updatedAt", "phase", "currentNodeId"] as const) stringValue(candidate[field], field);
  if (!Number.isFinite(Date.parse(String(candidate.createdAt))) || !Number.isFinite(Date.parse(String(candidate.updatedAt)))) {
    throw new Error("Run projection timestamps are invalid.");
  }
  
  const verification = candidate.verification;
  if (verification !== undefined) {
    const verificationObject = objectValue(verification);
    if (verificationObject.contract === undefined) {
      throw new Error("v2 verification projection must include the current contract field.");
    }
    if (verificationObject.elapsedMs === undefined) {
      throw new Error("v2 verification projection must include elapsedMs.");
    }
    const commands = arrayValue(objectValue(verification).commands, "verification.commands");
    for (const command of commands) {
      const item = objectValue(command);
      stringValue(item.executable, "verification.commands.executable");
      if (!Array.isArray(item.args) || item.args.some((arg) => typeof arg !== "string")) throw new Error("verification.commands.args is invalid.");
      stringValue(item.cwd, "verification.commands.cwd");
    }
  }
  return value as RunProjectionV2;
}

export function validateSessionIndexProjectionV4(value: unknown): SessionIndexProjectionV4 {
  const candidate = objectValue(value);
  if (candidate.version !== 4) throw new Error("Session index must use version 4.");
  arrayValue(candidate.activeSessionIds, "activeSessionIds");
  const activeIds = candidate.activeSessionIds as unknown[];
  for (const [index, sessionId] of activeIds.entries()) {
    stringValue(sessionId, `activeSessionIds[${index}]`);
    if (!SAFE_ID.test(String(sessionId))) throw new Error(`activeSessionIds[${index}] is unsafe.`);
  }
  if (new Set(activeIds as string[]).size !== activeIds.length) throw new Error("activeSessionIds contains duplicates.");
  const metas = arrayValue(candidate.sessionMetas, "sessionMetas");
  const metadataIds = new Set<string>();
  for (const [index, meta] of metas.entries()) {
    const item = objectValue(meta);
    for (const field of ["sessionId", "goal", "targetProjectPath", "createdAt"] as const) stringValue(item[field], `sessionMetas[${index}].${field}`);
    if (!SAFE_ID.test(String(item.sessionId)) || !String(item.goal).trim() || !String(item.targetProjectPath).trim() || !Number.isFinite(Date.parse(String(item.createdAt))) || metadataIds.has(String(item.sessionId))) throw new Error(`sessionMetas[${index}] is invalid.`);
    if (!["RUNNING", "WAITING_USER", "PAUSED", "SUCCESS", "FAILED", "STOPPED", "BLOCKED"].includes(String(item.status))) throw new Error(`sessionMetas[${index}].status is invalid.`);
    metadataIds.add(String(item.sessionId));
  }
  if (activeIds.some((sessionId) => !metadataIds.has(String(sessionId)))) throw new Error("activeSessionIds has no corresponding session metadata.");
  for (const [index, model] of arrayValue(candidate.availableModels, "availableModels").entries()) stringValue(model, `availableModels[${index}]`);
  if ((candidate.availableModels as unknown[]).some((model) => !(model as string).trim())) throw new Error("availableModels contains an empty model id.");
  nullableString(candidate.modelsDiscoveredAt, "modelsDiscoveredAt");
  nullableString(candidate.modelsDiscoveredCli, "modelsDiscoveredCli");
  if (candidate.modelsDiscoveredAt !== null && !Number.isFinite(Date.parse(String(candidate.modelsDiscoveredAt)))) throw new Error("modelsDiscoveredAt is invalid.");
  if (candidate.modelsDiscoveredCli !== null && !String(candidate.modelsDiscoveredCli).trim()) throw new Error("modelsDiscoveredCli must not be empty.");
  if (candidate.manualModelsOverride !== null) throw new Error("manualModelsOverride must be null for session index v4.");
  if (candidate.modelVariants !== null) {
    const variants = objectValue(candidate.modelVariants);
    for (const [provider, models] of Object.entries(variants)) {
      const values = arrayValue(models, `modelVariants.${provider}`);
      for (const [index, model] of values.entries()) stringValue(model, `modelVariants.${provider}[${index}]`);
      if (values.some((model) => !String(model).trim())) throw new Error(`modelVariants.${provider} contains an empty model id.`);
    }
  }
  return value as SessionIndexProjectionV4;
}

export function validateProviderDiscoveryResultV2(value: unknown): ProviderDiscoveryResultV2 {
  const candidate = objectValue(value);
  if (candidate.schemaVersion !== 2) throw new Error("Provider discovery schema must be version 2.");
  for (const field of ["providerId", "label", "adapter", "binary", "discoveredAt"] as const) {
    stringValue(candidate[field], field);
  }
  if (!(candidate.adapter === "opencode" || candidate.adapter === "kilo" || candidate.adapter === "codex" || candidate.adapter === "claude")) throw new Error("Provider discovery adapter is invalid.");
  if (!SAFE_ID.test(String(candidate.providerId)) || !String(candidate.label).trim() || !String(candidate.binary).trim()) {
    throw new Error("Provider discovery identity is invalid.");
  }
  if (typeof candidate.enabled !== "boolean" || typeof candidate.available !== "boolean") {
    throw new Error("Provider discovery enabled/available fields must be boolean.");
  }
  for (const [index, model] of arrayValue(candidate.models, "models").entries()) {
    stringValue(model, `models[${index}]`);
  }
  if (candidate.catalogSource !== "command" && candidate.catalogSource !== "configured") throw new Error("Provider discovery catalogSource is invalid.");
  if ((candidate.adapter === "opencode" || candidate.adapter === "kilo") && candidate.catalogSource !== "command") throw new Error("OpenCode/Kilo discovery must use a command catalog.");
  if ((candidate.adapter === "codex" || candidate.adapter === "claude") && candidate.catalogSource !== "configured") throw new Error("Codex/Claude discovery must use a configured catalog.");
  if (candidate.command !== null && typeof candidate.command !== "string") {
    throw new Error("Provider discovery command must be a string or null.");
  }
  if (!Number.isFinite(Date.parse(String(candidate.discoveredAt)))) throw new Error("Provider discovery discoveredAt is invalid.");
  if (candidate.catalogSource === "command" && candidate.available && typeof candidate.command !== "string") throw new Error("Command catalog discovery must include its command.");
  if (candidate.catalogSource === "configured" && candidate.command !== null) throw new Error("Configured catalog discovery cannot include a command.");
  if (candidate.catalogSource === "command" && candidate.command !== null && !candidate.command.trim()) throw new Error("Provider discovery command must not be empty.");
  if (candidate.error !== null) {
    const error = objectValue(candidate.error);
    stringValue(error.code, "error.code");
    stringValue(error.message, "error.message");
    if (!String(error.code).trim() || !String(error.message).trim()) throw new Error("Provider discovery error code/message must not be empty.");
  }
  if (candidate.available && candidate.error !== null) throw new Error("Available provider discovery cannot contain an error.");
  if (!candidate.available && candidate.error === null) throw new Error("Unavailable provider discovery must contain an error.");
  const models = arrayValue(candidate.models, "models");
  if (models.some((model) => !String(model).trim())) throw new Error("Provider discovery models must not be empty.");
  if (candidate.available && models.length === 0) throw new Error("Available provider discovery must contain at least one model.");
  if (!candidate.available && models.length > 0) throw new Error("Unavailable provider discovery cannot contain models.");
  return value as ProviderDiscoveryResultV2;
}

export function validateOperatorSnapshotV3(value: unknown): OperatorSnapshotV3 {
  const candidate = objectValue(value);
  if (candidate.schemaVersion !== 3) throw new Error("Operator snapshot schema must be version 3.");
  stringValue(candidate.capturedAt, "capturedAt");
  if (!Number.isFinite(Date.parse(String(candidate.capturedAt)))) throw new Error("capturedAt is invalid.");
  if (candidate.projection !== null) validateRunProjectionV2(candidate.projection);
  validateSessionIndexProjectionV4(candidate.sessionIndex);
  if (candidate.settings !== null) objectValue(candidate.settings);
  const discoveries = arrayValue(candidate.providerDiscovery, "providerDiscovery");
  for (const discovery of discoveries) validateProviderDiscoveryResultV2(discovery);
  return value as OperatorSnapshotV3;
}

export function createOperatorSnapshotV3(input: {
  projection: RunProjectionV2 | null;
  sessionIndex: SessionIndexProjectionV4;
  settings: Record<string, unknown> | null;
  providerDiscovery: ProviderDiscoveryResultV2[];
  capturedAt?: string;
}): OperatorSnapshotV3 {
  const snapshot: OperatorSnapshotV3 = {
    schemaVersion: 3,
    capturedAt: input.capturedAt ?? new Date().toISOString(),
    projection: input.projection,
    sessionIndex: input.sessionIndex,
    settings: input.settings,
    providerDiscovery: input.providerDiscovery,
  };
  return validateOperatorSnapshotV3(snapshot);
}

export function createEmptySessionIndexProjection(): SessionIndexProjectionV4 {
  return {
    version: 4,
    activeSessionIds: [],
    sessionMetas: [],
    availableModels: [],
    modelsDiscoveredAt: null,
    modelsDiscoveredCli: null,
    manualModelsOverride: null,
    modelVariants: null,
  };
}

/** Current empty snapshot used by new desktop/core integrations. */
export function emptyOperatorSnapshot(): OperatorSnapshotV3 {
  return {
    schemaVersion: 3,
    capturedAt: new Date().toISOString(),
    projection: null,
    sessionIndex: createEmptySessionIndexProjection(),
    settings: null,
    providerDiscovery: [],
  };
}

// Keep the domain import in this module type-only so consumers can use the
// contract without loading the aggregate implementation at runtime.
export type RunStatusV4 = RunAggregate["execution"]["status"];
