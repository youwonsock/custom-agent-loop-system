#!/usr/bin/env node

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process";
import * as fse from "fs-extra";
import {
  AgentAttemptState,
  AttemptFailure,
  ClaimedControlRequest,
  ControlQueuePaths,
  FailureKind,
  SessionOwnership,
  SessionOwnershipAcquireResult,
  assertSafeSessionId,
  backupFileOnce,
  checkProcessLiveness,
  claimNextControlRequest,
  collectRecoveredChildPids,
  completeControlRequest,
  createId,
  ensureControlQueue,
  getControlQueuePaths,
  importLegacyControlFiles,
  recoverClaimedControlRequests,
  resolveContainedSessionPath,
  withShortFileLock,
} from "./resilience";
import {
  ProcessSupervisor,
  terminateProcessTreeBounded,
} from "./process_supervisor";
import {
  BuiltinModelRole,
  PipelineCompletionContract,
  PipelineDefinition,
  PipelineRole,
  PipelineStage,
  PipelineStageExecutor,
  PipelineStageType,
  defaultAgentLoopDefinition,
  defaultAgentRolesDefinition,
  defaultPipelineDefinition,
  executorForStage,
  loadPipelineDefinition,
  loadSeparatedPipelineDefinition,
  roleForStage,
  stageById,
  stageTypeForStage,
  validatePipeline,
} from "./pipeline";
import { AgentAttemptRunner } from "./agent_attempt_runner";
import {
  ProviderConfig,
  McpServerConfig,
  ToolAccessConfig,
  buildProviderInvocation,
  claudeMcpDocument,
  collectMcpSensitiveValues,
  enabledMcpServers,
  normalizeProviders,
  resolveMcpServerSecrets,
  validateToolAccess,
} from "./provider_runtime";
import {
  ConvergenceState,
  RequirementEvidenceRecord,
  RequirementLedger,
  advanceConvergence,
  deriveRequirementLedger,
  evaluateRequirementCoverage,
  latestRequirementStatuses,
  parseRequirementEvidence,
} from "./requirement_ledger";
import {
  LoopConfig,
  getDefaultConfig,
  loadLoopConfig,
} from "./runtime_config";
export {
  advanceConvergence,
  deriveRequirementLedger,
  evaluateRequirementCoverage,
  parseRequirementEvidence,
} from "./requirement_ledger";

const CORE_SECRET_VALUES_ENV = "AGENT_LOOP_SECRET_VALUES";

function consumeCoreSecretValues(): Record<string, string> {
  const raw = process.env[CORE_SECRET_VALUES_ENV];
  delete process.env[CORE_SECRET_VALUES_ENV];
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("secret bundle must be an object");
    }
    const values: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== "string") throw new Error(`secret '${key}' is not a string`);
      values[key] = value;
    }
    return values;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid Agent Loop secret bundle: ${reason}`);
  }
}

const CORE_SECRET_VALUES = consumeCoreSecretValues();

function resolveCmdToExe(cmdPath: string): string {
  try {
    const content = fs.readFileSync(cmdPath, "utf8");
    const cmdDir = path.dirname(cmdPath);
    const exeMatch = content.match(/"%dp0%\\([^"]+\.exe)"/i);
    if (exeMatch) {
      const resolved = path.join(cmdDir, exeMatch[1]);
      if (fs.existsSync(resolved)) return resolved;
    }
  } catch {
    // ignore read errors
  }
  return cmdPath;
}

function resolveBinaryOnWindows(binary: string): string {
  if (process.platform !== "win32") return binary;
  if (path.extname(binary).length > 0) return binary;
  if (path.isAbsolute(binary) && fs.existsSync(binary)) return binary;
  if (binary.toLowerCase() === "codex") {
    const architecture = process.arch === "arm64"
      ? { packageName: "codex-win32-arm64", target: "aarch64-pc-windows-msvc" }
      : { packageName: "codex-win32-x64", target: "x86_64-pc-windows-msvc" };
    const bundledCodex = path.resolve(
      __dirname,
      "..",
      "node_modules",
      "@openai",
      architecture.packageName,
      "vendor",
      architecture.target,
      "bin",
      "codex.exe"
    );
    if (fs.existsSync(bundledCodex)) return bundledCodex;
  }
  const pathExt = process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD;.VBS;.JS;.WS;.MSC";
  const extensions = pathExt.split(";").filter((e) => e.length > 0);
  const pathDirs = (process.env.PATH || "").split(path.delimiter).filter((d) => d.length > 0);
  for (const dir of pathDirs) {
    for (const ext of extensions) {
      const candidate = path.join(dir, binary + ext);
      try {
        if (fs.existsSync(candidate)) {
          const extLower = ext.toLowerCase();
          if (extLower === ".cmd" || extLower === ".bat") {
            const resolved = resolveCmdToExe(candidate);
            if (resolved !== candidate) return resolved;
          }
          return candidate;
        }
      } catch {
        // ignore inaccessible entries
      }
    }
  }
  return binary;
}

type AnyObj = Record<string, unknown>;

enum LoopStatus {
  RUNNING = "RUNNING",
  PAUSED = "PAUSED",
  WAITING_USER = "WAITING_USER",
  RECOVERING = "RECOVERING",
  STOPPED = "STOPPED",
  BLOCKED = "BLOCKED",
  SUCCESS = "SUCCESS",
  FAILED = "FAILED",
}

type AgentRole = string;
type AccessMode = "ask" | "full_access";

interface PendingAccessRequest {
  requestId: string;
  requestedPaths: string[];
  requestedAt: string;
  sourcePhase: string;
  reason: string;
}

interface ModelMapping {
  [role: string]: string;
  planner: string;
  implementer: string;
  tester: string;
  qa_lead: string;
  master: string;
  interrupter: string;
}

type VariantMapping = Partial<Record<AgentRole, string>>;

interface ErrorSignature {
  signature: string;
  rawMessage: string;
  timestamp: number;
  phase: string;
}

interface AgentState {
  status: "idle" | "running" | "retry_wait" | "completed" | "failed";
  lastExitCode: number | null;
  lastRunAt: string | null;
}

interface LoopState {
  stateVersion: 2;
  sessionId: string;
  status: LoopStatus;
  phase: string;
  loopCount: number;
  completedIterations: number;
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
  pipelineConfigPath: string | null;
  stageResults: Record<string, StageResultState>;
  requirements: RequirementLedger;
  convergence: ConvergenceState;
}

interface AutomaticRecoveryState {
  sourcePhase: string;
  failureKind: FailureKind;
  cycle: number;
  maxCycles: number;
  resumeAt: string;
  reason: string;
}

interface StageResultState {
  stageId: string;
  role: string;
  kind: string;
  executor?: PipelineStageExecutor;
  completedAt: string;
  output: string;
  verdict: "PASS" | "FAIL" | "APPROVED" | "REJECTED" | null;
  attemptId: string | null;
}

interface ResilienceSettings {
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

interface PlanChoice {
  id: number;
  title: string;
  body: string;
  markdownPath?: string;
}

interface SessionMeta {
  sessionId: string;
  goal: string;
  targetProjectPath: string;
  status: LoopStatus;
  createdAt: string;
}

interface SessionRegistry {
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

interface ProviderCatalogEntry {
  id: string;
  label: string;
  adapter: ProviderConfig["adapter"];
  binary: string;
  enabled: boolean;
  available: boolean;
  models: string[];
  modelLabels?: Record<string, string>;
  modelVariants?: Record<string, string[]>;
  discoveredAt: string | null;
  error: string | null;
}

function cliProfileFromConfig(config: LoopConfig, profileName: string, binaryLower: string): CliProfile {
  const profileCfg = config.cliProfiles[profileName] || config.cliProfiles[binaryLower];
  if (profileCfg) {
    return {
      name: profileName || binaryLower,
      defaultBinary: profileCfg.defaultBinary,
      modelsArgs: profileCfg.modelsArgs,
      interactionWhitelist: profileCfg.interactionWhitelist,
    };
  }
  return CLI_PROFILES[profileName] ?? CLI_PROFILES[binaryLower] ?? OPENCODE_PROFILE;
}

interface HandoffPayload {
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

export interface ReferenceIdentity {
  title: string;
  creator: string;
  packageId: string;
  canonicalUrl: string;
  candidateCount: number;
  identityMatch: "EXACT" | "AMBIGUOUS" | "SIMILAR" | "UNKNOWN";
  confidence: "HIGH" | "MEDIUM" | "LOW";
}

interface AttemptEvidenceSummary {
  attemptId: string | null;
  attemptNumber: number | null;
  result: LoopHistoryEntry["result"];
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

interface FailureEvidenceSummary {
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

interface AgentSkills {
  role: AgentRole;
  allowedTools: string[];
  enforcedRules: string[];
  systemPrompt: string;
}

interface AgentRoom {
  role: AgentRole;
  statePath: string;
  skillsPath: string;
  inputPayloadPath: string;
  outputPayloadPath: string;
}

interface LoopHistoryEntry {
  loopNumber: number;
  phase: string;
  agentRole: AgentRole;
  model: string;
  exitCode: number;
  startedAt: string;
  endedAt: string;
  output: string;
  result: "success" | "failure" | "timeout";
  signature: string | null;
  interruptMessage: string | null;
  attemptId?: string | null;
  attemptNumber?: number | null;
  failureKind?: FailureKind | null;
  rawLogPath?: string | null;
  rawLogBytes?: number | null;
  assistantTextBytes?: number | null;
  eventCount?: number | null;
  lastEventType?: string | null;
  lastToolName?: string | null;
  lastToolStatus?: string | null;
  lastToolCommand?: string | null;
  lastStepFinishReason?: string | null;
  lastStepFinishTotalTokens?: number | null;
  maxObservedTotalTokens?: number | null;
}

function resilienceSettingsFromConfig(): ResilienceSettings {
  return {
    transportTimeoutMs: loopConfig.defaults.transportTimeoutMs,
    toolTimeoutMs: loopConfig.defaults.toolTimeoutMs,
    maxAgentAttempts: loopConfig.defaults.maxAgentAttempts,
    maxCompletionRecoveryAttempts: loopConfig.defaults.maxCompletionRecoveryAttempts,
    maxAutomaticRecoveryCycles: loopConfig.defaults.maxAutomaticRecoveryCycles,
    automaticRecoveryBackoffMs: [...loopConfig.defaults.automaticRecoveryBackoffMs],
    retryBackoffMs: [...loopConfig.defaults.retryBackoffMs],
    phaseRecoveryBudgetMs: loopConfig.defaults.phaseRecoveryBudgetMs,
    terminationGraceMs: loopConfig.defaults.terminationGraceMs,
    killTimeoutMs: loopConfig.defaults.killTimeoutMs,
    heartbeatIntervalMs: loopConfig.defaults.heartbeatIntervalMs,
    leaseTtlMs: loopConfig.defaults.leaseTtlMs,
    maxInMemoryOutputBytes: loopConfig.defaults.maxInMemoryOutputBytes,
  };
}

interface FinalSummary {
  sessionId: string;
  goal: string;
  achievedAt: string;
  totalLoops: number;
  finalModelMapping: ModelMapping;
  progressNotes: string;
  approvedByMaster: boolean;
}

interface PtyRunResult {
  pid: number;
  exitCode: number;
  output: string;
  events: AnyObj[];
  timedOut: boolean;
  cancelled: boolean;
  autoInjected: { prompt: string; response: string; timestamp: string }[];
  outcome?: AgentAttemptState["status"];
  failureKind?: FailureKind | null;
  failureMessage?: string | null;
  assistantText?: string;
  cliSessionId?: string | null;
  rawLogPath?: string;
  controlRequest?: ClaimedControlRequest | null;
}

class StopRequestedError extends Error {
  constructor() {
    super("Stop requested");
    this.name = "StopRequestedError";
  }
}

class InterruptRequestedError extends Error {
  constructor(readonly messageText: string | null) {
    super("Interrupt requested");
    this.name = "InterruptRequestedError";
  }
}

class AgentRetriesExhaustedError extends Error {
  constructor(
    readonly role: AgentRole,
    readonly failure: AttemptFailure
  ) {
    super(`${role} exhausted its retry budget: ${failure.kind}: ${failure.message}`);
    this.name = "AgentRetriesExhaustedError";
  }
}

class ImplementationPreflightError extends Error {
  constructor(
    readonly failure: AttemptFailure,
    readonly outsidePaths: string[]
  ) {
    super(failure.message);
    this.name = "ImplementationPreflightError";
  }
}

const SENTINEL = "[PHASE_DONE]";
const MAX_RETAINED_HISTORY_FILES = 250;
const MAX_RETAINED_ATTEMPT_LOGS = 50;
const MAX_HISTORY_OUTPUT_BYTES = 512 * 1024;

function boundedHistoryOutput(value: string): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= MAX_HISTORY_OUTPUT_BYTES) return value;
  const marker = "\n[AGENT_LOOP_HISTORY_OUTPUT_TRUNCATED]\n";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const headBytes = Math.floor((MAX_HISTORY_OUTPUT_BYTES - markerBytes) / 4);
  const tailBytes = MAX_HISTORY_OUTPUT_BYTES - markerBytes - headBytes;
  const head = bytes.subarray(0, headBytes).toString("utf8").replace(/\uFFFD$/, "");
  const tail = bytes.subarray(bytes.length - tailBytes).toString("utf8").replace(/^\uFFFD/, "");
  return `${head}${marker}${tail}`;
}

const INTERACTION_WHITELIST: string[] = [
  "Apply changes? [y/n]",
  "Apply changes? (y/n)",
  "Continue? [y/n]",
  "Continue? (y/n)",
  "Proceed? [y/n]",
  "Proceed? (y/n)",
  "Allow? [y/n]",
  "Allow? (y/n)",
  "Overwrite? [y/n]",
  "Confirm? [y/n]",
  "Do you want to continue? [y/n]",
  "Do you want to apply",
];

interface CliProfile {
  name: string;
  defaultBinary: string;
  modelsArgs: string[];
  interactionWhitelist: string[];
}

const OPENCODE_PROFILE: CliProfile = {
  name: "opencode",
  defaultBinary: "opencode",
  modelsArgs: ["models"],
  interactionWhitelist: INTERACTION_WHITELIST,
};

const KILO_PROFILE: CliProfile = {
  name: "kilo",
  defaultBinary: "kilo",
  modelsArgs: ["models", "--pure"],
  interactionWhitelist: [
    ...INTERACTION_WHITELIST,
    "Action Required",
    "Run Command (y)",
    "Allow (y)",
  ],
};

const CODEX_PROFILE: CliProfile = {
  name: "codex",
  defaultBinary: "codex",
  modelsArgs: [],
  interactionWhitelist: INTERACTION_WHITELIST,
};

const CLAUDE_PROFILE: CliProfile = {
  name: "claude",
  defaultBinary: "claude",
  modelsArgs: [],
  interactionWhitelist: INTERACTION_WHITELIST,
};

const CLI_PROFILES: Record<string, CliProfile> = {
  opencode: OPENCODE_PROFILE,
  kilo: KILO_PROFILE,
  codex: CODEX_PROFILE,
  claude: CLAUDE_PROFILE,
};

function resolveCliProfile(profileName: string | null, binaryName: string): CliProfile {
  const lower = binaryName.toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, "");
  if (profileName && CLI_PROFILES[profileName]) {
    const builtin = CLI_PROFILES[profileName];
    if (lower !== builtin.defaultBinary && lower !== builtin.name && CLI_PROFILES[lower]) {
      return cliProfileFromConfig(loopConfig, profileName, lower);
    }
    return cliProfileFromConfig(loopConfig, profileName, lower);
  }
  if (CLI_PROFILES[lower]) {
    return cliProfileFromConfig(loopConfig, profileName ?? lower, lower);
  }
  return OPENCODE_PROFILE;
}

async function loadModelVariantsConfig(rootDir: string): Promise<Record<string, string[]> | null> {
  const cfgPath = path.join(rootDir, loopConfig.paths.variantsConfigFileName);
  try {
    const raw = await fse.readFile(cfgPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("the root value must be an object");
    }
    const normalized: Record<string, string[]> = {};
    for (const [model, variants] of Object.entries(parsed as Record<string, unknown>)) {
      if (!model.trim() || !Array.isArray(variants) || variants.some((value) => typeof value !== "string" || !value)) {
        throw new Error(`invalid variant list for model '${model}'`);
      }
      normalized[model] = [...new Set(variants)];
    }
    return normalized;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to load ${cfgPath}: ${reason}`);
  }
}

let loopConfig: LoopConfig = getDefaultConfig();

const DEFAULT_SKILLS: Record<AgentRole, AgentSkills> = {
  planner: {
    role: "planner",
    allowedTools: ["read", "glob", "grep", "bash", "webfetch"],
    enforcedRules: [
      "Read and research only. Do NOT create, modify, move, or delete files.",
      "Extract every explicit user requirement into an acceptance checklist before choosing implementation details.",
      "Separate mandatory acceptance requirements from optional design choices and unresolved ambiguity.",
      "Output exactly 3 numbered alternative implementation plans in the format below.",
      "Each option must cover the entire acceptance checklist and state approach, affected files, ordered steps, verification, and risks.",
      "Do not claim that implementation or verification has already succeeded.",
      "Treat every clause of the original user goal as an acceptance requirement; a plan may choose an approach but may not redefine the requested product.",
      "For named reference products, use source-supported gameplay facts and explicitly identify uncertainties instead of substituting an assumed genre.",
      "If a required decision cannot be established from the project or required research, use RESEARCH_BLOCKED or identify the exact operator decision instead of guessing.",
    ],
    systemPrompt: `Act only as a planner. Inspect the target and required sources, derive a requirement checklist, and produce exactly 3 distinct implementation strategies. Do not implement any option.

Output MUST follow this format EXACTLY:

=== PLAN OPTIONS ===
## OPTION 1: <short descriptive title>
<requirement coverage, approach, files, ordered steps, verification, risks>

## OPTION 2: <short descriptive title>
<requirement coverage, approach, files, ordered steps, verification, risks>

## OPTION 3: <short descriptive title>
<requirement coverage, approach, files, ordered steps, verification, risks>

Each option must be complete and independently selectable. Vary a material implementation decision, not merely wording. End after OPTION 3.`,
  },
  implementer: {
    role: "implementer",
    allowedTools: ["read", "write", "edit", "glob", "grep", "bash"],
    enforcedRules: [
      "Do NOT run destructive git commands (git clean, git checkout --, git reset --hard).",
      "Inspect existing files and prior work before editing; continue cumulatively instead of recreating completed work.",
      "Only modify files within the write-access roots supplied by the orchestrator.",
      "If a failure digest is provided, address the specific failures described.",
      "Implement both the original user goal and the approved plan; if they conflict, preserve the original goal and report the plan defect.",
      "Map each production change to an original acceptance requirement; do not add unrelated features or replace a locked reference product.",
      "Do not weaken, delete, skip, or rewrite tests merely to make a failing implementation pass.",
      "Run focused syntax, build, or smoke checks appropriate to the changed files before completing the phase.",
      "Report changed files, checks actually run, and unresolved blockers; never report a check as passed unless it executed successfully.",
    ],
    systemPrompt: "Act only as the implementer. Inspect current state, implement production changes that satisfy the original acceptance requirements using the approved plan as strategy, and run focused checks. Preserve valid existing work. Do not make the final QA or approval decision.",
  },
  tester: {
    role: "tester",
    allowedTools: ["read", "write", "edit", "glob", "grep", "bash"],
    enforcedRules: [
      "Review the implementation the implementer just produced (read the changed files).",
      "Derive tests independently from every original acceptance requirement and the locked reference identity, not only from implementation structure.",
      "You may write test files and run them with your bash tool to actually execute the tests.",
      "If test files already exist, run them before creating or expanding any test harness.",
      "Keep file reads and command output focused; do not dump entire large files when targeted reads are enough.",
      "Reserve the final response for the test verdict and completion token even when some tests fail.",
      "Cover the user-visible path plus relevant happy paths, failures, and boundaries; mocks or internal-only checks cannot replace acceptance behavior.",
      "Do NOT modify production source code. Only create or update test files.",
      "A blocked, skipped, not-run, or inconclusive required check must produce VERDICT: FAIL with the reason.",
      "Report commands actually executed and their observed results; never infer a passing result from files merely existing.",
      "End with an independent verdict line beginning 'VERDICT: PASS' or 'VERDICT: FAIL'; a concise reason may follow on that same line.",
    ],
    systemPrompt: "Act only as the tester. Run existing tests first, add only the smallest missing test coverage, and execute representative user-visible acceptance checks. You may edit tests but never production code. Conclude from observed evidence with VERDICT: PASS or VERDICT: FAIL.",
  },
  qa_lead: {
    role: "qa_lead",
    allowedTools: ["read", "glob", "grep", "bash"],
    enforcedRules: [
      "Read and execute non-mutating checks only. Do NOT create, modify, move, or delete files.",
      "Independently inspect representative production code and rerun critical checks; do not merely restate the tester's verdict.",
      "Audit test integrity: reject empty, skipped, tautological, mock-only, or implementation-shaped tests that do not prove acceptance behavior.",
      "Cross-check every original requirement and the locked reference identity against concrete implementation and runtime evidence.",
      "Use the original user goal as the authoritative acceptance contract; reject plan-compliant work that changes or omits the requested behavior.",
      "Missing, blocked, stale, or contradictory evidence requires REJECTED. Do not issue APPROVED with unresolved caveats.",
      "End with an independent line beginning APPROVED or REJECTED; a concrete reason may follow on that same line.",
    ],
    systemPrompt: "Act only as the independent QA lead. Audit implementation, test integrity, and requirement coverage using read-only inspection and non-mutating checks. Approve only when the evidence proves the original goal; otherwise reject with concrete defects.",
  },
  master: {
    role: "master",
    allowedTools: ["read", "glob", "grep", "bash"],
    enforcedRules: [
      "Read and execute non-mutating checks only. Do NOT create, modify, move, or delete files.",
      "Perform a fresh final acceptance audit against each clause of the original goal and the locked reference identity.",
      "Do not approve merely because the implementation matches the approved plan; independently compare every original requirement.",
      "Independently exercise the most important user-visible success path rather than relying solely on prior summaries.",
      "Partial, unverified, ambiguous, blocked, or caveated completion requires REJECTED.",
      "Do not repair the implementation or tests in this stage; return precise rejection evidence for the next implementation cycle.",
      "End with an independent line beginning APPROVED or REJECTED; specific feedback may follow on that same line.",
    ],
    systemPrompt: "Act only as the final acceptance gate. Re-evaluate the original goal from user-visible evidence, independently sample the critical path, and issue APPROVED only when every mandatory requirement is proven. Otherwise issue REJECTED with actionable evidence.",
  },
  interrupter: {
    role: "interrupter",
    allowedTools: ["read", "glob", "grep"],
    enforcedRules: [
      "Read only. Do NOT create, modify, move, or delete files and do not continue implementation or testing.",
      "Summarize the exact repeated failure or stagnation signature and recommend the smallest course correction that can break it.",
      "Be concise and actionable for the human operator.",
      "Treat the structured attempt evidence as authoritative. Never contradict its attempt counts, byte counts, event types, or completed tool status.",
      "Do not claim that a permission prompt, zero output, or a pending tool caused the failure unless the structured evidence explicitly supports it.",
      "Do not describe an exitCode 0 incomplete response as a transport teardown unless the evidence also reports a transport failure.",
      "A missing completion token is not proof that deliverables or tests are complete; distinguish files written from tests actually executed.",
      "When accessMode is full_access, outside-target path lists are diagnostic only and must not be described as a blocking path conflict without an explicit permission failure.",
      "Clearly label any root-cause conclusion not directly proven by the evidence as a hypothesis.",
      "Do not declare the user goal complete; this role diagnoses the pause and identifies the operator action required to resume safely.",
    ],
    systemPrompt: "Act only as the failure interrupter. Using authoritative attempt evidence, separate verified facts from hypotheses, identify the repeated token-wasting pattern, and provide the minimum concrete operator action needed to break it. Do not edit or resume the work.",
  },
};

function parsePlanChoices(output: string): PlanChoice[] {
  const marker = "=== PLAN OPTIONS ===";
  const idx = output.indexOf(marker);
  const section = idx >= 0 ? output.slice(idx + marker.length) : output;

  const choices: PlanChoice[] = [];
  const regex = /^## OPTION\s+(\d+):\s*(.+)$/gm;
  const matches: { index: number; id: number; title: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = regex.exec(section)) !== null) {
    matches.push({ index: m.index, id: parseInt(m[1], 10), title: m[2].trim() });
  }

  if (matches.length === 0) {
    choices.push({ id: 1, title: "Plan", body: output.trim() });
    return choices;
  }

  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index + matches[i].title.length + ("## OPTION ?: ".length + String(matches[i].id).length);
    const end = i + 1 < matches.length ? matches[i + 1].index : section.length;
    const body = section.slice(start, end).trim();
    choices.push({ id: matches[i].id, title: matches[i].title, body });
  }

  return choices;
}

export async function materializePlanChoiceMarkdown(
  sessionDir: string,
  choices: PlanChoice[],
  overviewFileName = "plan_options.md",
  optionsDirName = "plan_options"
): Promise<{ choices: PlanChoice[]; overviewPath: string }> {
  const resolvePlanPath = (candidate: string): string => {
    const root = path.resolve(sessionDir);
    const resolved = path.resolve(root, candidate);
    const relative = path.relative(root, resolved);
    if (
      relative.length === 0 ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error(`Plan document path escapes the session directory: ${candidate}`);
    }
    return resolved;
  };

  const optionsDir = resolvePlanPath(optionsDirName);
  await fse.ensureDir(optionsDir);
  const enriched = choices.map((choice) => {
    const fileName = `option_${choice.id}.md`;
    const optionPath = resolvePlanPath(path.join(optionsDirName, fileName));
    return {
      ...choice,
      markdownPath: path.relative(sessionDir, optionPath),
    };
  });

  await Promise.all(
    enriched.map((choice) =>
      atomicWriteText(
        path.join(sessionDir, choice.markdownPath!),
        `# Plan Option ${choice.id}: ${choice.title}\n\n${choice.body.trim()}\n`
      )
    )
  );

  const overview = [
    "# Plan Options",
    "",
    "> Read the plans in this editor. Select the preferred option from the Agent Loop sidebar.",
    "",
    ...enriched.flatMap((choice) => {
      const markdownLink = choice.markdownPath!.split(path.sep).join("/");
      return [
        `## Option ${choice.id}: ${choice.title}`,
        "",
        `[Open this option as a separate document](./${markdownLink})`,
        "",
        choice.body.trim(),
        "",
        "---",
        "",
      ];
    }),
  ].join("\n");
  const overviewPath = resolvePlanPath(overviewFileName);
  await atomicWriteText(overviewPath, `${overview.trim()}\n`);
  return { choices: enriched, overviewPath };
}

