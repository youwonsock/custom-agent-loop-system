import { AgentAttemptState, AttemptFailure, FailureKind } from "./resilience";
import { PipelineDefinition, PipelineStageExecutor } from "./pipeline";
import { PipelineCompilation } from "./pipeline_compiler";
import { ProviderConfig, ToolAccessConfig } from "./provider_runtime";
import { ConvergenceState, RequirementLedger } from "./requirement_ledger";
import { LoopStatus, StageOutcome } from "./workflow_contracts";
import type { DomainEvent } from "./domain_events";

export type AgentRole = string;
export type AccessMode = "ask" | "full_access";

export interface PendingAccessRequest {
  requestId: string;
  requestedPaths: string[];
  requestedAt: string;
  sourcePhase: string;
  reason: string;
}

export interface ModelMapping {
  [role: string]: string;
  planner: string;
  implementer: string;
  tester: string;
  qa_lead: string;
  master: string;
  interrupter: string;
}

export type VariantMapping = Partial<Record<AgentRole, string>>;

export interface ErrorSignature {
  signature: string;
  rawMessage: string;
  timestamp: number;
  phase: string;
}

export interface AgentState {
  status: "idle" | "running" | "retry_wait" | "completed" | "failed";
  lastExitCode: number | null;
  lastRunAt: string | null;
}

export interface AutomaticRecoveryState {
  sourcePhase: string;
  failureKind: FailureKind;
  cycle: number;
  maxCycles: number;
  resumeAt: string;
  reason: string;
}

export interface StageResultState {
  stageId: string;
  role: string;
  kind: string;
  executor?: PipelineStageExecutor;
  completedAt: string;
  output: string;
  verdict: "PASS" | "FAIL" | "APPROVED" | "REJECTED" | null;
  attemptId: string | null;
}

export interface ResilienceSettings {
  transportTimeoutMs: number;
  toolTimeoutMs: number;
  maxAgentAttempts: number;
  maxCompletionRecoveryAttempts: number;
  maxAutomaticRecoveryCycles: number;
  automaticRecoveryBackoffMs: number[];
  retryBackoffMs: number[];
  phaseRecoveryBudgetMs: number;
  terminationGraceMs: number;
  killTimeoutMs: number;
  heartbeatIntervalMs: number;
  leaseTtlMs: number;
  maxInMemoryOutputBytes: number;
}

export interface ReferenceIdentity {
  title: string;
  creator: string;
  packageId: string;
  canonicalUrl: string;
  candidateCount: number;
  identityMatch: "EXACT" | "AMBIGUOUS" | "SIMILAR" | "UNKNOWN";
  confidence: "HIGH" | "MEDIUM" | "LOW";
}

export type StageActivationStatus =
  | "reserved"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown_mutation";

export interface StageActivationReservation {
  activationId: string;
  sequence: number;
  stageId: string;
  executor: PipelineStageExecutor;
  mutationCapable: boolean;
  workflowStep: number;
  cycleNumber: number | null;
  attemptsReserved: number;
  maxAgentAttempts: number;
  status: StageActivationStatus;
  reservedAt: string;
  completedAt: string | null;
}

export interface LoopState {
  stateVersion: 2;
  aggregateFormatVersion: 1;
  aggregateRevision: number;
  fencingEpoch: number;
  aggregateChecksum: string;
  processedRequestIds: string[];
  artifactRefs: Record<string, ArtifactReference>;
  sessionId: string;
  status: LoopStatus;
  phase: string;
  loopCount: number;
  completedIterations: number;
  maxCycles: number;
  cyclesStarted: number;
  cyclesCompleted: number;
  maxWorkflowSteps: number;
  workflowStepsConsumed: number;
  currentActivation: StageActivationReservation | null;
  activationHistory: StageActivationReservation[];
  goal: string;
  targetProjectPath: string;
  additionalAllowedPaths: string[];
  accessMode: AccessMode;
  pendingAccessRequest: PendingAccessRequest | null;
  modelMapping: ModelMapping;
  providerMapping: Record<string, string>;
  providerConfigs: Record<string, ProviderConfig>;
  errorQueue: ErrorSignature[];
  agentStates: Record<string, AgentState>;
  refinedGoal: string | null;
  referenceIdentity: ReferenceIdentity | null;
  planningComplete: boolean;
  masterApproved: boolean;
  awaitingPlanApproval: boolean;
  planApproved: boolean;
  planPath: string | null;
  planOverviewPath: string | null;
  selectedPlanChoiceId: number | null;
  createdAt: string;
  updatedAt: string;
  maxIterations: number;
  phaseTimeoutMs: number;
  idleTimeoutMs: number;
  cliBinary: string;
  cliProfile: string;
  variantMapping: VariantMapping;
  toolAccess: ToolAccessConfig;
  lastFailureDigest: string | null;
  interruptMessage?: string;
  interruptBriefing?: string | null;
  planRevisionPending?: boolean;
  interruptedFromPhase?: string | null;
  activeAttempt: AgentAttemptState | null;
  lastFailure: AttemptFailure | null;
  recoveryCount: number;
  totalAgentAttempts: number;
  statusReason: string | null;
  automaticRecovery: AutomaticRecoveryState | null;
  resilience: ResilienceSettings;
  pipeline: PipelineDefinition;
  pipelineCompilation: PipelineCompilation;
  pipelineConfigPath: string | null;
  stageResults: Record<string, StageResultState>;
  stageOutcomes: StageOutcome[];
  domainEventSequence: number;
  domainEvents: DomainEvent[];
  requirements: RequirementLedger;
  convergence: ConvergenceState;
}

export interface ArtifactReference {
  sha256: string;
  mediaType: string;
  bytes: number;
}
