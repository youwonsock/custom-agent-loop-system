import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import runtimeDefaults from "./generated_runtime_defaults.json";
import { validateLoopPathsConfig } from "./pathSafety";

export type LoopStatus =
  | "RUNNING"
  | "PAUSED"
  | "WAITING_USER"
  | "STOPPED"
  | "BLOCKED"
  | "SUCCESS"
  | "FAILED";
export type Phase = string;
export type AgentRole = string;
export type AccessMode = "ask" | "full_access";
export type AttemptStatus =
  | "starting" | "running" | "retry_wait" | "succeeded"
  | "transport_timeout" | "idle_timeout" | "phase_timeout"
  | "tool_timeout"
  | "spawn_error" | "process_exit" | "incomplete_response"
  | "cancelled" | "unknown_outcome" | "orphaned_process";
export type FailureKind =
  | "transport_timeout" | "idle_timeout" | "phase_timeout" | "spawn_error"
  | "tool_timeout"
  | "process_exit" | "incomplete_response" | "network" | "rate_limited"
  | "auth" | "model_unavailable" | "permission" | "role_violation" | "cancelled"
  | "orphaned_process" | "unknown";

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
export type ProviderMapping = Record<AgentRole, string>;
export type ProviderAdapter = "opencode" | "kilo" | "codex" | "claude";

export interface ProviderCapabilities {
  readOnlyFilesystem: "enforced" | "best_effort" | "unsupported";
  workspaceWrites: "enforced" | "best_effort" | "unsupported";
  additionalRoots: "enforced" | "best_effort" | "unsupported";
  fullAccess: boolean;
  resumeSession: boolean;
  webSearchModes: Array<"cached" | "live">;
  mcpIsolation: "explicit" | "inherited" | "none";
  readOnlyMcpToolFiltering: "enforced" | "unsupported";
  processContainment: "supervised_tree";
  structuredEvents: "jsonl";
}

export interface ProviderConfig {
  label: string;
  adapter: ProviderAdapter;
  binary: string;
  enabled: boolean;
  modelsArgs: string[];
  fallbackModels: string[];
  interactionWhitelist?: string[];
  /** Informational only; the core derives the trusted profile from adapter. */
  capabilities?: ProviderCapabilities;
}

export interface ProviderCatalogEntry {
  id: string;
  label: string;
  adapter: ProviderAdapter;
  binary: string;
  enabled: boolean;
  available: boolean;
  models: string[];
  modelLabels?: Record<string, string>;
  modelVariants?: Record<string, string[]>;
  discoveredAt: string | null;
  error: string | null;
}

export interface McpServerConfig {
  id: string;
  name: string;
  enabled: boolean;
  type: "local" | "remote";
  command?: string;
  args?: string[];
  url?: string;
  environment?: Record<string, string>;
  headers?: Record<string, string>;
  timeoutMs?: number;
  tools?: Array<{
    name: string;
    sideEffect: "read_only" | "write" | "unknown";
  }>;
  allowedTools?: string[];
}

export interface ToolAccessConfig {
  webSearch: { enabled: boolean; mode: "cached" | "live" };
  mcpServers: McpServerConfig[];
}

export type PipelineStageExecutor = "planning" | "implementation" | "test" | "review" | "approval" | "interrupt";
export interface PipelineRole {
  id: string;
  modelRole: "planner" | "implementer" | "tester" | "qa_lead" | "master" | "interrupter";
  description: string;
  instructions: string;
  provider?: string;
  model?: string;
  variant?: string;
}
export interface PipelineStage {
  id: string;
  name: string;
  role: string;
  kind: string;
  instructions: string;
  onSuccess: string;
  onFailure: string;
  countsIteration: boolean;
  requiresPlanApproval: boolean;
  planOptionsCount: number;
}
export interface PipelineDefinition {
  version: 1;
  name: string;
  startStageId: string;
  interruptStageId: string;
  reentryStageId: string;
  iterationCompletionStageId: string;
  roles: PipelineRole[];
  stages: PipelineStage[];
}
export interface AgentRolesDefinition {
  version: 1;
  roles: PipelineRole[];
}
export interface AgentLoopDefinition {
  version: 1;
  name: string;
  startStageId: string;
  interruptStageId: string;
  reentryStageId: string;
  iterationCompletionStageId: string;
  stages: PipelineStage[];
}

