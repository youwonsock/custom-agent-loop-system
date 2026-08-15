import { AgentRunResult } from "./agent_runtime";
import {
  AccessMode,
  LoopState,
  PendingAccessRequest,
  ReferenceIdentity,
  StageResultState,
} from "./loop_state";
import { PipelineRole, PipelineStage, PipelineStageType } from "./pipeline";
import { AttemptFailure, FailureKind } from "./resilience";
import { RequirementLedger } from "./requirement_ledger";
import { ToolAccessConfig } from "./provider_runtime";

export interface PlanChoice {
  id: number;
  title: string;
  body: string;
  markdownPath?: string;
}

export interface AttemptEvidenceSummary {
  attemptId: string | null;
  attemptNumber: number | null;
  result: "success" | "failure" | "timeout";
  failureKind: FailureKind | null;
  exitCode: number;
  startedAt: string;
  endedAt: string;
  outputBytes: number;
  assistantTextBytes: number | null;
  eventCount: number | null;
  lastEventType: string | null;
  lastToolName: string | null;
  lastToolStatus: string | null;
  lastToolCommand: string | null;
  lastStepFinishReason: string | null;
  lastStepFinishTotalTokens: number | null;
  maxObservedTotalTokens: number | null;
  rawLogPath: string | null;
  rawLogBytes: number | null;
}

export interface FailureEvidenceSummary {
  sourcePhase: string | null;
  targetProjectPath: string;
  additionalAllowedPaths: string[];
  accessMode: AccessMode;
  pendingAccessRequest: PendingAccessRequest | null;
  detectedAbsolutePathsOutsideTarget: string[];
  detectedAbsolutePathsOutsideAllowedRoots: string[];
  lastFailure: AttemptFailure | null;
  attempts: AttemptEvidenceSummary[];
}

export interface HandoffPayload {
  sessionId: string;
  originalGoal: string;
  approvedPlan: string | null;
  lockedReferenceIdentity: ReferenceIdentity | null;
  targetProjectPath: string;
  additionalAllowedPaths: string[];
  accessMode: AccessMode;
  progressNotes: string;
  failureDigest: string | null;
  phase: string;
  loopCount: number;
  toolAccess?: ToolAccessConfig;
  interruptMessage?: string;
  planRevised?: boolean;
  failureEvidence?: FailureEvidenceSummary | null;
  requirements?: RequirementLedger;
}

export interface AgentRoom {
  role: string;
  statePath: string;
  skillsPath: string;
  inputPayloadPath: string;
  outputPayloadPath: string;
}

export interface StageExecutionServices {
  state: LoopState;
  executeAgent(
    role: string,
    prompt: string,
    maxAttempts: number | undefined,
    stageType: PipelineStageType,
    modelRole?: PipelineRole["modelRole"],
    planOptionsCount?: number
  ): Promise<AgentRunResult>;
  buildPrompt(
    role: string,
    payload: HandoffPayload,
    roleDefinition: PipelineRole,
    stage: PipelineStage,
    stageType: PipelineStageType
  ): string;
  extractOutput(result: AgentRunResult): string;
  appendProgressNote(note: string): Promise<void>;
  commitPhaseResult(patch: Partial<LoopState>): Promise<void>;
  archiveLoop(
    loopNum: number,
    phase: string,
    role: string,
    result: AgentRunResult,
    startedAt: Date,
    endedAt: Date
  ): Promise<void>;
  recordStageResult(
    stage: PipelineStage,
    output: string,
    verdict: StageResultState["verdict"],
    result?: AgentRunResult
  ): void;
}
