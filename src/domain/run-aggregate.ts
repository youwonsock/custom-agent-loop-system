import type { JsonObject, JsonValue } from "./json";
import type { DomainEffect } from "./domain-effect";
import type {
  ArtifactReference,
  NodeFailure,
  PendingHumanInput,
  TaskExecutionResult,
  TaskOutputReference,
} from "./task-result";
import type {
  CompiledWorkflowBundle,
  HumanGateResponse,
} from "./workflow";

export type RunStatus =
  | "RUNNING"
  | "WAITING_USER"
  | "PAUSED"
  | "BLOCKED"
  | "STOPPED"
  | "SUCCESS"
  | "FAILED";

export interface WorkflowRequirement {
  id: string;
  text: string;
}

export interface WorkflowContext {
  goal: string;
  requirements: WorkflowRequirement[];
  approvedPlan: TaskOutputReference | null;
  selectedPlanChoiceId: string | null;
  targetProjectPath: string;
  additionalAllowedPaths: string[];
  accessMode: "ask" | "full_access";
  planChoices: Array<{
    id: string;
    title: string;
    planArtifactId: string;
  }>;
  requirementEvidence: Array<{
    activationId: string;
    requirementId: string;
    status: "satisfied" | "unsatisfied" | "unknown";
    evidence: string;
    artifactIds: string[];
  }>;
  failureSummary: string | null;
  recovery: JsonValue | null;
  convergence: {
    stagnantCycles: number;
    history: Array<{ signature: string; improved: boolean; recordedAt: string }>;
  };
  interruptBriefing: { artifactId: string; summary: string } | null;
  humanResponses: Record<string, HumanGateResponse>;
}

export interface ExecutionState {
  status: RunStatus;
  currentNodeId: string;
  activeActivationId: string | null;
  workflowStepsConsumed: number;
  cyclesStarted: number;
  cyclesCompleted: number;
  activeCycleNumber: number | null;
  reason: string | null;
  lastFailure: NodeFailure | null;
}

export type NodeExecutionStatus =
  | "reserved"
  | "running"
  | "waiting_user"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown_mutation";

export interface NodeExecutionRecord {
  activationId: string;
  nodeId: string;
  taskId: string | null;
  agentId: string | null;
  workflowStep: number;
  cycleNumber: number | null;
  status: NodeExecutionStatus;
  sideEffect: "none" | "workspace_mutation";
  attemptIds: string[];
  reservedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  output: TaskOutputReference | null;
  signal: string | null;
  failure: NodeFailure | null;
}

export type DomainEventType =
  | "run.started"
  | "run.resumed"
  | "run.paused"
  | "run.completed"
  | "node.reserved"
  | "node.started"
  | "node.completed"
  | "node.failed"
  | "human_input.requested"
  | "human_input.received";

export interface DomainEvent {
  schemaVersion: 1;
  sequence: number;
  eventId: string;
  runId: string;
  nodeId: string | null;
  activationId: string | null;
  attemptId: string | null;
  type: DomainEventType;
  summary: string;
  detail: JsonObject;
  recordedAt: string;
}

export interface RunAggregate {
  schemaVersion: 1;
  runId: string;
  definition: CompiledWorkflowBundle;
  context: WorkflowContext;
  execution: ExecutionState;
  nodeExecutions: Record<string, NodeExecutionRecord>;
  latestCompletedByNode: Record<string, string>;
  pendingInput: PendingHumanInput | null;
  artifacts: Record<string, ArtifactReference>;
  events: DomainEvent[];
  eventSequence: number;
  processedRequestIds: string[];
  revision: number;
  fencingEpoch: number;
  checksum: string;
  createdAt: string;
  updatedAt: string;
}

export interface NodeOutcome {
  nodeId: string;
  activationId: string;
  result: TaskExecutionResult;
  targetId: string | null;
  terminalStatus: RunStatus | null;
  effects: DomainEffect[];
  completedAt: string;
}