export interface ErrorSignature {
  signature: string;
  rawMessage: string;
  timestamp: number;
  phase: Phase;
}

export interface AgentState {
  status: "idle" | "running" | "retry_wait" | "completed" | "failed";
  lastExitCode: number | null;
  lastRunAt: string | null;
}

export interface AgentAttemptState {
  attemptId: string;
  activationId?: string;
  role: AgentRole;
  phase: Phase;
  status: AttemptStatus;
  ownerPid: number;
  childPid: number | null;
  cliSessionId: string | null;
  attemptNumber: number;
  maxAttempts: number;
  reconnectUsed: boolean;
  startedAt: string;
  lastOutputAt: string | null;
  lastProgressAt: string | null;
  deadlineAt: string;
  nextRetryAt: string | null;
  endedAt: string | null;
  exitCode: number | null;
  failureKind: FailureKind | null;
  failureMessage: string | null;
  outputLogPath: string | null;
  activity: "initial_transport" | "model_generation" | "tool_execution";
}

export interface AttemptFailure {
  kind: FailureKind;
  message: string;
  retryable: boolean;
  occurredAt: string;
  attemptId: string | null;
  role: AgentRole | null;
  phase: Phase | null;
  exitCode: number | null;
  cliSessionId: string | null;
}

export interface PendingAccessRequest {
  requestId: string;
  requestedPaths: string[];
  requestedAt: string;
  sourcePhase: Phase;
  reason: string;
}

export interface ControlRequest {
  requestId: string;
  type: "STOP" | "INTERRUPT";
  createdAt: string;
  message: string | null;
}

export interface ControlAck {
  requestId: string;
  type: ControlRequest["type"];
  acceptedAt: string;
  completedAt: string | null;
  result: "accepted" | "completed" | "cancelled" | "failed";
  message: string | null;
}

export interface ResilienceSettings {
  transportTimeoutMs: number;
  toolTimeoutMs: number;
  maxAgentAttempts: number;
  retryBackoffMs: number[];
  terminationGraceMs: number;
  killTimeoutMs: number;
  heartbeatIntervalMs: number;
  leaseTtlMs: number;
  maxInMemoryOutputBytes: number;
}

export type RequirementEvidenceStatus = "SATISFIED" | "PARTIAL" | "FAILED" | "BLOCKED";
export interface RequirementLedger {
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
    status: RequirementEvidenceStatus;
    summary: string;
    attemptId: string | null;
    recordedAt: string;
  }>;
}

export interface ConvergenceState {
  stagnantCycles: number;
  history: Array<{
    loopCount: number;
    score: number;
    signature: string;
    unresolvedRequirementIds: string[];
    recordedAt: string;
  }>;
}

export interface ArtifactReference {
  sha256: string;
  mediaType: string;
  bytes: number;
}

export type DomainEventType =
  | "workflow.started" | "workflow.resumed" | "workflow.paused"
  | "workflow.completed" | "workflow.failed"
  | "stage.started" | "stage.completed" | "stage.failed" | "stage.paused"
  | "attempt.started" | "attempt.progressed" | "attempt.completed" | "attempt.failed";

export interface DomainEvent {
  schemaVersion: 1;
  sequence: number;
  eventId: string;
  type: DomainEventType;
  recordedAt: string;
  stageId: string | null;
  activationId: string | null;
  attemptId: string | null;
  role: string | null;
  summary: string;
  detail: Record<string, string | number | boolean | null>;
}

export interface RemainingExecutionBudgets {
  cycles: { remaining: number; consumed: number; limit: number };
  workflowSteps: { remaining: number; consumed: number; limit: number };
  stageAttempts: { remaining: number | null; consumed: number | null; limit: number | null };
}

export type NextPermittedAction =
  | "wait_for_attempt" | "execute_next_stage"
  | "approve_filesystem_access" | "approve_plan" | "reconcile_unknown_mutation"
  | "resume_session" | "inspect_failure" | "none_complete";

