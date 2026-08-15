import type { AgentRunResult } from "./agent_runtime";
import type { ArtifactReference } from "./loop_state";
import type {
  PipelineCompletionContract,
  PipelineStage,
  PipelineStageExecutor,
} from "./pipeline";
import type { RequirementEvidenceRecord } from "./requirement_ledger";
import {
  StageDecision,
  StageExecutionStatus,
  StageOutcome,
  StageOutcomeFailure,
} from "./workflow_contracts";

const MAX_STAGE_OUTCOMES = 128;
const MAX_OUTCOME_SUMMARY_BYTES = 4_096;
const STRUCTURED_OUTCOME_EVENT = "agent_loop.stage_outcome";

export interface StructuredStageOutcomeSignal {
  schemaVersion: 1;
  stageId: string;
  executor: PipelineStageExecutor;
  status: StageExecutionStatus;
  decision: StageDecision | null;
}

export interface StructuredStageOutcomeObservation {
  present: boolean;
  valid: boolean;
  reason: string | null;
  signal: StructuredStageOutcomeSignal | null;
}

function boundedUtf8Tail(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maximumBytes) return value;
  return bytes.subarray(bytes.length - maximumBytes).toString("utf8").replace(/^\uFFFD/, "");
}

function isStageDecision(value: unknown): value is StageDecision {
  return ["pass", "fail", "approved", "rejected"].includes(String(value));
}

function isStageExecutionStatus(value: unknown): value is StageExecutionStatus {
  return ["succeeded", "failed", "waiting_user", "paused", "blocked", "stopped"]
    .includes(String(value));
}

function parseSignal(value: unknown): StructuredStageOutcomeSignal | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const decision = candidate.decision ?? null;
  if (
    candidate.schemaVersion !== 1 ||
    typeof candidate.stageId !== "string" ||
    typeof candidate.executor !== "string" ||
    !isStageExecutionStatus(candidate.status) ||
    (decision !== null && !isStageDecision(decision))
  ) return null;
  return {
    schemaVersion: 1,
    stageId: candidate.stageId,
    executor: candidate.executor as PipelineStageExecutor,
    status: candidate.status,
    decision,
  };
}

/**
 * Reads only a top-level provider JSONL event. Assistant prose containing JSON
 * cannot impersonate a structured provider event.
 */
export function observeStructuredStageOutcome(
  events: readonly Record<string, unknown>[],
  expected: {
    stageId: string;
    executor: PipelineStageExecutor;
    decision: StageDecision | null;
  }
): StructuredStageOutcomeObservation {
  const candidates = events.filter((event) => event.type === STRUCTURED_OUTCOME_EVENT);
  if (candidates.length === 0) {
    return { present: false, valid: true, reason: null, signal: null };
  }
  const parsed = candidates.map((event) => parseSignal(event.outcome ?? event.stageOutcome));
  if (parsed.some((signal) => signal === null)) {
    return {
      present: true,
      valid: false,
      reason: "Structured stage outcome is malformed or uses an unsupported schema version.",
      signal: null,
    };
  }
  const signal = parsed[parsed.length - 1]!;
  if (parsed.some((candidate) => JSON.stringify(candidate) !== JSON.stringify(signal))) {
    return {
      present: true,
      valid: false,
      reason: "Provider emitted contradictory structured stage outcomes.",
      signal: null,
    };
  }
  if (signal.stageId !== expected.stageId || signal.executor !== expected.executor) {
    return {
      present: true,
      valid: false,
      reason:
        `Structured stage outcome identity mismatch: expected ${expected.stageId}/${expected.executor}, ` +
        `received ${signal.stageId}/${signal.executor}.`,
      signal,
    };
  }
  if (signal.status !== "succeeded") {
    return {
      present: true,
      valid: false,
      reason: `Structured stage outcome reported ${signal.status} for a legacy-successful attempt.`,
      signal,
    };
  }
  if (signal.decision !== expected.decision) {
    return {
      present: true,
      valid: false,
      reason:
        `Structured stage decision ${String(signal.decision)} does not match legacy decision ` +
        `${String(expected.decision)}.`,
      signal,
    };
  }
  return { present: true, valid: true, reason: null, signal };
}

export function stageDecisionFromVerdict(
  verdict: "PASS" | "FAIL" | "APPROVED" | "REJECTED" | null
): StageDecision | null {
  if (verdict === "PASS") return "pass";
  if (verdict === "FAIL") return "fail";
  if (verdict === "APPROVED") return "approved";
  if (verdict === "REJECTED") return "rejected";
  return null;
}

