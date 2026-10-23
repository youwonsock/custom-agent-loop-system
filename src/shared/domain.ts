export const NODE_TYPES = [
  "planning",
  "implementation",
  "test",
  "review",
  "approval",
  "interrupt",
] as const;
export type NodeType = (typeof NODE_TYPES)[number];
export const SERVICE_TYPES = ["codex", "claude", "opencode", "kilo"] as const;
export type ServiceType = (typeof SERVICE_TYPES)[number];
export type Terminal = "SUCCESS" | "PAUSED";
export interface ExecutionBinding {
  connectionId: string;
  modelId: string;
  variant?: string;
}
export interface AgentNode {
  id: string;
  name: string;
  roleName: string;
  type: NodeType;
  instructions: string;
  position: { x: number; y: number };
  binding?: ExecutionBinding;
  planning?: { requiresApproval: boolean; optionsCount: number };
}
export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  outcome: "success" | "failure";
}
export interface AgentGraphDocument {
  version: 2;
  id: string;
  revision: number;
  name: string;
  description: string;
  nodes: AgentNode[];
  edges: GraphEdge[];
  defaultBinding?: ExecutionBinding;
  entrypoints: {
    start: string | null;
    reentry: string | null;
    interrupt: string | null;
    cycleCompletion: string | null;
  };
  viewport: { x: number; y: number; zoom: number };
  updatedAt: string;
}
export interface LocalConnection {
  id: string;
  label: string;
  type: ServiceType;
  binary: string;
}
export interface ModelInfo {
  id: string;
  label: string;
  variants: string[];
  resolvedModelId?: string;
  pricing?: ModelPricing;
}
export interface ModelPricing {
  status: "free" | "paid" | "unknown";
  source: "native_flag" | "native_cost" | "unavailable";
  checkedAt: string;
  reason: string;
}
export interface ModelCatalog {
  connectionId: string;
  targetProjectPath: string;
  binary: string;
  queriedAt: string;
  status:
    | "ready"
    | "missing_binary"
    | "auth_required"
    | "unsupported"
    | "query_failed"
    | "empty";
  models: ModelInfo[];
  error: string | null;
}
export interface GraphDiagnostic {
  code: string;
  message: string;
  nodeId?: string;
}
export type SessionStatus =
  | "RUNNING"
  | "RECOVERING"
  | "WAITING_USER"
  | "PAUSED"
  | "STOPPED"
  | "BLOCKED"
  | "SUCCESS"
  | "FAILED";
export interface ExecutionSettings {
  maxIterations: number;
  maxAgentAttempts: number;
  maxCompletionRecoveryAttempts: number;
  phaseTimeoutMs: number;
  idleTimeoutMs: number;
  toolTimeoutMs: number;
  transportTimeoutMs: number;
  phaseRecoveryBudgetMs: number;
  retryBackoffMs: number[];
  terminationGraceMs: number;
  killTimeoutMs: number;
  heartbeatIntervalMs: number;
  leaseTtlMs: number;
  maxInMemoryOutputBytes: number;
  maxAutomaticRecoveryCycles: number;
  automaticRecoveryBackoffMs: number[];
}
export interface CommandReceipt {
  id: string;
  command: string;
  exitCode: number | null;
  environmentError: string | null;
}
export interface AttemptRecord {
  /** Written only after runtime completion validation; absent legacy evidence fails closed. */
  completionAccepted?: boolean;
  fileMutation?: boolean;
  pricing?: ModelPricing;
  commands?: CommandReceipt[];
  id: string;
  number: number;
  status: string;
  startedAt: string;
  endedAt: string | null;
  pid: number | null;
  cliSessionId: string | null;
  reconnectUsed: boolean;
  mode: "standard" | "completion_recovery";
  failureKind: string | null;
  message: string | null;
  logPath: string;
  lastProgressAt: string | null;
  activity: string;
  deadlineAt: string;
  requestedModelId: string;
  actualModelId: string | null;
  assistantTextBytes: number;
  maxTokens: number;
}
export interface PlanChoice {
  id: number;
  title: string;
  body: string;
  revision: number;
}
export interface NodeVisit {
  verifiedCommands?: CommandReceipt[];
  id: string;
  nodeId: string;
  number: number;
  status: "running" | "waiting_approval" | "succeeded" | "failed" | "paused";
  startedAt: string;
  completedAt: string | null;
  attempts: AttemptRecord[];
  output: string;
  verdict: string | null;
  plans: PlanChoice[];
  selectedPlanId: number | null;
  cycleStartedAt: string;
  cycleDeadlineAt: string;
  recoveryCount: number;
  transitionCommitted: boolean;
  automaticCycles: number;
}
export interface SessionState {
  stateVersion: 3;
  id: string;
  requestId: string;
  goal: string;
  targetProjectPath: string;
  graph: AgentGraphDocument;
  connections: LocalConnection[];
  bindings: Record<string, ExecutionBinding>;
  settings: ExecutionSettings;
  status: SessionStatus;
  statusReason: string | null;
  createdAt: string;
  updatedAt: string;
  currentNodeId: string | null;
  activeVisitId: string | null;
  visits: NodeVisit[];
  completedIterations: number;
  visitLimit: number;
  iterationLimit: number;
  accessMode: "ask" | "full_access";
  additionalAllowedPaths: string[];
  pendingAccess: { paths: string[]; nodeId: string; visitId: string } | null;
  pendingApproval: { nodeId: string; visitId: string } | null;
  approvedPlanRef: {
    visitId: string;
    choiceId: number;
    revision: number;
  } | null;
  automaticRecovery: { count: number; resumeAt: string } | null;
  processedRequests: string[];
  interruptMessage: string | null;
  requirements: {
    version: 1;
    derivedAt: string;
    items: Array<{
      id: string;
      text: string;
      category: "deliverable" | "behavior" | "constraint" | "research";
      mandatory: true;
      source: "original_goal";
    }>;
    evidence: Array<{
      requirementId: string;
      stageId: string;
      role: string;
      status: "SATISFIED" | "PARTIAL" | "FAILED" | "BLOCKED";
      summary: string;
      attemptId: string | null;
      recordedAt: string;
    }>;
  };
  convergence: {
    stagnantCycles: number;
    history: Array<{
      loopCount: number;
      score: number;
      signature: string;
      unresolvedRequirementIds: string[];
      recordedAt: string;
    }>;
  };
}
export interface SessionAction {
  requestId: string;
  type:
    | "resume"
    | "stop"
    | "interrupt"
    | "approve_plan"
    | "select_plan"
    | "edit_plan"
    | "approve_access";
  nodeId?: string;
  visitId?: string;
  choiceId?: number;
  expectedRevision?: number;
  body?: string;
  message?: string;
  decision?: "allow_requested" | "full_access";
}
export interface StudioEvent {
  type: "session" | "log" | "graphs" | "connections";
  sessionId?: string;
  data?: unknown;
}