async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  await fse.ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString("hex")}`;
  const jsonStr = JSON.stringify(data, null, 2);
  await fse.writeFile(tmpPath, jsonStr, "utf8");
  await renameWithRetry(tmpPath, filePath);
}

async function atomicWriteSensitiveJson(filePath: string, data: unknown): Promise<void> {
  await fse.ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString("hex")}`;
  try {
    await fse.writeFile(tmpPath, JSON.stringify(data, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    await renameWithRetry(tmpPath, filePath);
    await fse.chmod(filePath, 0o600).catch(() => {});
  } catch (err) {
    await fse.remove(tmpPath).catch(() => {});
    throw err;
  }
}

const CLAUDE_MCP_RUNTIME_FILE_PATTERN =
  /^claude_mcp_[A-Za-z0-9_-]+\.json(?:\.tmp\.\d+\.\d+\.[a-f0-9]{8})?$/;

export async function cleanupClaudeMcpRuntimeFiles(runtimeDir: string): Promise<void> {
  let stat: fs.Stats;
  try {
    stat = await fse.lstat(runtimeDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Unsafe Claude MCP runtime directory: ${runtimeDir}`);
  }
  const entries = await fse.readdir(runtimeDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !CLAUDE_MCP_RUNTIME_FILE_PATTERN.test(entry.name)) continue;
    await fse.remove(path.join(runtimeDir, entry.name));
  }
}

function runtimeSensitiveValues(runtimeMcpServers: readonly McpServerConfig[]): string[] {
  return [...new Set([
    ...Object.values(CORE_SECRET_VALUES),
    ...collectMcpSensitiveValues(runtimeMcpServers),
  ].filter(Boolean))];
}

async function atomicWriteText(filePath: string, content: string): Promise<void> {
  await fse.ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString("hex")}`;
  await fse.writeFile(tmpPath, content, "utf8");
  await renameWithRetry(tmpPath, filePath);
}

async function renameWithRetry(src: string, dest: string, maxRetries = 5): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      await fse.rename(src, dest);
      return;
    } catch (err: unknown) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EBUSY" || code === "EACCES") {
        await sleep(50 * Math.pow(2, attempt));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function atomicReadJson<T>(filePath: string): Promise<T | null> {
  try {
    const content = await fse.readFile(filePath, "utf8");
    return JSON.parse(content) as T;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    const backupPath = `${filePath}.corrupt.${Date.now()}`;
    try {
      await fse.copy(filePath, backupPath);
      console.error(`[atomicReadJson] Corrupted JSON at ${filePath}. Backed up to ${backupPath}.`);
    } catch {
      console.error(`[atomicReadJson] Corrupted JSON at ${filePath} and backup failed.`);
    }
    return null;
  }
}

interface SessionMetaPatch {
  sessionId: string;
  goal?: string;
  targetProjectPath?: string;
  status?: LoopStatus;
  createdAt?: string;
}

function upsertSessionMeta(registry: SessionRegistry, patch: SessionMetaPatch): void {
  const existing = registry.sessionMetas.find((m) => m.sessionId === patch.sessionId);
  if (existing) {
    if (patch.status !== undefined) existing.status = patch.status;
    if (patch.goal !== undefined) existing.goal = patch.goal;
    if (patch.targetProjectPath !== undefined) existing.targetProjectPath = patch.targetProjectPath;
  } else {
    registry.sessionMetas.push({
      sessionId: patch.sessionId,
      goal: patch.goal ?? "",
      targetProjectPath: patch.targetProjectPath ?? "",
      status: patch.status ?? LoopStatus.RUNNING,
      createdAt: patch.createdAt ?? new Date().toISOString(),
    });
  }
  if (!registry.activeSessionIds.includes(patch.sessionId)) {
    registry.activeSessionIds.push(patch.sessionId);
  }
}

async function reloadRegistry(registryPath: string, fallback: SessionRegistry): Promise<SessionRegistry> {
  const fresh = await atomicReadJson<SessionRegistry>(registryPath);
  return fresh ?? fallback;
}

async function mergeAndWriteSessionMeta(
  registryPath: string,
  fallback: SessionRegistry,
  patch: SessionMetaPatch
): Promise<SessionRegistry> {
  const lockPath = path.join(path.dirname(registryPath), loopConfig.paths.registryLockFileName);
  return withShortFileLock(lockPath, async () => {
    const merged = await reloadRegistry(registryPath, fallback);
    upsertSessionMeta(merged, patch);
    await atomicWriteJson(registryPath, merged);
    return merged;
  });
}

async function mergeAndWriteRegistryFields(
  registryPath: string,
  fallback: SessionRegistry,
  fields: Partial<Pick<SessionRegistry, "availableModels" | "modelsDiscoveredAt" | "modelsDiscoveredCli" | "modelVariants" | "providerCatalog">>
): Promise<SessionRegistry> {
  const lockPath = path.join(path.dirname(registryPath), loopConfig.paths.registryLockFileName);
  return withShortFileLock(lockPath, async () => {
    const merged = await reloadRegistry(registryPath, fallback);
    if (fields.availableModels !== undefined) merged.availableModels = fields.availableModels;
    if (fields.modelsDiscoveredAt !== undefined) merged.modelsDiscoveredAt = fields.modelsDiscoveredAt;
    if (fields.modelsDiscoveredCli !== undefined) merged.modelsDiscoveredCli = fields.modelsDiscoveredCli;
    if (fields.modelVariants !== undefined) merged.modelVariants = fields.modelVariants;
    if (fields.providerCatalog !== undefined) merged.providerCatalog = fields.providerCatalog;
    await atomicWriteJson(registryPath, merged);
    return merged;
  });
}

function resetStaleRunningAgentStates(agentStates: Record<AgentRole, AgentState>): void {
  for (const role of Object.keys(agentStates) as AgentRole[]) {
    if (agentStates[role].status === "running") {
      agentStates[role] = {
        status: "idle",
        lastExitCode: -1,
        lastRunAt: new Date().toISOString(),
      };
    }
  }
}

export function normalizeLoopState(raw: LoopState): { state: LoopState; migrated: boolean } {
  const state = raw as LoopState;
  const requiresLegacyOwnershipBlock = state.stateVersion !== 2;
  let migrated = state.stateVersion !== 2;
  if ((state as unknown as { stateVersion?: number }).stateVersion === undefined) {
    state.stateVersion = 2;
  } else if (state.stateVersion !== 2) {
    if (state.stateVersion > 2) {
      throw new Error(`Unsupported loop state version: ${state.stateVersion}`);
    }
    state.stateVersion = 2;
  }

  if (typeof state.targetProjectPath !== "string" || state.targetProjectPath.trim().length === 0) {
    state.targetProjectPath = process.cwd();
    migrated = true;
  } else if (!isAbsoluteFileSystemPath(state.targetProjectPath)) {
    state.targetProjectPath = path.resolve(state.targetProjectPath);
    migrated = true;
  }

  const rawAllowedPaths = (state as unknown as { additionalAllowedPaths?: unknown }).additionalAllowedPaths;
  const validAllowedPaths = Array.isArray(rawAllowedPaths)
    ? rawAllowedPaths.filter(
        (value): value is string => typeof value === "string" && isAbsoluteFileSystemPath(value.trim())
      )
    : [];
  const normalizedAllowedPaths = normalizeAdditionalAllowedPaths(
    validAllowedPaths,
    state.targetProjectPath
  );
  if (
    !Array.isArray(rawAllowedPaths) ||
    JSON.stringify(rawAllowedPaths) !== JSON.stringify(normalizedAllowedPaths)
  ) {
    state.additionalAllowedPaths = normalizedAllowedPaths;
    migrated = true;
  }
  if (state.accessMode !== "ask" && state.accessMode !== "full_access") {
    state.accessMode = "ask";
    migrated = true;
  }
  if (!Object.prototype.hasOwnProperty.call(state, "pendingAccessRequest")) {
    state.pendingAccessRequest = null;
    migrated = true;
  } else if (
    state.pendingAccessRequest &&
    (!Array.isArray(state.pendingAccessRequest.requestedPaths) ||
      state.pendingAccessRequest.requestedPaths.length === 0)
  ) {
    state.pendingAccessRequest = null;
    migrated = true;
  }

  if (!Object.prototype.hasOwnProperty.call(state, "activeAttempt")) {
    state.activeAttempt = null;
    migrated = true;
  } else if (state.activeAttempt) {
    if (!state.activeAttempt.activity) {
      state.activeAttempt.activity = state.activeAttempt.lastOutputAt
        ? "model_generation"
        : "initial_transport";
      migrated = true;
    }
    if (!state.activeAttempt.mode) {
      state.activeAttempt.mode = "standard";
      migrated = true;
    }
    if (!Number.isFinite(state.activeAttempt.completionRecoveryNumber)) {
      state.activeAttempt.completionRecoveryNumber = 0;
      migrated = true;
    }
  }
  if (!Object.prototype.hasOwnProperty.call(state, "lastFailure")) {
    state.lastFailure = null;
    migrated = true;
  }
  if (
    state.lastFailure &&
    state.lastFailure.kind !== "phase_timeout" &&
    /phase exceeded|progress-renewable phase window|recovery budget deadline/i.test(
      state.lastFailure.message
    )
  ) {
    const previousKind = state.lastFailure.kind;
    state.lastFailure.kind = "phase_timeout";
    state.lastFailure.retryable = true;
    state.lastFailureDigest =
      `[${state.lastFailure.phase ?? state.phase}] phase_timeout: ${state.lastFailure.message}\n` +
      `The previous ${previousKind} label was a classifier error. Inspect existing work and continue cumulatively.`;
    migrated = true;
  }
  if (!Number.isFinite(state.recoveryCount)) {
    state.recoveryCount = 0;
    migrated = true;
  }
  if (!Number.isFinite(state.totalAgentAttempts)) {
    state.totalAgentAttempts = 0;
    migrated = true;
  }
  if (!Object.prototype.hasOwnProperty.call(state, "statusReason")) {
    state.statusReason = null;
    migrated = true;
  }
  if (!Object.prototype.hasOwnProperty.call(state, "automaticRecovery")) {
    state.automaticRecovery = null;
    migrated = true;
  } else if (
    state.automaticRecovery &&
    (!Number.isFinite(state.automaticRecovery.cycle) ||
      !Number.isFinite(state.automaticRecovery.maxCycles) ||
      !Number.isFinite(Date.parse(state.automaticRecovery.resumeAt)))
  ) {
    state.automaticRecovery = null;
    migrated = true;
  }
  if (!Number.isFinite(state.completedIterations)) {
    state.completedIterations = 0;
    migrated = true;
  }
  if (!state.resilience) {
    state.resilience = resilienceSettingsFromConfig();
    migrated = true;
  } else {
    const defaults = resilienceSettingsFromConfig();
    state.resilience = {
      ...defaults,
      ...state.resilience,
      automaticRecoveryBackoffMs:
        Array.isArray(state.resilience.automaticRecoveryBackoffMs) &&
        state.resilience.automaticRecoveryBackoffMs.length > 0
          ? state.resilience.automaticRecoveryBackoffMs
          : defaults.automaticRecoveryBackoffMs,
      retryBackoffMs:
        Array.isArray(state.resilience.retryBackoffMs) && state.resilience.retryBackoffMs.length > 0
          ? state.resilience.retryBackoffMs
          : defaults.retryBackoffMs,
    };
  }
  if (!state.variantMapping) {
    state.variantMapping = {};
    migrated = true;
  }
  if (!state.cliProfile) {
    state.cliProfile = resolveCliProfile(null, state.cliBinary || loopConfig.defaults.cliBinary).name;
    migrated = true;
  }
  if (!state.providerMapping || typeof state.providerMapping !== "object") {
    const fallbackProvider = loopConfig.providers[state.cliProfile]?.enabled ? state.cliProfile : "opencode";
    state.providerMapping = Object.fromEntries(
      Object.keys(state.modelMapping ?? {}).map((role) => [role, fallbackProvider])
    );
    migrated = true;
  }
  if (!state.providerConfigs || typeof state.providerConfigs !== "object") {
    state.providerConfigs = normalizeProviders(loopConfig.providers);
    const legacyProvider = state.providerConfigs[state.cliProfile];
    if (legacyProvider && state.cliBinary) legacyProvider.binary = state.cliBinary;
    migrated = true;
  } else {
    state.providerConfigs = normalizeProviders(state.providerConfigs);
  }
  if (!state.toolAccess) {
    state.toolAccess = validateToolAccess(loopConfig.toolAccess);
    migrated = true;
  } else {
    const normalizedToolAccess = validateToolAccess(state.toolAccess);
    if (JSON.stringify(normalizedToolAccess) !== JSON.stringify(state.toolAccess)) migrated = true;
    state.toolAccess = normalizedToolAccess;
  }
  if (!state.pipeline) {
    state.pipeline = defaultPipelineDefinition();
    state.pipelineConfigPath = null;
    migrated = true;
  } else {
    state.pipeline = validatePipeline(state.pipeline);
    if (!Object.prototype.hasOwnProperty.call(state, "pipelineConfigPath")) {
      state.pipelineConfigPath = null;
      migrated = true;
    }
  }
  if (!state.stageResults) {
    state.stageResults = {};
    migrated = true;
  }
  if (
    !state.requirements ||
    state.requirements.version !== 1 ||
    !Array.isArray(state.requirements.items) ||
    state.requirements.items.length === 0
  ) {
    state.requirements = deriveRequirementLedger(state.goal, state.createdAt);
    migrated = true;
  } else if (!Array.isArray(state.requirements.evidence)) {
    state.requirements.evidence = [];
    migrated = true;
  }
  if (
    !state.convergence ||
    !Number.isFinite(state.convergence.stagnantCycles) ||
    !Array.isArray(state.convergence.history)
  ) {
    state.convergence = { stagnantCycles: 0, history: [] };
    migrated = true;
  }
  if (!Object.prototype.hasOwnProperty.call(state, "referenceIdentity")) {
    state.referenceIdentity = null;
    migrated = true;
  }
  if (!Object.prototype.hasOwnProperty.call(state, "planOverviewPath")) {
    state.planOverviewPath = null;
    migrated = true;
  }
  if (!Object.prototype.hasOwnProperty.call(state, "selectedPlanChoiceId")) {
    state.selectedPlanChoiceId = null;
    migrated = true;
  }
  if (!state.agentStates) {
    state.agentStates = createDefaultAgentStates(state.pipeline);
    migrated = true;
  } else {
    for (const role of Object.keys(createDefaultAgentStates(state.pipeline)) as AgentRole[]) {
      if (!state.agentStates[role]) {
        state.agentStates[role] = { status: "idle", lastExitCode: null, lastRunAt: null };
        migrated = true;
      }
    }
  }

  if (state.status === LoopStatus.PAUSED && state.awaitingPlanApproval) {
    state.status = LoopStatus.WAITING_USER;
    state.statusReason = "Plan approval is required before implementation can start.";
    migrated = true;
  } else if (state.status === LoopStatus.PAUSED && state.pendingAccessRequest) {
    state.status = LoopStatus.WAITING_USER;
    state.statusReason = "Filesystem access approval is required before implementation can continue.";
    migrated = true;
  } else if (state.status === LoopStatus.PAUSED && state.lastFailure?.kind === "orphaned_process") {
    state.status = LoopStatus.BLOCKED;
    state.statusReason = state.lastFailure.message;
    migrated = true;
  } else if (state.status === LoopStatus.PAUSED && state.activeAttempt?.failureKind === "cancelled") {
    state.status = LoopStatus.STOPPED;
    state.statusReason = state.activeAttempt.failureMessage ?? "Session was stopped.";
    migrated = true;
  }

  if (requiresLegacyOwnershipBlock && state.status === LoopStatus.RUNNING) {
    state.status = LoopStatus.BLOCKED;
    state.statusReason = "Legacy RUNNING session has no verifiable ownership lease.";
    resetStaleRunningAgentStates(state.agentStates);
    state.lastFailure = {
      kind: "unknown",
      message: "Legacy RUNNING session migrated without a verifiable ownership lease; manual resume required.",
      retryable: false,
      occurredAt: new Date().toISOString(),
      attemptId: state.activeAttempt?.attemptId ?? null,
      role: state.activeAttempt?.role ?? null,
      phase: state.phase,
      exitCode: state.activeAttempt?.exitCode ?? null,
      cliSessionId: state.activeAttempt?.cliSessionId ?? null,
    };
  }
  return { state, migrated };
}

function createDefaultAgentStates(
  pipeline: PipelineDefinition = defaultPipelineDefinition()
): Record<AgentRole, AgentState> {
  return Object.fromEntries(
    pipeline.roles.map((role) => [
      role.id,
      { status: "idle", lastExitCode: null, lastRunAt: null } satisfies AgentState,
    ])
  );
}

function applyPipelineTarget(state: LoopState, target: string): void {
  if (target === "SUCCESS") {
    state.status = LoopStatus.SUCCESS;
    return;
  }
  if (target === "PAUSED") {
    state.status = LoopStatus.PAUSED;
    return;
  }
  stageById(state.pipeline, target);
  state.phase = target;
}

async function atomicAppendLine(filePath: string, line: string): Promise<void> {
  await fse.ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.append.${process.pid}.${Date.now()}`;
  let existing = "";
  try {
    existing = await fse.readFile(filePath, "utf8");
  } catch {
    existing = "";
  }
  const newline = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  const newContent = existing + newline + line + "\n";
  await fse.writeFile(tmpPath, newContent, "utf8");
  await renameWithRetry(tmpPath, filePath);
}

function stripAnsi(str: string): string {
  return str
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, "")
    .replace(/\x1b[()][AB012]/g, "")
    .replace(/\x1b[=>]/g, "")
    .replace(/[\x00-\x08\x0e-\x1f\x7f]/g, "");
}

function generateSessionId(): string {
  return `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
}

/*
 * Legacy inline PTY runner intentionally disabled. All live execution paths,
 * including plan revision, use the import-safe ProcessSupervisor.
 *
function spawnCliPty(opts: SpawnCliOptions): SpawnHandle {
  const args = opts.cliProfile.buildRunArgs({
    model: opts.model,
    targetProjectPath: opts.targetProjectPath,
    prompt: opts.prompt,
    variant: opts.variant,
    resumeSessionId: opts.resumeSessionId,
  });

  const env: { [key: string]: string } = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  env["AGENT_LOOP_SESSION_ID"] = opts.sessionId;
  env["AGENT_LOOP_AGENT_ROLE"] = opts.agentRole;
  env["AGENT_LOOP_PHASE"] = opts.phaseLabel;

  const resolvedBinary = resolveBinaryOnWindows(opts.cliBinary);

  const hasTty = !!(process.stdin && (process.stdin as { isTTY?: boolean }).isTTY);
  const useConpty = process.platform === "win32" && hasTty;

  if (process.platform === "win32" && !hasTty) {
    console.warn(`[spawnCliPty] No TTY detected; disabling ConPTY to avoid AttachConsole failures.`);
  }

  const ptyProc = pty.spawn(resolvedBinary, args, {
    name: "xterm-256color",
    cols: loopConfig.defaults.ptyCols,
    rows: loopConfig.defaults.ptyRows,
    cwd: opts.targetProjectPath,
    env,
    useConpty,
  });

  const pid = ptyProc.pid;

    const done = new Promise<PtyRunResult>((resolve) => {
      const lineBuffer = new LineBuffer();
      const events: AnyObj[] = [];
      const autoInjected: { prompt: string; response: string; timestamp: string }[] = [];
      let output = "";
      let resolved = false;
      let idleTimer: NodeJS.Timeout | null = null;
      let phaseTimer: NodeJS.Timeout | null = null;
      let jsonReassemblyBuffer = "";

    const finish = (result: Omit<PtyRunResult, "pid">) => {
      if (resolved) return;
      resolved = true;
      if (idleTimer) clearTimeout(idleTimer);
      if (phaseTimer) clearTimeout(phaseTimer);
      if (stopTimer) clearInterval(stopTimer);
      try { ptyProc.kill(); } catch {}
      resolve({ pid, ...result });
    };

    const triggerTimeout = (reason: string) => {
      killProcessTree(pid).then(() => {
        finish({ exitCode: -1, output, events, timedOut: true, cancelled: false, autoInjected });
        console.error(`[spawnCliPty] ${reason} for session=${opts.sessionId} role=${opts.agentRole}`);
      });
    };

    let stopTimer: NodeJS.Timeout | null = null;
    const checkStopRequest = async () => {
      if (resolved || !opts.stopRequestPath) return;
      try {
        const s = await fse.readFile(opts.stopRequestPath, "utf8");
        if (s.trim().length > 0) {
          await fse.remove(opts.stopRequestPath).catch(() => {});
          killProcessTree(pid).then(() => {
            finish({ exitCode: -1, output, events, timedOut: false, cancelled: true, autoInjected });
            console.log(`[spawnCliPty] Stop requested for session=${opts.sessionId} role=${opts.agentRole}`);
          });
        }
      } catch {
        // stop file does not exist
      }
    };

    if (opts.stopRequestPath) {
      stopTimer = setInterval(() => {
        checkStopRequest().catch(() => {});
      }, 500);
    }

    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (!resolved) triggerTimeout(`Idle timeout (${opts.idleTimeoutMs}ms)`);
      }, opts.idleTimeoutMs);
    };

    if (opts.timeoutMs > 0) {
      phaseTimer = setTimeout(() => {
        if (!resolved) triggerTimeout(`Phase timeout (${opts.timeoutMs}ms)`);
      }, opts.timeoutMs);
    }

    resetIdle();

    ptyProc.onData((data) => {
      output += data;
      resetIdle();

      const stripped = stripAnsi(data);
      const lines = lineBuffer.push(stripped);

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;

        if (jsonReassemblyBuffer.length > 0) {
          jsonReassemblyBuffer += trimmed;
          if (jsonReassemblyBuffer.endsWith("}")) {
            try {
              const evt = JSON.parse(jsonReassemblyBuffer) as AnyObj;
              events.push(evt);
            } catch {
              // Genuinely invalid JSON, discard
            }
            jsonReassemblyBuffer = "";
          }
        } else if (trimmed.startsWith("{")) {
          if (trimmed.endsWith("}")) {
            try {
              const evt = JSON.parse(trimmed) as AnyObj;
              events.push(evt);
            } catch {
              // Starts with { and ends with } but invalid — try accumulating anyway
              jsonReassemblyBuffer = trimmed;
            }
          } else {
            jsonReassemblyBuffer = trimmed;
          }
        }

        const lower = trimmed.toLowerCase();
        const isDestructive = loopConfig.destructivePrompts.some((p) => lower.includes(p.toLowerCase()));
        const matchedWhitelist = opts.cliProfile.interactionWhitelist.find((p) => lower.includes(p.toLowerCase()));

        if (matchedWhitelist && !isDestructive) {
          const response = "y\n";
          ptyProc.write(response);
          autoInjected.push({ prompt: trimmed, response: "y", timestamp: new Date().toISOString() });
        }
      }
    });

    ptyProc.onExit((e) => {
      finish({ exitCode: e.exitCode, output, events, timedOut: false, cancelled: false, autoInjected });
    });
  });

  return { pid, done };
}
*/

function discoverCliModels(cliBinary: string, override: string[] | null, profile: CliProfile): Promise<string[]> {
  if (override && override.length > 0) {
    return Promise.resolve(override);
  }
  return new Promise<string[]>((resolve) => {
    execFile(
      cliBinary,
      profile.modelsArgs,
      { maxBuffer: 10 * 1024 * 1024, timeout: 30 * 1000, shell: process.platform === "win32" },
      (err, stdout, stderr) => {
      if (err) {
        console.warn(`[discoverCliModels] Failed to run '${cliBinary} ${profile.modelsArgs.join(" ")}': ${err.message}`);
        resolve([]);
        return;
      }
      const text = `${stdout}\n${stderr}`;
      const models: string[] = [];
      // Match lines that look like "provider/model" or "kilo/provider/model" (kilo nested format).
      // We prefer the longest match per line to capture nested identifiers like kilo/ai21/jamba-large-1.7.
      const lineRegex = /^([a-zA-Z0-9_~.-]+)\/([a-zA-Z0-9_~.-]+)(?:\/([a-zA-Z0-9_~.-]+))?/gm;
      let lineMatch: RegExpExecArray | null;
      while ((lineMatch = lineRegex.exec(text)) !== null) {
        let model: string;
        if (lineMatch[3]) {
          // 3-part: kilo/provider/model
          model = `${lineMatch[1]}/${lineMatch[2]}/${lineMatch[3]}`;
        } else {
          // 2-part: provider/model
          model = `${lineMatch[1]}/${lineMatch[2]}`;
        }
        if (!model.startsWith(".") && !model.startsWith("/") && !models.includes(model)) {
          models.push(model);
        }
      }
      if (models.length === 0) {
        const tuiErrorPatterns = [
          "registered data providers",
          "no registered",
          "tui",
          "auth",
          "connect",
        ];
        const lowerText = text.toLowerCase();
        const matched = tuiErrorPatterns.find((p) => lowerText.includes(p));
        if (matched) {
          console.warn(
            `[discoverCliModels] '${cliBinary} ${profile.modelsArgs.join(" ")}' returned a TUI/auth error instead of models. ` +
            `Output: ${text.slice(0, 400)}\n` +
            `If using kilo: run 'kilo auth' or set KILOCODE_API_KEY environment variable, then retry.`
          );
        } else if (text.trim().length > 0) {
          console.warn(
            `[discoverCliModels] '${cliBinary} ${profile.modelsArgs.join(" ")}' returned no parseable models. ` +
            `Output: ${text.slice(0, 400)}`
          );
        } else {
          console.warn(
            `[discoverCliModels] '${cliBinary} ${profile.modelsArgs.join(" ")}' produced no output. ` +
            `Verify the CLI is installed and authenticated.`
          );
        }
      }
      resolve(models);
    });
  });
}

function normalizeSignature(raw: string): string {
  let s = raw.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  s = s.replace(/[A-Za-z]:[\\/][^\s:|"'`]+/g, "<PATH>");
  s = s.replace(/(^|[\s:(])(\/[^\s:|"'`]+)/g, "$1<PATH>");
  s = s.replace(/:\d+:\d+/g, ":<LN>:<COL>");
  s = s.replace(/:\d+/g, ":<LN>");
  s = s.replace(/0x[0-9a-fA-F]+/g, "0x<HEX>");
  s = s.replace(/\b\d{10,}\b/g, "<TS>");

  const errorMatch = s.match(/(?:error|exception|fail(?:ed)?)[:]\s*([^\n]+)/i);
  if (errorMatch) {
    return errorMatch[1].trim().slice(0, 120).toLowerCase();
  }

  return s.trim().slice(0, 120).toLowerCase();
}

function pushAndCheckOscillation(
  queue: ErrorSignature[],
  entry: ErrorSignature
): { oscillation: boolean; queue: ErrorSignature[] } {
  const newQueue = [...queue, entry].slice(-5);

  let freqCount = 0;
  for (const e of newQueue) {
    if (e.signature === entry.signature) freqCount++;
  }
  if (freqCount >= 3) {
    return { oscillation: true, queue: newQueue };
  }

  const sigs = newQueue.map((e) => e.signature);
  if (sigs.length >= 4) {
    const half = Math.floor(sigs.length / 2);
    const recent = sigs.slice(-half);
    const older = sigs.slice(-half * 2, -half);
    if (recent.length === older.length && recent.every((v, i) => v === older[i])) {
      return { oscillation: true, queue: newQueue };
    }
  }

  return { oscillation: false, queue: newQueue };
}

function extractFailureDigest(testLog: string): string {
  const lines = testLog.split("\n").map((l) => stripAnsi(l)).filter((l) => l.trim().length > 0);
  const failures: string[] = [];
  const files = new Set<string>();

  for (const line of lines) {
    const failMatch = line.match(/(?:FAIL|failed|✕|AssertionError|Error:)\s*(.*)/i);
    if (failMatch) {
      const text = failMatch[1] ? failMatch[1].trim() : failMatch[0].trim();
      if (text.length > 0) failures.push(text.slice(0, 120));
    }
    const fileMatch = line.match(/([A-Za-z0-9_./\\-]+\.(ts|js|tsx|jsx|py|go|rs|java|cpp|c|h|cs|rb|php|swift|kt))/);
    if (fileMatch) {
      files.add(path.basename(fileMatch[1]));
    }
    if (failures.length >= 5 && files.size >= 5) break;
  }

  const parts: string[] = [];
  if (failures.length > 0) {
    parts.push("Failures:");
    for (const f of failures.slice(0, 5)) {
      parts.push(`  - ${f}`);
    }
  }
  if (files.size > 0) {
    parts.push("Affected files:");
    for (const f of Array.from(files).slice(0, 5)) {
      parts.push(`  - ${f}`);
    }
  }

  if (parts.length === 0) {
    const cleanLog = stripAnsi(testLog);
    const lastLines = cleanLog.split("\n").filter((l) => l.trim().length > 0).slice(-20);
    return lastLines.join("\n").slice(0, 800);
  }

  return parts.join("\n");
}

function extractOutput(result: PtyRunResult): string {
  if (result.assistantText && result.assistantText.trim().length > 0) {
    const normalized = result.assistantText.replace(/\r\n/g, "\n");
    const lines = normalized.split("\n");
    const sentinelIndex = lines.findIndex((line) => line.trim() === SENTINEL);
    return (sentinelIndex >= 0 ? lines.slice(0, sentinelIndex) : lines).join("\n").trim();
  }
  const messages: string[] = [];
  for (const evt of result.events) {
    if (evt.type === "text") {
      const part = evt.part as Record<string, unknown> | undefined;
      const text = part && typeof part.text === "string" ? (part.text as string) : null;
      if (text && text.length > 0) {
        messages.push(text);
        continue;
      }
    }
    if (evt.type === "step_finish") {
      const part = evt.part as Record<string, unknown> | undefined;
      const result = part && typeof part.result === "string" ? (part.result as string) : null;
      if (result && result.length > 0) {
        messages.push(result);
        continue;
      }
    }
    const contentKeys = ["content", "text", "message", "output"];
    for (const key of contentKeys) {
      const val = evt[key];
      if (typeof val === "string" && val.length > 0) {
        messages.push(val);
        break;
      }
    }
  }
  if (messages.length > 0) {
    return messages.join("\n");
  }

  const stripped = stripAnsi(result.output);
  const sentinelIdx = stripped.indexOf(SENTINEL);
  if (sentinelIdx >= 0) {
    return stripped.slice(0, sentinelIdx).trim();
  }

  return stripped.trim().slice(-2000);
}

export function extractVerdictFromOutput(result: PtyRunResult): string {
  // Completion validation uses the complete assistant transcript. Verdict
  // extraction must use the same source: Codex emits each assistant update as
  // an item.completed event, so inspecting only the final event loses a valid
  // decision that appeared at the start of the final assistant message.
  const assistantText = assistantTextBeforeSentinel(result);
  if (assistantText.length > 0) return assistantText;
  return extractOutput(result);
}

function approvalVerdictFromLine(line: string): "APPROVED" | "REJECTED" | null {
  const match = line
    .trim()
    .match(/^(APPROVED|REJECTED)(?:$|[\s:;,.!?()[\]{}|\u2013\u2014-].*)/i);
  return match ? (match[1].toUpperCase() as "APPROVED" | "REJECTED") : null;
}

export function filterDiscoveredModelsForProvider(
  providerId: string,
  adapter: ProviderConfig["adapter"],
  models: string[]
): string[] {
  const unique = [...new Set(models.map((model) => model.trim()).filter(Boolean))];
  if (providerId === "kilo" && adapter === "kilo") {
    return unique.filter((model) => model.startsWith("kilo/"));
  }
  if (providerId === "opencode" && adapter === "opencode") {
    return unique.filter((model) => model.startsWith("opencode/") || model.startsWith("opencode-go/"));
  }
  return unique;
}

export interface ProviderModelDiscoveryResult {
  available: boolean;
  models: string[];
  error: string | null;
  modelLabels?: Record<string, string>;
  modelVariants?: Record<string, string[]>;
}

export function discoverCodexModels(
  binary: string,
  appServerArgs: string[] = ["app-server"],
  timeoutMs = 30_000
): Promise<ProviderModelDiscoveryResult> {
  const resolvedBinary = resolveBinaryOnWindows(binary);
  const extension = path.extname(resolvedBinary).toLowerCase();
  const needsWindowsShell =
    process.platform === "win32" && (extension === ".cmd" || extension === ".bat");
  return new Promise((resolve) => {
    let child: ChildProcessWithoutNullStreams | null = null;
    let settled = false;
    let spawned = false;
    let stdoutBuffer = "";
    let stderr = "";
    let requestId = 2;
    let modelListStarted = false;
    const models = new Set<string>();
    const modelLabels: Record<string, string> = {};
    const modelVariants: Record<string, string[]> = {};
    const seenCursors = new Set<string>();
    const pendingModelRequestIds = new Set<number>();

    const finish = (result: ProviderModelDiscoveryResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child?.stdin.end(); } catch { /* best effort */ }
      try { child?.kill(); } catch { /* best effort */ }
      resolve(result);
    };

    const fail = (message: string, available = spawned): void => {
      const detail = stderr.trim() ? `${message} (${stderr.trim().slice(-500)})` : message;
      finish({ available, models: [], error: detail });
    };

    const send = (message: Record<string, unknown>): void => {
      if (!child?.stdin.writable) {
        fail("Codex app-server stdin closed before model discovery completed.");
        return;
      }
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };

    const requestModelPage = (cursor?: string): void => {
      const params: Record<string, unknown> = { limit: 100, includeHidden: true };
      if (cursor) params.cursor = cursor;
      const id = requestId++;
      pendingModelRequestIds.add(id);
      send({ method: "model/list", id, params });
    };

    const handleMessage = (message: AnyObj): void => {
      if (message.id === 1) {
        if (message.error) {
          fail(`Codex app-server initialize failed: ${JSON.stringify(message.error)}`);
          return;
        }
        send({ method: "initialized", params: {} });
        modelListStarted = true;
        requestModelPage();
        return;
      }
      if (!modelListStarted || typeof message.id !== "number" || !pendingModelRequestIds.has(message.id)) return;
      pendingModelRequestIds.delete(message.id);
      if (message.error) {
        fail(`Codex model/list failed: ${JSON.stringify(message.error)}`);
        return;
      }
      const result = message.result as AnyObj | undefined;
      const data = Array.isArray(result?.data) ? result.data : [];
      for (const candidate of data) {
        if (!candidate || typeof candidate !== "object") continue;
        const item = candidate as AnyObj;
        const model = typeof item.model === "string"
          ? item.model.trim()
          : typeof item.id === "string"
            ? item.id.trim()
            : "";
        if (model) models.add(model);
        if (model && typeof item.displayName === "string" && item.displayName.trim()) {
          modelLabels[model] = item.displayName.trim();
        }
        if (model && Array.isArray(item.supportedReasoningEfforts)) {
          const efforts = item.supportedReasoningEfforts
            .map((effort) => {
              if (!effort || typeof effort !== "object") return "";
              const value = (effort as AnyObj).reasoningEffort;
              return typeof value === "string" ? value.trim() : "";
            })
            .filter(Boolean);
          if (efforts.length > 0) modelVariants[model] = [...new Set(efforts)];
        }
      }
      const nextCursor = typeof result?.nextCursor === "string" && result.nextCursor.trim()
        ? result.nextCursor.trim()
        : null;
      if (nextCursor) {
        if (seenCursors.has(nextCursor) || seenCursors.size >= 50) {
          fail("Codex model/list returned a repeated or excessive pagination cursor.");
          return;
        }
        seenCursors.add(nextCursor);
        requestModelPage(nextCursor);
        return;
      }
      finish({
        available: true,
        models: [...models],
        error: null,
        modelLabels,
        modelVariants,
      });
    };

    const timer = setTimeout(() => {
      fail(`Codex model discovery timed out after ${timeoutMs}ms.`);
    }, Math.max(1, timeoutMs));

    try {
      child = spawn(resolvedBinary, appServerArgs, {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        shell: needsWindowsShell,
      }) as ChildProcessWithoutNullStreams;
    } catch (error) {
      fail(`Unable to start Codex app-server: ${error instanceof Error ? error.message : String(error)}`, false);
      return;
    }
    child.once("spawn", () => {
      spawned = true;
      send({
        method: "initialize",
        id: 1,
        params: {
          clientInfo: {
            name: "custom_agent_loop",
            title: "Custom Agent Loop System",
            version: "1.2.0",
          },
        },
      });
    });
    child.once("error", (error) => {
      fail(`Unable to start Codex app-server: ${error.message}`, false);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-64 * 1024);
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          handleMessage(JSON.parse(trimmed) as AnyObj);
        } catch {
          stderr = `${stderr}\nInvalid Codex app-server JSON: ${trimmed.slice(0, 300)}`.slice(-64 * 1024);
        }
      }
    });
    child.once("exit", (code, signal) => {
      if (!settled) {
        fail(`Codex app-server exited before model discovery completed (code=${code}, signal=${signal}).`);
      }
    });
  });
}

export function probeProviderBinary(
  binary: string
): Promise<{ available: boolean; error: string | null }> {
  const candidates: string[] = [];
  if (process.platform === "win32") {
    const resolved = resolveBinaryOnWindows(binary);
    candidates.push(resolved);
    if (!path.isAbsolute(resolved)) candidates.push(path.resolve(resolved));
  } else if (path.isAbsolute(binary) || binary.includes(path.sep)) {
    candidates.push(path.resolve(binary));
  } else {
    for (const directory of (process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
      candidates.push(path.join(directory, binary));
    }
  }
  for (const candidate of [...new Set(candidates)]) {
    try {
      fs.accessSync(candidate, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
      return Promise.resolve({ available: true, error: null });
    } catch {
      // Try the next PATH candidate.
    }
  }
  return Promise.resolve({
    available: false,
    error: `Provider binary '${binary}' is unavailable: not installed or not executable from PATH.`,
  });
}

async function discoverProviderCatalog(
  providers: Record<string, ProviderConfig>,
  legacyOverride: string[] | null = null
): Promise<Record<string, ProviderCatalogEntry>> {
  const discoveredAt = new Date().toISOString();
  const pairs = await Promise.all(
    Object.entries(providers).map(async ([id, provider]): Promise<[string, ProviderCatalogEntry]> => {
      if (!provider.enabled) {
        return [id, {
          id, label: provider.label, adapter: provider.adapter, binary: provider.binary,
          enabled: false, available: false, models: [], discoveredAt: null, error: null,
        }];
      }
      const binaryProbe = await probeProviderBinary(provider.binary);
      if (!binaryProbe.available) {
        return [id, {
          id, label: provider.label, adapter: provider.adapter, binary: provider.binary,
          enabled: true, available: false, models: [], discoveredAt, error: binaryProbe.error,
        }];
      }
      let models: string[] = [];
      let error: string | null = null;
      let modelLabels: Record<string, string> | undefined;
      let modelVariants: Record<string, string[]> | undefined;
      if (provider.adapter === "codex") {
        const discovery = await discoverCodexModels(provider.binary);
        if (!discovery.available) {
          return [id, {
            id, label: provider.label, adapter: provider.adapter, binary: provider.binary,
            enabled: true, available: false, models: [], discoveredAt, error: discovery.error,
          }];
        }
        models = discovery.models.length > 0
          ? discovery.models
          : [...provider.fallbackModels];
        modelLabels = discovery.modelLabels;
        modelVariants = discovery.modelVariants;
        error = discovery.error ?? (discovery.models.length === 0
          ? `Codex model/list returned no models; using ${models.length} configured fallback model(s).`
          : null);
      } else if (provider.modelsArgs.length === 0) {
        models = [...provider.fallbackModels];
      } else {
        const profile: CliProfile = {
          name: id,
          defaultBinary: provider.binary,
          modelsArgs: provider.modelsArgs,
          interactionWhitelist: provider.interactionWhitelist ?? INTERACTION_WHITELIST,
        };
        const providerOverride = id === "opencode" ? legacyOverride : null;
        models = await discoverCliModels(provider.binary, providerOverride, profile);
        if (!providerOverride?.length) {
          models = filterDiscoveredModelsForProvider(id, provider.adapter, models);
        }
        if (models.length === 0) {
          models = [...provider.fallbackModels];
          error = `Model discovery returned no models; using ${models.length} configured fallback model(s).`;
        }
      }
      return [id, {
        id,
        label: provider.label,
        adapter: provider.adapter,
        binary: provider.binary,
        enabled: provider.enabled,
        available: true,
        models: [...new Set(models)],
        ...(modelLabels ? { modelLabels } : {}),
        ...(modelVariants ? { modelVariants } : {}),
        discoveredAt,
        error,
      }];
    })
  );
  return Object.fromEntries(pairs);
}

function flatCatalogModels(catalog: Record<string, ProviderCatalogEntry>): string[] {
  return [...new Set(
    Object.values(catalog)
      .filter((entry) => entry.enabled && entry.available)
      .flatMap((entry) => entry.models)
  )];
}

function reusableProviderCatalog(
  registry: SessionRegistry,
  providers: Record<string, ProviderConfig>,
  maxAgeMs = 5 * 60 * 1000
): Record<string, ProviderCatalogEntry> | null {
  const catalog = registry.providerCatalog;
  const discoveredAt = Date.parse(registry.modelsDiscoveredAt ?? "");
  if (!catalog || !Number.isFinite(discoveredAt) || Date.now() - discoveredAt > maxAgeMs) return null;
  const providerIds = Object.keys(providers).sort();
  if (providerIds.join("\0") !== Object.keys(catalog).sort().join("\0")) return null;
  for (const id of providerIds) {
    const provider = providers[id];
    const entry = catalog[id];
    if (
      !entry ||
      typeof entry.available !== "boolean" ||
      entry.binary !== provider.binary ||
      entry.adapter !== provider.adapter ||
      entry.enabled !== provider.enabled
    ) return null;
  }
  return catalog;
}

function parseJsonRecord(value: string | undefined, option: string): Record<string, string> {
  if (!value || value === "true") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("expected object");
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>)
        .filter(([, item]) => typeof item === "string" && item.trim().length > 0)
        .map(([key, item]) => [key, String(item)])
    );
  } catch (error) {
    throw new Error(`${option} must be a JSON object of string values: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function parseApprovalVerdict(output: string): "APPROVED" | "REJECTED" | null {
  const verdicts = output
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map(approvalVerdictFromLine)
    .filter((verdict): verdict is "APPROVED" | "REJECTED" => verdict !== null);
  return verdicts[verdicts.length - 1] ?? null;
}

export function approvalDecisionSignature(output: string): string {
  const lines = output.replace(/\r\n/g, "\n").split("\n");
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index].trim();
    const verdict = approvalVerdictFromLine(line);
    if (!verdict) continue;
    const rationale = line.replace(/^(APPROVED|REJECTED)(?:\s*[:;,.!?\u2013\u2014-]\s*|\s+)/i, "");
    const normalizedRationale = normalizeSignature(rationale);
    return `master_${verdict.toLowerCase()}:${normalizedRationale || "no_reason"}`;
  }
  return "master_protocol:missing_approval_verdict";
}

function parseMasterVerdict(output: string): "approved" | "rejected" | "unknown" {
  const last = parseApprovalVerdict(output);
  return last === "APPROVED" ? "approved" : last === "REJECTED" ? "rejected" : "unknown";
}

function testerVerdictFromLine(line: string): "PASS" | "FAIL" | null {
  const match = line
    .trim()
    .match(/^VERDICT:\s*(PASS|FAIL)(?:$|[\s:;,.!?()[\]{}|\u2013\u2014-].*)/i);
  return match ? (match[1].toUpperCase() as "PASS" | "FAIL") : null;
}

export function parseTesterVerdict(output: string): "PASS" | "FAIL" | null {
  const verdicts = output
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map(testerVerdictFromLine)
    .filter((verdict): verdict is "PASS" | "FAIL" => verdict !== null);
  return verdicts[verdicts.length - 1] ?? null;
}

function assistantTextBeforeSentinel(result: PtyRunResult): string {
  const text = (result.assistantText ?? extractOutput(result)).replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  const sentinelIndex = lines.findIndex((line) => line.trim() === SENTINEL);
  return (sentinelIndex >= 0 ? lines.slice(0, sentinelIndex) : lines).join("\n").trim();
}

const READ_ONLY_MODEL_ROLES = new Set<BuiltinModelRole>([
  "planner",
  "qa_lead",
  "master",
  "interrupter",
]);

export function isReadOnlyModelRole(role: BuiltinModelRole): boolean {
  return READ_ONLY_MODEL_ROLES.has(role);
}

function isMutatingToolName(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const compact = value.toLowerCase().replace(/[^a-z]/g, "");
  return [
    "write",
    "writefile",
    "edit",
    "multiedit",
    "notebookedit",
    "applypatch",
    "patch",
    "createfile",
    "deletefile",
    "movefile",
    "renamefile",
  ].some((name) => compact === name || compact.endsWith(name));
}

function eventContainsFileMutation(value: unknown, depth = 0): boolean {
  if (!value || depth > 6) return false;
  if (Array.isArray(value)) {
    return value.some((entry) => eventContainsFileMutation(entry, depth + 1));
  }
  if (typeof value !== "object") return false;
  const node = value as AnyObj;
  const type = typeof node.type === "string" ? node.type.toLowerCase() : "";
  if (type === "file_change" || type === "filechange") return true;
  if (type.includes("tool")) {
    if (
      isMutatingToolName(node.name) ||
      isMutatingToolName(node.tool) ||
      isMutatingToolName(node.toolName) ||
      isMutatingToolName(node.tool_name)
    ) return true;
  }
  return Object.values(node).some((entry) => eventContainsFileMutation(entry, depth + 1));
}

/** Detects provider-reported write/edit/file-change events for read-only role enforcement. */
export function hasObservedFileMutation(result: Pick<PtyRunResult, "events">): boolean {
  return result.events.some((event) => eventContainsFileMutation(event));
}

export function validateAgentCompletion(
  completionKind: PipelineCompletionContract | PipelineStageExecutor,
  result: PtyRunResult,
  planOptionsCount = 3,
  requirements: {
    externalResearchRequired?: boolean;
    namedReferenceRequired?: boolean;
    expectedReferenceIdentity?: ReferenceIdentity | null;
    forbidFileMutation?: boolean;
  } = {}
): { valid: boolean; reason: string | null } {
  if (result.exitCode !== 0) {
    return { valid: false, reason: `Process exited with code ${result.exitCode}` };
  }
  const assistantText = (result.assistantText ?? "").replace(/\r\n/g, "\n");
  const lines = assistantText.split("\n").map((line) => line.trim());
  const sentinelIndex = lines.findIndex((line) => line === SENTINEL);
  if (sentinelIndex < 0) {
    return { valid: false, reason: `Assistant response did not contain ${SENTINEL} on its own line.` };
  }
  if (requirements.forbidFileMutation && hasObservedFileMutation(result)) {
    return {
      valid: false,
      reason: "This read-only role emitted a file mutation event; its result cannot complete the phase.",
    };
  }
  const before = lines.slice(0, sentinelIndex);
  if (requirements.externalResearchRequired) {
    const completedSearches = countCompletedWebSearch(result);
    if (completedSearches < 1) {
      return {
        valid: false,
        reason: "The original goal requires internet research, but this attempt did not complete a web search.",
      };
    }
    const researchText = before.join("\n");
    if (!/^\[RESEARCH_EVIDENCE\]$/im.test(researchText)) {
      return {
        valid: false,
        reason: "The response is missing an independent [RESEARCH_EVIDENCE] marker.",
      };
    }
    if (!/^SOURCE:\s*https?:\/\/\S+/im.test(researchText)) {
      return {
        valid: false,
        reason: "The research evidence does not cite an HTTP(S) source URL.",
      };
    }
    if (!/^(?:VERIFIED_FACT|LIMITATION):\s*\S+/im.test(researchText)) {
      return {
        valid: false,
        reason: "The research evidence is missing a VERIFIED_FACT or LIMITATION line.",
      };
    }
    const researchBlocked = isResearchBlockedResponse(researchText);
    if (/^CONFIDENCE:\s*LOW\b/im.test(researchText) && !researchBlocked) {
      return {
        valid: false,
        reason: "Low-confidence research must end with RESEARCH_BLOCKED instead of guessing.",
      };
    }
    if (researchBlocked) {
      return { valid: true, reason: null };
    }
    if (requirements.namedReferenceRequired) {
      if (completedSearches < 2) {
        return {
          valid: false,
          reason: "Named-reference verification requires at least two completed web research actions.",
        };
      }
      const identity = parseReferenceIdentity(researchText);
      if (!identity) {
        return {
          valid: false,
          reason: "Named-reference research is missing a complete [REFERENCE_IDENTITY] block.",
        };
      }
      const identityFailure = validateExactReferenceIdentity(identity);
      if (identityFailure) return { valid: false, reason: identityFailure };
      const evidenceFailure = validateNamedReferenceEvidence(researchText, identity);
      if (evidenceFailure) return { valid: false, reason: evidenceFailure };
      const expected = requirements.expectedReferenceIdentity;
      if (expected && !sameReferenceIdentity(identity, expected)) {
        return {
          valid: false,
          reason:
            `Reference identity changed between stages. Expected ${referenceIdentityLabel(expected)}, ` +
            `received ${referenceIdentityLabel(identity)}.`,
        };
      }
      if (completionKind === "review" || completionKind === "approval") {
        const approved = parseApprovalVerdict(researchText) === "APPROVED";
        if (approved && containsReferenceIdentityContradiction(researchText)) {
          return {
            valid: false,
            reason: "APPROVED contradicts the response's own statement that the named reference was not exactly verified.",
          };
        }
      }
    }
  }
  const completionContract: PipelineCompletionContract =
    completionKind === "planning" ? "plan_options"
      : completionKind === "test" ? "verdict"
        : completionKind === "review" || completionKind === "approval" ? "approval"
          : completionKind === "implementation" || completionKind === "interrupt" ? "phase_done"
            : completionKind;
  if (completionContract === "plan_options") {
    const choices = parsePlanChoices(before.join("\n"));
    if (choices.length !== planOptionsCount) {
      return { valid: false, reason: `Planning returned ${choices.length} plan option(s); exactly ${planOptionsCount} are required.` };
    }
    const expectedIds = Array.from({ length: planOptionsCount }, (_, index) => index + 1);
    if (!expectedIds.every((id, index) => choices[index]?.id === id)) {
      return {
        valid: false,
        reason: `Planning option IDs must be unique and sequential from 1 to ${planOptionsCount}.`,
      };
    }
  }
  if (completionContract === "verdict") {
    if (parseTesterVerdict(before.join("\n")) === null) {
      return { valid: false, reason: "Tester response is missing a final VERDICT: PASS|FAIL line." };
    }
  }
  if (completionContract === "approval") {
    if (parseApprovalVerdict(before.join("\n")) === null) {
      return { valid: false, reason: "Approval response is missing an APPROVED or REJECTED line." };
    }
  }
  return { valid: true, reason: null };
}

export function goalRequiresExternalResearch(goal: string): boolean {
  const normalized = goal.replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  return (
    /(?:인터넷|웹)\s*(?:을|를|에서|으로)?\s*(?:검색|조사|찾)/i.test(normalized) ||
    /\b(?:search|browse|research|look\s*up)(?:\s+the)?\s+(?:internet|web)\b/i.test(normalized) ||
    /\b(?:internet|web)\s+(?:search|research)\b/i.test(normalized)
  );
}

export function goalRequiresNamedReferenceVerification(goal: string): boolean {
  if (!goalRequiresExternalResearch(goal)) return false;
  const normalized = goal.replace(/\s+/g, " ").trim();
  return (
    /(?:게임|앱|제품|서비스|사이트)(?:과|와)?\s*(?:같은|동일한|비슷한|유사한)/i.test(normalized) ||
    /(?:처럼|기반으로|참고해서|레퍼런스)/i.test(normalized) ||
    /\b(?:same as|similar to|based on|inspired by|clone of|reference (?:app|game|product))\b/i.test(normalized)
  );
}

export function parseReferenceIdentity(output: string): ReferenceIdentity | null {
  const blocks = [...output.matchAll(/\[REFERENCE_IDENTITY\]([\s\S]*?)\[\/REFERENCE_IDENTITY\]/gi)];
  const body = blocks[blocks.length - 1]?.[1];
  if (!body) return null;
  const value = (name: string): string | null => {
    const match = body.match(new RegExp(`^${name}:\\s*(\\S(?:.*\\S)?)\\s*$`, "im"));
    return match?.[1]?.trim() ?? null;
  };
  const title = value("TITLE");
  const creator = value("CREATOR");
  const packageId = value("PACKAGE_ID");
  const canonicalUrl = value("CANONICAL_URL");
  const candidateCountRaw = value("CANDIDATE_COUNT");
  const candidateCount = candidateCountRaw && /^\d+$/.test(candidateCountRaw)
    ? Number(candidateCountRaw)
    : null;
  const identityMatch = value("IDENTITY_MATCH")?.toUpperCase();
  const confidence = value("CONFIDENCE")?.toUpperCase();
  if (
    !title || !creator || !packageId || !canonicalUrl || candidateCount === null ||
    !identityMatch || !["EXACT", "AMBIGUOUS", "SIMILAR", "UNKNOWN"].includes(identityMatch) ||
    !confidence || !["HIGH", "MEDIUM", "LOW"].includes(confidence)
  ) return null;
  return {
    title,
    creator,
    packageId,
    canonicalUrl,
    candidateCount,
    identityMatch: identityMatch as ReferenceIdentity["identityMatch"],
    confidence: confidence as ReferenceIdentity["confidence"],
  };
}

function validateExactReferenceIdentity(identity: ReferenceIdentity): string | null {
  if (identity.candidateCount !== 1) {
    return "Named-reference research found multiple or zero candidate products; it must use RESEARCH_BLOCKED and ask the operator to select the exact reference.";
  }
  if (identity.identityMatch !== "EXACT" || identity.confidence !== "HIGH") {
    return "Named references require IDENTITY_MATCH: EXACT and CONFIDENCE: HIGH; ambiguous, similar, or medium-confidence matches must use RESEARCH_BLOCKED.";
  }
  if (!/^https?:\/\/\S+$/i.test(identity.canonicalUrl)) {
    return "REFERENCE_IDENTITY requires an HTTP(S) CANONICAL_URL.";
  }
  if (/^(?:n\/?a|none|unknown|unverified|-)+$/i.test(identity.packageId)) {
    return "REFERENCE_IDENTITY requires a verified package or stable product ID.";
  }
  return null;
}

function evidenceBlocks(output: string): string[] {
  return [...output.matchAll(/\[RESEARCH_EVIDENCE\]([\s\S]*?)\[\/RESEARCH_EVIDENCE\]/gi)]
    .map((match) => match[1]);
}

function evidenceField(block: string, name: string): string | null {
  const match = block.match(new RegExp(`^${name}:\\s*(\\S(?:.*\\S)?)\\s*$`, "im"));
  return match?.[1]?.trim() ?? null;
}

function validateNamedReferenceEvidence(output: string, identity: ReferenceIdentity): string | null {
  const blocks = evidenceBlocks(output);
  const records = blocks.map((block) => ({
    type: evidenceField(block, "EVIDENCE_TYPE")?.toUpperCase() ?? "",
    source: evidenceField(block, "SOURCE") ?? "",
    referenceId: evidenceField(block, "REFERENCE_ID") ?? "",
    fact: evidenceField(block, "VERIFIED_FACT") ?? "",
  }));
  if (records.length < 2) {
    return "Named-reference verification requires at least two [RESEARCH_EVIDENCE] blocks.";
  }
  if (!records.some((record) => record.type === "IDENTITY")) {
    return "Named-reference verification requires EVIDENCE_TYPE: IDENTITY.";
  }
  if (!records.some((record) => record.type === "GAMEPLAY")) {
    return "Named-reference verification requires EVIDENCE_TYPE: GAMEPLAY.";
  }
  const canonical = normalizeResearchUrl(identity.canonicalUrl);
  if (!records.some(
    (record) => record.type === "IDENTITY" && normalizeResearchUrl(record.source) === canonical
  )) {
    return "The canonical reference URL must also be cited by an EVIDENCE_TYPE: IDENTITY block.";
  }
  const expectedId = normalizeReferenceValue(identity.packageId);
  if (records.some((record) => normalizeReferenceValue(record.referenceId) !== expectedId)) {
    return "Every research evidence block must use the locked package/product REFERENCE_ID.";
  }
  if (records.some((record) => !record.fact || !/^https?:\/\/\S+$/i.test(record.source))) {
    return "Every research evidence block requires a direct HTTP(S) SOURCE and VERIFIED_FACT.";
  }
  const hosts = new Set<string>();
  for (const record of records) {
    try {
      hosts.add(new URL(record.source).hostname.toLowerCase().replace(/^www\./, ""));
    } catch {
      return "Research evidence contains an invalid SOURCE URL.";
    }
  }
  if (hosts.size < 2) {
    return "Named-reference verification requires evidence from at least two distinct source domains.";
  }
  return null;
}

function normalizeResearchUrl(value: string): string {
  try {
    const parsed = new URL(value);
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return value.trim().toLowerCase().replace(/\/$/, "");
  }
}

function normalizeReferenceValue(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "");
}

function sameReferenceIdentity(left: ReferenceIdentity, right: ReferenceIdentity): boolean {
  return (
    normalizeReferenceValue(left.packageId) === normalizeReferenceValue(right.packageId) &&
    normalizeSignature(left.title) === normalizeSignature(right.title) &&
    normalizeSignature(left.creator) === normalizeSignature(right.creator)
  );
}

function referenceIdentityLabel(identity: ReferenceIdentity): string {
  return `${identity.title} / ${identity.creator} / ${identity.packageId}`;
}

function containsReferenceIdentityContradiction(output: string): boolean {
  return /(?:not (?:the )?(?:exact|same)|different (?:app|game|product)|only (?:a )?(?:similar|style|wording) match|cannot (?:confirm|verify|identify)|unable to (?:confirm|verify|identify)|does not certify|ambiguous|unclear|정확[^\n]{0,30}(?:확인|검증)[^\n]{0,20}(?:못|않)|동일[^\n]{0,20}(?:아니|않)|별도 앱|다른 게임|모호|단정할 수 없|보증[^\n]{0,20}제한)/i.test(output);
}

export function isResearchBlockedResponse(output: string): boolean {
  return output
    .replace(/\r\n/g, "\n")
    .split("\n")
    .some((line) => line.trim() === "RESEARCH_BLOCKED");
}

function countCompletedWebSearch(result: PtyRunResult): number {
  return result.events.filter((event) => {
    const type = typeof event.type === "string" ? event.type : "";
    if (type === "item.completed") {
      const item = event.item as Record<string, unknown> | undefined;
      return item?.type === "web_search";
    }
    if (type === "tool_use" || type === "tool_result") {
      const part = event.part as Record<string, unknown> | undefined;
      const state = part?.state as Record<string, unknown> | undefined;
      const toolName = [event.name, event.tool, part?.name, part?.tool]
        .find((value) => typeof value === "string");
      const normalizedTool = typeof toolName === "string"
        ? toolName.toLowerCase().replace(/[^a-z]/g, "")
        : "";
      const completed = type === "tool_result" || ["completed", "success"].includes(
        typeof state?.status === "string" ? state.status.toLowerCase() : ""
      );
      return completed && ["websearch", "webfetch"].includes(normalizedTool);
    }
    return false;
  }).length;
}

export type AbsolutePathDialect = "win32" | "posix";

export function detectAbsolutePathDialect(value: string): AbsolutePathDialect | null {
  const candidate = value.trim();
  if (!candidate || candidate.includes("\0")) return null;
  // path.win32.isAbsolute("/repo") is true even though that spelling is also a
  // native POSIX path. Detect unambiguous Windows forms first and otherwise
  // preserve leading-forward-slash paths as POSIX.
  // Device namespaces, drive-root-relative paths, incomplete UNC paths, and
  // double-forward-slash paths are intentionally rejected as ambiguous.
  if (/^(?:\\\\|\/\/)[?.][\\/]/.test(candidate)) return null;
  if (/^[A-Za-z]:[\\/]/.test(candidate)) {
    return candidate.slice(2).includes(":") ? null : "win32";
  }
  if (/^\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/.test(candidate)) {
    return candidate.includes(":") ? null : "win32";
  }
  if (/^\/(?!\/)/.test(candidate)) return "posix";
  return null;
}

function isAbsoluteFileSystemPath(value: string): boolean {
  return detectAbsolutePathDialect(value) !== null;
}

function canonicalizeAbsolutePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("\0") || !isAbsoluteFileSystemPath(trimmed)) {
    throw new Error(`Allowed path must be an absolute filesystem path: ${JSON.stringify(value)}`);
  }
  const dialect = detectAbsolutePathDialect(trimmed);
  const pathApi = dialect === "win32" ? path.win32 : path.posix;
  const normalized = pathApi.normalize(trimmed);
  const root = pathApi.parse(normalized).root;
  return normalized === root ? normalized : normalized.replace(/[\\\/]+$/g, "");
}

export function normalizeAdditionalAllowedPaths(
  values: readonly string[],
  targetProjectPath?: string
): string[] {
  const target = targetProjectPath ? canonicalizeAbsolutePath(targetProjectPath) : null;
  const targetDialect = target ? detectAbsolutePathDialect(target) : null;
  const unique = new Map<string, string>();
  for (const value of values) {
    const normalized = canonicalizeAbsolutePath(value);
    const dialect = detectAbsolutePathDialect(normalized);
    if (targetDialect && dialect !== targetDialect) {
      throw new Error(
        `Additional allowed path uses ${dialect ?? "an invalid"} dialect but target uses ${targetDialect}: ${value}`
      );
    }
    if (target && pathIsContained(target, normalized)) continue;
    const key = dialect === "win32" ? `win32:${normalized.toLowerCase()}` : `posix:${normalized}`;
    if (!unique.has(key)) unique.set(key, normalized);
  }
  return [...unique.values()];
}

function pathIsContained(targetProjectPath: string, candidatePath: string): boolean {
  const targetDialect = detectAbsolutePathDialect(targetProjectPath);
  const candidateDialect = detectAbsolutePathDialect(candidatePath);
  if (!targetDialect || targetDialect !== candidateDialect) return false;
  const pathApi = targetDialect === "win32" ? path.win32 : path.posix;
  const targetResolved = pathApi.resolve(targetProjectPath);
  const candidateResolved = pathApi.resolve(candidatePath);
  const target = targetDialect === "win32" ? targetResolved.toLowerCase() : targetResolved;
  const candidate = targetDialect === "win32" ? candidateResolved.toLowerCase() : candidateResolved;
  const relative = pathApi.relative(target, candidate);
  return relative === "" || (!relative.startsWith(`..${pathApi.sep}`) && relative !== ".." && !pathApi.isAbsolute(relative));
}

async function canonicalNativeLocation(
  value: string,
  label: string,
  requireExistingDirectory: boolean
): Promise<string> {
  const dialect = detectAbsolutePathDialect(value);
  const nativeDialect: AbsolutePathDialect = process.platform === "win32" ? "win32" : "posix";
  if (!dialect) {
    throw new Error(`${label} must be an unambiguous absolute filesystem path: ${value}`);
  }
  if (dialect && dialect !== nativeDialect) {
    throw new Error(`${label} uses ${dialect} syntax on a ${nativeDialect} host: ${value}`);
  }
  const resolved = path.resolve(value);
  let existingAncestor = resolved;
  const missingSegments: string[] = [];
  while (true) {
    try {
      const stat = await fse.stat(existingAncestor);
      if (existingAncestor === resolved && !stat.isDirectory()) {
        throw new Error(`${label} must be a directory: ${resolved}`);
      }
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      if (requireExistingDirectory) {
        throw new Error(`${label} must be an existing directory: ${resolved}`);
      }
      const parent = path.dirname(existingAncestor);
      if (parent === existingAncestor) throw new Error(`${label} has no existing ancestor: ${resolved}`);
      missingSegments.unshift(path.basename(existingAncestor));
      existingAncestor = parent;
    }
  }
  const canonicalAncestor = await fse.realpath(existingAncestor);
  return path.resolve(canonicalAncestor, ...missingSegments);
}

export async function assertMutableRootOutsideTarget(
  mutableRoot: string,
  targetProjectPath: string,
  additionalWriteRoots: readonly string[] = []
): Promise<void> {
  const canonicalRoot = await canonicalNativeLocation(mutableRoot, "Agent Loop mutable root", false);
  const canonicalWriteRoots = await Promise.all([
    canonicalNativeLocation(targetProjectPath, "Target project path", true),
    ...additionalWriteRoots.map((entry) =>
      canonicalNativeLocation(entry, "Additional provider write root", true)
    ),
  ]);
  const rootForComparison = process.platform === "win32" ? canonicalRoot.toLowerCase() : canonicalRoot;
  for (const canonicalWriteRoot of canonicalWriteRoots) {
    const writeRootForComparison = process.platform === "win32"
      ? canonicalWriteRoot.toLowerCase()
      : canonicalWriteRoot;
    const relative = path.relative(writeRootForComparison, rootForComparison);
    const mutableRootIsWritable =
      relative === "" ||
      (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
    if (mutableRootIsWritable) {
      throw new Error(
        `Unsafe Agent Loop layout: mutable root '${canonicalRoot}' is inside or identical to ` +
        `provider write root '${canonicalWriteRoot}'. Choose a --root outside every provider write root.`
      );
    }
  }
}

function warnFullAccessLimitations(): void {
  console.warn(
    "[security] --full-access may grant the selected provider host-wide filesystem and tool access. " +
    "Separating the Agent Loop mutable root reduces accidental writes but is not a security boundary " +
    "for a provider running with the same OS user privileges."
  );
}

function extractAbsolutePathCandidates(markdown: string): string[] {
  const patterns = [
    /(?<![A-Za-z0-9_])[A-Za-z]:[\\/][^\s`"'<>|*?]*/g,
    /(?<!\\)\\\\[^\s`"'<>|*?]+/g,
    /(?<![:\\A-Za-z0-9_])\\(?!\\)[^\s`"'<>|*?]+/g,
    /(?<![A-Za-z0-9_:\/])\/(?!\/)[^\s`"'<>|*?]*/g,
    /(?<![A-Za-z0-9_:\/])\/\/[^\s`"'<>|*?]+/g,
  ];
  return patterns.flatMap((pattern) => markdown.match(pattern) ?? []);
}

export function findAbsolutePathsOutsideTarget(
  markdown: string,
  targetProjectPath: string
): string[] {
  return findAbsolutePathsOutsideAllowedRoots(markdown, targetProjectPath, []);
}

export function findAbsolutePathsOutsideAllowedRoots(
  markdown: string,
  targetProjectPath: string,
  additionalAllowedPaths: readonly string[]
): string[] {
  const allowedRoots = [
    canonicalizeAbsolutePath(targetProjectPath),
    ...normalizeAdditionalAllowedPaths(additionalAllowedPaths, targetProjectPath),
  ];
  const candidates = extractAbsolutePathCandidates(markdown);
  const unique = new Map<string, string>();
  for (const rawCandidate of candidates) {
    const candidate = rawCandidate.replace(/[\]),.;:]+$/g, "");
    if (!candidate || !allowedRoots.some((root) => pathIsContained(root, candidate))) {
      const dialect = detectAbsolutePathDialect(candidate);
      const key = dialect === "win32" ? `win32:${candidate.toLowerCase()}` : `posix:${candidate}`;
      if (candidate) unique.set(key, candidate);
    }
  }
  return [...unique.values()];
}

export function summarizeAttemptEvents(result: PtyRunResult): Pick<
  LoopHistoryEntry,
  "lastEventType" | "lastToolName" | "lastToolStatus" | "lastToolCommand" |
  "lastStepFinishReason" | "lastStepFinishTotalTokens" | "maxObservedTotalTokens"
> {
  const lastEvent = result.events[result.events.length - 1];
  const lastEventType = typeof lastEvent?.type === "string" ? lastEvent.type : null;
  const part = lastEvent?.part as Record<string, unknown> | undefined;
  const state = part?.state as Record<string, unknown> | undefined;
  const input = state?.input as Record<string, unknown> | undefined;
  const command = typeof input?.command === "string"
    ? input.command.replace(/\s+/g, " ").trim().slice(0, 500)
    : null;
  const stepFinishEvents = result.events.filter((event) => event.type === "step_finish");
  const lastStepFinish = stepFinishEvents[stepFinishEvents.length - 1];
  const lastStepPart = lastStepFinish?.part as Record<string, unknown> | undefined;
  const lastStepTokens = lastStepPart?.tokens as Record<string, unknown> | undefined;
  let maxObservedTotalTokens: number | null = null;
  for (const event of result.events) {
    const eventPart = event.part as Record<string, unknown> | undefined;
    const tokens = eventPart?.tokens as Record<string, unknown> | undefined;
    const usage = event.usage as Record<string, unknown> | undefined;
    const message = event.message as Record<string, unknown> | undefined;
    const messageUsage = message?.usage as Record<string, unknown> | undefined;
    const total = typeof tokens?.total === "number"
      ? tokens.total
      : typeof usage?.total_tokens === "number"
        ? usage.total_tokens
        : typeof usage?.input_tokens === "number" || typeof usage?.output_tokens === "number"
          ? Number(usage.input_tokens ?? 0) + Number(usage.output_tokens ?? 0)
          : typeof messageUsage?.input_tokens === "number" || typeof messageUsage?.output_tokens === "number"
            ? Number(messageUsage.input_tokens ?? 0) + Number(messageUsage.output_tokens ?? 0)
            : null;
    if (total !== null && (maxObservedTotalTokens === null || total > maxObservedTotalTokens)) {
      maxObservedTotalTokens = total;
    }
  }
  const lastItem = lastEvent?.item as Record<string, unknown> | undefined;
  const lastMessage = lastEvent?.message as Record<string, unknown> | undefined;
  const lastContent = Array.isArray(lastMessage?.content) ? lastMessage.content : [];
  const lastClaudeTool = [...lastContent].reverse().find(
    (block) => Boolean(block) && typeof block === "object" && (block as AnyObj).type === "tool_use"
  ) as Record<string, unknown> | undefined;
  return {
    lastEventType,
    lastToolName: typeof part?.tool === "string"
      ? part.tool
      : typeof lastItem?.type === "string" && lastItem.type !== "agent_message"
        ? lastItem.type
        : typeof lastClaudeTool?.name === "string" ? lastClaudeTool.name : null,
    lastToolStatus: typeof state?.status === "string"
      ? state.status
      : typeof lastItem?.status === "string" ? lastItem.status : null,
    lastToolCommand: command,
    lastStepFinishReason:
      typeof lastStepPart?.reason === "string" ? lastStepPart.reason : null,
    lastStepFinishTotalTokens:
      typeof lastStepTokens?.total === "number" ? lastStepTokens.total : null,
    maxObservedTotalTokens,
  };
}

export function classifyAgentFailure(result: PtyRunResult, completionReason: string | null): AttemptFailure {
  const combined = `${result.failureMessage ?? ""}\n${result.assistantText ?? ""}\n${result.output}`.toLowerCase();
  let kind: FailureKind = result.failureKind ?? "unknown";
  let retryable = true;
  if (result.cancelled) {
    kind = "cancelled";
    retryable = false;
  } else if (
    result.exitCode === 2 &&
    /unexpected argument|unknown (?:argument|option)|unrecognized (?:argument|option)|invalid value .* for|usage:\s*\S+/.test(combined)
  ) {
    kind = "spawn_error";
    retryable = false;
  } else if (
    completionReason?.startsWith("This read-only role emitted a file mutation event") &&
    result.exitCode === 0
  ) {
    kind = "role_violation";
    retryable = false;
  } else if (completionReason && result.exitCode === 0) {
    kind = "incomplete_response";
  } else if (kind === "unknown" || kind === "process_exit") {
    if (
      /rate.?limit|too many requests|(?:http(?: status)?|status(?: code)?)\s*[:=]?\s*429\b/.test(combined)
    ) {
      kind = "rate_limited";
    } else if (
      /unauthori[sz]ed|authentication (?:failed|required)|invalid api key|login required|(?:http(?: status)?|status(?: code)?)\s*[:=]?\s*401\b/.test(combined)
    ) {
      kind = "auth";
      retryable = false;
    } else if (/model .*not found|unknown model|no such model|model unavailable/.test(combined)) {
      kind = "model_unavailable";
      retryable = false;
    } else if (/permission denied|access denied|operation not permitted|eacces|eperm/.test(combined)) {
      kind = "permission";
      retryable = false;
    } else if (/econnreset|econnrefused|enotfound|network|socket|connection (?:closed|lost|reset)|fetch failed/.test(combined)) {
      kind = "network";
    }
  }
  if (kind === "spawn_error" && /enoent|not recognized|not found/.test(combined)) retryable = false;
  if (["auth", "model_unavailable", "permission", "role_violation", "cancelled", "orphaned_process"].includes(kind)) {
    retryable = false;
  }
  return {
    kind,
    message:
      (kind === "spawn_error" && result.output.trim() ? result.output.trim().slice(-2000) : null) ??
      (result.exitCode === 0 ? completionReason : null) ??
      result.failureMessage ??
      `Agent process ended with exit code ${result.exitCode}`,
    retryable,
    occurredAt: new Date().toISOString(),
    attemptId: null,
    role: null,
    phase: null,
    exitCode: result.exitCode,
    cliSessionId: result.cliSessionId ?? null,
  };
}

function retryAfterMs(result: PtyRunResult): number | null {
  const combined = `${result.assistantText ?? ""}\n${result.output}`;
  const seconds = combined.match(/retry-after\s*[:=]\s*(\d+)/i);
  if (seconds) return Math.min(120_000, Math.max(1_000, Number(seconds[1]) * 1_000));
  return null;
}

async function initGoalTree(
  rootDir: string,
  sessionId: string,
  pipeline: PipelineDefinition
): Promise<{ sessionDir: string; rooms: Record<AgentRole, AgentRoom> }> {
  const cfg = loopConfig.paths;
  const sessionsRoot = path.join(rootDir, cfg.sessionsRoot);
  const sessionDir = resolveContainedSessionPath(sessionsRoot, sessionId);

  const rooms: Partial<Record<AgentRole, AgentRoom>> = {};

  for (const roleDefinition of pipeline.roles) {
    const role = roleDefinition.id;
    const roomDirName = roomDirectoryName(pipeline, role);
    const roomDir = path.join(sessionDir, roomDirName);
    await fse.ensureDir(roomDir);
    rooms[role] = {
      role,
      statePath: path.join(roomDir, cfg.roomFileNames.state),
      skillsPath: path.join(roomDir, cfg.roomFileNames.skills),
      inputPayloadPath: path.join(roomDir, cfg.roomFileNames.input),
      outputPayloadPath: path.join(roomDir, cfg.roomFileNames.output),
    };
    await atomicWriteJson(rooms[role]!.skillsPath, skillsForPipelineRole(roleDefinition));
    await atomicWriteJson(rooms[role]!.statePath, { status: "idle", lastExitCode: null, lastRunAt: null });
    await atomicWriteJson(rooms[role]!.inputPayloadPath, {});
    await atomicWriteJson(rooms[role]!.outputPayloadPath, {});
  }

  await fse.ensureDir(path.join(sessionDir, cfg.loopHistoryDirName));
  await fse.ensureDir(path.join(sessionDir, cfg.attemptLogsDirName));
  await ensureControlQueue(getControlQueuePaths(sessionDir, cfg.controlDirName));

  const notesPath = path.join(sessionDir, cfg.sessionFileNames.progressNotes);
  if (!await fse.pathExists(notesPath)) {
    await fse.writeFile(notesPath, "", "utf8");
  }

  return { sessionDir, rooms: rooms as Record<AgentRole, AgentRoom> };
}

function skillsForPipelineRole(role: PipelineRole): AgentSkills {
  const base = DEFAULT_SKILLS[role.modelRole];
  return {
    ...base,
    role: role.id,
    enforcedRules: [
      ...base.enforcedRules,
      ...(role.instructions.trim() ? [role.instructions.trim()] : []),
    ],
    systemPrompt: `${base.systemPrompt}\n\nRole specialization: ${role.description}\n${role.instructions}`.trim(),
  };
}

function roomDirectoryName(pipeline: PipelineDefinition, roleId: string): string {
  const configured = loopConfig.paths.roomDirNames[roleId];
  if (configured) return configured;
  const index = pipeline.roles.findIndex((role) => role.id === roleId);
  if (index < 0) throw new Error(`Unknown pipeline role: ${roleId}`);
  return `${index}_${roleId}`;
}

export function buildPrompt(
  role: AgentRole,
  payload: HandoffPayload,
  roleDefinition?: PipelineRole,
  stage?: PipelineStage,
  stageType?: PipelineStageType
): string {
  const resolvedRole =
    roleDefinition ??
    ({
      id: role,
      modelRole: role as BuiltinModelRole,
      description: "",
      instructions: "",
    } satisfies PipelineRole);
  const skills = skillsForPipelineRole(resolvedRole);
  const lines: string[] = [];
  lines.push(`You are the ${role.toUpperCase()} agent in an autonomous coding loop.`);
  lines.push(`Session ID: ${payload.sessionId}`);
  lines.push(`Phase: ${payload.phase}`);
  lines.push(`Loop iteration: ${payload.loopCount}`);
  lines.push("");
  lines.push("=== ORIGINAL USER GOAL (AUTHORITATIVE) ===");
  lines.push(payload.originalGoal);
  lines.push("");
  lines.push("=== APPROVED IMPLEMENTATION PLAN (SUBORDINATE STRATEGY) ===");
  lines.push(payload.approvedPlan?.trim() || "(no plan has been approved yet)");
  lines.push("");
  lines.push("The original user goal is the acceptance contract and is never replaced by the approved plan.");
  lines.push("If the plan omits, narrows, reinterprets, or conflicts with the original goal, the original goal wins.");
  lines.push("A named reference product must not be replaced with a merely similar genre based on assumption.");
  const requirementLedger = payload.requirements ?? deriveRequirementLedger(payload.originalGoal);
  lines.push("");
  lines.push("=== FIXED REQUIREMENT LEDGER (MACHINE-CHECKED) ===");
  for (const item of requirementLedger.items) {
    lines.push(`- ${item.id} [${item.category.toUpperCase()}]: ${item.text}`);
  }
  const latestStatuses = latestRequirementStatuses(requirementLedger);
  if (latestStatuses.size > 0) {
    lines.push("Latest recorded evidence status:");
    for (const item of requirementLedger.items) {
      lines.push(`- ${item.id}: ${latestStatuses.get(item.id) ?? "UNKNOWN"}`);
    }
  }
  lines.push("Do not merge, delete, weaken, or silently reinterpret these requirements.");
  if (payload.lockedReferenceIdentity) {
    lines.push("");
    lines.push("=== LOCKED REFERENCE IDENTITY (MUST NOT CHANGE) ===");
    lines.push(JSON.stringify(payload.lockedReferenceIdentity, null, 2));
    lines.push("All implementation, tests, research, and approval must refer to this exact title, creator, and package/product ID.");
    lines.push("A different product with a similar title, description, genre, or marketing phrase is not an acceptable substitute.");
  }
  lines.push("");
  lines.push("=== TARGET PROJECT PATH ===");
  lines.push(payload.targetProjectPath);
  lines.push("");
  lines.push("=== WRITE ACCESS ROOTS ===");
  if (payload.accessMode === "full_access") {
    lines.push("FULL FILESYSTEM ACCESS was explicitly granted by the operator for this session.");
  } else {
    lines.push(`- ${payload.targetProjectPath} (primary target)`);
    for (const allowedPath of payload.additionalAllowedPaths) {
      lines.push(`- ${allowedPath} (approved after an access request)`);
    }
    lines.push("Do not create, modify, move, or delete files outside these roots.");
    lines.push("If another location is required, report the exact absolute path instead of writing to it.");
  }
  lines.push("");
  lines.push("=== PROGRESS NOTES (cumulative) ===");
  lines.push(payload.progressNotes.length > 0 ? payload.progressNotes : "(none yet)");
  lines.push("");
  if (payload.failureDigest && payload.failureDigest.length > 0) {
    lines.push("=== LAST FAILURE DIGEST (address these specifically) ===");
    lines.push(payload.failureDigest);
    lines.push("");
  }
  if (payload.failureEvidence) {
    lines.push("=== AUTHORITATIVE FAILURE EVIDENCE (JSON; do not contradict) ===");
    lines.push(JSON.stringify(payload.failureEvidence, null, 2));
    lines.push("");
    lines.push("Use the evidence above for all factual claims. Separate verified facts from hypotheses.");
    lines.push("");
  }
  if (payload.interruptMessage && payload.interruptMessage.length > 0) {
    lines.push("=== HUMAN OPERATOR INTERRUPT MESSAGE ===");
    lines.push(payload.interruptMessage);
    lines.push("");
    lines.push("The operator has paused this session with the above message.");
    lines.push("Address their specific concerns in your briefing.");
    lines.push("");
  }
  if (payload.planRevised) {
    lines.push("=== PLAN REVISION — RE-IMPLEMENTATION REQUIRED ===");
    lines.push("The operator revised the plan while the session was paused or interrupted.");
    lines.push("Review ALL existing changes in the target project.");
    lines.push("Update the implementation to match the REVISED goal/plan above.");
    lines.push("Do not assume the previous implementation still matches the plan.");
    lines.push("");
  }
  lines.push("=== ENFORCED RULES (do NOT violate) ===");
  for (const rule of skills.enforcedRules) {
    lines.push(`- ${rule}`);
  }
  lines.push("");
  lines.push("=== YOUR INSTRUCTIONS ===");
  lines.push(skills.systemPrompt);
  const useWebSearch = payload.toolAccess?.webSearch.enabled ?? false;
  const mcpServers = payload.toolAccess
    ? enabledMcpServers(payload.toolAccess)
    : [];
  if (useWebSearch || mcpServers.length > 0) {
    lines.push("");
    lines.push("=== CONNECTED INFORMATION TOOLS ===");
    if (useWebSearch) {
      lines.push("- Web search is enabled. Use it when the goal depends on current, external, or source-verifiable information.");
    }
    for (const server of mcpServers) {
      lines.push(`- MCP server '${server.name}' (${server.id}) is connected for this role.`);
    }
    lines.push("Prefer connected MCP sources over generic web search when they directly cover the requested data.");
  }
  const externalResearchRequired = goalRequiresExternalResearch(payload.originalGoal);
  const namedReferenceRequired = goalRequiresNamedReferenceVerification(payload.originalGoal);
  const requiresIndependentResearch = externalResearchRequired &&
    ["planning", "review", "approval"].includes(stageType?.executor ?? "");
  if (externalResearchRequired) {
    lines.push("");
    lines.push("=== EXTERNAL RESEARCH REQUIREMENT ===");
    lines.push("The original goal explicitly requires internet research; this is a mandatory acceptance requirement.");
    lines.push("Do not infer a named product's gameplay from its title, category, or a vague store description.");
    lines.push("Preserve exact product identity and distinguish verified mechanics from assumptions.");
    if (requiresIndependentResearch) {
      lines.push("You MUST perform web search during this attempt and report source-supported evidence.");
      if (namedReferenceRequired) {
        lines.push("First identify the exact named product. Use this exact structure:");
        lines.push("[REFERENCE_IDENTITY]");
        lines.push("TITLE: <exact store/product title>");
        lines.push("CREATOR: <verified developer/publisher/owner>");
        lines.push("PACKAGE_ID: <verified package or stable product ID>");
        lines.push("CANONICAL_URL: https://official-or-store-page.example");
        lines.push("CANDIDATE_COUNT: <number of distinct products found for the requested name>");
        lines.push("IDENTITY_MATCH: EXACT|AMBIGUOUS|SIMILAR|UNKNOWN");
        lines.push("CONFIDENCE: HIGH|MEDIUM|LOW");
        lines.push("[/REFERENCE_IDENTITY]");
        lines.push("Then provide at least two evidence blocks from two distinct domains: one IDENTITY source and one GAMEPLAY source.");
      }
      lines.push("[RESEARCH_EVIDENCE]");
      if (namedReferenceRequired) lines.push("EVIDENCE_TYPE: IDENTITY|GAMEPLAY|SUPPORTING");
      lines.push("SOURCE: https://direct-source-url.example");
      if (namedReferenceRequired) lines.push("REFERENCE_ID: <the exact PACKAGE_ID above>");
      lines.push("VERIFIED_FACT: <a source-supported gameplay fact>");
      lines.push("LIMITATION: <what the checked sources do not establish>");
      if (!namedReferenceRequired) lines.push("CONFIDENCE: HIGH|MEDIUM|LOW");
      lines.push("[/RESEARCH_EVIDENCE]");
      lines.push("Use real direct URLs, not the placeholder above.");
      if (namedReferenceRequired) {
        lines.push("Only IDENTITY_MATCH: EXACT with CONFIDENCE: HIGH may proceed.");
        lines.push("Only CANDIDATE_COUNT: 1 may proceed. List all distinct title/creator/package candidates in VERIFIED_FACT or LIMITATION evidence.");
        lines.push("If the title is ambiguous, CANDIDATE_COUNT is not 1, the creator/package ID is unknown, or exact gameplay cannot be tied to that same ID, output RESEARCH_BLOCKED on its own line.");
        lines.push("MEDIUM confidence, a similar game, a shared phrase, or a matching genre must never be approved as the requested reference.");
      } else {
        lines.push("If reliable sources do not establish the requested facts, set CONFIDENCE: LOW, output RESEARCH_BLOCKED on its own line, and do not guess or approve.");
      }
    }
  }
  if (stage?.instructions.trim()) {
    lines.push("");
    lines.push("=== CURRENT STAGE INSTRUCTIONS ===");
    lines.push(stage.instructions.trim());
  }
  if (stageType && ["implementation", "test", "review", "approval"].includes(stageType.executor)) {
    lines.push("");
    lines.push("=== REQUIREMENT EVIDENCE OUTPUT CONTRACT ===");
    lines.push("Before the completion token, emit one block for EVERY requirement ID:");
    lines.push("[REQUIREMENT_EVIDENCE]");
    lines.push("REQ_ID: REQ-001");
    lines.push("STATUS: SATISFIED|PARTIAL|FAILED|BLOCKED");
    lines.push("EVIDENCE: <specific file, command/result, observed behavior, or blocker>");
    lines.push("[/REQUIREMENT_EVIDENCE]");
    lines.push("Use SATISFIED only for concrete observed evidence. PASS or APPROVED is rejected unless every requirement is SATISFIED.");
  }
  if (stage && stageType?.completionContract === "plan_options") {
    lines.push("");
    lines.push("=== PLANNING COMPLETION CONTRACT ===");
    lines.push(
      `This stage requires exactly ${stage.planOptionsCount} numbered plan options in the existing OPTION format. ` +
      "This stage-specific count supersedes any generic role-template count. " +
      "Exception: when required research cannot establish the named reference's core gameplay, output the research evidence and RESEARCH_BLOCKED instead of inventing plan options."
    );
    lines.push(`Every option must explicitly list coverage for: ${requirementLedger.items.map((item) => item.id).join(", ")}.`);
  }
  lines.push("");
  lines.push(`When you have completed your task, output the token ${SENTINEL} on a line by itself, then stop.`);
  return lines.join("\n");
}

function buildCompletionRecoveryPrompt(
  role: AgentRole,
  roleDefinition: PipelineRole,
  stage: PipelineStage,
  stageType: PipelineStageType,
  state: Pick<
    LoopState,
    "sessionId" | "loopCount" | "targetProjectPath" | "accessMode" |
    "additionalAllowedPaths" | "refinedGoal" | "goal" | "lastFailure"
    | "toolAccess" | "referenceIdentity" | "requirements"
  >,
  recoveryNumber: number,
  recoveryLimit: number
): string {
  const skills = skillsForPipelineRole(roleDefinition);
  const lines = [
    `You are the ${role.toUpperCase()} agent performing a bounded completion recovery.`,
    `Session ID: ${state.sessionId}`,
    `Phase: ${stage.id}`,
    `Loop iteration: ${state.loopCount}`,
    `Completion recovery: ${recoveryNumber}/${recoveryLimit}`,
    "",
    "=== WHY THIS FRESH SESSION EXISTS ===",
    "The prior agent process exited cleanly but did not satisfy the phase completion contract.",
    "Work may already exist. Inspect and reuse it; do not restart the phase or recreate broad scaffolding.",
    state.lastFailure
      ? `Prior failure: ${state.lastFailure.kind}: ${state.lastFailure.message}`
      : "Prior failure: incomplete response.",
    "",
    "=== TARGET PROJECT PATH ===",
    state.targetProjectPath,
    "",
    "=== ACCESS ===",
    state.accessMode === "full_access"
      ? "FULL FILESYSTEM ACCESS was explicitly granted by the operator."
      : `Writes must stay within: ${[state.targetProjectPath, ...state.additionalAllowedPaths].join(", ")}`,
    "",
    "=== ORIGINAL USER GOAL (AUTHORITATIVE) ===",
    state.goal.slice(0, 3000),
    "",
    "=== APPROVED IMPLEMENTATION PLAN (SUBORDINATE STRATEGY) ===",
    (state.refinedGoal || "(no approved plan)").slice(0, 3000),
    "",
    "The original goal wins over any conflict, omission, narrowing, or reinterpretation in the plan.",
    ...(state.referenceIdentity
      ? [
          "",
          "=== LOCKED REFERENCE IDENTITY (MUST NOT CHANGE) ===",
          JSON.stringify(state.referenceIdentity, null, 2),
        ]
      : []),
    "",
    "=== RECOVERY RULES ===",
    "- Use targeted file reads and concise command output. Do not dump complete large files.",
    "- Complete only the missing verification/finalization work.",
    "- Do not claim success without executing the relevant checks.",
  ];
  if (["implementation", "test", "review", "approval"].includes(stageType.executor)) {
    lines.push(
      "",
      "=== FIXED REQUIREMENTS AND EVIDENCE CONTRACT ===",
      ...state.requirements.items.map((item) => `- ${item.id}: ${item.text}`),
      "Emit one [REQUIREMENT_EVIDENCE] block with REQ_ID, STATUS, and EVIDENCE for every ID before the completion token."
    );
  }
  if (stageType.completionContract === "verdict") {
    lines.push(
      "- Run existing test files before writing any new test infrastructure.",
      "- Do not modify production files. If a test fails, report it instead of hiding or bypassing it.",
      "- End with an independent line beginning VERDICT: PASS or VERDICT: FAIL; a concise reason may follow on that same line."
    );
  } else if (stageType.completionContract === "approval") {
    lines.push(
      "- End with an independent line beginning APPROVED or REJECTED; a concise reason may follow on that same line."
    );
  }
  if (
    goalRequiresExternalResearch(state.goal) &&
    ["planning", "review", "approval"].includes(stageType.executor)
  ) {
    lines.push(
      "- This recovery must independently use web search and include [RESEARCH_EVIDENCE], a direct SOURCE URL, VERIFIED_FACT or LIMITATION, and CONFIDENCE.",
      "- If core reference mechanics remain unverified, output RESEARCH_BLOCKED instead of guessing or approving."
    );
    if (goalRequiresNamedReferenceVerification(state.goal)) {
      lines.push(
        "- Named-reference recovery requires [REFERENCE_IDENTITY] with exact title, creator, package/product ID, canonical URL, CANDIDATE_COUNT: 1, IDENTITY_MATCH: EXACT, and CONFIDENCE: HIGH.",
        "- Provide IDENTITY and GAMEPLAY evidence for the same REFERENCE_ID from at least two distinct domains.",
        "- Ambiguous, similar, different-product, or medium-confidence evidence must output RESEARCH_BLOCKED."
      );
    }
  }
  for (const rule of skills.enforcedRules) lines.push(`- ${rule}`);
  lines.push(
    "",
    "=== COMPLETION CONTRACT ===",
    `After the required verdict when applicable, output ${SENTINEL} on its own line as the final line, then stop.`
  );
  return lines.join("\n");
}

function parseArgs(args: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const eqIdx = key.indexOf("=");
      if (eqIdx >= 0) {
        result[key.slice(0, eqIdx)] = key.slice(eqIdx + 1);
        continue;
      }
      if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
        result[key] = args[++i];
      } else {
        result[key] = "true";
      }
    }
  }
  return result;
}

function parseIntSafe(value: string | undefined, defaultValue: number): number {
  if (value === undefined || value === "true" || value.length === 0) return defaultValue;
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return defaultValue;
  return n;
}

export function boundedAttemptTimeoutMs(
  phaseTimeoutMs: number,
  cycleDeadlineMs: number,
  nowMs = Date.now()
): number {
  return Math.max(0, Math.min(phaseTimeoutMs, cycleDeadlineMs - nowMs));
}

export async function cleanupRecoveredChildProcesses(
  childPids: number[],
  killTimeoutMs: number,
  dependencies: {
    currentPid: number;
    check: typeof checkProcessLiveness;
    terminate: typeof terminateProcessTreeBounded;
  } = {
    currentPid: process.pid,
    check: checkProcessLiveness,
    terminate: terminateProcessTreeBounded,
  }
): Promise<{ orphanedPid: number | null }> {
  for (const childPid of childPids) {
    let liveness = dependencies.check(childPid);
    if (childPid === dependencies.currentPid) {
      liveness = "unknown";
    } else if (liveness !== "dead") {
      liveness = await dependencies.terminate(childPid, killTimeoutMs);
    }
    if (liveness !== "dead") return { orphanedPid: childPid };
  }
  return { orphanedPid: null };
}

export function shouldStartManualRecoveryCycle(
  state: LoopState,
  recoveryResume: boolean
): boolean {
  return (
    !recoveryResume &&
    [
      LoopStatus.PAUSED,
      LoopStatus.WAITING_USER,
      LoopStatus.RECOVERING,
      LoopStatus.STOPPED,
      LoopStatus.BLOCKED,
    ].includes(state.status) &&
    Boolean(
      state.lastFailure ||
      state.interruptBriefing ||
      (state.activeAttempt && state.activeAttempt.status !== "succeeded")
    )
  );
}

export interface AttemptSpendEvidence {
  assistantTextBytes: number | null;
  maxObservedTotalTokens: number | null;
}

export type ExhaustedFailureDisposition =
  | "pause_stagnation"
  | "recover_transport"
  | "wait_for_user"
  | "blocked"
  | "stopped";

export function classifyExhaustedFailureDisposition(
  failure: AttemptFailure,
  attempts: AttemptSpendEvidence[]
): ExhaustedFailureDisposition {
  if (failure.kind === "orphaned_process") return "blocked";
  if (failure.kind === "cancelled") return "stopped";
  if (["auth", "model_unavailable", "permission", "role_violation"].includes(failure.kind)) {
    return "wait_for_user";
  }
  if (failure.kind === "spawn_error" && !failure.retryable) return "wait_for_user";

  const observedSpendAttempts = attempts.filter(
    (attempt) =>
      (attempt.maxObservedTotalTokens ?? 0) > 0 ||
      (attempt.assistantTextBytes ?? 0) > 0
  ).length;
  if (failure.kind === "rate_limited") return "recover_transport";
  if (failure.retryable && observedSpendAttempts < 2) return "recover_transport";
  return observedSpendAttempts >= 2 ? "pause_stagnation" : "wait_for_user";
}

export function automaticRecoveryDelayMs(
  cycle: number,
  backoffMs: number[]
): number {
  if (backoffMs.length === 0) return 60_000;
  return backoffMs[Math.min(Math.max(1, cycle) - 1, backoffMs.length - 1)];
}

function parseRetryBackoff(
  value: string | undefined,
  fallback: number[],
  optionName = "--retry-backoff"
): number[] {
  if (!value || value === "true") return [...fallback];
  const parsed = value.split(",").map((part) => Number.parseInt(part.trim(), 10));
  if (parsed.length === 0 || parsed.some((item) => !Number.isFinite(item) || item <= 0)) {
    throw new Error(`${optionName} must be a comma-separated list of positive milliseconds.`);
  }
  return parsed;
}

function applyResilienceOverrides(
  parsed: Record<string, string>,
  current: ResilienceSettings
): ResilienceSettings {
  return {
    transportTimeoutMs: parseIntSafe(parsed["transport-timeout"], current.transportTimeoutMs),
    toolTimeoutMs: parseIntSafe(parsed["tool-timeout"], current.toolTimeoutMs),
    maxAgentAttempts: parseIntSafe(parsed["max-agent-attempts"], current.maxAgentAttempts),
    maxCompletionRecoveryAttempts: parseIntSafe(
      parsed["completion-recovery-attempts"],
      current.maxCompletionRecoveryAttempts
    ),
    maxAutomaticRecoveryCycles: parseIntSafe(
      parsed["automatic-recovery-cycles"],
      current.maxAutomaticRecoveryCycles
    ),
    automaticRecoveryBackoffMs: parseRetryBackoff(
      parsed["automatic-recovery-backoff"],
      current.automaticRecoveryBackoffMs,
      "--automatic-recovery-backoff"
    ),
    retryBackoffMs: parseRetryBackoff(parsed["retry-backoff"], current.retryBackoffMs),
    phaseRecoveryBudgetMs: parseIntSafe(
      parsed["phase-recovery-budget"],
      current.phaseRecoveryBudgetMs
    ),
    terminationGraceMs: parseIntSafe(parsed["termination-grace"], current.terminationGraceMs),
    killTimeoutMs: parseIntSafe(parsed["kill-timeout"], current.killTimeoutMs),
    heartbeatIntervalMs: parseIntSafe(
      parsed["heartbeat-interval"],
      current.heartbeatIntervalMs
    ),
    leaseTtlMs: parseIntSafe(parsed["lease-ttl"], current.leaseTtlMs),
    maxInMemoryOutputBytes: parseIntSafe(
      parsed["max-output-bytes"],
      current.maxInMemoryOutputBytes
    ),
  };
}

function validateRuntimeSettings(
  maxIterations: number,
  phaseTimeoutMs: number,
  idleTimeoutMs: number,
  settings: ResilienceSettings
): void {
  const namedValues: Array<[string, number]> = [
    ["maxIterations", maxIterations],
    ["phaseTimeoutMs", phaseTimeoutMs],
    ["idleTimeoutMs", idleTimeoutMs],
    ["transportTimeoutMs", settings.transportTimeoutMs],
    ["toolTimeoutMs", settings.toolTimeoutMs],
    ["maxAgentAttempts", settings.maxAgentAttempts],
    ["phaseRecoveryBudgetMs", settings.phaseRecoveryBudgetMs],
    ["terminationGraceMs", settings.terminationGraceMs],
    ["killTimeoutMs", settings.killTimeoutMs],
    ["heartbeatIntervalMs", settings.heartbeatIntervalMs],
    ["leaseTtlMs", settings.leaseTtlMs],
    ["maxInMemoryOutputBytes", settings.maxInMemoryOutputBytes],
  ];
  for (const [name, value] of namedValues) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive integer.`);
    }
  }
  if (settings.maxAgentAttempts > 10) {
    throw new Error("maxAgentAttempts must be between 1 and 10.");
  }
  if (
    !Number.isSafeInteger(settings.maxCompletionRecoveryAttempts) ||
    settings.maxCompletionRecoveryAttempts < 0 ||
    settings.maxCompletionRecoveryAttempts > 3
  ) {
    throw new Error("maxCompletionRecoveryAttempts must be between 0 and 3.");
  }
  if (
    !Number.isSafeInteger(settings.maxAutomaticRecoveryCycles) ||
    settings.maxAutomaticRecoveryCycles < 0 ||
    settings.maxAutomaticRecoveryCycles > 10
  ) {
    throw new Error("maxAutomaticRecoveryCycles must be between 0 and 10.");
  }
  if (
    settings.transportTimeoutMs > phaseTimeoutMs ||
    idleTimeoutMs > phaseTimeoutMs ||
    settings.toolTimeoutMs > phaseTimeoutMs
  ) {
    throw new Error(
      "transportTimeoutMs, idleTimeoutMs, and toolTimeoutMs must not exceed phaseTimeoutMs."
    );
  }
  if (settings.heartbeatIntervalMs >= settings.leaseTtlMs) {
    throw new Error("heartbeatIntervalMs must be smaller than leaseTtlMs.");
  }
  if (settings.retryBackoffMs.length < Math.max(0, settings.maxAgentAttempts - 1)) {
    throw new Error("retryBackoffMs must contain at least maxAgentAttempts - 1 entries.");
  }
  if (settings.retryBackoffMs.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    throw new Error("All retryBackoffMs entries must be positive integers.");
  }
  if (
    settings.maxAutomaticRecoveryCycles > 0 &&
    (settings.automaticRecoveryBackoffMs.length === 0 ||
      settings.automaticRecoveryBackoffMs.some(
        (value) => !Number.isSafeInteger(value) || value <= 0
      ))
  ) {
    throw new Error("automaticRecoveryBackoffMs must contain positive delays when automatic recovery is enabled.");
  }
  const minimumRecoveryBudget =
    phaseTimeoutMs * settings.maxAgentAttempts +
    Math.ceil(
      settings.retryBackoffMs
        .slice(0, Math.max(0, settings.maxAgentAttempts - 1))
        .reduce((sum, value) => sum + value, 0) * 1.2
    );
  if (settings.phaseRecoveryBudgetMs < minimumRecoveryBudget) {
    throw new Error(
      `phaseRecoveryBudgetMs must be at least ${minimumRecoveryBudget}ms for the configured attempts and backoff.`
    );
  }
}

function printUsage(): void {
  console.log(`
Custom Agent Loop System - Dynamic Multi-Model Multi-Session Orchestrator

Usage:
  agent-loop init                                    Initialize the system in the current directory
  agent-loop models [--binary opencode] [--profile]  List available CLI models
  agent-loop run --goal "..." --target "..." [opts]  Start a new session
  agent-loop resume --session <id> [opts]            Resume a held session
  agent-loop revise-plan --session <id> --message "..."  Revise the plan with AI

Options for 'run':
  --goal <text>              The goal to achieve (required)
  --target <path>            Target project path (default: cwd)
  --full-access              Allow filesystem access outside the target without prompting
  --binary <name>            CLI binary name (default: opencode)
  --profile <name>           Legacy default provider: opencode | kilo | codex | claude
  --max-iterations <n>       Max loop iterations (default: 20)
  --phase-timeout <ms>       Progress-renewable attempt window (default: 900000)
  --idle-timeout <ms>        Model no-progress timeout after connection (default: 300000)
  --tool-timeout <ms>        Tool execution no-progress timeout (default: 600000)
  --transport-timeout <ms>   Initial connection no-output timeout (default: 120000)
  --phase-recovery-budget <ms> Total role recovery budget (default: 2880000)
  --max-agent-attempts <n>   Attempts per role (default: 3)
  --completion-recovery-attempts <n> Extra fresh-session contract recovery attempts (default: 1)
  --automatic-recovery-cycles <n> Automatic transport recovery cycles before waiting for the operator (default: 3)
  --automatic-recovery-backoff <ms,...> Cooldowns between automatic recovery cycles (default: 60000,300000,900000)
  --retry-backoff <ms,...>   Retry delays (default: 5000,30000)
  --termination-grace <ms>   Graceful PTY shutdown wait (default: 3000)
  --kill-timeout <ms>        Forced process-tree verification wait (default: 5000)
  --heartbeat-interval <ms>  Owner lease heartbeat (default: 5000)
  --lease-ttl <ms>           Owner lease expiry threshold (default: 20000)
  --max-output-bytes <n>     In-memory output ring size (default: 1048576)
  --planner-model <m>        Model for planner agent
  --implementer-model <m>    Model for implementer agent
  --tester-model <m>         Model for tester agent
  --qa-model <m>             Model for qa_lead agent
  --master-model <m>         Model for master agent
  --interrupter-model <m>    Model for interrupter agent
  --model-mapping <json>     Arbitrary pipeline role-to-model mapping
  --provider-mapping <json>  Arbitrary pipeline role-to-provider mapping
  --roles <path>             Agent role definition file (default: <root>/agent_roles.json)
  --loop <path>              Loop graph definition file (default: <root>/agent_loop.json)
  --session <id>             Pre-assigned session ID (optional; auto-generated if omitted)
  --root <path>              Orchestrator root dir (default: this file's dir)

Options for 'resume':
  --session <id>             Session ID to resume (required)
  --approve-access           Approve the pending access request before resuming
  --full-access              Grant full filesystem access before resuming
  --root <path>              Orchestrator root dir
`);
}

class LoopOrchestrator {
  private registry: SessionRegistry;
  private state: LoopState;
  private rooms: Record<AgentRole, AgentRoom>;
  private readonly rootDir: string;
  private readonly registryPath: string;
  private readonly sessionDir: string;
  private readonly controlPaths: ControlQueuePaths;
  private readonly ownership: SessionOwnership;
  private activeControlRequest: ClaimedControlRequest | null = null;
  private activePtyPid: number | null = null;
  private disposed = false;
  private signalHandlersRegistered = false;

  constructor(
    rootDir: string,
    registry: SessionRegistry,
    state: LoopState,
    rooms: Record<AgentRole, AgentRoom>,
    ownership?: SessionOwnership
  ) {
    const cfg = loopConfig.paths;
    this.rootDir = rootDir;
    this.registry = registry;
    this.state = state;
    this.rooms = rooms;
    this.registryPath = path.join(rootDir, cfg.registryFileName);
    this.sessionDir = resolveContainedSessionPath(path.join(rootDir, cfg.sessionsRoot), state.sessionId);
    this.controlPaths = getControlQueuePaths(this.sessionDir, cfg.controlDirName);
    this.ownership =
      ownership ??
      new SessionOwnership({
        sessionDir: this.sessionDir,
        ownerLockFileName: cfg.ownerLockFileName,
        leaseFileName: cfg.leaseFileName,
        heartbeatIntervalMs: state.resilience.heartbeatIntervalMs,
        leaseTtlMs: state.resilience.leaseTtlMs,
      });
  }

  private enterInterruptPhase(): void {
    if (this.state.phase !== this.state.pipeline.interruptStageId) {
      this.state.interruptedFromPhase = this.state.phase;
    }
    this.state.phase = this.state.pipeline.interruptStageId;
  }

  async run(
    preAcquiredOwnership?: SessionOwnershipAcquireResult,
    recoverPersistedAttempt = false
  ): Promise<void> {
    await assertMutableRootOutsideTarget(
      this.rootDir,
      this.state.targetProjectPath,
      this.state.additionalAllowedPaths
    );
    this.registerSignalHandlers();
    const ownershipResult =
      preAcquiredOwnership ?? await this.ownership.acquire();

    try {
      await cleanupClaudeMcpRuntimeFiles(path.join(this.sessionDir, "runtime"));
      await ensureControlQueue(this.controlPaths);
      await recoverClaimedControlRequests(this.controlPaths);
      if (ownershipResult.recoveredStaleOwner || recoverPersistedAttempt) {
        const staleChildPids = collectRecoveredChildPids(
          ownershipResult.previousLease,
          this.state.activeAttempt?.childPid
        );
        const cleanup = await cleanupRecoveredChildProcesses(
          staleChildPids,
          this.state.resilience.killTimeoutMs
        );
        if (cleanup.orphanedPid !== null) {
          const staleChildPid = cleanup.orphanedPid;
          const occurredAt = new Date().toISOString();
          this.state.status = LoopStatus.BLOCKED;
          this.state.statusReason =
            `Recovered stale owner but could not confirm termination of PTY pid ${staleChildPid}.`;
          if (this.state.activeAttempt) {
            this.state.activeAttempt.status = "orphaned_process";
            this.state.activeAttempt.endedAt = occurredAt;
            this.state.activeAttempt.failureKind = "orphaned_process";
            this.state.activeAttempt.failureMessage =
              `Recovered stale owner but could not confirm termination of PTY pid ${staleChildPid}.`;
          }
          this.state.lastFailure = {
            kind: "orphaned_process",
            message: `Recovered stale owner but could not confirm termination of PTY pid ${staleChildPid}.`,
            retryable: false,
            occurredAt,
            attemptId: this.state.activeAttempt?.attemptId ?? null,
            role: this.state.activeAttempt?.role ?? null,
            phase: this.state.phase,
            exitCode: null,
            cliSessionId: this.state.activeAttempt?.cliSessionId ?? null,
          };
          await this.appendProgressNote(
            `[Loop ${this.state.loopCount}] RECOVERY: Orphaned PTY pid ${staleChildPid}; automatic recovery blocked.`
          );
          await this.saveState();
          await this.saveRegistry();
          return;
        }

        if (
          this.state.activeAttempt &&
          ["starting", "running", "retry_wait"].includes(this.state.activeAttempt.status)
        ) {
          const recoveredAttempt = this.state.activeAttempt;
          recoveredAttempt.status = "process_exit";
          recoveredAttempt.childPid = null;
          recoveredAttempt.endedAt = new Date().toISOString();
          recoveredAttempt.failureKind = "process_exit";
          recoveredAttempt.failureMessage =
            "The previous orchestrator owner exited before the attempt completed.";
          this.state.lastFailure = {
            kind: "process_exit",
            message: recoveredAttempt.failureMessage,
            retryable: true,
            occurredAt: recoveredAttempt.endedAt,
            attemptId: recoveredAttempt.attemptId,
            role: recoveredAttempt.role,
            phase: recoveredAttempt.phase,
            exitCode: recoveredAttempt.exitCode,
            cliSessionId: recoveredAttempt.cliSessionId,
          };
          await this.saveState();
        }
      }

      while (!this.disposed && this.state.status === LoopStatus.RUNNING) {
      const pendingControl = await this.pollControlRequest();
      if (pendingControl) {
        if (pendingControl.request.type === "STOP") {
          await this.handleClaimedStop(pendingControl, "Session paused before the next phase.");
          return;
        }
        this.state.interruptMessage = pendingControl.request.message ?? "Operator requested interrupt.";
        this.enterInterruptPhase();
        await this.appendProgressNote(
          `[Loop ${this.state.loopCount}] INTERRUPT: Human operator message: "${this.state.interruptMessage}"`
        );
        await completeControlRequest(this.controlPaths, pendingControl, "completed", "Interrupt accepted.");
        await this.saveState();
        continue;
      }

      const currentStage = stageById(this.state.pipeline, this.state.phase);
      if (
        currentStage.countsIteration &&
        this.state.completedIterations >= this.state.maxIterations
      ) {
        this.state.status = LoopStatus.PAUSED;
        this.state.statusReason =
          `Completed implementation-to-verification cycle budget (${this.state.maxIterations}) was exhausted. ` +
          "Resume only after reviewing unresolved requirements or revising the plan.";
        await this.appendProgressNote(
          `[Loop ${this.state.loopCount}] PAUSED: ${this.state.statusReason}`
        );
        await this.saveState();
        await this.saveRegistry();
        console.warn(`[orchestrator] Max iterations (${this.state.maxIterations}) reached. Session PAUSED.`);
        return;
      }

      try {
        const currentStageType = stageTypeForStage(this.state.pipeline, currentStage);
        switch (currentStageType.executor) {
          case "planning":
            await this.runPlanning(currentStage);
            break;
          case "implementation":
            await this.runImplementation(currentStage, this.state.lastFailureDigest);
            this.state.lastFailureDigest = null;
            break;
          case "test":
            await this.runTestGeneration(currentStage);
            break;
          case "review":
            await this.runVerification(currentStage);
            break;
          case "approval":
            await this.runMasterApproval(currentStage);
            break;
          case "interrupt":
            await this.runInterrupter(currentStage);
            break;
          default:
            this.state.status = LoopStatus.FAILED;
            await this.saveState();
            await this.saveRegistry();
            return;
        }
        await this.saveState();
        await this.saveRegistry();
      } catch (err: unknown) {
        if (err instanceof StopRequestedError) {
          return;
        }
        if (err instanceof ImplementationPreflightError) {
          this.state.lastFailure = err.failure;
          const allowedRoots = [
            this.state.targetProjectPath,
            ...this.state.additionalAllowedPaths,
          ];
          this.state.pendingAccessRequest = {
            requestId: `access_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`,
            requestedPaths: [...err.outsidePaths],
            requestedAt: new Date().toISOString(),
            sourcePhase: this.state.phase,
            reason:
              `Implementation needs access outside the current target. ` +
              `Current allowed root(s): ${allowedRoots.join(", ")}`,
          };
          this.state.interruptBriefing = null;
          this.state.status = LoopStatus.WAITING_USER;
          this.state.statusReason =
            `Filesystem access approval is required for ${err.outsidePaths.length} path(s).`;
          await this.appendProgressNote(
            `[Loop ${this.state.loopCount}] ${this.state.phase}: Waiting for operator access approval for ` +
            `${err.outsidePaths.length} path(s).`
          );
          await this.saveState();
          await this.saveRegistry();
          return;
        }
        if (err instanceof InterruptRequestedError) {
          this.state.interruptMessage = err.messageText ?? "Operator requested interrupt.";
          this.enterInterruptPhase();
          await this.appendProgressNote(
            `[Loop ${this.state.loopCount}] INTERRUPT: ${this.state.interruptMessage}`
          );
          await this.saveState();
          await this.saveRegistry();
          continue;
        }
        if (err instanceof AgentRetriesExhaustedError) {
          this.state.lastFailure = err.failure;
          const evidence = await this.collectFailureEvidence();
          const disposition = classifyExhaustedFailureDisposition(
            err.failure,
            evidence.attempts
          );
          const observedTokenAttempts = evidence.attempts.filter(
            (attempt) => (attempt.maxObservedTotalTokens ?? 0) > 0
          ).length;
          const observedAssistantAttempts = evidence.attempts.filter(
            (attempt) => (attempt.assistantTextBytes ?? 0) > 0
          ).length;
          const localBriefing =
            `Agent ${err.role} could not complete phase ${this.state.phase} after the configured attempts.\n` +
            `Failure: ${err.failure.kind}: ${err.failure.message}\n` +
            `Evidence: ${evidence.attempts.length} attempt(s), ${observedTokenAttempts} with observed token usage, ` +
            `${observedAssistantAttempts} with assistant text.\n` +
            `Disposition: ${disposition}.`;
          this.state.interruptBriefing = localBriefing;
          await this.appendProgressNote(
            `[Loop ${this.state.loopCount}] ${this.state.phase}: Retry budget exhausted (${err.failure.kind}).`
          );
          if (executorForStage(this.state.pipeline, currentStage) === "interrupt") {
            const operatorRequested = Boolean(this.state.interruptMessage);
            this.state.status = operatorRequested ? LoopStatus.STOPPED : LoopStatus.PAUSED;
            this.state.statusReason = operatorRequested
              ? "Operator interrupt stopped after the bounded briefing attempt failed."
              : "Stagnation was already established; the bounded interrupter attempt also failed.";
            await this.saveState();
            await this.saveRegistry();
            return;
          }

          if (disposition === "recover_transport") {
            const previousCycle =
              this.state.automaticRecovery?.sourcePhase === this.state.phase
                ? this.state.automaticRecovery.cycle
                : 0;
            const nextCycle = previousCycle + 1;
            if (nextCycle <= this.state.resilience.maxAutomaticRecoveryCycles) {
              const delayMs = automaticRecoveryDelayMs(
                nextCycle,
                this.state.resilience.automaticRecoveryBackoffMs
              );
              const resumeAt = new Date(Date.now() + delayMs).toISOString();
              this.state.status = LoopStatus.RECOVERING;
              this.state.statusReason =
                `Transient ${err.failure.kind}; automatic recovery ${nextCycle}/` +
                `${this.state.resilience.maxAutomaticRecoveryCycles} is scheduled.`;
              this.state.automaticRecovery = {
                sourcePhase: this.state.phase,
                failureKind: err.failure.kind,
                cycle: nextCycle,
                maxCycles: this.state.resilience.maxAutomaticRecoveryCycles,
                resumeAt,
                reason: err.failure.message,
              };
              if (this.state.activeAttempt) this.state.activeAttempt.nextRetryAt = resumeAt;
              await this.appendProgressNote(
                `[Loop ${this.state.loopCount}] ${this.state.phase}: RECOVERING at ${resumeAt} ` +
                `(automatic cycle ${nextCycle}/${this.state.resilience.maxAutomaticRecoveryCycles}).`
              );
            } else {
              this.state.status = LoopStatus.WAITING_USER;
              this.state.statusReason =
                `Transient recovery remained unavailable after ${previousCycle} automatic cycle(s).`;
              this.state.automaticRecovery = null;
            }
          } else if (disposition === "pause_stagnation") {
            this.state.status = LoopStatus.PAUSED;
            this.state.statusReason =
              "Attempts consumed model output or tokens without satisfying the phase contract.";
            this.state.automaticRecovery = null;
          } else if (disposition === "blocked") {
            this.state.status = LoopStatus.BLOCKED;
            this.state.statusReason = err.failure.message;
            this.state.automaticRecovery = null;
          } else if (disposition === "stopped") {
            this.state.status = LoopStatus.STOPPED;
            this.state.statusReason = err.failure.message;
            this.state.automaticRecovery = null;
          } else {
            this.state.status = LoopStatus.WAITING_USER;
            this.state.statusReason = err.failure.message;
            this.state.automaticRecovery = null;
          }
          await this.saveState();
          await this.saveRegistry();
          return;
        }
        if (this.disposed || this.state.status !== LoopStatus.RUNNING) {
          return;
        }
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[orchestrator] Error in phase ${this.state.phase}: ${errMsg}`);

        const entry: ErrorSignature = {
          signature: normalizeSignature(errMsg),
          rawMessage: errMsg,
          timestamp: Date.now(),
          phase: this.state.phase,
        };
        const oscResult = pushAndCheckOscillation(this.state.errorQueue, entry);
        this.state.errorQueue = oscResult.queue;

        if (oscResult.oscillation) {
          console.warn(`[orchestrator] Oscillation detected. Entering INTERRUPT phase.`);
          this.enterInterruptPhase();
          await this.saveState();
          await this.saveRegistry();
        } else {
          if (executorForStage(this.state.pipeline, currentStage) !== "planning") {
            applyPipelineTarget(this.state, currentStage.onFailure);
          }
          await this.saveState();
          await this.saveRegistry();
        }
      }
      }
    } finally {
      await this.ownership.release();
    }
  }

  private async runPlanning(stage: PipelineStage): Promise<void> {
    if (this.state.planningComplete && this.state.stageResults[stage.id]) {
      applyPipelineTarget(this.state, stage.onSuccess);
      return;
    }

    if (this.state.awaitingPlanApproval) {
      return;
    }

    if (
      goalRequiresExternalResearch(this.state.goal) &&
      !this.state.toolAccess.webSearch.enabled
    ) {
      this.state.status = LoopStatus.WAITING_USER;
      this.state.statusReason =
        "The original goal explicitly requires internet research, but Web Search is disabled. Enable Web Search and resume the session.";
      await this.appendProgressNote(
        "[Loop 0] PLANNING: Waiting for Web Search because the original goal explicitly requires internet research."
      );
      await this.commitPhaseResult({});
      return;
    }

    const payload: HandoffPayload = {
      sessionId: this.state.sessionId,
      originalGoal: this.state.goal,
      approvedPlan: null,
      lockedReferenceIdentity: null,
      targetProjectPath: this.state.targetProjectPath,
      additionalAllowedPaths: this.state.additionalAllowedPaths,
      accessMode: this.state.accessMode,
      progressNotes: "",
      failureDigest: null,
      phase: stage.id,
      loopCount: 0,
      toolAccess: this.state.toolAccess,
      requirements: this.state.requirements,
    };

    const role = roleForStage(this.state.pipeline, stage);
    const stageType = stageTypeForStage(this.state.pipeline, stage);
    const prompt = buildPrompt(role.id, payload, role, stage, stageType);
    const result = await this.executeAgent(
      role.id,
      prompt,
      undefined,
      stageType,
      role.modelRole,
      stage.planOptionsCount
    );

    if (result.exitCode !== 0) {
      throw new Error(`Planner exited with code ${result.exitCode}`);
    }

    const output = extractOutput(result);
    if (isResearchBlockedResponse(output)) {
      this.state.referenceIdentity = null;
      this.recordStageResult(stage, output, null);
      this.state.status = LoopStatus.WAITING_USER;
      this.state.statusReason =
        "Internet research did not establish the named reference's core gameplay. Clarify the reference or provide a reliable source before resuming.";
      await this.appendProgressNote(
        "[Loop 0] PLANNING: Research evidence was insufficient; waiting for operator clarification instead of guessing."
      );
      await this.archiveLoop(0, stage.id, role.id, result, new Date(), new Date());
      await this.commitPhaseResult({});
      return;
    }
    if (goalRequiresNamedReferenceVerification(this.state.goal)) {
      const identity = parseReferenceIdentity(output);
      if (!identity) {
        throw new Error("Planner completed without a valid locked reference identity.");
      }
      this.state.referenceIdentity = identity;
    } else {
      this.state.referenceIdentity = null;
    }
    let choices = parsePlanChoices(output);

    const planPath = path.join(this.sessionDir, loopConfig.paths.sessionFileNames.plan);
    const choicesPath = path.join(this.sessionDir, loopConfig.paths.sessionFileNames.planChoices);
    const materialized = await materializePlanChoiceMarkdown(
      this.sessionDir,
      choices,
      loopConfig.paths.sessionFileNames.planOverview,
      loopConfig.paths.sessionFileNames.planOptionsDir
    );
    choices = materialized.choices;
    await atomicWriteJson(choicesPath, choices);

    this.state.planPath = planPath;
    this.state.planOverviewPath = materialized.overviewPath;
    this.state.selectedPlanChoiceId = null;
    this.recordStageResult(stage, output, null);
    if (!stage.requiresPlanApproval) {
      const selected = choices[0];
      await atomicWriteText(planPath, `${selected.body.trim()}\n`);
      this.state.refinedGoal = selected.body;
      this.state.planningComplete = true;
      this.state.awaitingPlanApproval = false;
      this.state.planApproved = true;
      this.state.selectedPlanChoiceId = selected.id;
      await this.appendProgressNote(
        `[Loop 0] ${stage.id}: ${choices.length} plan options generated; option ${selected.id} selected automatically.`
      );
      await this.archiveLoop(0, stage.id, role.id, result, new Date(), new Date());
      applyPipelineTarget(this.state, stage.onSuccess);
      await this.commitPhaseResult({});
      return;
    }

    this.state.awaitingPlanApproval = true;
    this.state.planApproved = false;
    this.state.status = LoopStatus.WAITING_USER;
    this.state.statusReason = "Select and approve a plan before implementation starts.";

    await this.appendProgressNote(`[Loop 0] PLANNING: ${choices.length} plan options generated. Awaiting user selection.`);
    await this.archiveLoop(0, stage.id, role.id, result, new Date(), new Date());
    await this.commitPhaseResult({
      phase: stage.id,
      status: LoopStatus.WAITING_USER,
      awaitingPlanApproval: true,
      planApproved: false,
      planPath,
      planOverviewPath: materialized.overviewPath,
      selectedPlanChoiceId: null,
    });
  }

  private async runImplementation(
    stage: PipelineStage,
    failureDigest: string | null
  ): Promise<void> {
    const implementationGoal = [this.state.goal, this.state.refinedGoal ?? ""]
      .filter((value) => value.trim().length > 0)
      .join("\n\n");
    const outsidePaths = this.state.accessMode === "full_access"
      ? []
      : findAbsolutePathsOutsideAllowedRoots(
          implementationGoal,
          this.state.targetProjectPath,
          this.state.additionalAllowedPaths
        );
    if (outsidePaths.length > 0) {
      throw new ImplementationPreflightError(
        {
          kind: "permission",
          message:
            `Approved implementation plan references path(s) outside the configured write-access roots ` +
            `(${[this.state.targetProjectPath, ...this.state.additionalAllowedPaths].join(", ")}): ` +
            outsidePaths.join(", "),
          retryable: false,
          occurredAt: new Date().toISOString(),
          attemptId: null,
          role: stage.role,
          phase: stage.id,
          exitCode: null,
          cliSessionId: null,
        },
        outsidePaths
      );
    }
    const planRevised = !!this.state.planRevisionPending;
    if (stage.countsIteration) this.state.loopCount++;
    await this.saveState();

    const notes = await this.readProgressNotes();
    const payload: HandoffPayload = {
      sessionId: this.state.sessionId,
      originalGoal: this.state.goal,
      approvedPlan: this.state.refinedGoal,
      lockedReferenceIdentity: this.state.referenceIdentity,
      targetProjectPath: this.state.targetProjectPath,
      additionalAllowedPaths: this.state.additionalAllowedPaths,
      accessMode: this.state.accessMode,
      progressNotes: notes,
      failureDigest,
      phase: stage.id,
      loopCount: this.state.loopCount,
      planRevised,
      toolAccess: this.state.toolAccess,
      requirements: this.state.requirements,
    };

    const role = roleForStage(this.state.pipeline, stage);
    const stageType = stageTypeForStage(this.state.pipeline, stage);
    const prompt = buildPrompt(role.id, payload, role, stage, stageType);
    const startedAt = new Date();
    const result = await this.executeAgent(
      role.id,
      prompt,
      undefined,
      stageType,
      role.modelRole
    );
    const endedAt = new Date();

    await this.archiveLoop(this.state.loopCount, stage.id, role.id, result, startedAt, endedAt);

    if (result.exitCode !== 0) {
      throw new Error(`Implementer exited with code ${result.exitCode}: ${extractOutput(result).slice(0, 200)}`);
    }

    if (planRevised) {
      this.state.planRevisionPending = false;
      await this.appendProgressNote(
        `[Loop ${this.state.loopCount}] IMPLEMENTATION: Code re-implemented after plan revision.`
      );
    } else {
      await this.appendProgressNote(`[Loop ${this.state.loopCount}] IMPLEMENTATION: Code changes applied.`);
    }
    this.recordStageResult(stage, extractOutput(result), null);
    applyPipelineTarget(this.state, stage.onSuccess);
    await this.commitPhaseResult({ planRevisionPending: false, lastFailureDigest: null });
  }

  private async runTestGeneration(stage: PipelineStage): Promise<void> {
    const notes = await this.readProgressNotes();
    const priorStageFailure =
      this.state.lastFailure?.phase === stage.id
        ? `[${this.state.lastFailure.kind}] ${this.state.lastFailure.message}\n` +
          "Inspect and run any existing tests before creating more test infrastructure."
        : null;
    const payload: HandoffPayload = {
      sessionId: this.state.sessionId,
      originalGoal: this.state.goal,
      approvedPlan: this.state.refinedGoal,
      lockedReferenceIdentity: this.state.referenceIdentity,
      targetProjectPath: this.state.targetProjectPath,
      additionalAllowedPaths: this.state.additionalAllowedPaths,
      accessMode: this.state.accessMode,
      progressNotes: notes,
      failureDigest: priorStageFailure,
      phase: stage.id,
      loopCount: this.state.loopCount,
      toolAccess: this.state.toolAccess,
      requirements: this.state.requirements,
    };

    const role = roleForStage(this.state.pipeline, stage);
    const stageType = stageTypeForStage(this.state.pipeline, stage);
    const prompt = buildPrompt(role.id, payload, role, stage, stageType);
    const startedAt = new Date();
    const result = await this.executeAgent(
      role.id,
      prompt,
      undefined,
      stageType,
      role.modelRole
    );
    const endedAt = new Date();

    await this.archiveLoop(this.state.loopCount, stage.id, role.id, result, startedAt, endedAt);

    if (result.exitCode !== 0) {
      throw new Error(`Tester exited with code ${result.exitCode}: ${extractOutput(result).slice(0, 200)}`);
    }

    const testerOutput = extractOutput(result);
    const assertedVerdict = parseTesterVerdict(testerOutput) ?? "FAIL";
    const requirementCoverage = evaluateRequirementCoverage(
      testerOutput,
      this.state.requirements.items
    );
    const verdict = assertedVerdict === "PASS" && !requirementCoverage.allSatisfied
      ? "FAIL"
      : assertedVerdict;
    if (assertedVerdict === "PASS" && verdict === "FAIL") {
      this.state.lastFailureDigest =
        `Tester PASS rejected by requirement gate. Missing evidence: ` +
        `${requirementCoverage.missing.join(", ") || "none"}; unresolved: ` +
        `${requirementCoverage.unresolved.join(", ") || "none"}.`;
    }
    await atomicWriteJson(this.rooms[role.id].outputPayloadPath, {
      loopCount: this.state.loopCount,
      producedAt: endedAt.toISOString(),
      output: testerOutput,
      verdict,
    });

    this.recordStageResult(stage, testerOutput, verdict);
    await this.appendProgressNote(`[Loop ${this.state.loopCount}] ${stage.id}: Test role ${role.id} verdict: ${verdict}.`);
    applyPipelineTarget(this.state, verdict === "PASS" ? stage.onSuccess : stage.onFailure);
    await this.commitPhaseResult({});
  }

  private async runVerification(stage: PipelineStage): Promise<void> {
    const evidence = Object.values(this.state.stageResults)
      .filter((result) => {
        const sourceStage = this.state.pipeline.stages.find((candidate) => candidate.id === result.stageId);
        return sourceStage ? executorForStage(this.state.pipeline, sourceStage) === "test" : result.executor === "test";
      })
      .map((result) => `[${result.stageId}] ${result.verdict ?? "UNKNOWN"}\n${result.output}`)
      .join("\n\n");
    const notes = await this.readProgressNotes();
    const payload: HandoffPayload = {
      sessionId: this.state.sessionId,
      originalGoal: this.state.goal,
      approvedPlan: this.state.refinedGoal,
      lockedReferenceIdentity: this.state.referenceIdentity,
      targetProjectPath: this.state.targetProjectPath,
      additionalAllowedPaths: this.state.additionalAllowedPaths,
      accessMode: this.state.accessMode,
      progressNotes: notes,
      failureDigest: null,
      phase: stage.id,
      loopCount: this.state.loopCount,
      toolAccess: this.state.toolAccess,
      requirements: this.state.requirements,
    };
    const role = roleForStage(this.state.pipeline, stage);
    const stageType = stageTypeForStage(this.state.pipeline, stage);
    const reviewPrompt =
      buildPrompt(role.id, payload, role, stage, stageType) +
      `\n\n=== PRIOR TEST EVIDENCE (truncated) ===\n${stripAnsi(evidence).slice(-6000)}`;
    const startedAt = new Date();
    const result = await this.executeAgent(
      role.id,
      reviewPrompt,
      undefined,
      stageType,
      role.modelRole
    );
    const endedAt = new Date();
    await this.archiveLoop(this.state.loopCount, stage.id, role.id, result, startedAt, endedAt);

    const output = extractOutput(result);
    if (isResearchBlockedResponse(output)) {
      this.recordStageResult(stage, output, null);
      this.state.status = LoopStatus.WAITING_USER;
      this.state.statusReason =
        "QA could not independently verify the named reference from web sources. Clarify the reference or provide a reliable source before resuming.";
      await this.appendProgressNote(
        `[Loop ${this.state.loopCount}] ${stage.id}: Research blocked; waiting for operator clarification.`
      );
      await this.commitPhaseResult({});
      return;
    }
    const verdict = parseMasterVerdict(output);
    const requirementCoverage = evaluateRequirementCoverage(
      output,
      this.state.requirements.items
    );
    const approved = verdict === "approved" && requirementCoverage.allSatisfied;
    this.recordStageResult(stage, output, approved ? "APPROVED" : "REJECTED");
    if (approved) {
      await this.appendProgressNote(`[Loop ${this.state.loopCount}] ${stage.id}: APPROVED by ${role.id}.`);
      applyPipelineTarget(this.state, stage.onSuccess);
      await this.commitPhaseResult({ lastFailureDigest: null });
      return;
    }

    const requirementGateFailure = verdict === "approved" && !requirementCoverage.allSatisfied
      ? `QA APPROVED rejected by requirement gate. Missing evidence: ` +
        `${requirementCoverage.missing.join(", ") || "none"}; unresolved: ` +
        `${requirementCoverage.unresolved.join(", ") || "none"}.`
      : "";
    const failureDigest = requirementGateFailure || extractFailureDigest(`${output}\n${evidence}`);
    const entry: ErrorSignature = {
      signature: normalizeSignature(failureDigest),
      rawMessage: failureDigest,
      timestamp: Date.now(),
      phase: stage.id,
    };
    const oscillation = pushAndCheckOscillation(this.state.errorQueue, entry);
    this.state.errorQueue = oscillation.queue;
    if (oscillation.oscillation || this.state.convergence.stagnantCycles >= 1) {
      this.enterInterruptPhase();
    } else {
      applyPipelineTarget(this.state, stage.onFailure);
    }
    await this.appendProgressNote(
      `[Loop ${this.state.loopCount}] ${stage.id}: REJECTED by ${role.id}; next=${this.state.phase}.`
    );
    await this.commitPhaseResult({ lastFailureDigest: failureDigest });
  }

  private async runMasterApproval(stage: PipelineStage): Promise<void> {
    const notes = await this.readProgressNotes();
    const payload: HandoffPayload = {
      sessionId: this.state.sessionId,
      originalGoal: this.state.goal,
      approvedPlan: this.state.refinedGoal,
      lockedReferenceIdentity: this.state.referenceIdentity,
      targetProjectPath: this.state.targetProjectPath,
      additionalAllowedPaths: this.state.additionalAllowedPaths,
      accessMode: this.state.accessMode,
      progressNotes: notes,
      failureDigest: null,
      phase: stage.id,
      loopCount: this.state.loopCount,
      toolAccess: this.state.toolAccess,
      requirements: this.state.requirements,
    };

    const role = roleForStage(this.state.pipeline, stage);
    const stageType = stageTypeForStage(this.state.pipeline, stage);
    const prompt = buildPrompt(role.id, payload, role, stage, stageType);
    const startedAt = new Date();
    const result = await this.executeAgent(
      role.id,
      prompt,
      undefined,
      stageType,
      role.modelRole
    );
    const endedAt = new Date();

    await this.archiveLoop(this.state.loopCount, stage.id, role.id, result, startedAt, endedAt);

    const fullOutput = extractOutput(result);
    if (isResearchBlockedResponse(fullOutput)) {
      this.recordStageResult(stage, fullOutput, null);
      this.state.status = LoopStatus.WAITING_USER;
      this.state.statusReason =
        "Final acceptance could not independently verify the named reference from web sources. Clarify the reference or provide a reliable source before resuming.";
      await this.appendProgressNote(
        `[Loop ${this.state.loopCount}] ${stage.id}: Research blocked; final approval withheld pending operator clarification.`
      );
      await this.commitPhaseResult({ masterApproved: false });
      return;
    }
    const verdictText = extractVerdictFromOutput(result);
    const verdict = parseMasterVerdict(verdictText);
    const requirementCoverage = evaluateRequirementCoverage(
      fullOutput,
      this.state.requirements.items
    );
    const approved =
      result.exitCode === 0 &&
      verdict === "approved" &&
      requirementCoverage.allSatisfied;
    this.recordStageResult(
      stage,
      fullOutput,
      approved ? "APPROVED" : verdict === "rejected" ? "REJECTED" : null
    );

    console.log(`[orchestrator] Master verdict: ${verdict} (exitCode=${result.exitCode})`);
    console.log(`[orchestrator] Verdict text (last 200 chars): ${verdictText.slice(-200)}`);

    if (approved) {
      applyPipelineTarget(this.state, stage.onSuccess);
      await this.commitPhaseResult({ masterApproved: true, lastFailureDigest: null });
      await this.appendProgressNote(`[Loop ${this.state.loopCount}] ${stage.id}: APPROVED by ${role.id}.`);
      if (this.state.status === LoopStatus.SUCCESS) {
        await this.emitFinalSummary();
        await this.saveRegistry();
        console.log(`[orchestrator] Session ${this.state.sessionId} achieved SUCCESS.`);
      }
    } else if (verdict === "approved") {
      const protocolFailure =
        `Master APPROVED rejected by requirement gate. Missing evidence: ` +
        `${requirementCoverage.missing.join(", ") || "none"}; unresolved: ` +
        `${requirementCoverage.unresolved.join(", ") || "none"}.`;
      await this.appendProgressNote(
        `[Loop ${this.state.loopCount}] ${stage.id}: APPROVED rejected because mandatory requirement evidence was incomplete.`
      );
      this.state.statusReason = protocolFailure;
      this.enterInterruptPhase();
      await this.commitPhaseResult({ masterApproved: false, lastFailureDigest: protocolFailure });
    } else if (verdict === "unknown") {
      const protocolFailure =
        "Master completed without an extractable APPROVED or REJECTED decision. " +
        "Implementation will not be repeated for a decision-protocol failure.";
      await this.appendProgressNote(
        `[Loop ${this.state.loopCount}] ${stage.id}: INVALID DECISION; entering INTERRUPT instead of re-running implementation.`
      );
      const rejectEntry: ErrorSignature = {
        signature: approvalDecisionSignature(verdictText),
        rawMessage: protocolFailure,
        timestamp: Date.now(),
        phase: stage.id,
      };
      this.state.errorQueue = pushAndCheckOscillation(this.state.errorQueue, rejectEntry).queue;
      this.state.statusReason = protocolFailure;
      this.enterInterruptPhase();
      await this.commitPhaseResult({ masterApproved: false, lastFailureDigest: protocolFailure });
    } else {
      await this.appendProgressNote(`[Loop ${this.state.loopCount}] ${stage.id}: REJECTED (${verdict}).`);
      const rejectionDigest = stripAnsi(verdictText).trim().slice(-4000);
      const rejectEntry: ErrorSignature = {
        signature: approvalDecisionSignature(verdictText),
        rawMessage: rejectionDigest.slice(0, 400),
        timestamp: Date.now(),
        phase: stage.id,
      };
      const rejectOsc = pushAndCheckOscillation(this.state.errorQueue, rejectEntry);
      this.state.errorQueue = rejectOsc.queue;
      if (rejectOsc.oscillation) {
        this.enterInterruptPhase();
      } else {
        applyPipelineTarget(this.state, stage.onFailure);
      }
      await this.commitPhaseResult({
        masterApproved: false,
        lastFailureDigest: rejectionDigest || "Master rejected the implementation without additional details.",
      });
    }
  }

  private async runInterrupter(stage: PipelineStage): Promise<void> {
    const notes = await this.readProgressNotes();
    const failureEvidence = await this.collectFailureEvidence();
    const queuedErrors = this.state.errorQueue
      .map((e) => `[${e.phase}] ${e.signature}`)
      .join("\n");
    const errorSummary = [
      this.state.lastFailure
        ? `[${this.state.lastFailure.phase ?? this.state.phase}] ${this.state.lastFailure.kind}: ${this.state.lastFailure.message}`
        : "",
      queuedErrors,
      this.state.interruptBriefing ?? "",
    ]
      .filter((value) => value.trim().length > 0)
      .join("\n");

    const humanMessage = this.state.interruptMessage;

    const payload: HandoffPayload = {
      sessionId: this.state.sessionId,
      originalGoal: this.state.goal,
      approvedPlan: this.state.refinedGoal,
      lockedReferenceIdentity: this.state.referenceIdentity,
      targetProjectPath: this.state.targetProjectPath,
      additionalAllowedPaths: this.state.additionalAllowedPaths,
      accessMode: this.state.accessMode,
      progressNotes: notes,
      failureDigest: errorSummary,
      phase: stage.id,
      loopCount: this.state.loopCount,
      interruptMessage: humanMessage,
      failureEvidence,
      toolAccess: this.state.toolAccess,
      requirements: this.state.requirements,
    };

    const role = roleForStage(this.state.pipeline, stage);
    const stageType = stageTypeForStage(this.state.pipeline, stage);
    const prompt = buildPrompt(role.id, payload, role, stage, stageType);
    const startedAt = new Date();
    const result = await this.executeAgent(
      role.id,
      prompt,
      1,
      stageType,
      role.modelRole
    );
    const endedAt = new Date();

    await this.archiveLoop(this.state.loopCount, stage.id, role.id, result, startedAt, endedAt);

    const briefing = extractOutput(result);
    this.recordStageResult(stage, briefing, null);
    this.state.interruptBriefing = briefing;
    console.warn("\n=== INTERRUPTER BRIEFING ===");
    console.warn(briefing);
    console.warn("============================");
    const terminalStatus = humanMessage ? LoopStatus.STOPPED : LoopStatus.PAUSED;
    console.warn(`Session ${this.state.sessionId} is ${terminalStatus}. Review the briefing and resume with:`);
    console.warn(`  agent-loop resume --session ${this.state.sessionId} --root ${this.rootDir}`);

    if (humanMessage) {
      this.state.interruptMessage = undefined;
      this.state.status = LoopStatus.STOPPED;
      this.state.statusReason = "Operator interrupt completed after producing a briefing.";
    } else {
      applyPipelineTarget(this.state, stage.onSuccess);
      this.state.statusReason = "Repeated token-consuming work showed no meaningful convergence.";
    }
    await this.commitPhaseResult({});
  }

  private async collectFailureEvidence(): Promise<FailureEvidenceSummary> {
    const sourcePhase = this.state.interruptedFromPhase ?? this.state.lastFailure?.phase ?? null;
    const historyDir = path.join(this.sessionDir, loopConfig.paths.loopHistoryDirName);
    const fileNames = await fse.readdir(historyDir).catch(() => [] as string[]);
    const entries: LoopHistoryEntry[] = [];
    for (const fileName of fileNames) {
      if (!fileName.endsWith(".json")) continue;
      const entry = await atomicReadJson<LoopHistoryEntry>(path.join(historyDir, fileName));
      if (!entry || !entry.attemptId) continue;
      if (sourcePhase && entry.phase !== sourcePhase) continue;
      if (entry.loopNumber !== this.state.loopCount) continue;
      entries.push(entry);
    }

    const uniqueEntries = new Map<string, LoopHistoryEntry>();
    for (const entry of entries) {
      uniqueEntries.set(entry.attemptId!, entry);
    }
    const attempts: AttemptEvidenceSummary[] = [];
    for (const entry of [...uniqueEntries.values()].sort(
      (left, right) => (left.attemptNumber ?? 0) - (right.attemptNumber ?? 0)
    )) {
      const rawLogBytes = entry.rawLogBytes ?? (
        entry.rawLogPath
          ? await fse.stat(entry.rawLogPath).then((stat) => stat.size).catch(() => null)
          : null
      );
      attempts.push({
        attemptId: entry.attemptId ?? null,
        attemptNumber: entry.attemptNumber ?? null,
        result: entry.result,
        failureKind: entry.failureKind ?? null,
        exitCode: entry.exitCode,
        startedAt: entry.startedAt,
        endedAt: entry.endedAt,
        outputBytes: Buffer.byteLength(entry.output ?? "", "utf8"),
        assistantTextBytes: entry.assistantTextBytes ?? null,
        eventCount: entry.eventCount ?? null,
        lastEventType: entry.lastEventType ?? null,
        lastToolName: entry.lastToolName ?? null,
        lastToolStatus: entry.lastToolStatus ?? null,
        lastToolCommand: entry.lastToolCommand ?? null,
        lastStepFinishReason: entry.lastStepFinishReason ?? null,
        lastStepFinishTotalTokens: entry.lastStepFinishTotalTokens ?? null,
        maxObservedTotalTokens: entry.maxObservedTotalTokens ?? null,
        rawLogPath: entry.rawLogPath ?? null,
        rawLogBytes,
      });
    }

    return {
      sourcePhase,
      targetProjectPath: this.state.targetProjectPath,
      additionalAllowedPaths: this.state.additionalAllowedPaths,
      accessMode: this.state.accessMode,
      pendingAccessRequest: this.state.pendingAccessRequest,
      detectedAbsolutePathsOutsideTarget: findAbsolutePathsOutsideTarget(
        [this.state.goal, this.state.refinedGoal ?? ""].join("\n\n"),
        this.state.targetProjectPath
      ),
      detectedAbsolutePathsOutsideAllowedRoots: findAbsolutePathsOutsideAllowedRoots(
        [this.state.goal, this.state.refinedGoal ?? ""].join("\n\n"),
        this.state.targetProjectPath,
        this.state.additionalAllowedPaths
      ),
      lastFailure: this.state.lastFailure,
      attempts,
    };
  }

  private async pollControlRequest(): Promise<ClaimedControlRequest | null> {
    if (this.activeControlRequest) return null;
    await importLegacyControlFiles(
      this.controlPaths,
      path.join(this.sessionDir, loopConfig.paths.sessionFileNames.stopRequest),
      path.join(this.sessionDir, loopConfig.paths.sessionFileNames.interruptMessage)
    );
    const claimed = await claimNextControlRequest(this.controlPaths);
    if (claimed) this.activeControlRequest = claimed;
    return claimed;
  }

  private async completeActiveControl(
    result: "completed" | "cancelled" | "failed",
    message: string
  ): Promise<void> {
    const claimed = this.activeControlRequest;
    if (!claimed) return;
    this.activeControlRequest = null;
    await completeControlRequest(this.controlPaths, claimed, result, message);
  }

  private async handleClaimedStop(
    claimed: ClaimedControlRequest,
    message: string
  ): Promise<void> {
    this.activeControlRequest = claimed;
    this.state.status = LoopStatus.STOPPED;
    this.state.statusReason = message;
    this.resetRunningAgentStates();
    await this.appendProgressNote(
      `[Loop ${this.state.loopCount}] STOP: User requested stop. ${message}`
    );
    await this.saveState();
    await this.saveRegistry();
    await this.completeActiveControl("completed", message);
    while (true) {
      const remaining = await claimNextControlRequest(this.controlPaths);
      if (!remaining) break;
      await completeControlRequest(
        this.controlPaths,
        remaining,
        "cancelled",
        "Session was already stopped by an earlier request."
      );
    }
  }

  private resetRunningAgentStates(): void {
    resetStaleRunningAgentStates(this.state.agentStates);
  }

  private async executeAgent(
    role: AgentRole,
    prompt: string,
    maxAttemptsOverride: number | undefined,
    stageType: PipelineStageType,
    modelRole: BuiltinModelRole = "implementer",
    planOptionsCount = 3
  ): Promise<PtyRunResult> {
    const pipelineRole = this.state.pipeline.roles.find((candidate) => candidate.id === role);
    const readOnlyRole = isReadOnlyModelRole(modelRole);
    const providerId =
      pipelineRole?.provider ??
      this.state.providerMapping?.[role] ??
      this.state.providerMapping?.[modelRole] ??
      this.state.cliProfile;
    const provider = this.state.providerConfigs?.[providerId] ?? loopConfig.providers[providerId];
    if (!provider) throw new Error(`No provider configured for role ${role}: ${providerId}`);
    if (!provider.enabled) throw new Error(`Provider ${providerId} configured for role ${role} is disabled.`);
    const model =
      pipelineRole?.model ??
      this.state.modelMapping[modelRole] ??
      this.state.modelMapping[role];
    if (!model) throw new Error(`No model configured for role ${role} (modelRole=${modelRole}).`);
    const variant =
      pipelineRole?.variant ||
      this.state.variantMapping?.[role] ||
      this.state.variantMapping?.[modelRole] ||
      undefined;
    const maxAttempts =
      maxAttemptsOverride ??
      (stageType.executor === "interrupt" ? 1 : this.state.resilience.maxAgentAttempts);
    const maxCompletionRecoveryAttempts =
      stageType.executor === "planning" || stageType.executor === "interrupt"
        ? 0
        : this.state.resilience.maxCompletionRecoveryAttempts;
    const totalAttemptSlots = maxAttempts + maxCompletionRecoveryAttempts;
    const attemptRunner = new AgentAttemptRunner({
      maxAttempts,
      retryBackoffMs: this.state.resilience.retryBackoffMs,
    });
    const previous =
      this.state.activeAttempt?.role === role &&
      this.state.activeAttempt.phase === this.state.phase &&
      this.state.activeAttempt.status !== "succeeded"
        ? this.state.activeAttempt
        : null;
    let attemptNumber = previous ? previous.attemptNumber + 1 : 1;
    let completionRecoveryUsed =
      previous?.mode === "completion_recovery"
        ? previous.completionRecoveryNumber
        : 0;
    let completionRecoveryNext = Boolean(
      previous &&
      previous.mode !== "completion_recovery" &&
      previous.failureKind === "incomplete_response" &&
      previous.exitCode === 0 &&
      previous.attemptNumber >= maxAttempts &&
      completionRecoveryUsed < maxCompletionRecoveryAttempts
    );
    let cliSessionId = previous?.cliSessionId ?? null;
    let reconnectUsed = previous?.reconnectUsed ?? false;
    let reconnectNext = Boolean(
      previous &&
      !reconnectUsed &&
      cliSessionId &&
      ["network", "transport_timeout", "idle_timeout"].includes(previous.failureKind ?? "")
    );
    const cycleStartedAt = previous?.cycleStartedAt ?? new Date().toISOString();
    const cycleDeadline =
      Date.parse(cycleStartedAt) + this.state.resilience.phaseRecoveryBudgetMs;

    if (previous?.nextRetryAt) {
      const remainingBackoff = Date.parse(previous.nextRetryAt) - Date.now();
      if (remainingBackoff > 0) {
        this.state.agentStates[role].status = "retry_wait";
        await this.waitForRetry(Math.min(remainingBackoff, Math.max(0, cycleDeadline - Date.now())));
      }
    }

    while (
      (attemptNumber <= maxAttempts || completionRecoveryNext) &&
      Date.now() < cycleDeadline
    ) {
      const isCompletionRecovery = completionRecoveryNext;
      const completionRecoveryNumber = isCompletionRecovery
        ? completionRecoveryUsed + 1
        : 0;
      const attemptId = createId("attempt");
      const startedAt = new Date();
      const attemptTimeoutMs = boundedAttemptTimeoutMs(
        isCompletionRecovery
          ? Math.min(this.state.phaseTimeoutMs, this.state.idleTimeoutMs, 5 * 60 * 1000)
          : this.state.phaseTimeoutMs,
        cycleDeadline,
        startedAt.getTime()
      );
      if (attemptTimeoutMs <= 0) break;
      const resumeThisAttempt = !isCompletionRecovery && reconnectNext;
      if (resumeThisAttempt) reconnectUsed = true;
      if (isCompletionRecovery) {
        completionRecoveryUsed = completionRecoveryNumber;
        completionRecoveryNext = false;
        cliSessionId = null;
        reconnectUsed = false;
      }
      const rawLogPath = path.join(
        this.sessionDir,
        loopConfig.paths.attemptLogsDirName,
        `${this.state.loopCount}_${this.state.phase.toLowerCase()}_${role}_${attemptNumber}_${attemptId}.log`
      );
      const activeAttempt: AgentAttemptState = {
        attemptId,
        role,
        phase: this.state.phase,
        status: "starting",
        ownerPid: process.pid,
        childPid: null,
        cliSessionId,
        attemptNumber,
        maxAttempts: totalAttemptSlots,
        reconnectUsed,
        cycleStartedAt,
        startedAt: startedAt.toISOString(),
        lastOutputAt: null,
        lastProgressAt: null,
        deadlineAt: new Date(startedAt.getTime() + attemptTimeoutMs).toISOString(),
        nextRetryAt: null,
        endedAt: null,
        exitCode: null,
        failureKind: null,
        failureMessage: null,
        outputLogPath: rawLogPath,
        activity: "initial_transport",
        mode: isCompletionRecovery ? "completion_recovery" : "standard",
        completionRecoveryNumber,
      };
      this.state.activeAttempt = activeAttempt;
      this.state.totalAgentAttempts++;
      this.state.agentStates[role] = {
        status: "running",
        lastExitCode: null,
        lastRunAt: startedAt.toISOString(),
      };

      const recoveryPrompt = isCompletionRecovery
        ? buildCompletionRecoveryPrompt(
            role,
            pipelineRole ?? {
              id: role,
              modelRole,
              description: role,
              instructions: "",
            },
            stageById(this.state.pipeline, this.state.phase),
            stageType,
            this.state,
            completionRecoveryNumber,
            maxCompletionRecoveryAttempts
          )
        : attemptNumber > 1
          ? `${prompt}\n\n=== RECOVERY ATTEMPT ${attemptNumber}/${maxAttempts} ===\n` +
            `The previous attempt ended with ${previous?.failureKind ?? this.state.lastFailure?.kind ?? "an interruption"}. ` +
            `Inspect the current workspace before acting. Preserve valid existing changes and continue cumulatively; do not blindly repeat completed work.`
          : prompt;
      await atomicWriteJson(this.rooms[role].inputPayloadPath, {
        attempt: activeAttempt,
        prompt: recoveryPrompt,
        resumeCliSessionId: resumeThisAttempt ? cliSessionId : null,
      });
      await this.saveState();

      const configuredMcpServers = enabledMcpServers(this.state.toolAccess);
      const selectedMcpServers = readOnlyRole ? [] : configuredMcpServers;
      const runtimeMcpServers = resolveMcpServerSecrets(
        selectedMcpServers,
        CORE_SECRET_VALUES,
        process.env
      );
      const sensitiveValues = runtimeSensitiveValues(runtimeMcpServers);
      const useWebSearch = this.state.toolAccess.webSearch.enabled;
      let claudeMcpConfigPath: string | undefined;
      if (provider.adapter === "claude" && runtimeMcpServers.length > 0) {
        const runtimeDir = path.join(this.sessionDir, "runtime");
        await fse.ensureDir(runtimeDir);
        await cleanupClaudeMcpRuntimeFiles(runtimeDir);
        claudeMcpConfigPath = path.join(runtimeDir, `claude_mcp_${attemptId}.json`);
      }
      const invocation = buildProviderInvocation(provider, {
        model,
        targetProjectPath: this.state.targetProjectPath,
        additionalAllowedPaths: this.state.additionalAllowedPaths,
        prompt: recoveryPrompt,
        variant,
        resumeSessionId: resumeThisAttempt ? cliSessionId ?? undefined : undefined,
        fullAccess: this.state.accessMode === "full_access",
        readOnly: readOnlyRole,
        webSearch: useWebSearch,
        webSearchMode: this.state.toolAccess.webSearch.mode,
        mcpServers: runtimeMcpServers,
        claudeMcpConfigPath,
      });
      const interactionWhitelist = (
        provider.interactionWhitelist
        ?? (provider.adapter === "kilo" ? KILO_PROFILE.interactionWhitelist : INTERACTION_WHITELIST)
      ).filter((pattern) => !/(?:allow|permission|action required|run command)/i.test(pattern));

      console.log(
        `\n[${this.state.sessionId}] Phase=${this.state.phase} Role=${role} ` +
        `Provider=${providerId} Model=${model}${variant ? ` Variant=${variant}` : ""} ` +
        `Web=${useWebSearch ? "on" : "off"} MCP=${selectedMcpServers.length} Loop=${this.state.loopCount} ` +
        (isCompletionRecovery
          ? `CompletionRecovery=${completionRecoveryNumber}/${maxCompletionRecoveryAttempts}`
          : `Attempt=${attemptNumber}/${maxAttempts}${resumeThisAttempt ? ` ResumeCLI=${cliSessionId}` : ""}`)
      );

      let progressWrite = Promise.resolve();
      let lastProgressPersistedAt = 0;
      const supervisor = new ProcessSupervisor();
      const supervised = await (async () => {
        try {
          if (claudeMcpConfigPath) {
            await atomicWriteSensitiveJson(
              claudeMcpConfigPath,
              claudeMcpDocument(runtimeMcpServers)
            );
          }
          return await supervisor.run({
        binary: resolveBinaryOnWindows(invocation.binary),
        args: invocation.args,
        cwd: this.state.targetProjectPath,
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
          ),
          AGENT_LOOP_SESSION_ID: this.state.sessionId,
          AGENT_LOOP_AGENT_ROLE: role,
          AGENT_LOOP_PHASE: this.state.phase,
          AGENT_LOOP_ATTEMPT_ID: attemptId,
          ...invocation.env,
        },
        cols: loopConfig.defaults.ptyCols,
        rows: loopConfig.defaults.ptyRows,
        useConpty: process.platform === "win32" && !!process.stdin?.isTTY,
        transportTimeoutMs: this.state.resilience.transportTimeoutMs,
        idleTimeoutMs: this.state.idleTimeoutMs,
        toolTimeoutMs: this.state.resilience.toolTimeoutMs,
        phaseTimeoutMs: attemptTimeoutMs,
        absoluteDeadlineAtMs: isCompletionRecovery
          ? startedAt.getTime() + attemptTimeoutMs
          : cycleDeadline,
        terminationGraceMs: this.state.resilience.terminationGraceMs,
        killTimeoutMs: this.state.resilience.killTimeoutMs,
        maxInMemoryOutputBytes: this.state.resilience.maxInMemoryOutputBytes,
        rawLogPath,
        interactionWhitelist,
        destructivePrompts: loopConfig.destructivePrompts,
        sensitiveValues,
        pollControl: () => this.pollControlRequest(),
        onProgress: (progress) => {
          this.activePtyPid = progress.childPid;
          this.ownership.setChildPid(progress.childPid);
          if (this.state.activeAttempt?.attemptId !== attemptId) return;
          this.state.activeAttempt.status = "running";
          this.state.activeAttempt.childPid = progress.childPid;
          this.state.activeAttempt.lastOutputAt = progress.lastOutputAt;
          this.state.activeAttempt.lastProgressAt = progress.lastProgressAt;
          this.state.activeAttempt.cliSessionId = progress.cliSessionId;
          this.state.activeAttempt.activity = progress.activity;
          this.state.activeAttempt.deadlineAt = progress.deadlineAt;
          if (Date.now() - lastProgressPersistedAt >= 1_000) {
            lastProgressPersistedAt = Date.now();
            progressWrite = progressWrite.then(() => this.saveState()).catch(() => {});
          }
        },
          });
        } finally {
          if (claudeMcpConfigPath) await fse.remove(claudeMcpConfigPath).catch(() => {});
        }
      })();
      await progressWrite;
      this.activePtyPid = null;
      this.ownership.setChildPid(null);

      const result: PtyRunResult = {
        pid: supervised.pid,
        exitCode: supervised.exitCode,
        output: supervised.output,
        events: supervised.events,
        timedOut: supervised.timedOut,
        cancelled: supervised.cancelled,
        autoInjected: supervised.autoInjected,
        outcome: supervised.outcome,
        failureKind: supervised.failureKind,
        failureMessage: supervised.failureMessage,
        assistantText: supervised.assistantText,
        cliSessionId: supervised.cliSessionId,
        rawLogPath: supervised.rawLogPath,
        controlRequest: supervised.controlRequest,
      };
      cliSessionId = result.cliSessionId ?? cliSessionId;

      if (supervised.controlRequest) {
        this.activeControlRequest = supervised.controlRequest;
        activeAttempt.status = "cancelled";
        activeAttempt.endedAt = supervised.endedAt;
        activeAttempt.exitCode = result.exitCode;
        activeAttempt.failureKind = "cancelled";
        activeAttempt.failureMessage = supervised.failureMessage;
        activeAttempt.cliSessionId = cliSessionId;
        await atomicWriteJson(this.rooms[role].outputPayloadPath, {
          attempt: activeAttempt,
          output: extractOutput(result),
          rawLogPath,
        });
        if (supervised.controlRequest.request.type === "STOP") {
          await this.handleClaimedStop(supervised.controlRequest, `${role} attempt terminated.`);
          throw new StopRequestedError();
        }
        await this.completeActiveControl("completed", "Interrupt accepted; active attempt terminated.");
        throw new InterruptRequestedError(supervised.controlRequest.request.message);
      }

      const completion =
        supervised.outcome === "succeeded"
          ? validateAgentCompletion(
              stageType.completionContract,
              result,
              planOptionsCount,
              {
                externalResearchRequired:
                  goalRequiresExternalResearch(this.state.goal) &&
                  ["planning", "review", "approval"].includes(stageType.executor),
                namedReferenceRequired:
                  goalRequiresNamedReferenceVerification(this.state.goal) &&
                  ["planning", "review", "approval"].includes(stageType.executor),
                expectedReferenceIdentity:
                  ["review", "approval"].includes(stageType.executor)
                    ? this.state.referenceIdentity
                    : null,
                forbidFileMutation: readOnlyRole,
              }
            )
          : { valid: false, reason: supervised.failureMessage };
      if (supervised.outcome === "succeeded" && completion.valid) {
        activeAttempt.status = "succeeded";
        activeAttempt.endedAt = supervised.endedAt;
        activeAttempt.exitCode = result.exitCode;
        activeAttempt.cliSessionId = cliSessionId;
        this.state.activeAttempt = activeAttempt;
        if (stageType.executor !== "interrupt") {
          this.state.lastFailure = null;
          this.state.automaticRecovery = null;
          this.state.statusReason = null;
        }
        this.state.agentStates[role] = {
          status: "completed",
          lastExitCode: result.exitCode,
          lastRunAt: supervised.endedAt,
        };
        await atomicWriteJson(this.rooms[role].outputPayloadPath, {
          attempt: activeAttempt,
          output: assistantTextBeforeSentinel(result),
          rawLogPath,
          structuredResult: null,
        });
        await atomicWriteJson(this.rooms[role].statePath, this.state.agentStates[role]);
        return result;
      }

      const failure = classifyAgentFailure(result, completion.reason);
      failure.attemptId = attemptId;
      failure.role = role;
      failure.phase = this.state.phase;
      failure.cliSessionId = cliSessionId;
      result.failureKind = failure.kind;
      result.failureMessage = failure.message;
      activeAttempt.status =
        failure.kind === "transport_timeout"
          ? "transport_timeout"
          : failure.kind === "idle_timeout"
          ? "idle_timeout"
          : failure.kind === "tool_timeout"
          ? "tool_timeout"
          : failure.kind === "phase_timeout"
          ? "phase_timeout"
          : failure.kind === "spawn_error"
          ? "spawn_error"
          : failure.kind === "orphaned_process"
          ? "orphaned_process"
          : failure.kind === "incomplete_response"
          ? "incomplete_response"
          : "process_exit";
      activeAttempt.endedAt = supervised.endedAt;
      activeAttempt.exitCode = result.exitCode;
      activeAttempt.failureKind = failure.kind;
      activeAttempt.failureMessage = failure.message;
      activeAttempt.cliSessionId = cliSessionId;
      activeAttempt.reconnectUsed = reconnectUsed;
      this.state.activeAttempt = activeAttempt;
      this.state.lastFailure = failure;
      this.state.agentStates[role] = {
        status: "failed",
        lastExitCode: result.exitCode,
        lastRunAt: supervised.endedAt,
      };
      await atomicWriteJson(this.rooms[role].outputPayloadPath, {
        attempt: activeAttempt,
        output: extractOutput(result),
        failure,
        rawLogPath,
      });
      await atomicWriteJson(this.rooms[role].statePath, this.state.agentStates[role]);
      await this.archiveLoop(
        this.state.loopCount,
        this.state.phase,
        role,
        result,
        new Date(supervised.startedAt),
        new Date(supervised.endedAt)
      );

      const budgetRemaining = cycleDeadline - Date.now();
      const retryDecision = attemptRunner.decideRetry({
        failure,
        attemptNumber,
        budgetRemainingMs: budgetRemaining,
        cliSessionId,
        reconnectUsed,
        retryAfterMs: retryAfterMs(result),
      });
      const canRunCompletionRecovery =
        !retryDecision.retry &&
        !isCompletionRecovery &&
        failure.kind === "incomplete_response" &&
        result.exitCode === 0 &&
        maxCompletionRecoveryAttempts > completionRecoveryUsed &&
        budgetRemaining > 0;
      if (canRunCompletionRecovery) {
        completionRecoveryNext = true;
        reconnectNext = false;
        cliSessionId = null;
        const backoffMs = Math.min(1_000, budgetRemaining);
        activeAttempt.nextRetryAt = new Date(Date.now() + backoffMs).toISOString();
        this.state.agentStates[role].status = "retry_wait";
        await this.appendProgressNote(
          `[Loop ${this.state.loopCount}] ${role}: Normal attempt budget ended with ` +
          `incomplete_response after exitCode 0; starting a fresh bounded completion recovery session.`
        );
        await this.saveState();
        await this.waitForRetry(backoffMs);
        attemptNumber++;
        continue;
      }
      if (!retryDecision.retry) {
        await this.saveState();
        throw new AgentRetriesExhaustedError(role, failure);
      }

      reconnectNext = retryDecision.reconnect;
      completionRecoveryNext = false;
      const backoffMs = retryDecision.delayMs;
      activeAttempt.nextRetryAt = new Date(Date.now() + backoffMs).toISOString();
      this.state.agentStates[role].status = "retry_wait";
      await this.appendProgressNote(
        `[Loop ${this.state.loopCount}] ${role}: Attempt ${attemptNumber}/${maxAttempts} failed ` +
        `(${failure.kind}); retrying in ${backoffMs}ms${reconnectNext ? " using the existing CLI session" : ""}.`
      );
      await this.saveState();
      await this.waitForRetry(backoffMs);
      attemptNumber++;
    }

    const failure: AttemptFailure =
      this.state.lastFailure ?? {
        kind: "phase_timeout",
        message: "Phase recovery budget exhausted before another attempt could start.",
        retryable: false,
        occurredAt: new Date().toISOString(),
        attemptId: this.state.activeAttempt?.attemptId ?? null,
        role,
        phase: this.state.phase,
        exitCode: this.state.activeAttempt?.exitCode ?? null,
        cliSessionId: this.state.activeAttempt?.cliSessionId ?? null,
      };
    throw new AgentRetriesExhaustedError(role, failure);
  }

  private async waitForRetry(waitMs: number): Promise<void> {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      const claimed = await this.pollControlRequest();
      if (claimed) {
        if (claimed.request.type === "STOP") {
          await this.handleClaimedStop(claimed, "Stopped during retry backoff.");
          throw new StopRequestedError();
        }
        this.activeControlRequest = claimed;
        await this.completeActiveControl("completed", "Interrupt accepted during retry backoff.");
        throw new InterruptRequestedError(claimed.request.message);
      }
      await sleep(Math.min(250, Math.max(1, deadline - Date.now())));
    }
  }

  private async archiveLoop(
    loopNum: number,
    phase: string,
    role: AgentRole,
    result: PtyRunResult,
    startedAt: Date,
    endedAt: Date
  ): Promise<void> {
    const rawLogPath = result.rawLogPath ?? null;
    const rawLogBytes = rawLogPath
      ? await fse.stat(rawLogPath).then((stat) => stat.size).catch(() => null)
      : null;
    const lastEvent = summarizeAttemptEvents(result);
    const entry: LoopHistoryEntry = {
      loopNumber: loopNum,
      phase,
      agentRole: role,
      model: (() => {
        const pipelineRole = this.state.pipeline.roles.find((candidate) => candidate.id === role);
        const providerId = pipelineRole?.provider
          ?? this.state.providerMapping?.[role]
          ?? this.state.providerMapping?.[pipelineRole?.modelRole ?? role]
          ?? this.state.cliProfile;
        const model = pipelineRole?.model ?? this.state.modelMapping[pipelineRole?.modelRole ?? role] ?? "unknown";
        return `${providerId}:${model}`;
      })(),
      exitCode: result.exitCode,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      output: boundedHistoryOutput(result.output),
      result: result.timedOut ? "timeout" : result.exitCode === 0 ? "success" : "failure",
      signature: null,
      interruptMessage: this.state.interruptMessage ?? null,
      attemptId: this.state.activeAttempt?.attemptId ?? null,
      attemptNumber: this.state.activeAttempt?.attemptNumber ?? null,
      failureKind: result.failureKind ?? null,
      rawLogPath,
      rawLogBytes,
      assistantTextBytes: Buffer.byteLength(result.assistantText ?? "", "utf8"),
      eventCount: result.events.length,
      ...lastEvent,
    };
    const attemptSuffix = this.state.activeAttempt
      ? `_attempt_${this.state.activeAttempt.attemptNumber}_${this.state.activeAttempt.attemptId}`
      : "";
    const fileName = `loop_${loopNum}_${phase.toLowerCase()}_${role}${attemptSuffix}.json`;
    const filePath = path.join(this.sessionDir, loopConfig.paths.loopHistoryDirName, fileName);
    await atomicWriteJson(filePath, entry);
    await Promise.all([
      this.pruneRetainedFiles(
        path.join(this.sessionDir, loopConfig.paths.loopHistoryDirName),
        ".json",
        MAX_RETAINED_HISTORY_FILES
      ),
      this.pruneRetainedFiles(
        path.join(this.sessionDir, loopConfig.paths.attemptLogsDirName),
        ".log",
        MAX_RETAINED_ATTEMPT_LOGS
      ),
    ]);
  }

  private async pruneRetainedFiles(
    directory: string,
    suffix: string,
    maximumFiles: number
  ): Promise<void> {
    const names = (await fse.readdir(directory).catch(() => [] as string[]))
      .filter((name) => name.endsWith(suffix));
    if (names.length <= maximumFiles) return;
    const candidates = await Promise.all(names.map(async (name) => {
      const filePath = path.join(directory, name);
      const stat = await fse.stat(filePath).catch(() => null);
      return stat ? { filePath, modifiedAt: stat.mtimeMs } : null;
    }));
    const removable = candidates
      .filter((candidate): candidate is { filePath: string; modifiedAt: number } => candidate !== null)
      .sort((left, right) => left.modifiedAt - right.modifiedAt)
      .slice(0, Math.max(0, names.length - maximumFiles));
    await Promise.all(removable.map(({ filePath }) => fse.remove(filePath).catch(() => {})));
  }

  private async appendProgressNote(note: string): Promise<void> {
    const notesPath = path.join(this.sessionDir, loopConfig.paths.sessionFileNames.progressNotes);
    await atomicAppendLine(notesPath, note);
  }

  private async readProgressNotes(): Promise<string> {
    const notesPath = path.join(this.sessionDir, loopConfig.paths.sessionFileNames.progressNotes);
    try {
      return await fse.readFile(notesPath, "utf8");
    } catch {
      return "";
    }
  }

  private async emitFinalSummary(): Promise<void> {
    const notes = await this.readProgressNotes();
    const summary: FinalSummary = {
      sessionId: this.state.sessionId,
      goal: this.state.goal,
      achievedAt: new Date().toISOString(),
      totalLoops: this.state.loopCount,
      finalModelMapping: this.state.modelMapping,
      progressNotes: notes,
      approvedByMaster: this.state.masterApproved,
    };
    const summaryPath = path.join(this.sessionDir, loopConfig.paths.sessionFileNames.finalSummary);
    await atomicWriteJson(summaryPath, summary);
  }

  private recordStageResult(
    stage: PipelineStage,
    output: string,
    verdict: StageResultState["verdict"]
  ): void {
    const validRequirementIds = new Set(this.state.requirements.items.map((item) => item.id));
    const requirementEvidence = parseRequirementEvidence(output)
      .filter((record) => validRequirementIds.has(record.requirementId))
      .map((record): RequirementEvidenceRecord => ({
        ...record,
        stageId: stage.id,
        role: stage.role,
        attemptId: this.state.activeAttempt?.attemptId ?? null,
        recordedAt: new Date().toISOString(),
      }));
    if (requirementEvidence.length > 0) {
      this.state.requirements.evidence = [
        ...this.state.requirements.evidence,
        ...requirementEvidence,
      ].slice(-200);
    }
    if (stage.id === this.state.pipeline.iterationCompletionStageId) {
      this.state.completedIterations++;
      this.state.convergence = advanceConvergence(
        this.state.convergence,
        this.state.requirements,
        this.state.loopCount
      );
    }
    this.state.stageResults[stage.id] = {
      stageId: stage.id,
      role: stage.role,
      kind: stage.kind,
      executor: executorForStage(this.state.pipeline, stage),
      completedAt: new Date().toISOString(),
      output,
      verdict,
      attemptId: this.state.activeAttempt?.attemptId ?? null,
    };
  }

  private async saveState(): Promise<void> {
    this.state.updatedAt = new Date().toISOString();
    const statePath = path.join(this.sessionDir, loopConfig.paths.sessionFileNames.state);
    const lockPath = path.join(this.sessionDir, loopConfig.paths.stateLockFileName);
    await withShortFileLock(lockPath, () => atomicWriteJson(statePath, this.state));
  }

  private async commitPhaseResult(patch: Partial<LoopState>): Promise<void> {
    if (
      this.state.activeAttempt &&
      ["starting", "running", "retry_wait"].includes(this.state.activeAttempt.status)
    ) {
      throw new Error(
        `Cannot commit phase ${this.state.phase} while attempt ${this.state.activeAttempt.attemptId} is not terminal.`
      );
    }
    Object.assign(this.state, patch);
    await this.saveState();
  }

  private async saveRegistry(): Promise<void> {
    this.registry = await mergeAndWriteSessionMeta(this.registryPath, this.registry, {
      sessionId: this.state.sessionId,
      goal: this.state.goal,
      targetProjectPath: this.state.targetProjectPath,
      status: this.state.status,
      createdAt: this.state.createdAt,
    });
  }

  private registerSignalHandlers(): void {
    if (this.signalHandlersRegistered) return;
    this.signalHandlersRegistered = true;

    const handler = () => {
      this.dispose().then(() => {
        process.exitCode = 0;
      }).catch((err) => {
        console.error(`[orchestrator] Error during disposal: ${err.message}`);
        process.exitCode = 1;
      });
    };

    process.on("SIGINT", handler);
    process.on("SIGTERM", handler);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    if (this.activePtyPid !== null) {
      console.log(`[orchestrator] Killing active PTY pid=${this.activePtyPid}`);
      await terminateProcessTreeBounded(
        this.activePtyPid,
        this.state.resilience.killTimeoutMs
      );
      this.activePtyPid = null;
      this.ownership.setChildPid(null);
    }

    if (this.state.status === LoopStatus.RUNNING) {
      this.state.status = LoopStatus.STOPPED;
      this.state.statusReason = "Core process received a graceful termination signal.";
      await this.appendProgressNote(
        `[Loop ${this.state.loopCount}] STOPPED: Operator stopped the session via command.`
      );
    }
    this.resetRunningAgentStates();
    await this.saveState();
    await this.saveRegistry();
    await this.ownership.release();
    console.log(`[orchestrator] Session ${this.state.sessionId} disposed. Status: ${this.state.status}.`);
  }
}