export interface OperatorSnapshot {
  schemaVersion: 1;
  sessionId: string;
  status: LoopStatus;
  currentStage: string;
  currentRole: string | null;
  activeAttempt: {
    attemptId: string;
    number: number;
    status: string;
    activity: string;
  } | null;
  nextPermittedAction: NextPermittedAction;
  pauseReason: string | null;
  progressSummary: string;
  budgets: RemainingExecutionBudgets;
  latestEvent: DomainEvent | null;
}

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
  status: "reserved" | "running" | "completed" | "failed" | "cancelled" | "unknown_mutation";
  reservedAt: string;
  completedAt: string | null;
}

export interface LoopState {
  stateVersion: 4;
  sessionId: string;
  status: LoopStatus;
  phase: Phase;
  loopCount: number;
  completedIterations: number;
  maxCycles?: number;
  cyclesStarted?: number;
  cyclesCompleted?: number;
  maxWorkflowSteps?: number;
  workflowStepsConsumed?: number;
  currentActivation?: StageActivationReservation | null;
  activationHistory?: StageActivationReservation[];
  goal: string;
  targetProjectPath: string;
  additionalAllowedPaths: string[];
  accessMode: AccessMode;
  pendingAccessRequest: PendingAccessRequest | null;
  modelMapping: ModelMapping;
  providerMapping: ProviderMapping;
  providerConfigs: Record<string, ProviderConfig>;
  errorQueue: ErrorSignature[];
  agentStates: Record<AgentRole, AgentState>;
  refinedGoal: string | null;
  referenceIdentity: {
    title: string;
    creator: string;
    packageId: string;
    canonicalUrl: string;
    candidateCount: number;
    identityMatch: "EXACT" | "AMBIGUOUS" | "SIMILAR" | "UNKNOWN";
    confidence: "HIGH" | "MEDIUM" | "LOW";
  } | null;
  planningComplete: boolean;
  masterApproved: boolean;
  createdAt: string;
  updatedAt: string;
  phaseTimeoutMs: number;
  idleTimeoutMs: number;
  cliBinary: string;
  cliProfile: string;
  variantMapping: VariantMapping;
  toolAccess: ToolAccessConfig;
  awaitingPlanApproval: boolean;
  planApproved: boolean;
  planPath: string | null;
  planOverviewPath: string | null;
  selectedPlanChoiceId: string | null;
  interruptMessage?: string | null;
  interruptBriefing?: string | null;
  lastFailureDigest?: string | null;
  planRevisionPending?: boolean;
  interruptedFromPhase?: Phase | null;
  activeAttempt: AgentAttemptState | null;
  lastFailure: AttemptFailure | null;
  recoveryCount: number;
  totalAgentAttempts: number;
  statusReason: string | null;
  resilience: ResilienceSettings;
  pipeline: PipelineDefinition;
  pipelineConfigPath: string | null;
  stageResults: Record<string, {
    stageId: string;
    role: string;
    kind: string;
    executor?: PipelineStageExecutor;
    completedAt: string;
    output: string;
    verdict: "PASS" | "FAIL" | "APPROVED" | "REJECTED" | null;
    attemptId: string | null;
  }>;
  domainEventSequence?: number;
  domainEvents?: DomainEvent[];
  requirements: RequirementLedger;
  convergence: ConvergenceState;
}

export interface PlanChoice {
  id: string;
  title: string;
  body: string;
  markdownPath?: string;
}

export interface SessionMeta {
  sessionId: string;
  goal: string;
  targetProjectPath: string;
  status: LoopStatus;
  createdAt: string;
}

export interface SessionRegistry {
  version: number;
  activeSessionIds: string[];
  availableModels: string[];
  modelsDiscoveredAt: string | null;
  modelsDiscoveredCli: string | null;
  sessionMetas: SessionMeta[];
  manualModelsOverride: string[] | null;
  modelVariants: Record<string, string[]> | null;
  providerCatalog?: Record<string, ProviderCatalogEntry>;
}

export interface LoopHistoryEntry {
  loopNumber: number;
  phase: Phase;
  agentRole: AgentRole;
  model: string;
  exitCode: number;
  startedAt: string;
  endedAt: string;
  output: string;
  result: "success" | "failure" | "timeout";
  signature: string | null;
  interruptMessage?: string | null;
}

