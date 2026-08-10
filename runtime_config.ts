import * as path from "node:path";
import * as fse from "fs-extra";
import {
  DEFAULT_PROVIDERS,
  DEFAULT_TOOL_ACCESS,
  ProviderConfig,
  ToolAccessConfig,
  assertMcpCredentialsAreReferenced,
  normalizeProviders,
  validateToolAccess,
} from "./provider_runtime";
import runtimeDefaults from "./runtime_defaults.json";

export const RUNTIME_DEFAULTS = runtimeDefaults;

export interface LoopPathsConfig {
  sessionsRoot: string;
  registryFileName: string;
  variantsConfigFileName: string;
  loopHistoryDirName: string;
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
  roomFileNames: { state: string; skills: string; input: string; output: string };
  roomDirNames: Record<string, string>;
  controlDirName: string;
  ownerLockFileName: string;
  stateLockFileName: string;
  leaseFileName: string;
  registryLockFileName: string;
  attemptLogsDirName: string;
}

export interface LoopDefaultsConfig {
  cliBinary: string;
  maxIterations: number;
  phaseTimeoutMs: number;
  idleTimeoutMs: number;
  ptyCols: number;
  ptyRows: number;
  profileFallbackModels: Record<string, string>;
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

export interface LoopCliProfileConfig {
  defaultBinary: string;
  modelsArgs: string[];
  interactionWhitelist: string[];
  extraInteractionPatterns: string[];
}

export interface LoopConfig {
  paths: LoopPathsConfig;
  defaults: LoopDefaultsConfig;
  cliProfiles: Record<string, LoopCliProfileConfig>;
  providers: Record<string, ProviderConfig>;
  toolAccess: ToolAccessConfig;
  destructivePrompts: string[];
  variantDefaults: Record<string, string[]>;
}

export function getDefaultConfig(): LoopConfig {
  return {
    paths: {
      sessionsRoot: ".goal/sessions",
      registryFileName: "sessions_registry.json",
      variantsConfigFileName: "model_variants.json",
      loopHistoryDirName: "loop_history",
      sessionFileNames: {
        state: "loop_state.json",
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
      controlDirName: "control",
      ownerLockFileName: "session_owner.lock",
      stateLockFileName: "state_write.lock",
      leaseFileName: "session_lease.json",
      registryLockFileName: "registry.lock",
      attemptLogsDirName: "attempt_logs",
    },
    defaults: {
      cliBinary: "opencode",
      maxIterations: RUNTIME_DEFAULTS.maxIterations,
      phaseTimeoutMs: RUNTIME_DEFAULTS.phaseTimeoutMs,
      idleTimeoutMs: RUNTIME_DEFAULTS.idleTimeoutMs,
      ptyCols: 200,
      ptyRows: 50,
      profileFallbackModels: {
        opencode: "opencode/big-pickle",
        kilo: "anthropic/claude-sonnet-4-5",
        _default: "anthropic/claude-sonnet-4-5",
      },
      transportTimeoutMs: RUNTIME_DEFAULTS.transportTimeoutMs,
      toolTimeoutMs: RUNTIME_DEFAULTS.toolTimeoutMs,
      maxAgentAttempts: RUNTIME_DEFAULTS.maxAgentAttempts,
      maxCompletionRecoveryAttempts: RUNTIME_DEFAULTS.maxCompletionRecoveryAttempts,
      maxAutomaticRecoveryCycles: RUNTIME_DEFAULTS.maxAutomaticRecoveryCycles,
      automaticRecoveryBackoffMs: [...RUNTIME_DEFAULTS.automaticRecoveryBackoffMs],
      retryBackoffMs: [...RUNTIME_DEFAULTS.retryBackoffMs],
      phaseRecoveryBudgetMs: RUNTIME_DEFAULTS.phaseRecoveryBudgetMs,
      terminationGraceMs: RUNTIME_DEFAULTS.terminationGraceMs,
      killTimeoutMs: RUNTIME_DEFAULTS.killTimeoutMs,
      heartbeatIntervalMs: RUNTIME_DEFAULTS.heartbeatIntervalMs,
      leaseTtlMs: RUNTIME_DEFAULTS.leaseTtlMs,
      maxInMemoryOutputBytes: RUNTIME_DEFAULTS.maxInMemoryOutputBytes,
    },
    cliProfiles: {},
    providers: normalizeProviders(DEFAULT_PROVIDERS),
    toolAccess: validateToolAccess(DEFAULT_TOOL_ACCESS),
    destructivePrompts: [
      "Delete", "Remove all", "Destroy", "Force overwrite",
      "git clean", "git checkout --", "git reset --hard",
      "Drop table", "Drop database",
    ],
    variantDefaults: {
      anthropic: ["high", "max"],
      openai: ["none", "minimal", "low", "medium", "high", "xhigh"],
      google: ["low", "high"],
      gemini: ["low", "high"],
      opencode: ["none", "minimal", "low", "medium", "high", "xhigh"],
      "opencode-go": ["none", "minimal", "low", "medium", "high", "xhigh"],
      kilo: ["none", "minimal", "low", "medium", "high", "xhigh"],
      deepseek: ["low", "medium", "high", "max"],
    },
  };
}

function mergeConfig(defaults: LoopConfig, overrides: Partial<LoopConfig>): LoopConfig {
  const overridePaths = overrides.paths;
  return {
    paths: {
      ...defaults.paths,
      ...overridePaths,
      sessionFileNames: {
        ...defaults.paths.sessionFileNames,
        ...overridePaths?.sessionFileNames,
      },
      roomFileNames: {
        ...defaults.paths.roomFileNames,
        ...overridePaths?.roomFileNames,
      },
      roomDirNames: {
        ...defaults.paths.roomDirNames,
        ...overridePaths?.roomDirNames,
      },
    } as LoopPathsConfig,
    defaults: {
      ...defaults.defaults,
      ...overrides.defaults,
      profileFallbackModels: {
        ...defaults.defaults.profileFallbackModels,
        ...overrides.defaults?.profileFallbackModels,
      },
    } as LoopDefaultsConfig,
    cliProfiles: { ...defaults.cliProfiles, ...overrides.cliProfiles },
    providers: normalizeProviders({ ...defaults.providers, ...overrides.providers }),
    toolAccess: validateToolAccess(overrides.toolAccess ?? defaults.toolAccess),
    destructivePrompts: overrides.destructivePrompts ?? defaults.destructivePrompts,
    variantDefaults: { ...defaults.variantDefaults, ...overrides.variantDefaults },
  };
}

function assertSafeRelativePath(value: unknown, label: string, singleSegment = false): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty relative path.`);
  }
  const candidate = value.trim();
  if (
    path.isAbsolute(candidate) ||
    path.win32.isAbsolute(candidate) ||
    path.posix.isAbsolute(candidate) ||
    candidate.includes("\0")
  ) {
    throw new Error(`${label} must stay relative to the agent-loop data root.`);
  }
  const portableParts = candidate.replace(/\\/g, "/").split("/");
  if (portableParts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`${label} contains an unsafe path segment.`);
  }
  const windowsReservedName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
  if (portableParts.some((part) =>
    /[\x00-\x1f<>:"|?*]/.test(part) ||
    /[ .]$/.test(part) ||
    windowsReservedName.test(part)
  )) {
    throw new Error(`${label} contains a non-portable or unsafe path segment.`);
  }
  if (singleSegment && portableParts.length !== 1) {
    throw new Error(`${label} must be a single path segment.`);
  }
  return candidate;
}

function assertPositiveInteger(value: unknown, label: string, minimum = 1): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new Error(`${label} must be an integer greater than or equal to ${minimum}.`);
  }
  return Number(value);
}

function validateMergedConfig(config: LoopConfig): LoopConfig {
  const paths = config.paths;
  assertSafeRelativePath(paths.sessionsRoot, "paths.sessionsRoot");
  for (const [key, value] of Object.entries({
    registryFileName: paths.registryFileName,
    variantsConfigFileName: paths.variantsConfigFileName,
    loopHistoryDirName: paths.loopHistoryDirName,
    controlDirName: paths.controlDirName,
    ownerLockFileName: paths.ownerLockFileName,
    stateLockFileName: paths.stateLockFileName,
    leaseFileName: paths.leaseFileName,
    registryLockFileName: paths.registryLockFileName,
    attemptLogsDirName: paths.attemptLogsDirName,
  })) {
    assertSafeRelativePath(value, `paths.${key}`, true);
  }
  for (const [key, value] of Object.entries(paths.sessionFileNames)) {
    assertSafeRelativePath(value, `paths.sessionFileNames.${key}`, true);
  }
  for (const [key, value] of Object.entries(paths.roomFileNames)) {
    assertSafeRelativePath(value, `paths.roomFileNames.${key}`, true);
  }
  for (const [key, value] of Object.entries(paths.roomDirNames)) {
    assertSafeRelativePath(value, `paths.roomDirNames.${key}`, true);
  }

  const defaults = config.defaults;
  if (typeof defaults.cliBinary !== "string" || !defaults.cliBinary.trim()) {
    throw new Error("defaults.cliBinary must be a non-empty string.");
  }
  for (const key of [
    "maxIterations",
    "phaseTimeoutMs",
    "idleTimeoutMs",
    "ptyCols",
    "ptyRows",
    "transportTimeoutMs",
    "toolTimeoutMs",
    "maxAgentAttempts",
    "maxCompletionRecoveryAttempts",
    "maxAutomaticRecoveryCycles",
    "phaseRecoveryBudgetMs",
    "terminationGraceMs",
    "killTimeoutMs",
    "heartbeatIntervalMs",
    "leaseTtlMs",
    "maxInMemoryOutputBytes",
  ] as const) {
    const minimum = key === "maxCompletionRecoveryAttempts" || key === "maxAutomaticRecoveryCycles" ? 0 : 1;
    assertPositiveInteger(defaults[key], `defaults.${key}`, minimum);
  }
  for (const [key, values] of [
    ["automaticRecoveryBackoffMs", defaults.automaticRecoveryBackoffMs],
    ["retryBackoffMs", defaults.retryBackoffMs],
  ] as const) {
    if (!Array.isArray(values) || values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
      throw new Error(`defaults.${key} must contain only non-negative integer milliseconds.`);
    }
  }
  if (defaults.transportTimeoutMs > defaults.phaseTimeoutMs) {
    throw new Error("defaults.transportTimeoutMs must not exceed defaults.phaseTimeoutMs.");
  }
  if (defaults.idleTimeoutMs > defaults.phaseTimeoutMs) {
    throw new Error("defaults.idleTimeoutMs must not exceed defaults.phaseTimeoutMs.");
  }
  if (defaults.toolTimeoutMs > defaults.phaseTimeoutMs) {
    throw new Error("defaults.toolTimeoutMs must not exceed defaults.phaseTimeoutMs.");
  }
  if (defaults.heartbeatIntervalMs >= defaults.leaseTtlMs) {
    throw new Error("defaults.heartbeatIntervalMs must be lower than defaults.leaseTtlMs.");
  }
  if (defaults.terminationGraceMs > defaults.killTimeoutMs) {
    throw new Error("defaults.terminationGraceMs must not exceed defaults.killTimeoutMs.");
  }
  let scheduledRetryMs = 0;
  for (let index = 0; index < defaults.maxAgentAttempts - 1; index += 1) {
    scheduledRetryMs += defaults.retryBackoffMs.length > 0
      ? defaults.retryBackoffMs[Math.min(index, defaults.retryBackoffMs.length - 1)]
      : 0;
  }
  const minimumRecoveryBudget = defaults.phaseTimeoutMs * defaults.maxAgentAttempts + scheduledRetryMs;
  if (defaults.phaseRecoveryBudgetMs < minimumRecoveryBudget) {
    throw new Error(
      `defaults.phaseRecoveryBudgetMs must cover all attempts and backoff (${minimumRecoveryBudget}ms minimum).`
    );
  }
  if (defaults.maxInMemoryOutputBytes < 1024) {
    throw new Error("defaults.maxInMemoryOutputBytes must be at least 1024 bytes.");
  }
  for (const [name, profile] of Object.entries(config.cliProfiles)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) {
      throw new Error(`Unsafe CLI profile id: ${name}`);
    }
    if (!profile || typeof profile.defaultBinary !== "string" || !profile.defaultBinary.trim()) {
      throw new Error(`cliProfiles.${name}.defaultBinary must be a non-empty string.`);
    }
    for (const [key, values] of Object.entries({
      modelsArgs: profile.modelsArgs,
      interactionWhitelist: profile.interactionWhitelist,
      extraInteractionPatterns: profile.extraInteractionPatterns,
    })) {
      if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) {
        throw new Error(`cliProfiles.${name}.${key} must be an array of strings.`);
      }
    }
  }
  if (!Array.isArray(config.destructivePrompts) || config.destructivePrompts.some((value) => typeof value !== "string")) {
    throw new Error("destructivePrompts must be an array of strings.");
  }
  for (const [key, values] of Object.entries(config.variantDefaults)) {
    if (!key || !Array.isArray(values) || values.some((value) => typeof value !== "string" || !value)) {
      throw new Error(`variantDefaults.${key} must be an array of non-empty strings.`);
    }
  }
  return config;
}

export async function loadLoopConfig(rootDir: string): Promise<LoopConfig> {
  const cfgPath = path.join(rootDir, "loop_config.json");
  const defaults = getDefaultConfig();
  try {
    const raw = await fse.readFile(cfgPath, "utf-8");
    const overrides = JSON.parse(raw) as Partial<LoopConfig>;
    const merged = validateMergedConfig(mergeConfig(defaults, overrides));
    assertMcpCredentialsAreReferenced(merged.toolAccess);
    return merged;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return validateMergedConfig(defaults);
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to load ${cfgPath}: ${reason}`);
  }
}