function createDefaultLoopState(
  sessionId: string,
  goal: string,
  targetProjectPath: string,
  modelMapping: ModelMapping,
  providerMapping: Record<string, string>,
  providerConfigs: Record<string, ProviderConfig>,
  variantMapping: VariantMapping,
  cliBinary: string,
  cliProfile: string,
  maxIterations: number,
  phaseTimeoutMs: number,
  idleTimeoutMs: number,
  pipeline: PipelineDefinition,
  pipelineConfigPath: string | null,
  additionalAllowedPaths: string[] = [],
  accessMode: AccessMode = "ask"
): LoopState {
  const now = new Date().toISOString();
  const agentStates = createDefaultAgentStates(pipeline);

  return {
    stateVersion: 2,
    sessionId,
    status: LoopStatus.RUNNING,
    phase: pipeline.startStageId,
    loopCount: 0,
    completedIterations: 0,
    goal,
    targetProjectPath: path.resolve(targetProjectPath),
    additionalAllowedPaths: normalizeAdditionalAllowedPaths(
      additionalAllowedPaths,
      path.resolve(targetProjectPath)
    ),
    accessMode,
    pendingAccessRequest: null,
    modelMapping,
    providerMapping,
    providerConfigs,
    variantMapping,
    errorQueue: [],
    agentStates,
    refinedGoal: null,
    referenceIdentity: null,
    planningComplete: false,
    masterApproved: false,
    awaitingPlanApproval: false,
    planApproved: false,
    planPath: null,
    planOverviewPath: null,
    selectedPlanChoiceId: null,
    lastFailureDigest: null,
    interruptBriefing: null,
    planRevisionPending: false,
    interruptedFromPhase: null,
    activeAttempt: null,
    lastFailure: null,
    recoveryCount: 0,
    totalAgentAttempts: 0,
    statusReason: null,
    automaticRecovery: null,
    resilience: resilienceSettingsFromConfig(),
    pipeline,
    pipelineConfigPath,
    stageResults: {},
    requirements: deriveRequirementLedger(goal, now),
    convergence: { stagnantCycles: 0, history: [] },
    createdAt: now,
    updatedAt: now,
    maxIterations,
    phaseTimeoutMs,
    idleTimeoutMs,
    cliBinary,
    cliProfile,
    toolAccess: validateToolAccess(loopConfig.toolAccess),
  };
}