export interface FinalSummary {
  sessionId: string;
  goal: string;
  achievedAt: string;
  totalLoops: number;
  finalModelMapping: ModelMapping;
  progressNotes: string;
  approvedByMaster: boolean;
}

export interface SessionBundle {
  registry: SessionRegistry;
  state: LoopState | null;
  progressNotes: string;
  finalSummary: FinalSummary | null;
}

export type WebviewMessage =
  | { command: "requestState" }
  | { command: "newSession"; goal: string; targetProjectPath: string; accessMode: AccessMode; modelMapping: Partial<ModelMapping>; providerMapping?: Partial<ProviderMapping>; variantMapping?: Partial<VariantMapping> }
  | { command: "resumeSession"; sessionId: string }
  | { command: "resolveAccessRequest"; sessionId: string; decision: "allow_requested" | "full_access" }
  | { command: "setAccessMode"; sessionId: string; accessMode: AccessMode }
  | { command: "stopSession"; sessionId: string }
  | { command: "discoverModels" }
  | { command: "selectSession"; sessionId: string }
  | { command: "refreshModels" }
  | { command: "openProgressNotes"; sessionId: string }
  | { command: "openFinalSummary"; sessionId: string }
  | { command: "deleteSession"; sessionId: string }
  | { command: "setCliProfile"; profile: string }
  | { command: "saveSystemSettings"; settings: SystemSettings }
  | { command: "openSessionFolder"; sessionId: string }
  | { command: "interruptSession"; sessionId: string; message: string }
  | { command: "selectPlanChoice"; sessionId: string; choiceId: string }
  | { command: "revisePlan"; sessionId: string; message: string }
  | { command: "approvePlan"; sessionId: string }
  | { command: "requestPlanReviewState"; sessionId: string }
  | { command: "selectSession"; sessionId: string };

export interface PlanReviewSessionInfo {
  sessionId: string;
  status: LoopStatus;
  goal: string;
  phase: Phase | null;
  awaitingPlanApproval: boolean;
  interruptStageId: string;
}

export interface PlanReviewStatePayload {
  sessionId: string;
  awaitingPlanApproval: boolean;
  planApproved: boolean;
  choices: PlanChoice[] | null;
  planMd: string | null;
  isPaused: boolean;
  phase: Phase | null;
  interruptBriefing: string | null;
  planRevisionPending: boolean;
  interruptStageId: string;
  selectedPlanChoiceId: string | null;
  sessions: PlanReviewSessionInfo[];
}

export interface WebviewStatePayload {
  registry: SessionRegistry;
  selectedSessionId: string | null;
  state: LoopState | null;
  progressNotes: string;
  timeline: DomainEvent[];
  operatorSnapshot: OperatorSnapshot | null;
  finalSummary: FinalSummary | null;
  isRunning: boolean;
  defaultTargetPath: string;
  cliProfile: string;
  modelsDiscoveredCli: string | null;
  modelVariants: Record<string, string[]> | null;
  variantMapping: VariantMapping;
  variantDefaults: Record<string, string[]>;
  cliProfiles: Record<string, { defaultBinary: string }>;
  systemSettings: SystemSettings;
  runtimeLeaseStatus: string | null;
}

export interface ExtensionConfig {
  cliBinary: string;
  cliProfile: string;
  rootDir: string;
  nodeBinary: string;
  orchestratorScript: string;
  maxCycles: number;
  phaseTimeoutMs: number;
  idleTimeoutMs: number;
  toolTimeoutMs: number;
  pollIntervalMs: number;
  transportTimeoutMs: number;
  maxAgentAttempts: number;
  retryBackoffMs: number[];
  terminationGraceMs: number;
  killTimeoutMs: number;
  heartbeatIntervalMs: number;
  leaseTtlMs: number;
  maxInMemoryOutputBytes: number;
}

