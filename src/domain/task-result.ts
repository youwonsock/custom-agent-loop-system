import type { JsonValue } from "./json";

export type RequirementEvidenceStatus = "satisfied" | "unsatisfied" | "unknown";

export interface RequirementEvidence {
  requirementId: string;
  status: RequirementEvidenceStatus;
  evidence: string;
  artifactIds?: string[];
}

export interface TaskResultEnvelopeV1 {
  schemaVersion: 1;
  signal: string;
  summary: string;
  requirementEvidence: RequirementEvidence[];
  payload: JsonValue;
}

export interface ArtifactReference {
  artifactId: string;
  sha256: string;
  mediaType: string;
  bytes: number;
  createdAt: string;
}

export interface TaskOutputReference {
  activationId: string;
  artifactId: string;
  schemaId: string;
  signal: string;
  summary: string;
}

export interface NodeFailure {
  kind:
    | "provider"
    | "timeout"
    | "permission"
    | "format"
    | "schema"
    | "guardrail"
    | "budget"
    | "security"
    | "stopped"
    | "interrupted"
    | "unknown_mutation"
    | "internal";
  message: string;
  retryable: boolean;
  ambiguousMutation: boolean;
  attemptId: string | null;
  controlCommand?: import("./control-command").RunControlCommand;
}

export interface PendingHumanInput {
  requestId: string;
  kind: "plan_approval" | "access_approval" | "verification_approval" | "custom";
  nodeId: string;
  activationId: string;
  prompt: string;
  allowedSignals: string[];
  context: JsonValue;
  createdAt: string;
}

export type TaskExecutionStatus =
  | "succeeded"
  | "failed"
  | "waiting_user"
  | "paused"
  | "blocked"
  | "stopped";

export interface TaskExecutionResult {
  status: TaskExecutionStatus;
  signal: string | null;
  output: TaskOutputReference | null;
  effects: import("./domain-effect").DomainEffect[];
  artifacts: ArtifactReference[];
  failure: NodeFailure | null;
  pendingInput: PendingHumanInput | null;
}