function resolveModelMapping(
  parsed: Record<string, string>,
  availableModels: string[],
  fallback: string
): ModelMapping {
  const dynamic = parseJsonRecord(parsed["model-mapping"], "--model-mapping");
  const pick = (key: string, role: string): string => {
    if (dynamic[role]) return dynamic[role];
    const explicit = parsed[key];
    if (explicit && explicit.length > 0) return explicit;
    if (availableModels.length > 0) return availableModels[0];
    return fallback;
  };

  return {
    ...dynamic,
    planner: pick("planner-model", "planner"),
    implementer: pick("implementer-model", "implementer"),
    tester: pick("tester-model", "tester"),
    qa_lead: pick("qa-model", "qa_lead"),
    master: pick("master-model", "master"),
    interrupter: pick("interrupter-model", "interrupter"),
  };
}

function resolveProviderMapping(
  parsed: Record<string, string>,
  providers: Record<string, ProviderConfig>,
  defaultProvider: string
): Record<string, string> {
  const dynamic = parseJsonRecord(parsed["provider-mapping"], "--provider-mapping");
  const normalizedDefault = providers[defaultProvider]?.enabled
    ? defaultProvider
    : Object.keys(providers).find((id) => providers[id].enabled) ?? "opencode";
  const roles = ["planner", "implementer", "tester", "qa_lead", "master", "interrupter"];
  for (const role of roles) {
    const flag = role === "qa_lead" ? "qa-provider" : `${role}-provider`;
    dynamic[role] = parsed[flag] || dynamic[role] || normalizedDefault;
  }
  for (const [role, providerId] of Object.entries(dynamic)) {
    if (!providers[providerId]) throw new Error(`Unknown provider '${providerId}' configured for role '${role}'.`);
    if (!providers[providerId].enabled) throw new Error(`Provider '${providerId}' configured for role '${role}' is disabled.`);
  }
  return dynamic;
}