export interface LoopPathsConfig {
  sessionsRoot: string;
  registryFileName: string;
  sessionsIndexFileName: string;
  variantsConfigFileName: string;
  loopHistoryDirName: string;
  controlDirName: string;
  ownerLockFileName: string;
  stateLockFileName: string;
  leaseFileName: string;
  registryLockFileName: string;
  attemptLogsDirName: string;
  sessionFileNames: {
    state: string;
    progressNotes: string;
    finalSummary: string;
    plan: string;
    planChoices: string;
    planOverview: string;
    planOptionsDir: string;
    interruptMessage: string;
    stopRequest: string;
  };
  roomFileNames: {
    state: string;
    skills: string;
    input: string;
    output: string;
  };
  roomDirNames: Record<string, string>;
}

export interface LoopConfig {
  paths: LoopPathsConfig;
  cliProfiles?: Record<string, { defaultBinary: string; modelsArgs: string[] }>;
  providers?: Record<string, ProviderConfig>;
  toolAccess?: ToolAccessConfig;
  variantDefaults?: Record<string, string[]>;
}

export interface SystemSettings {
  providers: Record<string, ProviderConfig>;
  toolAccess: ToolAccessConfig;
  pipeline: PipelineDefinition;
}

function defaultLoopPaths(): LoopPathsConfig {
  return {
    sessionsRoot: ".goal/sessions",
    registryFileName: "sessions_registry.json",
    sessionsIndexFileName: "sessions_index.json",
    variantsConfigFileName: "model_variants.json",
    loopHistoryDirName: "loop_history",
    controlDirName: "control",
    ownerLockFileName: "session_owner.lock",
    stateLockFileName: "state_write.lock",
    leaseFileName: "session_lease.json",
    registryLockFileName: "registry.lock",
    attemptLogsDirName: "attempt_logs",
    sessionFileNames: {
      state: "run_projection.json",
      progressNotes: "progress_notes.txt",
      finalSummary: "final_summary.json",
      plan: "plan.md",
      planChoices: "plan_choices.json",
      planOverview: "plan_options.md",
      planOptionsDir: "plan_options",
      interruptMessage: "interrupt_message.txt",
      stopRequest: "stop_request.txt",
    },
    roomFileNames: {
      state: "state.json",
      skills: "skills.json",
      input: "input.json",
      output: "output.json",
    },
    roomDirNames: {
      planner: "0_planner",
      implementer: "1_implementer",
      tester: "2_tester",
      qa_lead: "3_qa_lead",
      master: "4_master",
      interrupter: "5_interrupter",
    },
  };
}

