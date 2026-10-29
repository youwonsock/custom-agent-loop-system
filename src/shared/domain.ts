import type {
  Activity,
  AttemptStatus,
  FailureKind,
  NodeVerdict,
} from "./execution_types";
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
  automation?: {
    maxRepairCycles: number;
    nativeApprovalReview: boolean;
    browserVerification?: boolean;
    verificationContract?: boolean;
    authoredNodeTests?: boolean;
    testSourceGuard?: boolean;
    reserveFinalizationBudget?: boolean;
    guardOwnedProcesses?: boolean;
    targetScopeGuard?: boolean;
    programIoGuard?: boolean;
  };
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
  /** Optional in historical v3 snapshots; all newly started sessions set these. */
  sessionTimeoutMs?: number;
  maxSessionAttempts?: number;
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
export interface VerificationManifest {
  version: 1;
  protectedFiles: string[];
  checks: Array<{ id: string; command: string; requirements: string[] }>;
  requiredFiles?: Array<{ path: string; requirements: string[] }>;
  nodeTests?: NodeTestPolicy;
}
export interface NodeTestPolicy {
  checkId: string;
  suiteCheckId: string;
  scopes: Array<{
    id: string;
    file: string;
    requirements: string[];
    cases: string[];
    challenges: Array<{ id: string; adapter: string; targets: string[] }>;
  }>;
}
export interface NodeTestProof {
  version: 1;
  runId: string;
  reportDigest: string;
  sourceHashes: Record<string, string>;
  scopes: Array<{
    id: string;
    file: string;
    cases: string[];
    challenges: string[];
  }>;
}
export interface VerificationContract {
  version: 1;
  status: "pending" | "locked";
  origin?: "supplied" | "implementation";
  lockedAt?: string;
  manifest?: VerificationManifest;
  hashes?: Record<string, string>;
  digest?: string;
}
export interface SessionBudget {
  startedAt: string;
  deadlineAt: string;
  maxAttempts: number;
  exhaustedReason: string | null;
}
export interface CommandReceipt {
  id: string;
  command: string;
  exitCode: number | null;
  environmentError: string | null;
}
export interface NativeScopeAudit {
  version: 1;
  cwd: string;
  roots: string[];
  inspectedCalls: number;
  blockedCalls: number;
  outsideCalls: number;
  unresolvedCalls: number;
  blocked: Array<{ tool: string; path: string }>;
  violations: Array<{ tool: string; path: string }>;
}
export interface ProgramIoAudit {
  version: 1;
  backend: "macos-seatbelt" | "apple-container-vm";
  policyId: string;
  profileDigest: string;
  cwd: string;
  preflightPassed: boolean;
  nativeCommands: number;
  completedCommands: number;
  unwrappedCommands: number;
  unresolvedCommands: number;
  invalidReceipts: number;
  runtimeReadRoots: string[];
  commands: Array<{
    id: string;
    command: string;
    exitCode: number;
    pid: number;
    processGroupStopped: boolean;
    containerRemoved?: boolean;
    containerName?: string;
  }>;
}
export interface AttemptRecord {
  programIoAudit?: ProgramIoAudit;
  scopeAudit?: NativeScopeAudit;
  verificationInvalidation?: { at: string; reason: string; files: string[] };
  readFiles?: string[];
  /** Written only after runtime completion validation; absent legacy evidence fails closed. */
  completionAccepted?: boolean;
  fileMutation?: boolean;
  pricing?: ModelPricing;
  commands?: CommandReceipt[];
  id: string;
  number: number;
  status: AttemptStatus | FailureKind | "interrupted";
  startedAt: string;
  endedAt: string | null;
  pid: number | null;
  cliSessionId: string | null;
  reconnectUsed: boolean;
  mode: "standard" | "completion_recovery";
  failureKind: FailureKind | "worker_crash" | null;
  message: string | null;
  logPath: string;
  lastProgressAt: string | null;
  activity: Activity;
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
  stageDeadlineAt?: string;
  verificationSourceHashes?: Record<string, string>;
  verifiedCommands?: CommandReceipt[];
  nodeTestProof?: NodeTestProof;
  id: string;
  nodeId: string;
  number: number;
  status: "running" | "waiting_approval" | "succeeded" | "failed" | "paused";
  startedAt: string;
  completedAt: string | null;
  attempts: AttemptRecord[];
  output: string;
  verdict: NodeVerdict | null;
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
  verificationContract?: VerificationContract;
  executionBudget?: SessionBudget;
  /** Monotonic persistence revision; absent in legacy version-3 snapshots. */
  revision?: number;
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
