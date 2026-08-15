import {
  PipelineCompletionContract,
  PipelineDefinition,
  PipelineStage,
  PipelineStageExecutor,
} from "./pipeline";
import type { RequirementEvidenceRecord } from "./requirement_ledger";

export enum LoopStatus {
  RUNNING = "RUNNING",
  PAUSED = "PAUSED",
  WAITING_USER = "WAITING_USER",
  RECOVERING = "RECOVERING",
  STOPPED = "STOPPED",
  BLOCKED = "BLOCKED",
  SUCCESS = "SUCCESS",
  FAILED = "FAILED",
}

export type StageExecutionStatus =
  | "succeeded"
  | "failed"
  | "waiting_user"
  | "paused"
  | "blocked"
  | "stopped";

export type StageDecision = "pass" | "fail" | "approved" | "rejected";

export interface StageOutcomeArtifact {
  key: string;
  sha256: string;
  mediaType: string;
  bytes: number;
}

export interface StageOutcomeFailure {
  kind: string;
  message: string;
  retryable: boolean;
  exitCode: number | null;
}

export interface StageOutcomeCompatibility {
  legacyContract: PipelineCompletionContract;
  legacyValidated: boolean;
  structuredSignalPresent: boolean;
  decisionsEquivalent: boolean;
}

/**
 * Durable, core-authored result for one stage activation. Provider output is
 * evidence for this envelope, never the authority that advances the workflow.
 */
export interface StageOutcome {
  schemaVersion: 1;
  outcomeId: string;
  stageId: string;
  activationId: string | null;
  attemptId: string | null;
  role: string;
  executor: PipelineStageExecutor;
  status: StageExecutionStatus;
  decision: StageDecision | null;
  requirementEvidence: RequirementEvidenceRecord[];
  artifacts: StageOutcomeArtifact[];
  failure: StageOutcomeFailure | null;
  outputSummary: string;
  source: "structured" | "legacy_text" | "system";
  compatibility: StageOutcomeCompatibility;
  recordedAt: string;
}

export interface TransitionDecision {
  sourceStageId: string;
  target: string;
  terminalStatus?: LoopStatus.SUCCESS | LoopStatus.PAUSED | LoopStatus.BLOCKED;
}

export interface WorkflowCursor {
  status: LoopStatus;
  phase: string;
  pipeline: PipelineDefinition;
}

export interface StageExecutor {
  execute(stage: PipelineStage): Promise<void>;
}

export interface WorkflowEngine<TState extends WorkflowCursor = WorkflowCursor> {
  applyTarget(state: TState, target: string): TransitionDecision;
}