export async function loadLoopPathsConfig(rootDir: string): Promise<LoopPathsConfig> {
  const cfgPath = path.join(rootDir, "loop_config.json");
  const defaults = defaultLoopPaths();
  try {
    const raw = await fs.readFile(cfgPath, "utf-8");
    const cfg = JSON.parse(raw) as Partial<LoopConfig>;
    if (cfg.paths) {
      return validateLoopPathsConfig({
        ...defaults,
        ...cfg.paths,
        sessionFileNames: {
          ...defaults.sessionFileNames,
          ...cfg.paths.sessionFileNames,
        },
        roomFileNames: {
          ...defaults.roomFileNames,
          ...cfg.paths.roomFileNames,
        },
        roomDirNames: {
          ...defaults.roomDirNames,
          ...cfg.paths.roomDirNames,
        },
      } as LoopPathsConfig);
    }
    return validateLoopPathsConfig(defaults);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return validateLoopPathsConfig(defaults);
    }
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to load Agent Loop paths from ${cfgPath}: ${reason}`);
  }
}

export async function loadLoopVariantDefaults(rootDir: string): Promise<Record<string, string[]>> {
  const cfgPath = path.join(rootDir, "loop_config.json");
  try {
    const raw = await fs.readFile(cfgPath, "utf-8");
    const cfg = JSON.parse(raw) as Partial<LoopConfig>;
    return cfg.variantDefaults ?? {};
  } catch {
    return {};
  }
}

export async function loadCliProfilesConfig(rootDir: string): Promise<Record<string, { defaultBinary: string; modelsArgs: string[] }>> {
  const cfgPath = path.join(rootDir, "loop_config.json");
  try {
    const raw = await fs.readFile(cfgPath, "utf-8");
    const cfg = JSON.parse(raw) as Partial<LoopConfig>;
    return cfg.cliProfiles ?? {};
  } catch {
    return {};
  }
}

function normalizePathSetting(value: string | undefined): string {
  if (!value) return "";
  let v = value.trim();
  // Strip surrounding quotes that users often paste in (e.g. "C:\path" or 'C:\path').
  while (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    v = v.slice(1, -1).trim();
  }
  return v;
}

export function readExtensionConfig(): ExtensionConfig {
  const cfg = vscode.workspace.getConfiguration("agentLoop");
  const cliProfile = cfg.get<string>("cliProfile", "opencode").trim();
  const cliBinary = cfg.get<string>("cliBinary", "opencode").trim();
  const result: ExtensionConfig = {
    cliBinary,
    cliProfile,
    rootDir: normalizePathSetting(cfg.get<string>("rootDir", "")),
    nodeBinary: normalizePathSetting(cfg.get<string>("nodeBinary", "node")) || "node",
    orchestratorScript: normalizePathSetting(cfg.get<string>("orchestratorScript", "")),
    maxCycles: cfg.get<number>("maxCycles", runtimeDefaults.maxCycles),
    phaseTimeoutMs: cfg.get<number>("phaseTimeoutMs", runtimeDefaults.phaseTimeoutMs),
    idleTimeoutMs: cfg.get<number>("idleTimeoutMs", runtimeDefaults.idleTimeoutMs),
    toolTimeoutMs: cfg.get<number>("toolTimeoutMs", runtimeDefaults.toolTimeoutMs),
    pollIntervalMs: cfg.get<number>("pollIntervalMs", runtimeDefaults.pollIntervalMs),
    transportTimeoutMs: cfg.get<number>("transportTimeoutMs", runtimeDefaults.transportTimeoutMs),
    maxAgentAttempts: cfg.get<number>("maxAgentAttempts", runtimeDefaults.maxAgentAttempts),
    retryBackoffMs: cfg.get<number[]>("retryBackoffMs", [...runtimeDefaults.retryBackoffMs]),
    terminationGraceMs: cfg.get<number>("terminationGraceMs", runtimeDefaults.terminationGraceMs),
    killTimeoutMs: cfg.get<number>("killTimeoutMs", runtimeDefaults.killTimeoutMs),
    heartbeatIntervalMs: cfg.get<number>("heartbeatIntervalMs", runtimeDefaults.heartbeatIntervalMs),
    leaseTtlMs: cfg.get<number>("leaseTtlMs", runtimeDefaults.leaseTtlMs),
    maxInMemoryOutputBytes: cfg.get<number>("maxInMemoryOutputBytes", runtimeDefaults.maxInMemoryOutputBytes),
  };
  validateExtensionConfig(result);
  return result;
}

export function validateExtensionConfig(config: ExtensionConfig): void {
  const positive = [
    config.maxCycles,
    config.phaseTimeoutMs,
    config.idleTimeoutMs,
    config.toolTimeoutMs,
    config.pollIntervalMs,
    config.transportTimeoutMs,
    config.maxAgentAttempts,
    config.terminationGraceMs,
    config.killTimeoutMs,
    config.heartbeatIntervalMs,
    config.leaseTtlMs,
    config.maxInMemoryOutputBytes,
  ];
  if (positive.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    throw new Error("All Agent Loop numeric settings must be positive integers.");
  }
  if (
    config.transportTimeoutMs > config.phaseTimeoutMs ||
    config.idleTimeoutMs > config.phaseTimeoutMs ||
    config.toolTimeoutMs > config.phaseTimeoutMs
  ) {
    throw new Error(
      "transportTimeoutMs, idleTimeoutMs, and toolTimeoutMs must not exceed phaseTimeoutMs."
    );
  }
  if (config.heartbeatIntervalMs >= config.leaseTtlMs) {
    throw new Error("heartbeatIntervalMs must be smaller than leaseTtlMs.");
  }
  if (
    config.retryBackoffMs.length < config.maxAgentAttempts - 1 ||
    config.retryBackoffMs.some((value) => !Number.isSafeInteger(value) || value <= 0)
  ) {
    throw new Error("retryBackoffMs must contain positive delays for every retry.");
  }
}