function alignAutomaticModelsWithProviders(
  parsed: Record<string, string>,
  modelMapping: ModelMapping,
  providerMapping: Record<string, string>,
  catalog: Record<string, ProviderCatalogEntry>
): void {
  const explicit = parseJsonRecord(parsed["model-mapping"], "--model-mapping");
  const roleFlags: Record<string, string> = {
    planner: "planner-model",
    implementer: "implementer-model",
    tester: "tester-model",
    qa_lead: "qa-model",
    master: "master-model",
    interrupter: "interrupter-model",
  };
  for (const [role, providerId] of Object.entries(providerMapping)) {
    if (explicit[role] || (roleFlags[role] && parsed[roleFlags[role]])) continue;
    const providerDefault = catalog[providerId]?.models[0];
    if (providerDefault) modelMapping[role] = providerDefault;
  }
}

function resolveVariantMapping(parsed: Record<string, string>): VariantMapping {
  const mapping: VariantMapping = {};
  const roleToFlag: Record<string, AgentRole> = {
    "planner-variant": "planner",
    "implementer-variant": "implementer",
    "tester-variant": "tester",
    "qa-variant": "qa_lead",
    "master-variant": "master",
    "interrupter-variant": "interrupter",
  };
  for (const [flag, role] of Object.entries(roleToFlag)) {
    if (parsed[flag]) mapping[role] = parsed[flag];
  }
  return mapping;
}