export function createStageOutcome(input: {
  stage: PipelineStage;
  executor: PipelineStageExecutor;
  completionContract: PipelineCompletionContract;
  activationId: string | null;
  attemptId: string | null;
  output: string;
  verdict: "PASS" | "FAIL" | "APPROVED" | "REJECTED" | null;
  requirementEvidence: RequirementEvidenceRecord[];
  artifacts: Readonly<Record<string, ArtifactReference>>;
  structuredObservation?: StructuredStageOutcomeObservation;
  status?: StageExecutionStatus;
  failure?: StageOutcomeFailure | null;
  recordedAt?: string;
}): StageOutcome {
  const recordedAt = input.recordedAt ?? new Date().toISOString();
  const decision = stageDecisionFromVerdict(input.verdict);
  const structured = input.structuredObservation;
  return {
    schemaVersion: 1,
    outcomeId:
      `${input.activationId ?? `stage_${input.stage.id}`}:` +
      `${input.attemptId ?? "system"}:${recordedAt}`,
    stageId: input.stage.id,
    activationId: input.activationId,
    attemptId: input.attemptId,
    role: input.stage.role,
    executor: input.executor,
    status: input.status ?? "succeeded",
    decision,
    requirementEvidence: input.requirementEvidence.map((record) => ({ ...record })),
    artifacts: Object.entries(input.artifacts)
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, 128)
      .map(([key, reference]) => ({ key, ...reference })),
    failure: input.failure ?? null,
    outputSummary: boundedUtf8Tail(input.output.trim(), MAX_OUTCOME_SUMMARY_BYTES),
    source: structured?.present && structured.valid ? "structured" : "legacy_text",
    compatibility: {
      legacyContract: input.completionContract,
      legacyValidated: true,
      structuredSignalPresent: structured?.present ?? false,
      decisionsEquivalent: !structured?.present || structured.valid,
    },
    recordedAt,
  };
}

export function appendStageOutcome(
  outcomes: readonly StageOutcome[],
  outcome: StageOutcome
): StageOutcome[] {
  return [
    ...outcomes.filter((candidate) =>
      outcome.activationId
        ? candidate.activationId !== outcome.activationId
        : candidate.outcomeId !== outcome.outcomeId
    ),
    outcome,
  ]
    .slice(-MAX_STAGE_OUTCOMES);
}

export function createFailedStageOutcome(input: {
  stage: PipelineStage;
  executor: PipelineStageExecutor;
  completionContract: PipelineCompletionContract;
  activationId: string | null;
  attemptId: string | null;
  artifacts: Readonly<Record<string, ArtifactReference>>;
  status: Exclude<StageExecutionStatus, "succeeded">;
  failure: StageOutcomeFailure;
  recordedAt?: string;
}): StageOutcome {
  const recordedAt = input.recordedAt ?? new Date().toISOString();
  return {
    schemaVersion: 1,
    outcomeId:
      `${input.activationId ?? `stage_${input.stage.id}`}:` +
      `${input.attemptId ?? "system"}:${recordedAt}`,
    stageId: input.stage.id,
    activationId: input.activationId,
    attemptId: input.attemptId,
    role: input.stage.role,
    executor: input.executor,
    status: input.status,
    decision: null,
    requirementEvidence: [],
    artifacts: Object.entries(input.artifacts)
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, 128)
      .map(([key, reference]) => ({ key, ...reference })),
    failure: { ...input.failure },
    outputSummary: boundedUtf8Tail(input.failure.message, MAX_OUTCOME_SUMMARY_BYTES),
    source: "system",
    compatibility: {
      legacyContract: input.completionContract,
      legacyValidated: false,
      structuredSignalPresent: false,
      decisionsEquivalent: true,
    },
    recordedAt,
  };
}

export function normalizeStageOutcomes(value: unknown): StageOutcome[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((candidate): candidate is StageOutcome => {
      if (!candidate || typeof candidate !== "object") return false;
      const outcome = candidate as Partial<StageOutcome>;
      return (
        outcome.schemaVersion === 1 &&
        typeof outcome.outcomeId === "string" &&
        typeof outcome.stageId === "string" &&
        typeof outcome.executor === "string" &&
        isStageExecutionStatus(outcome.status) &&
        typeof outcome.recordedAt === "string"
      );
    })
    .slice(-MAX_STAGE_OUTCOMES);
}

export function structuredDecisionForCompletion(
  contract: PipelineCompletionContract,
  result: Pick<AgentRunResult, "assistantText">
): StageDecision | null {
  const text = result.assistantText ?? "";
  if (contract === "verdict") {
    const matches = [...text.matchAll(/^\s*VERDICT:\s*(PASS|FAIL)\b.*$/gim)];
    const value = matches[matches.length - 1]?.[1]?.toUpperCase();
    return value === "PASS" ? "pass" : value === "FAIL" ? "fail" : null;
  }
  if (contract === "approval") {
    const matches = [...text.matchAll(/^\s*(APPROVED|REJECTED)(?:\s|$|[:;,.!?()[\]{}|\u2013\u2014-]).*$/gim)];
    const value = matches[matches.length - 1]?.[1]?.toUpperCase();
    return value === "APPROVED" ? "approved" : value === "REJECTED" ? "rejected" : null;
  }
  return null;
}
