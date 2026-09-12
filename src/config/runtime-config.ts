import * as path from "node:path";
import * as fse from "fs-extra";
import { readPackagedConfigJson } from "./package-config-root";
import {
  DEFAULT_PROVIDERS,
  DEFAULT_TOOL_ACCESS,
  ProviderConfig,
  ToolAccessConfig,
  assertMcpCredentialsAreReferenced,
  normalizeProviders,
  validateToolAccess,
} from "../runtime/providers/provider-runtime";

const runtimeDefaults = readPackagedConfigJson<{
  maxCycles: number;
  phaseTimeoutMs: number;
  idleTimeoutMs: number;
  toolTimeoutMs: number;
  transportTimeoutMs: number;
  maxAgentAttempts: number;
  retryBackoffMs: number[];
  terminationGraceMs: number;
  killTimeoutMs: number;
  heartbeatIntervalMs: number;
  leaseTtlMs: number;
  maxInMemoryOutputBytes: number;
}>("runtime_defaults.json");

export const RUNTIME_DEFAULTS = runtimeDefaults;

export interface LoopPathsConfig {
  sessionsRoot: string;
  registryFileName: string;
  sessionsIndexFileName: string;
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
  verificationLogsDirName: string;
}

export interface LoopDefaultsConfig {
  cliBinary: string;
  maxCycles: number;
  phaseTimeoutMs: number;
  idleTimeoutMs: number;
  ptyCols: number;
  ptyRows: number;
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
      sessionsIndexFileName: "sessions_index.json",
      variantsConfigFileName: "model_variants.json",
      loopHistoryDirName: "loop_history",
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
      controlDirName: "control",
      ownerLockFileName: "session_owner.lock",
      stateLockFileName: "state_write.lock",
      leaseFileName: "session_lease.json",
      registryLockFileName: "registry.lock",
      attemptLogsDirName: "attempt_logs",
      verificationLogsDirName: "verification_logs",
    },
    defaults: {
      cliBinary: "opencode",
      maxCycles: RUNTIME_DEFAULTS.maxCycles,
      phaseTimeoutMs: RUNTIME_DEFAULTS.phaseTimeoutMs,
      idleTimeoutMs: RUNTIME_DEFAULTS.idleTimeoutMs,
      ptyCols: 200,
      ptyRows: 50,
      transportTimeoutMs: RUNTIME_DEFAULTS.transportTimeoutMs,
      toolTimeoutMs: RUNTIME_DEFAULTS.toolTimeoutMs,
      maxAgentAttempts: RUNTIME_DEFAULTS.maxAgentAttempts,
      retryBackoffMs: [...RUNTIME_DEFAULTS.retryBackoffMs],
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
  const objectOverride = <T extends object>(value: unknown, label: string): T | undefined => {
    if (value === undefined) return undefined;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object when provided.`);
    return value as T;
  };
  const overridePaths = objectOverride<Partial<LoopPathsConfig>>(overrides.paths, "paths");
  const overrideDefaults = objectOverride<Partial<LoopDefaultsConfig>>(overrides.defaults, "defaults");
  const overrideProfiles = objectOverride<Record<string, LoopCliProfileConfig>>(overrides.cliProfiles, "cliProfiles");
  const overrideProviders = objectOverride<Record<string, Partial<ProviderConfig>>>(overrides.providers, "providers");
  const overrideToolAccess = objectOverride<Partial<ToolAccessConfig>>(overrides.toolAccess, "toolAccess");
  const overrideVariants = objectOverride<Record<string, string[]>>(overrides.variantDefaults, "variantDefaults");
  if (overrides.destructivePrompts !== undefined && !Array.isArray(overrides.destructivePrompts)) throw new Error("destructivePrompts must be an array when provided.");
  const assertKeys = (value: Record<string, unknown> | undefined, allowed: ReadonlySet<string>, label: string): void => {
    if (!value) return;
    for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${label} contains unsupported field: ${key}`);
  };
  const pathKeys = new Set(["sessionsRoot", "registryFileName", "sessionsIndexFileName", "variantsConfigFileName", "loopHistoryDirName", "sessionFileNames", "roomFileNames", "roomDirNames", "controlDirName", "ownerLockFileName", "stateLockFileName", "leaseFileName", "registryLockFileName", "attemptLogsDirName", "verificationLogsDirName"]);
  const sessionFileKeys = new Set(["state", "progressNotes", "finalSummary", "plan", "planChoices", "planOverview", "planOptionsDir", "interruptMessage", "stopRequest"]);
  const roomFileKeys = new Set(["state", "skills", "input", "output"]);
  const defaultKeys = new Set(["cliBinary", "maxCycles", "phaseTimeoutMs", "idleTimeoutMs", "ptyCols", "ptyRows", "transportTimeoutMs", "toolTimeoutMs", "maxAgentAttempts", "retryBackoffMs", "terminationGraceMs", "killTimeoutMs", "heartbeatIntervalMs", "leaseTtlMs", "maxInMemoryOutputBytes"]);
  assertKeys(overridePaths as Record<string, unknown> | undefined, pathKeys, "paths");
  if (overridePaths?.sessionFileNames !== undefined) assertKeys(objectOverride<Record<string, unknown>>(overridePaths.sessionFileNames, "paths.sessionFileNames"), sessionFileKeys, "paths.sessionFileNames");
  if (overridePaths?.roomFileNames !== undefined) assertKeys(objectOverride<Record<string, unknown>>(overridePaths.roomFileNames, "paths.roomFileNames"), roomFileKeys, "paths.roomFileNames");
  if (overridePaths?.roomDirNames !== undefined) objectOverride<Record<string, unknown>>(overridePaths.roomDirNames, "paths.roomDirNames");
  assertKeys(overrideDefaults as Record<string, unknown> | undefined, defaultKeys, "defaults");
  if (overrideProfiles) {
    for (const [name, profile] of Object.entries(overrideProfiles)) {
      assertKeys(objectOverride<Record<string, unknown>>(profile, `cliProfiles.${name}`), new Set(["defaultBinary", "modelsArgs", "interactionWhitelist", "extraInteractionPatterns"]), `cliProfiles.${name}`);
    }
  }
  if (overrideToolAccess?.webSearch !== undefined) objectOverride<Record<string, unknown>>(overrideToolAccess.webSearch, "toolAccess.webSearch");
  if (overrideToolAccess?.mcpServers !== undefined && !Array.isArray(overrideToolAccess.mcpServers)) throw new Error("toolAccess.mcpServers must be an array when provided.");
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
      ...overrideDefaults,
    } as LoopDefaultsConfig,
    cliProfiles: { ...defaults.cliProfiles, ...overrideProfiles },
    providers: normalizeProviders({ ...defaults.providers, ...overrideProviders }),
    toolAccess: validateToolAccess(overrideToolAccess ?? defaults.toolAccess),
    destructivePrompts: overrides.destructivePrompts ?? defaults.destructivePrompts,
    variantDefaults: { ...defaults.variantDefaults, ...overrideVariants },
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
    sessionsIndexFileName: paths.sessionsIndexFileName,
    variantsConfigFileName: paths.variantsConfigFileName,
    loopHistoryDirName: paths.loopHistoryDirName,
    controlDirName: paths.controlDirName,
    ownerLockFileName: paths.ownerLockFileName,
    stateLockFileName: paths.stateLockFileName,
    leaseFileName: paths.leaseFileName,
    registryLockFileName: paths.registryLockFileName,
    attemptLogsDirName: paths.attemptLogsDirName,
    verificationLogsDirName: paths.verificationLogsDirName,
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
    "maxCycles",
    "phaseTimeoutMs",
    "idleTimeoutMs",
    "ptyCols",
    "ptyRows",
    "transportTimeoutMs",
    "toolTimeoutMs",
    "maxAgentAttempts",
    "terminationGraceMs",
    "killTimeoutMs",
    "heartbeatIntervalMs",
    "leaseTtlMs",
    "maxInMemoryOutputBytes",
  ] as const) {
    assertPositiveInteger(defaults[key], `defaults.${key}`, 1);
  }
  for (const [key, values] of [["retryBackoffMs", defaults.retryBackoffMs]] as const) {
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
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Configuration root must be an object.");
    }
    const overridesRecord = parsed as Record<string, unknown>;
    const allowedTopLevel = new Set(["$schema", "paths", "defaults", "cliProfiles", "providers", "toolAccess", "destructivePrompts", "variantDefaults"]);
    for (const key of Object.keys(overridesRecord)) {
      if (!allowedTopLevel.has(key)) throw new Error(`Unsupported configuration field: ${key}`);
    }
    if (overridesRecord.$schema !== undefined && (typeof overridesRecord.$schema !== "string" || !overridesRecord.$schema.trim())) {
      throw new Error("$schema must be a non-empty string when provided.");
    }
    const overrides = overridesRecord as Partial<LoopConfig>;
    const merged = validateMergedConfig(mergeConfig(defaults, overrides));
    assertMcpCredentialsAreReferenced(merged.toolAccess);
    return merged;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Configuration is not initialized at ${cfgPath}. Run the init command first.`);
    }
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to load ${cfgPath}: ${reason}`);
  }
}