async function resolveRootDir(parsed: Record<string, string>): Promise<string> {
  if (parsed.root) return path.resolve(parsed.root);
  const scriptDir = path.dirname(process.argv[1]);
  if (await fse.pathExists(path.join(scriptDir, loopConfig.paths.registryFileName))) {
    return scriptDir;
  }
  return process.cwd();
}

async function reconcileSessionRegistry(rootDir: string): Promise<void> {
  const registryPath = path.join(rootDir, loopConfig.paths.registryFileName);
  const registry = await atomicReadJson<SessionRegistry>(registryPath);
  if (!registry) return;
  const sessionsRoot = path.join(rootDir, loopConfig.paths.sessionsRoot);
  const entries = await fse.readdir(sessionsRoot, { withFileTypes: true }).catch(() => []);
  const discovered: SessionMetaPatch[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      assertSafeSessionId(entry.name);
      const statePath = path.join(
        resolveContainedSessionPath(sessionsRoot, entry.name),
        loopConfig.paths.sessionFileNames.state
      );
      const state = await atomicReadJson<LoopState>(statePath);
      if (!state) continue;
      discovered.push({
        sessionId: entry.name,
        goal: state.goal,
        targetProjectPath: state.targetProjectPath,
        status: state.status,
        createdAt: state.createdAt,
      });
    } catch {
      // Ignore malformed or unsafe session directories.
    }
  }
  if (discovered.length === 0) return;
  const lockPath = path.join(rootDir, loopConfig.paths.registryLockFileName);
  await withShortFileLock(lockPath, async () => {
    const fresh = (await atomicReadJson<SessionRegistry>(registryPath)) ?? registry;
    let changed = false;
    for (const patch of discovered) {
      const existing = fresh.sessionMetas.find((meta) => meta.sessionId === patch.sessionId);
      if (!existing) {
        upsertSessionMeta(fresh, patch);
        changed = true;
      }
    }
    if (changed) await atomicWriteJson(registryPath, fresh);
  });
}

async function ensureAgentConfigFiles(rootDir: string): Promise<void> {
  const rolesPath = path.join(rootDir, "agent_roles.json");
  const agentLoopPath = path.join(rootDir, "agent_loop.json");
  if (!await fse.pathExists(rolesPath)) {
    await atomicWriteJson(rolesPath, {
      $schema: "./agent_roles.schema.json",
      ...defaultAgentRolesDefinition(),
    });
  }
  if (!await fse.pathExists(agentLoopPath)) {
    await atomicWriteJson(agentLoopPath, {
      $schema: "./agent_loop.schema.json",
      ...defaultAgentLoopDefinition(),
    });
  }
}

async function cmdInit(rootDir: string): Promise<void> {
  const cfg = loopConfig.paths;
  await fse.ensureDir(path.join(rootDir, cfg.sessionsRoot));
  await ensureAgentConfigFiles(rootDir);
  const registryPath = path.join(rootDir, cfg.registryFileName);
  const existing = await atomicReadJson<SessionRegistry>(registryPath);
  if (existing) {
    console.log(`Already initialized at ${rootDir}`);
    return;
  }
  const registry: SessionRegistry = {
    version: 1,
    activeSessionIds: [],
    availableModels: [],
    modelsDiscoveredAt: null,
    modelsDiscoveredCli: null,
    sessionMetas: [],
    manualModelsOverride: null,
    modelVariants: null,
    providerCatalog: {},
  };
  await atomicWriteJson(registryPath, registry);
  console.log(`Initialized agent-loop system at ${rootDir}`);
  console.log(`Registry: ${registryPath}`);
  console.log(`Sessions dir: ${path.join(rootDir, loopConfig.paths.sessionsRoot)}`);
}

async function cmdModels(_parsed: Record<string, string>, rootDir: string): Promise<void> {
  const registryPath = path.join(rootDir, loopConfig.paths.registryFileName);
  const registry = await atomicReadJson<SessionRegistry>(registryPath);
  const providers = normalizeProviders(loopConfig.providers);
  const catalog = await discoverProviderCatalog(providers, registry?.manualModelsOverride ?? null);
  const models = flatCatalogModels(catalog);

  if (registry) {
    const modelVariantsConfig = await loadModelVariantsConfig(rootDir);
    await mergeAndWriteRegistryFields(registryPath, registry, {
      availableModels: models,
      modelsDiscoveredAt: new Date().toISOString(),
      modelsDiscoveredCli: "all enabled providers",
      modelVariants: modelVariantsConfig ?? null,
      providerCatalog: catalog,
    });
  }

  console.log(`Provider catalog (${Object.keys(catalog).length} providers, ${models.length} models):`);
  for (const entry of Object.values(catalog)) {
    console.log(`  ${entry.id}: ${entry.enabled ? entry.models.length : "disabled"}${entry.error ? ` (${entry.error})` : ""}`);
  }
}

async function cmdRun(parsed: Record<string, string>, rootDir: string): Promise<void> {
  const goal = parsed.goal;
  if (!goal || goal === "true") {
    console.error("Error: --goal is required for 'run'");
    printUsage();
    process.exit(1);
  }

  const targetProjectPath = parsed.target && parsed.target !== "true" ? parsed.target : process.cwd();
  const additionalAllowedPaths: string[] = [];
  const accessMode: AccessMode = parsed["full-access"] === "true" ? "full_access" : "ask";
  const cliBinary = parsed.binary && parsed.binary !== "true" ? parsed.binary : loopConfig.defaults.cliBinary;
  const profile = resolveCliProfile(parsed.profile ?? null, cliBinary);
  const maxIterations = parseIntSafe(parsed["max-iterations"], loopConfig.defaults.maxIterations);
  const phaseTimeoutMs = parseIntSafe(parsed["phase-timeout"], loopConfig.defaults.phaseTimeoutMs);
  const idleTimeoutMs = parseIntSafe(parsed["idle-timeout"], loopConfig.defaults.idleTimeoutMs);
  const resilience = applyResilienceOverrides(parsed, resilienceSettingsFromConfig());
  validateRuntimeSettings(maxIterations, phaseTimeoutMs, idleTimeoutMs, resilience);
  // This must precede registry initialization and provider model discovery: the
  // provider workspace must never contain mutable orchestration state.
  await assertMutableRootOutsideTarget(rootDir, targetProjectPath);
  if (accessMode === "full_access") warnFullAccessLimitations();

  const registryPath = path.join(rootDir, loopConfig.paths.registryFileName);
  let registry = await atomicReadJson<SessionRegistry>(registryPath);
  if (!registry) {
    await cmdInit(rootDir);
    registry = await atomicReadJson<SessionRegistry>(registryPath);
  }
  if (!registry) {
    console.error("Error: Failed to initialize or read session registry.");
    process.exit(1);
  }
  await ensureAgentConfigFiles(rootDir);
  let reg: SessionRegistry = registry;
  const providers = normalizeProviders(loopConfig.providers);
  const defaultProviderId = providers[profile.name] ? profile.name : "opencode";
  if (parsed.binary && parsed.binary !== "true" && providers[defaultProviderId]) {
    providers[defaultProviderId] = {
      ...providers[defaultProviderId],
      binary: cliBinary,
      modelsArgs: [...profile.modelsArgs],
    };
  }
  const cachedProviderCatalog = reusableProviderCatalog(reg, providers);
  console.log(cachedProviderCatalog
    ? `[orchestrator] Reusing the fresh provider model catalog.`
    : `[orchestrator] Discovering models from all enabled providers...`);
  const providerCatalog = cachedProviderCatalog
    ?? await discoverProviderCatalog(providers, reg.manualModelsOverride);
  const models = flatCatalogModels(providerCatalog);
  if (!cachedProviderCatalog) {
    reg = await mergeAndWriteRegistryFields(registryPath, reg, {
      availableModels: models,
      modelsDiscoveredAt: new Date().toISOString(),
      modelsDiscoveredCli: "all enabled providers",
      providerCatalog,
    });
  }

  if (models.length === 0) {
    console.warn(`[orchestrator] No models discovered. Using fallback model names. Specify models explicitly with --planner-model etc.`);
  } else {
    console.log(`[orchestrator] Discovered ${models.length} models.`);
  }

  const fallbackModels = loopConfig.defaults.profileFallbackModels;
  const profileFallback = providerCatalog[defaultProviderId]?.models[0]
    ?? fallbackModels[profile.name]
    ?? fallbackModels["_default"]
    ?? "anthropic/claude-sonnet-4-5";
  const fallbackModel = models.length > 0 ? models[0] : profileFallback;
  const modelMapping = resolveModelMapping(parsed, models, fallbackModel);
  const providerMapping = resolveProviderMapping(parsed, providers, defaultProviderId);
  alignAutomaticModelsWithProviders(parsed, modelMapping, providerMapping, providerCatalog);
  const variantMapping = resolveVariantMapping(parsed);

  console.log(`[orchestrator] Model mapping:`);
  for (const [role, model] of Object.entries(modelMapping)) {
    const vrnt = variantMapping[role as AgentRole] || "(default)";
    console.log(`  ${role}: ${providerMapping[role] ?? defaultProviderId}/${model} (variant: ${vrnt})`);
  }

  const modelVariantsConfig = await loadModelVariantsConfig(rootDir);
  if (modelVariantsConfig) {
    reg = await mergeAndWriteRegistryFields(registryPath, reg, {
      modelVariants: modelVariantsConfig,
    });
  }

  const sessionId = parsed.session && parsed.session !== "true" ? parsed.session : generateSessionId();
  assertSafeSessionId(sessionId);
  const sessionDir = resolveContainedSessionPath(
    path.join(rootDir, loopConfig.paths.sessionsRoot),
    sessionId
  );
  const statePath = path.join(sessionDir, loopConfig.paths.sessionFileNames.state);
  if (await fse.pathExists(statePath)) {
    console.error(`Error: Session ${sessionId} already exists.`);
    process.exit(1);
  }
  console.log(`[orchestrator] New session: ${sessionId}`);

  const requestedPipelinePath =
    parsed.pipeline && parsed.pipeline !== "true"
      ? path.resolve(parsed.pipeline)
      : null;
  const explicitRolesPath =
    parsed.roles && parsed.roles !== "true"
      ? path.resolve(parsed.roles)
      : null;
  const explicitLoopPath =
    parsed.loop && parsed.loop !== "true"
      ? path.resolve(parsed.loop)
      : null;
  if (explicitRolesPath && !await fse.pathExists(explicitRolesPath)) {
    throw new Error(`Agent roles file not found: ${explicitRolesPath}`);
  }
  if (explicitLoopPath && !await fse.pathExists(explicitLoopPath)) {
    throw new Error(`Agent loop file not found: ${explicitLoopPath}`);
  }
  if (requestedPipelinePath && !await fse.pathExists(requestedPipelinePath)) {
    throw new Error(`Legacy pipeline file not found: ${requestedPipelinePath}`);
  }
  const pipelineConfigPath =
    requestedPipelinePath
      ? requestedPipelinePath
      : null;
  const rolesConfigPath = explicitRolesPath ?? path.join(rootDir, "agent_roles.json");
  const loopGraphConfigPath = explicitLoopPath ?? path.join(rootDir, "agent_loop.json");
  const pipeline = pipelineConfigPath
    ? await loadPipelineDefinition(pipelineConfigPath)
    : await loadSeparatedPipelineDefinition(rolesConfigPath, loopGraphConfigPath);
  for (const role of pipeline.roles) {
    providerMapping[role.id] = role.provider
      ?? providerMapping[role.id]
      ?? providerMapping[role.modelRole]
      ?? defaultProviderId;
    if (!modelMapping[role.id]) {
      modelMapping[role.id] = role.model
        ?? providerCatalog[providerMapping[role.id]]?.models[0]
        ?? modelMapping[role.modelRole];
    }
  }
  console.log(
    `[orchestrator] Pipeline '${pipeline.name}' with ${pipeline.stages.length} stages and ${pipeline.roles.length} roles.`
  );

  const { sessionDir: _, rooms } = await initGoalTree(rootDir, sessionId, pipeline);

  const state = createDefaultLoopState(
    sessionId,
    goal,
    targetProjectPath,
    modelMapping,
    providerMapping,
    providers,
    variantMapping,
    cliBinary,
    profile.name,
    maxIterations,
    phaseTimeoutMs,
    idleTimeoutMs,
    pipeline,
    pipelineConfigPath,
    additionalAllowedPaths,
    accessMode
  );
  state.resilience = resilience;

  await atomicWriteJson(statePath, state);

  reg = await mergeAndWriteSessionMeta(registryPath, reg, {
    sessionId,
    goal,
    targetProjectPath: path.resolve(targetProjectPath),
    status: LoopStatus.RUNNING,
    createdAt: state.createdAt,
  });

  const orchestrator = new LoopOrchestrator(rootDir, reg, state, rooms);
  await orchestrator.run();

  const finalState = await atomicReadJson<LoopState>(statePath);
  if (finalState) {
    console.log(`\n[orchestrator] Session ${sessionId} ended with status: ${finalState.status}`);
    if (finalState.status === LoopStatus.SUCCESS) {
      const summaryPath = path.join(sessionDir, loopConfig.paths.sessionFileNames.finalSummary);
      console.log(`[orchestrator] Final summary: ${summaryPath}`);
    } else if (
      [
        LoopStatus.PAUSED,
        LoopStatus.WAITING_USER,
        LoopStatus.RECOVERING,
        LoopStatus.STOPPED,
        LoopStatus.BLOCKED,
      ].includes(finalState.status)
    ) {
      if (finalState.statusReason) {
        console.log(`[orchestrator] Reason: ${finalState.statusReason}`);
      }
      if (finalState.status === LoopStatus.RECOVERING && finalState.automaticRecovery) {
        console.log(
          `[orchestrator] Automatic recovery is scheduled for ${finalState.automaticRecovery.resumeAt}.`
        );
      } else {
        console.log(
          `[orchestrator] Resume with: agent-loop resume --session ${sessionId} --root ${rootDir}`
        );
      }
    }
  }
}

async function cmdResume(parsed: Record<string, string>, rootDir: string): Promise<void> {
  const sessionId = parsed.session;
  if (!sessionId || sessionId === "true") {
    console.error("Error: --session is required for 'resume'");
    printUsage();
    process.exit(1);
  }
  assertSafeSessionId(sessionId);

  const registryPath = path.join(rootDir, loopConfig.paths.registryFileName);
  let registry = await atomicReadJson<SessionRegistry>(registryPath);
  if (!registry) {
    console.error(`Error: No registry found at ${registryPath}. Run 'agent-loop init' first.`);
    process.exit(1);
  }

  const sessionDir = resolveContainedSessionPath(
    path.join(rootDir, loopConfig.paths.sessionsRoot),
    sessionId
  );
  const statePath = path.join(sessionDir, loopConfig.paths.sessionFileNames.state);
  const loadedState = await atomicReadJson<LoopState>(statePath);
  if (!loadedState) {
    console.error(`Error: No session found with ID ${sessionId}`);
    process.exit(1);
  }
  const normalized = normalizeLoopState(loadedState);
  const state = normalized.state;
  await assertMutableRootOutsideTarget(
    rootDir,
    state.targetProjectPath,
    state.additionalAllowedPaths
  );
  const statusBeforeResume = state.status;
  const wasRunningBeforeResume = statusBeforeResume === LoopStatus.RUNNING;
  const needsRecoveredChildCleanup =
    wasRunningBeforeResume ||
    (statusBeforeResume === LoopStatus.BLOCKED &&
      state.lastFailure?.kind === "orphaned_process");

  if (state.status === LoopStatus.SUCCESS) {
    console.log(`Session ${sessionId} is already SUCCESS. Nothing to resume.`);
    return;
  }
  if (state.status === LoopStatus.FAILED) {
    console.log(`Session ${sessionId} is FAILED. Cannot resume.`);
    return;
  }

  const grantFullAccess = parsed["full-access"] === "true";
  const approvePendingAccess = parsed["approve-access"] === "true";
  if (grantFullAccess) {
    state.accessMode = "full_access";
    state.pendingAccessRequest = null;
  } else if (approvePendingAccess) {
    if (!state.pendingAccessRequest) {
      throw new Error(`Session ${sessionId} has no pending access request to approve.`);
    }
    const approvedPaths = normalizeAdditionalAllowedPaths(
      [...state.additionalAllowedPaths, ...state.pendingAccessRequest.requestedPaths],
      state.targetProjectPath
    );
    await assertMutableRootOutsideTarget(rootDir, state.targetProjectPath, approvedPaths);
    state.additionalAllowedPaths = approvedPaths;
    state.pendingAccessRequest = null;
  }
  if (grantFullAccess || approvePendingAccess) {
    if (state.lastFailure?.kind === "permission") state.lastFailure = null;
    state.lastFailureDigest = null;
  }

  if (parsed["max-iterations"]) state.maxIterations = parseIntSafe(parsed["max-iterations"], state.maxIterations);
  if (parsed["phase-timeout"]) state.phaseTimeoutMs = parseIntSafe(parsed["phase-timeout"], state.phaseTimeoutMs);
  if (parsed["idle-timeout"]) state.idleTimeoutMs = parseIntSafe(parsed["idle-timeout"], state.idleTimeoutMs);
  state.resilience = applyResilienceOverrides(parsed, state.resilience);
  validateRuntimeSettings(
    state.maxIterations,
    state.phaseTimeoutMs,
    state.idleTimeoutMs,
    state.resilience
  );
  if (parsed.binary && parsed.binary !== "true") state.cliBinary = parsed.binary;
  if (parsed.profile && parsed.profile !== "true") state.cliProfile = parsed.profile;
  if (!state.cliProfile) state.cliProfile = resolveCliProfile(null, state.cliBinary).name;
  state.variantMapping = state.variantMapping ?? resolveVariantMapping(parsed);

  resetStaleRunningAgentStates(state.agentStates);

  const recoveryResume = parsed.recovery === "true";
  const accessSettingsChanged =
    grantFullAccess || approvePendingAccess;
  if (state.status === LoopStatus.WAITING_USER && state.pendingAccessRequest) {
    if (normalized.migrated || accessSettingsChanged) {
      if (normalized.migrated) await backupFileOnce(statePath, "v1.backup");
      await withShortFileLock(
        path.join(sessionDir, loopConfig.paths.stateLockFileName),
        () => atomicWriteJson(statePath, state)
      );
    }
    console.log(`Session ${sessionId} is awaiting access approval and remains WAITING_USER.`);
    return;
  }
  if (state.status === LoopStatus.WAITING_USER && state.awaitingPlanApproval && !state.planApproved) {
    if (normalized.migrated || accessSettingsChanged) {
      if (normalized.migrated) await backupFileOnce(statePath, "v1.backup");
      await withShortFileLock(
        path.join(sessionDir, loopConfig.paths.stateLockFileName),
        () => atomicWriteJson(statePath, state)
      );
    }
    console.log(`Session ${sessionId} is awaiting plan approval and remains WAITING_USER.`);
    return;
  }
  if (
    recoveryResume &&
    state.status === LoopStatus.RECOVERING &&
    state.automaticRecovery &&
    Date.parse(state.automaticRecovery.resumeAt) > Date.now()
  ) {
    if (normalized.migrated) {
      await withShortFileLock(
        path.join(sessionDir, loopConfig.paths.stateLockFileName),
        () => atomicWriteJson(statePath, state)
      );
    }
    console.log(
      `Session ${sessionId} remains RECOVERING until ${state.automaticRecovery.resumeAt}.`
    );
    return;
  }

  if (state.accessMode === "full_access") warnFullAccessLimitations();

  const ownership = new SessionOwnership({
    sessionDir,
    ownerLockFileName: loopConfig.paths.ownerLockFileName,
    leaseFileName: loopConfig.paths.leaseFileName,
    heartbeatIntervalMs: state.resilience.heartbeatIntervalMs,
    leaseTtlMs: state.resilience.leaseTtlMs,
  });
  const ownershipResult = await ownership.acquire();
  let ownershipTransferred = false;
  try {
    if (normalized.migrated) {
      await backupFileOnce(statePath, "v1.backup");
      await withShortFileLock(
        path.join(sessionDir, loopConfig.paths.stateLockFileName),
        () => atomicWriteJson(statePath, state)
      );
    }

    const startsManualRecoveryCycle = shouldStartManualRecoveryCycle(
      state,
      recoveryResume
    );
    const resumableStatuses = new Set<LoopStatus>([
      LoopStatus.PAUSED,
      LoopStatus.WAITING_USER,
      LoopStatus.RECOVERING,
      LoopStatus.STOPPED,
      LoopStatus.BLOCKED,
    ]);
    if (resumableStatuses.has(state.status)) {
      const scheduledAutomaticRecovery =
        recoveryResume && state.status === LoopStatus.RECOVERING;
      state.status = LoopStatus.RUNNING;
      state.statusReason = null;
      if (startsManualRecoveryCycle || scheduledAutomaticRecovery) {
        if (startsManualRecoveryCycle) state.recoveryCount++;
        if (!scheduledAutomaticRecovery) state.automaticRecovery = null;
        if (state.activeAttempt && state.activeAttempt.status !== "succeeded") {
          state.activeAttempt.attemptNumber = 0;
          state.activeAttempt.status = "retry_wait";
          state.activeAttempt.nextRetryAt = null;
          state.activeAttempt.reconnectUsed = false;
          state.activeAttempt.cliSessionId = null;
          state.activeAttempt.mode = "standard";
          state.activeAttempt.completionRecoveryNumber = 0;
          state.activeAttempt.cycleStartedAt = new Date().toISOString();
        }
      }

      if (state.awaitingPlanApproval && state.planApproved) {
        try {
          const plan = await fse.readFile(
            path.join(sessionDir, loopConfig.paths.sessionFileNames.plan),
            "utf8"
          );
          if (plan.trim().length > 0) state.refinedGoal = plan.trim();
        } catch { /* plan.md not yet written */ }
        state.planningComplete = true;
        state.awaitingPlanApproval = false;
        const planningStage = stageById(state.pipeline, state.phase);
        applyPipelineTarget(state, planningStage.onSuccess);
      } else if (state.planPath) {
        try {
          const plan = await fse.readFile(state.planPath, "utf8");
          if (plan.trim().length > 0) state.refinedGoal = plan.trim();
        } catch { /* keep existing refinedGoal */ }
      }

      if (state.planRevisionPending) {
        state.phase = state.pipeline.reentryStageId;
        state.interruptBriefing = null;
        state.interruptMessage = undefined;
        state.interruptedFromPhase = null;
        state.lastFailureDigest = null;
      } else if (state.phase === state.pipeline.interruptStageId) {
        state.phase = state.interruptedFromPhase ?? state.pipeline.reentryStageId;
        state.interruptedFromPhase = null;
        state.interruptBriefing = null;
      }
    }

    const rooms: Partial<Record<AgentRole, AgentRoom>> = {};
    for (const roleDefinition of state.pipeline.roles) {
      const role = roleDefinition.id;
      const roomDir = path.join(sessionDir, roomDirectoryName(state.pipeline, role));
      await fse.ensureDir(roomDir);
      rooms[role] = {
        role,
        statePath: path.join(roomDir, loopConfig.paths.roomFileNames.state),
        skillsPath: path.join(roomDir, loopConfig.paths.roomFileNames.skills),
        inputPayloadPath: path.join(roomDir, loopConfig.paths.roomFileNames.input),
        outputPayloadPath: path.join(roomDir, loopConfig.paths.roomFileNames.output),
      };
      if (!await fse.pathExists(rooms[role]!.skillsPath)) {
        await atomicWriteJson(rooms[role]!.skillsPath, skillsForPipelineRole(roleDefinition));
      }
      if (!await fse.pathExists(rooms[role]!.statePath)) {
        await atomicWriteJson(rooms[role]!.statePath, state.agentStates[role]);
      }
    }

    await withShortFileLock(
      path.join(sessionDir, loopConfig.paths.stateLockFileName),
      () => atomicWriteJson(statePath, state)
    );

    registry = await mergeAndWriteSessionMeta(registryPath, registry, {
      sessionId,
      goal: state.goal,
      targetProjectPath: state.targetProjectPath,
      status: state.status,
      createdAt: state.createdAt,
    });

    const orchestrator = new LoopOrchestrator(
      rootDir,
      registry,
      state,
      rooms as Record<AgentRole, AgentRoom>,
      ownership
    );
    ownershipTransferred = true;
    await orchestrator.run(
      ownershipResult,
      recoveryResume && needsRecoveredChildCleanup
    );

    const finalState = await atomicReadJson<LoopState>(statePath);
    if (finalState) {
      console.log(`\n[orchestrator] Session ${sessionId} ended with status: ${finalState.status}`);
    }
  } finally {
    if (!ownershipTransferred) {
      await ownership.release();
    }
  }
}

async function cmdRevisePlan(parsed: Record<string, string>, rootDir: string): Promise<void> {
  const sessionId = parsed.session;
  if (!sessionId || sessionId === "true") {
    console.error("Error: --session is required for 'revise-plan'");
    process.exit(1);
  }
  assertSafeSessionId(sessionId);
  const message = parsed.message || "";
  if (!message || message === "true") {
    console.error("Error: --message is required for 'revise-plan'");
    process.exit(1);
  }

  const registryPath = path.join(rootDir, loopConfig.paths.registryFileName);
  const registry = await atomicReadJson<SessionRegistry>(registryPath);
  if (!registry) {
    console.error(`Error: No registry found at ${registryPath}.`);
    process.exit(1);
  }

  const sessionDir = resolveContainedSessionPath(
    path.join(rootDir, loopConfig.paths.sessionsRoot),
    sessionId
  );
  const statePath = path.join(sessionDir, loopConfig.paths.sessionFileNames.state);
  const stateRaw = await atomicReadJson<LoopState>(statePath);
  if (!stateRaw) {
    console.error(`Error: No session found with ID ${sessionId}`);
    process.exit(1);
  }
  const state = normalizeLoopState(stateRaw).state;
  await assertMutableRootOutsideTarget(
    rootDir,
    state.targetProjectPath,
    state.additionalAllowedPaths
  );

  const planPath = path.join(sessionDir, loopConfig.paths.sessionFileNames.plan);
  let currentPlan = "";
  try { currentPlan = await fse.readFile(planPath, "utf8"); } catch { /* empty */ }

  const prompt = `You are the planner agent. Revise the plan according to the user's request.

Current Plan:
${currentPlan || "(no plan yet — the goal is: " + (state.refinedGoal || state.goal) + ")"}

User Revision Request: ${message}

Output the full revised plan as markdown only. Do not include the original prompt or any meta-commentary. Output ONLY the revised markdown plan.`;

  const planningStage =
    state.pipeline.stages.find((stage) => executorForStage(state.pipeline, stage) === "planning") ??
    stageById(state.pipeline, state.pipeline.startStageId);
  const planningRole = roleForStage(state.pipeline, planningStage);
  const providerId = planningRole.provider
    ?? state.providerMapping?.[planningRole.id]
    ?? state.providerMapping?.[planningRole.modelRole]
    ?? state.cliProfile;
  const provider = state.providerConfigs?.[providerId] ?? loopConfig.providers[providerId];
  if (!provider?.enabled) throw new Error(`Planner provider '${providerId}' is missing or disabled.`);
  // Plan revision is a read-only role. MCP capabilities have no persisted
  // side-effect classification, so do not even resolve their credentials.
  const runtimeMcpServers: McpServerConfig[] = [];
  const sensitiveValues = runtimeSensitiveValues(runtimeMcpServers);
  const invocation = buildProviderInvocation(provider, {
    model: planningRole.model ?? state.modelMapping[planningRole.modelRole],
    targetProjectPath: state.targetProjectPath,
    additionalAllowedPaths: state.additionalAllowedPaths,
    prompt,
    variant: planningRole.variant ?? state.variantMapping?.[planningRole.modelRole],
    fullAccess: state.accessMode === "full_access",
    readOnly: true,
    webSearch: state.toolAccess.webSearch.enabled,
    webSearchMode: state.toolAccess.webSearch.mode,
    mcpServers: runtimeMcpServers,
  });
  const supervised = await new ProcessSupervisor().run({
    binary: resolveBinaryOnWindows(invocation.binary),
    args: invocation.args,
    cwd: state.targetProjectPath,
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
      ),
      ...invocation.env,
    },
    cols: loopConfig.defaults.ptyCols,
    rows: loopConfig.defaults.ptyRows,
    useConpty: process.platform === "win32" && !!process.stdin?.isTTY,
    transportTimeoutMs: state.resilience.transportTimeoutMs,
    idleTimeoutMs: state.idleTimeoutMs,
    toolTimeoutMs: state.resilience.toolTimeoutMs,
    phaseTimeoutMs: state.phaseTimeoutMs,
    terminationGraceMs: state.resilience.terminationGraceMs,
    killTimeoutMs: state.resilience.killTimeoutMs,
    maxInMemoryOutputBytes: state.resilience.maxInMemoryOutputBytes,
    rawLogPath: path.join(
      sessionDir,
      loopConfig.paths.attemptLogsDirName,
      `plan_revision_${createId("attempt")}.log`
    ),
    interactionWhitelist: (provider.interactionWhitelist ?? INTERACTION_WHITELIST)
      .filter((pattern) => !/(?:allow|permission|action required|run command)/i.test(pattern)),
    destructivePrompts: loopConfig.destructivePrompts,
    sensitiveValues,
  });
  const result: PtyRunResult = {
    ...supervised,
    timedOut:
      supervised.outcome === "transport_timeout" ||
      supervised.outcome === "idle_timeout" ||
      supervised.outcome === "phase_timeout",
    cancelled: supervised.cancelled,
  };

  const output = extractOutput(result);
  const revised = result.assistantText?.trim() ?? "";
  if (
    supervised.outcome !== "succeeded" ||
    result.exitCode !== 0 ||
    revised.length === 0
  ) {
    const failureMessage =
      supervised.failureMessage ??
      (revised.length === 0
        ? "Planner exited without a non-empty assistant response."
        : `Planner exited with code ${result.exitCode}.`);
    console.error(`Plan revision was not committed: ${failureMessage}`);
    if (output.length > 0) console.log(output);
    process.exit(1);
  }

  const stateLockPath = path.join(
    sessionDir,
    loopConfig.paths.stateLockFileName
  );
  let committedLoopCount = state.loopCount;
  await withShortFileLock(stateLockPath, async () => {
    const latestRaw = await atomicReadJson<LoopState>(statePath);
    if (!latestRaw) {
      throw new Error(`Session state disappeared while revising plan: ${sessionId}`);
    }
    const latest = normalizeLoopState(latestRaw).state;
    const planRevisionStatuses = new Set<LoopStatus>([
      LoopStatus.PAUSED,
      LoopStatus.WAITING_USER,
      LoopStatus.STOPPED,
      LoopStatus.BLOCKED,
    ]);
    if (!planRevisionStatuses.has(latest.status)) {
      throw new Error(
        `Session ${sessionId} is not in a user-controlled hold state; the revised plan was not committed.`
      );
    }
    await atomicWriteText(planPath, `${revised}\n`);
    latest.planPath = planPath;
    latest.refinedGoal = revised;
    if (latest.planningComplete) {
      latest.planRevisionPending = true;
    }
    latest.convergence = { stagnantCycles: 0, history: [] };
    latest.updatedAt = new Date().toISOString();
    committedLoopCount = latest.loopCount;
    await atomicWriteJson(statePath, latest);
  });
  const notesPath = path.join(sessionDir, loopConfig.paths.sessionFileNames.progressNotes);
  await atomicAppendLine(
    notesPath,
    `[Loop ${committedLoopCount}] PLAN_REVISION: Plan revised by operator. Re-implementation required on resume.`
  );

  console.log(revised);
  process.exit(0);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    printUsage();
    process.exit(1);
  }

  const command = args[0];

  if (command === "--help" || command === "-h") {
    printUsage();
    return;
  }

  const parsed = parseArgs(args.slice(1));
  const rootDir = await resolveRootDir(parsed);
  loopConfig = await loadLoopConfig(rootDir);
  if (command === "run") {
    const targetProjectPath = parsed.target && parsed.target !== "true"
      ? parsed.target
      : process.cwd();
    await assertMutableRootOutsideTarget(rootDir, targetProjectPath);
  }
  if (command !== "init") {
    await reconcileSessionRegistry(rootDir);
  }

  switch (command) {
    case "init":
      await cmdInit(rootDir);
      break;
    case "models":
      await cmdModels(parsed, rootDir);
      break;
    case "run":
      await cmdRun(parsed, rootDir);
      break;
    case "resume":
      await cmdResume(parsed, rootDir);
      break;
    case "revise-plan":
      await cmdRevisePlan(parsed, rootDir);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
  }
  process.exit(0);
}

if (require.main === module) {
  void main().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[fatal] ${msg}`);
    process.exit(1);
  });
}
