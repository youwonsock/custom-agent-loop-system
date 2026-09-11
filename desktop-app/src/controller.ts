import * as path from "node:path";
import * as fsp from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { shell } from "electron";
import { CoreProcessRunner, type CoreLogEvent, type CoreProcessHandle } from "./core-process-runner";
import { initDesktopRoots, validateProjectPath, type DesktopRoots } from "./paths";
import { SecretStore } from "./secret-store";
import { validateDesktopSettings, validateDesktopSnapshot, validateModelDiscoveryPayload, validateProviderDiscoveryResultV2, validateRunProjectionV2 } from "./shared";
import type {
  DesktopSettings,
  DesktopSnapshot,
  ProviderDiscoveryResultV2,
  RunProjectionV2,
  SessionBundle,
  SessionIndexProjectionV4,
  ReleaseResult,
  ReleaseFailure,
} from "./shared";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const DEFAULT_SESSIONS_ROOT = ".goal/sessions";
const INIT_MANIFEST_FILE_NAME = "init_manifest.v1.json";
const HASHED_DEFINITION_FILES = [
  "agents.json", "agents.schema.json", "tasks.json", "tasks.schema.json",
  "workflow.json", "workflow.schema.json", "loop_config.schema.json",
] as const;

export interface ControllerEvents {
  state: (snapshot: DesktopSnapshot) => void;
  log: (event: { sessionId: string; stream: "stdout" | "stderr"; text: string }) => void;
  notification: (event: { level: "info" | "warning" | "error"; message: string }) => void;
}

export interface RecoveryResult {
  sessionId: string;
  status: "recovered" | "skipped" | "failed";
  reason: string | null;
}

export interface DesktopStartupStatus {
  ready: boolean;
  lifecycle: "new" | "initializing" | "initialized" | "releasing" | "released" | "failed";
  error: string | null;
  configRoot: string;
  dataRoot: string;
}

function validateIndex(value: unknown, filePath: string): SessionIndexProjectionV4 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Session index is not an object: ${filePath}`);
  const index = value as Partial<SessionIndexProjectionV4>;
  if (index.version !== 4 || !Array.isArray(index.activeSessionIds) || !Array.isArray(index.sessionMetas) || !Array.isArray(index.availableModels) || index.manualModelsOverride !== null || (index.modelVariants !== null && (typeof index.modelVariants !== "object" || Array.isArray(index.modelVariants))) || !index.providerCatalog || typeof index.providerCatalog !== "object" || Array.isArray(index.providerCatalog)) {
    throw new Error(`Session index must use version 4: ${filePath}`);
  }
  for (const [providerId, discovery] of Object.entries(index.providerCatalog)) {
    const validated = validateProviderDiscoveryResultV2(discovery);
    if (validated.providerId !== providerId) throw new Error(`Session index providerCatalog key mismatch: ${filePath}`);
  }
  if (index.activeSessionIds.some((id) => typeof id !== "string" || !SAFE_ID.test(id))) throw new Error(`Session index contains an invalid active session id: ${filePath}`);
  if (new Set(index.activeSessionIds).size !== index.activeSessionIds.length) throw new Error(`Session index contains duplicate active session ids: ${filePath}`);
  if (index.availableModels.some((model) => typeof model !== "string" || !model.trim())) throw new Error(`Session index contains an invalid model: ${filePath}`);
  if (index.modelsDiscoveredAt !== null && typeof index.modelsDiscoveredAt !== "string") throw new Error(`Session index modelsDiscoveredAt is invalid: ${filePath}`);
  if (index.modelsDiscoveredCli !== null && (typeof index.modelsDiscoveredCli !== "string" || !index.modelsDiscoveredCli.trim())) throw new Error(`Session index modelsDiscoveredCli is invalid: ${filePath}`);
  if (index.modelsDiscoveredAt !== null && !Number.isFinite(Date.parse(index.modelsDiscoveredAt))) throw new Error(`Session index modelsDiscoveredAt is invalid: ${filePath}`);
  if (index.modelVariants !== null) {
    for (const [providerId, models] of Object.entries(index.modelVariants as Record<string, unknown>)) {
      if (!Array.isArray(models) || models.some((model) => typeof model !== "string" || !model.trim())) throw new Error(`Session index modelVariants.${providerId} is invalid: ${filePath}`);
    }
  }
  const metadataIds = new Set<string>();
  for (const meta of index.sessionMetas) {
    if (!meta || typeof meta !== "object" || typeof meta.sessionId !== "string" || !SAFE_ID.test(meta.sessionId) || metadataIds.has(meta.sessionId) || typeof meta.goal !== "string" || !meta.goal.trim() || typeof meta.targetProjectPath !== "string" || !meta.targetProjectPath.trim() || typeof meta.createdAt !== "string" || !Number.isFinite(Date.parse(meta.createdAt)) || !["RUNNING", "WAITING_USER", "PAUSED", "SUCCESS", "FAILED", "STOPPED", "BLOCKED"].includes(meta.status)) {
      throw new Error(`Session index contains invalid session metadata: ${filePath}`);
    }
    metadataIds.add(meta.sessionId);
  }
  if (index.activeSessionIds.some((id) => !metadataIds.has(id))) throw new Error(`Session index active session metadata is missing: ${filePath}`);
  return value as SessionIndexProjectionV4;
}

function assertSafeId(value: string): string {
  if (!SAFE_ID.test(value)) throw new Error("Invalid session or choice id.");
  return value;
}

function parseObject(value: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch { throw new Error(`${label} is not valid JSON.`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${label} must be an object.`);
  return parsed as Record<string, unknown>;
}

function validateLockOwner(value: unknown, filePath: string): { ownerPid: number; createdAt: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Lock owner record is invalid: ${filePath}`);
  const record = value as { ownerId?: unknown; ownerPid?: unknown; createdAt?: unknown };
  if (!Number.isSafeInteger(record.ownerPid) || Number(record.ownerPid) <= 0 || typeof record.createdAt !== "string") {
    throw new Error(`Lock owner record is invalid: ${filePath}`);
  }
  if (typeof record.ownerId !== "string" || !record.ownerId.trim()) throw new Error(`Lock owner record is invalid: ${filePath}`);
  const createdAt = Date.parse(record.createdAt);
  if (!Number.isFinite(createdAt)) throw new Error(`Lock owner record timestamp is invalid: ${filePath}`);
  return { ownerPid: Number(record.ownerPid), createdAt };
}

async function hashDefinitionFiles(root: string): Promise<string> {
  const digest = createHash("sha256");
  for (const fileName of HASHED_DEFINITION_FILES) {
    digest.update(fileName);
    digest.update("\0");
    digest.update(await fsp.readFile(path.join(root, fileName)));
    digest.update("\0");
  }
  return digest.digest("hex");
}

async function verifyInitManifest(roots: DesktopRoots): Promise<boolean> {
  const filePath = path.join(roots.configRoot, INIT_MANIFEST_FILE_NAME);
  let raw: string;
  try {
    raw = await fsp.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const parsed = parseObject(raw, INIT_MANIFEST_FILE_NAME);
  if (
    parsed.schemaVersion !== 1 || typeof parsed.productVersion !== "string" ||
     parsed.productVersion !== "7.0.0" || typeof parsed.definitionSha256 !== "string" ||
     !/^[a-f0-9]{64}$/u.test(parsed.definitionSha256) || parsed.sessionIndexVersion !== 4 ||
     typeof parsed.initAt !== "string" || !Number.isFinite(Date.parse(parsed.initAt))
  ) throw new Error(`Initialization manifest is invalid: ${filePath}`);
  const packagedHash = await hashDefinitionFiles(roots.codeRoot);
  if (parsed.definitionSha256 !== packagedHash) throw new Error("Initialization manifest does not match packaged definitions.");
  const configuredHash = await hashDefinitionFiles(roots.configRoot);
  if (parsed.definitionSha256 !== configuredHash) throw new Error("Initialized definition files do not match the commit manifest.");
  const configuredConfig = parseObject(await fsp.readFile(path.join(roots.configRoot, "loop_config.json"), "utf8"), "loop_config.json");
  const paths = configuredConfig.paths && typeof configuredConfig.paths === "object" ? configuredConfig.paths as Record<string, unknown> : null;
  const indexName = safeRelativePath(paths?.sessionsIndexFileName, "paths.sessionsIndexFileName", "sessions_index.json", true);
  const indexPath = path.join(roots.dataRoot, indexName);
  const index = parseObject(await fsp.readFile(indexPath, "utf8"), indexName);
  validateIndex(index, indexPath);
  return true;
}

function safeRelativePath(value: unknown, label: string, defaultValue: string, singleSegment = false): string {
  const candidate = typeof value === "string" && value.trim() ? value.trim() : defaultValue;
  if (path.isAbsolute(candidate) || path.win32.isAbsolute(candidate) || path.posix.isAbsolute(candidate) || candidate.includes("\0")) {
    throw new Error(`${label} must be a relative path.`);
  }
  const parts = candidate.replace(/\\/gu, "/").split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw new Error(`${label} contains an unsafe path segment.`);
  const reserved = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/iu;
  if (parts.some((part) => /[\x00-\x1f<>:"|?*]/u.test(part) || /[ .]$/u.test(part) || reserved.test(part))) {
    throw new Error(`${label} contains a non-portable or unsafe path segment.`);
  }
  if (singleSegment && parts.length !== 1) throw new Error(`${label} must be a single path segment.`);
  return candidate;
}

export class DesktopController {
  private readonly events = new EventEmitter();
  private readonly runner: CoreProcessRunner;
  private readonly secrets: SecretStore;
  private readonly processes = new Map<string, CoreProcessHandle>();
  private readonly statePollers = new Map<string, NodeJS.Timeout>();
  private readonly planDrafts = new Map<string, string>();
  // A session that reached a verified terminal state must not be stopped a
  // second time when a different resource (for example its process handle)
  // failed during the same release attempt. Keeping this set across retries
  // makes the retry boundary resource-specific as promised by ReleaseResult.
  private readonly releasedSessions = new Set<string>();
  private settings: DesktopSettings | null = null;
  private rawConfig: Record<string, unknown> | null = null;
  private lifecycle: "new" | "initializing" | "initialized" | "releasing" | "released" | "failed" = "new";
  private initializationError: string | null = null;
  private releasePromise: Promise<ReleaseResult> | null = null;

  constructor(private readonly roots: DesktopRoots) {
    this.runner = new CoreProcessRunner(roots);
    this.secrets = new SecretStore(roots.configRoot);
  }

  on<K extends keyof ControllerEvents>(event: K, listener: ControllerEvents[K]): () => void {
    if (this.lifecycle !== "initialized") {
      throw new Error(`Desktop controller is not ready for event subscriptions (state: ${this.lifecycle}).`);
    }
    this.events.on(event, listener);
    return () => this.events.off(event, listener);
  }

  async init(): Promise<void> {
    if (this.lifecycle !== "new") {
      throw new Error(`Desktop controller cannot be initialized from state ${this.lifecycle}.`);
    }
    this.lifecycle = "initializing";
    try {
    await initDesktopRoots(this.roots);
    const capabilityResult = await this.runner.runShort("capabilities", [], { timeoutMs: 10_000 });
    if (capabilityResult.exitCode !== 0) throw new Error(capabilityResult.stderr || `Unable to verify the packaged Agent Loop core (exit ${String(capabilityResult.exitCode)}, ${capabilityResult.timedOut ? "timed out" : "process failure"}).`);
    const capabilityLines = capabilityResult.stdout.trim().split(/\r?\n/u).filter(Boolean);
    const handshake = parseObject(capabilityLines.join("\n"), "core capabilities");
    const requiredCapabilities = [
      "compiled-workflow-bundle-v2",
      "read-only-projection-v2",
      "verification-proof-v1",
      "verification-reapproval-v1",
      "strict-current-contracts-v1",
    ];
    const capabilityNames = Array.isArray(handshake.capabilities)
      ? handshake.capabilities.filter((value): value is string => typeof value === "string")
      : [];
    if (handshake.protocolVersion !== 3 || handshake.stateSchemaVersion !== 2 ||
        !Array.isArray(handshake.capabilities) ||
        capabilityNames.length !== handshake.capabilities.length ||
        requiredCapabilities.some((capability) => !capabilityNames.includes(capability))) {
      throw new Error("The packaged core does not satisfy protocol v3/state 2 and the strict v7 verification capabilities.");
    }
    const manifestPresent = await verifyInitManifest(this.roots);
    if (!manifestPresent) {
      const result = await this.runner.runShort("init", [], { timeoutMs: 20_000 });
      if (result.exitCode !== 0) throw new Error(result.stderr || "Unable to initialize Agent Loop definitions.");
    }
    this.settings = await this.readSettings();
    this.initializationError = null;
    this.lifecycle = "initialized";
    } catch (error) {
      this.initializationError = error instanceof Error ? error.message : String(error);
      this.lifecycle = "failed";
      throw error;
    }
  }

  /** Expose bootstrap failures without requiring a valid run projection. */
  getStartupStatus(): DesktopStartupStatus {
    return {
      ready: this.lifecycle === "initialized",
      lifecycle: this.lifecycle,
      error: this.initializationError,
      configRoot: this.roots.configRoot,
      dataRoot: this.roots.dataRoot,
    };
  }

  async openProfileFolder(kind: "config" | "data"): Promise<void> {
    const folder = kind === "config" ? this.roots.configRoot : this.roots.dataRoot;
    const error = await shell.openPath(folder);
    if (error) throw new Error(error);
  }

  private assertReady(): void {
    if (this.lifecycle !== "initialized") {
      throw new Error(`Desktop controller is not ready (state: ${this.lifecycle}).`);
    }
  }

  /**
   * Preserve the core's crash-recovery behavior when the desktop app starts.
   * A live or unverifiable owner is only observed; a stale dead owner is
   * resumed through the normal core command so fencing/reducer recovery stays
   * authoritative. Provider discovery is checked immediately before spawning
   * and an unavailable provider is surfaced instead of being replayed.
   */
  async recoverPersistedSessions(): Promise<RecoveryResult[]> {
    this.assertReady();
    const index = await this.readIndex();
    const candidates = [...new Set(index.activeSessionIds)];
    const results = await Promise.all(candidates.map(async (sessionId): Promise<RecoveryResult> => {
      try {
        assertSafeId(sessionId);
        if (this.processes.has(sessionId)) return { sessionId, status: "skipped", reason: "Session is already running in this desktop process." };
        const projection = await this.readProjection(sessionId);
        if (!projection || projection.status !== "RUNNING") return { sessionId, status: "skipped", reason: "Session projection is not running." };
        const action = await this.recoveryAction(sessionId);
        if (action !== "recover") return { sessionId, status: "skipped", reason: "Session ownership is still live or unverifiable." };
        await this.assertResumeProviderAvailable(sessionId);
        if (await this.recoveryAction(sessionId) !== "recover") return { sessionId, status: "skipped", reason: "Session ownership changed while checking recovery." };
        const handle = this.runner.run("resume", ["--session", sessionId, ...(await this.projectArgs(sessionId))], {
          sessionId,
          secretValues: await this.secretValues(),
          onLog: this.logFor(sessionId),
        });
        this.bindProcess(sessionId, handle);
        return { sessionId, status: "recovered", reason: null };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.notify("warning", `Session ${sessionId} was not auto-recovered: ${reason}`);
        return { sessionId, status: "failed", reason };
      }
    }));
    if (candidates.length > 0) this.emitState();
    return results;
  }

  private async recoveryAction(sessionId: string): Promise<"ignore" | "follow" | "recover"> {
    const settings = this.settings ?? await this.readSettings();
    const projection = await this.readProjection(sessionId);
    if (!projection || projection.status !== "RUNNING") return "ignore";
    const sessionDir = path.join(this.sessionsRoot(settings), sessionId);
    const readJson = async (name: string): Promise<Record<string, unknown> | null> => {
      const filePath = path.join(sessionDir, name);
      let raw: string;
      try {
        raw = await fsp.readFile(filePath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
      let parsed: unknown;
      try { parsed = JSON.parse(raw) as unknown; }
      catch { throw new Error(`Malformed session ownership record: ${filePath}`); }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Session ownership record is invalid: ${filePath}`);
      return parsed as Record<string, unknown>;
    };
    const ownerName = safeRelativePath(settings.paths.ownerLockFileName, "paths.ownerLockFileName", "session_owner.lock", true);
    const leaseName = safeRelativePath(settings.paths.leaseFileName, "paths.leaseFileName", "session_lease.json", true);
    const owner = await readJson(ownerName);
    const lease = await readJson(leaseName);
    if (owner && (
      typeof owner.ownerId !== "string" || !owner.ownerId ||
      !Number.isSafeInteger(owner.ownerPid) || Number(owner.ownerPid) <= 0 ||
      typeof owner.createdAt !== "string" || !Number.isFinite(Date.parse(owner.createdAt))
    )) throw new Error(`Session owner lock is invalid: ${sessionDir}`);
    if (lease && (
      !owner ||
      typeof lease.ownerId !== "string" || !lease.ownerId ||
      !Number.isSafeInteger(lease.ownerPid) || Number(lease.ownerPid) <= 0 ||
      typeof lease.acquiredAt !== "string" || !Number.isFinite(Date.parse(lease.acquiredAt)) ||
      typeof lease.heartbeatAt !== "string" || !Number.isFinite(Date.parse(lease.heartbeatAt)) ||
      typeof lease.expiresAt !== "string" || !Number.isFinite(Date.parse(lease.expiresAt)) ||
      lease.ownerId !== owner.ownerId || lease.ownerPid !== owner.ownerPid
    )) throw new Error(`Session owner lock and lease are inconsistent: ${sessionDir}`);
    const ownerPid = typeof lease?.ownerPid === "number"
      ? lease.ownerPid
      : typeof owner?.ownerPid === "number" ? owner.ownerPid : null;
    let ownerLiveness: "alive" | "dead" | "unknown" = "dead";
    if (ownerPid && ownerPid > 0) {
      try {
        process.kill(ownerPid, 0);
        ownerLiveness = "alive";
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        ownerLiveness = code === "ESRCH" ? "dead" : "unknown";
      }
    }
    if (ownerLiveness === "unknown") return "follow";
    if (lease) {
      const expiresAt = typeof lease.expiresAt === "string" ? Date.parse(lease.expiresAt) : Number.NaN;
      if (!Number.isFinite(expiresAt) || expiresAt > Date.now() || ownerLiveness === "alive") return "follow";
      return "recover";
    }
    if (owner) {
      const createdAt = typeof owner.createdAt === "string" ? Date.parse(owner.createdAt) : Number.NaN;
      const ttl = typeof settings.defaults.leaseTtlMs === "number" && Number.isFinite(settings.defaults.leaseTtlMs)
        ? settings.defaults.leaseTtlMs
        : 20_000;
      if (!Number.isFinite(createdAt) || Date.now() - createdAt < ttl || ownerLiveness === "alive") return "follow";
      return "recover";
    }
    return "recover";
  }

  private sessionsRoot(settings: DesktopSettings | null = this.settings): string {
    const relative = safeRelativePath(settings?.paths?.sessionsRoot, "paths.sessionsRoot", DEFAULT_SESSIONS_ROOT);
    return path.resolve(this.roots.dataRoot, relative);
  }

  private sessionFileName(key: string, defaultFileName: string): string {
    const paths = this.settings?.paths?.sessionFileNames;
    const value = paths && typeof paths === "object" ? (paths as Record<string, unknown>)[key] : undefined;
    return safeRelativePath(value, `paths.sessionFileNames.${key}`, defaultFileName, true);
  }

  private async readSettings(): Promise<DesktopSettings> {
    const configPath = path.join(this.roots.configRoot, "loop_config.json");
    try {
      const raw = await fsp.readFile(configPath, "utf8");
      const parsed = parseObject(raw, "loop_config.json");
      const allowedConfigKeys = new Set(["$schema", "paths", "defaults", "cliProfiles", "providers", "toolAccess", "destructivePrompts", "variantDefaults"]);
      for (const key of Object.keys(parsed)) {
        if (!allowedConfigKeys.has(key)) throw new Error(`loop_config.json contains unsupported field '${key}'.`);
      }
      this.rawConfig = structuredClone(parsed);
      return validateDesktopSettings({
        paths: (parsed.paths && typeof parsed.paths === "object" ? parsed.paths : {}) as Record<string, unknown>,
        providers: (parsed.providers && typeof parsed.providers === "object" ? parsed.providers : {}) as DesktopSettings["providers"],
        toolAccess: (parsed.toolAccess && typeof parsed.toolAccess === "object" ? parsed.toolAccess : {}) as Record<string, unknown>,
        defaults: (parsed.defaults && typeof parsed.defaults === "object" ? parsed.defaults : {}) as Record<string, unknown>,
        variantDefaults: (parsed.variantDefaults && typeof parsed.variantDefaults === "object" ? parsed.variantDefaults : {}) as Record<string, string[]>,
      });
    } catch (error) {
      throw new Error(`Unable to read Agent Loop settings: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async getSettings(): Promise<DesktopSettings> {
    this.assertReady();
    this.settings = await this.readSettings();
    return structuredClone(this.settings);
  }

  private async readIndex(): Promise<SessionIndexProjectionV4> {
    const settings = this.settings ?? await this.readSettings();
    const indexName = safeRelativePath(settings.paths?.sessionsIndexFileName, "paths.sessionsIndexFileName", "sessions_index.json", true);
    const filePath = path.join(this.roots.dataRoot, indexName);
    let raw: string;
    try { raw = await fsp.readFile(filePath, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Session index is not initialized: ${filePath}`);
      throw error;
    }
    return validateIndex(parseObject(raw, "sessions_index.json"), filePath);
  }

  private indexPath(settings: DesktopSettings | null = this.settings): string {
    const current = settings ?? this.settings;
    const indexName = safeRelativePath(current?.paths?.sessionsIndexFileName, "paths.sessionsIndexFileName", "sessions_index.json", true);
    return path.join(this.roots.dataRoot, indexName);
  }

  private indexLockPath(settings: DesktopSettings | null = this.settings): string {
    const current = settings ?? this.settings;
    const lockName = safeRelativePath(current?.paths?.registryLockFileName, "paths.registryLockFileName", "registry.lock", true);
    return path.join(this.roots.dataRoot, lockName);
  }

  /** Serialize file edits with a lock that is compatible with core's lock files. */
  private async withFileLock<T>(lockPath: string, operation: () => Promise<T>): Promise<T> {
    const parent = path.dirname(lockPath);
    const parentStat = await fsp.stat(parent);
    if (!parentStat.isDirectory()) throw new Error(`Lock parent is not a directory: ${parent}`);
    let handle: fsp.FileHandle | null = null;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      try {
        handle = await fsp.open(lockPath, "wx");
        await handle.writeFile(JSON.stringify({ ownerId: `desktop-${process.pid}-${randomBytes(8).toString("hex")}`, ownerPid: process.pid, createdAt: new Date().toISOString() }), "utf8");
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        let closeError: unknown;
        if (handle) {
          try { await handle.close(); }
          catch (releaseError) { closeError = releaseError; }
          finally { handle = null; }
          try { await fsp.unlink(lockPath); }
          catch (releaseError) {
            const releaseCode = (releaseError as NodeJS.ErrnoException).code;
            if (releaseCode !== "ENOENT") {
              throw new AggregateError(closeError === undefined ? [error, releaseError] : [error, closeError, releaseError], `Lock initialization failed: ${lockPath}`);
            }
          }
          if (closeError !== undefined) throw new AggregateError([error, closeError], `Lock handle release failed: ${lockPath}`);
        }
        if (code !== "EEXIST") throw error;
        // Reclaim only a lock whose recorded owner is dead and old enough to
        // be a crashed desktop process; live operations are never stolen.
        try {
          const raw = await fsp.readFile(lockPath, "utf8");
          const record = validateLockOwner(JSON.parse(raw), lockPath);
          const ownerPid = record.ownerPid;
          const createdAt = record.createdAt;
          let alive = ownerPid === process.pid;
          if (ownerPid && ownerPid !== process.pid) {
            try { process.kill(ownerPid, 0); alive = true; }
            catch (livenessError) {
              const livenessCode = (livenessError as NodeJS.ErrnoException).code;
              if (livenessCode === "ESRCH") alive = false;
              else if (livenessCode === "EPERM" || livenessCode === "EACCES") alive = true;
              else throw livenessError;
            }
          }
          if (Date.now() - createdAt > 30_000 && !alive) {
            try { await fsp.unlink(lockPath); }
            catch (reclaimError) {
              const reclaimCode = (reclaimError as NodeJS.ErrnoException).code;
              if (reclaimCode !== "ENOENT") throw reclaimError;
            }
          }
        } catch (inspectError) {
          const inspectCode = (inspectError as NodeJS.ErrnoException).code;
          if (inspectCode !== "ENOENT") throw inspectError;
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(250, 10 + attempt * 5)));
      }
    }
    if (!handle) throw new Error("Timed out acquiring the session index lock.");
    let value!: T;
    let operationError: unknown;
    try { value = await operation(); }
    catch (error) { operationError = error; }
    const releaseFailures: unknown[] = [];
    try { await handle.close(); }
    catch (error) { releaseFailures.push(error); }
    try { await fsp.unlink(lockPath); }
    catch (error) { releaseFailures.push(error); }
    if (operationError !== undefined && releaseFailures.length > 0) throw new AggregateError([operationError, ...releaseFailures], `Operation and lock release failed: ${lockPath}`);
    if (operationError !== undefined) throw operationError;
    if (releaseFailures.length > 0) throw new AggregateError(releaseFailures, `Lock release failed: ${lockPath}`);
    return value;
  }

  private async writeIndexAtomic(index: SessionIndexProjectionV4): Promise<void> {
    const indexPath = this.indexPath();
    const temporary = `${indexPath}.tmp.${process.pid}.${Date.now()}`;
    let primary: unknown;
    try {
      await fsp.writeFile(temporary, `${JSON.stringify(index, null, 2)}\n`, "utf8");
      await fsp.rename(temporary, indexPath);
    } catch (error) {
      primary = error;
    }
    let releaseFailure: unknown;
    try { await fsp.rm(temporary, { force: true }); }
    catch (error) { releaseFailure = error; }
    if (primary !== undefined && releaseFailure !== undefined) throw new AggregateError([primary, releaseFailure], `Index write and temporary-file cleanup failed: ${indexPath}`);
    if (primary !== undefined) throw primary;
    if (releaseFailure !== undefined) throw releaseFailure;
  }

  private async readProjection(sessionId: string): Promise<RunProjectionV2 | null> {
    assertSafeId(sessionId);
    const sessionDirectory = path.join(this.sessionsRoot(), sessionId);
    const filePath = path.join(sessionDirectory, this.sessionFileName("state", "run_projection.json"));
    let raw: string;
    try { raw = await fsp.readFile(filePath, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        try {
          const stat = await fsp.stat(sessionDirectory);
          if (!stat.isDirectory()) throw new Error(`Session storage is not a directory: ${sessionDirectory}`);
        } catch (directoryError) {
          if ((directoryError as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw directoryError;
        }
        throw new Error(`Run projection is missing: ${filePath}`);
      }
      throw error;
    }
    const projection = validateRunProjectionV2(parseObject(raw, "run_projection.json"));
    if (projection.runId !== sessionId || projection.sessionId !== sessionId) throw new Error(`Run projection session identity is invalid: ${filePath}`);
    return projection;
  }

  private async providerForSession(sessionId: string): Promise<{ providerId: string | null; configured: boolean }> {
    const projection = await this.readProjection(sessionId);
    const agentId = projection?.currentAgentId;
    if (!agentId) return { providerId: null, configured: true };
    const agents = parseObject(await fsp.readFile(path.join(this.roots.configRoot, "agents.json"), "utf8"), "agents.json").agents;
    if (!Array.isArray(agents)) throw new Error("agents.json must contain an agents array.");
    const agent = agents.find((entry) => entry && typeof entry === "object" && (entry as { id?: unknown }).id === agentId) as { runtimeDefaults?: { provider?: unknown } } | undefined;
    if (!agent) throw new Error(`Agent definition ${agentId} is missing.`);
    const providerId = typeof agent.runtimeDefaults?.provider === "string" ? agent.runtimeDefaults.provider.trim() : "";
    return { providerId: providerId || null, configured: Boolean(providerId) };
  }

  private async projectArgs(sessionId: string): Promise<string[]> {
    const projection = await this.readProjection(sessionId);
    if (!projection) throw new Error(`Session ${sessionId} was not found.`);
    // Keep the core RootSet's projectRoot aligned with the session target;
    // the target is still carried separately in the aggregate contract.
    const projectPath = await validateProjectPath(projection.targetProjectPath, this.roots);
    return ["--project-root", projectPath];
  }

  /** Avoid replaying a session when a previously discovered provider vanished. */
  private async assertResumeProviderAvailable(sessionId: string): Promise<void> {
    const provider = await this.providerForSession(sessionId);
    if (!provider.configured) {
      throw new Error(`The provider for the current agent is not configured; session ${sessionId} will not be replayed.`);
    }
    const providerId = provider.providerId;
    if (!providerId) return;
    let discovery: ProviderDiscoveryResultV2 | undefined;
    try {
      // Re-check the executable immediately before replay. A cached catalog is
      // useful for display, but it cannot prove that an external CLI still
      // exists after a restart or uninstall.
      const fresh = await this.discoverModels();
      discovery = fresh.providers.find((entry) => entry.providerId === providerId);
    } catch (error) {
      throw new Error(`Unable to verify provider '${providerId}' before resuming session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!discovery) throw new Error(`Provider '${providerId}' is not configured; session ${sessionId} will not be replayed.`);
    if (discovery && !discovery.available) {
      const code = discovery.error?.code ? ` (${discovery.error.code})` : "";
      throw new Error(`Provider '${providerId}' is unavailable${code}; install or configure it before resuming session ${sessionId}.`);
    }
  }

  private async buildSnapshot(sessionId?: string): Promise<DesktopSnapshot> {
    const index = await this.readIndex();
    let selected = sessionId;
    if (!selected) selected = index.activeSessionIds[0] ?? index.sessionMetas[index.sessionMetas.length - 1]?.sessionId;
    const projection = selected ? await this.readProjection(selected) : null;
    if (selected && index.activeSessionIds.includes(selected) && projection === null) {
      throw new Error(`Active session ${selected} has no readable run projection.`);
    }
    const catalog = index.providerCatalog;
    return validateDesktopSnapshot({
      schemaVersion: 3,
      capturedAt: new Date().toISOString(),
      projection,
      sessionIndex: index,
      settings: this.settings ? structuredClone(this.settings) as unknown as Record<string, unknown> : null,
      providerDiscovery: Object.values(catalog).filter((entry): entry is ProviderDiscoveryResultV2 => {
        try { validateModelDiscoveryPayload({ schemaVersion: 2, discoveredAt: null, providers: [entry], models: [] }); return true; }
        catch { return false; }
      }),
    });
  }

  async getSnapshot(sessionId?: string): Promise<DesktopSnapshot> {
    this.assertReady();
    return this.buildSnapshot(sessionId);
  }

  private emitState(sessionId?: string): void {
    void this.getSnapshot(sessionId).then((snapshot) => this.events.emit("state", snapshot)).catch((error) => this.notify("error", error instanceof Error ? error.message : String(error)));
  }

  private notify(level: "info" | "warning" | "error", message: string): void {
    this.events.emit("notification", { level, message });
  }

  private bindProcess(sessionId: string, handle: CoreProcessHandle): void {
    this.processes.set(sessionId, handle);
    // The core projection is updated independently of the utility-process
    // stdout stream. Poll while a long-running command owns the session so a
    // renderer sees planning gates, progress, and terminal state promptly.
    if (!this.statePollers.has(sessionId)) {
      const poller = setInterval(() => this.emitState(sessionId), 750);
      this.statePollers.set(sessionId, poller);
    }
    void handle.done.then((result) => {
      if (this.processes.get(sessionId) === handle) this.processes.delete(sessionId);
      const poller = this.statePollers.get(sessionId);
      if (poller) { clearInterval(poller); this.statePollers.delete(sessionId); }
      if (result.exitCode !== 0 && result.exitCode !== null) this.notify("error", `Session ${sessionId} core process exited with code ${result.exitCode}.`);
      this.emitState(sessionId);
    });
  }

  private logFor(sessionId: string): (event: CoreLogEvent) => void {
    return (event) => this.events.emit("log", { sessionId, ...event });
  }

  private async secretValues(): Promise<Record<string, string>> {
    // SecretStore fails closed when encryption is unavailable or the document
    // is corrupt. Never continue with plaintext or silently missing values.
    const required = new Set<string>();
    const servers = (this.settings?.toolAccess as { mcpServers?: unknown[] } | undefined)?.mcpServers;
    for (const server of servers ?? []) {
      if (!server || typeof server !== "object" || Array.isArray(server)) continue;
      for (const field of ["environment", "headers"] as const) {
        const values = (server as Record<string, unknown>)[field];
        if (!values || typeof values !== "object" || Array.isArray(values)) continue;
        for (const value of Object.values(values as Record<string, unknown>)) {
          const match = typeof value === "string" ? value.match(/^\$\{secret:([^}]+)\}$/u) : null;
          if (match) required.add(match[1]);
        }
      }
    }
    return this.secrets.getAll([...required]);
  }

  async startSession(input: { goal: string; projectPath: string; accessMode?: "ask" | "full_access"; sessionId?: string }): Promise<{ sessionId: string }> {
    this.assertReady();
    const goal = input.goal.trim();
    if (!goal || goal.length > 64 * 1024) throw new Error("Goal must be between 1 and 65536 characters.");
    const projectPath = await validateProjectPath(input.projectPath, this.roots);
    const sessionId = assertSafeId(input.sessionId?.trim() || `run_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`);
    if (this.processes.has(sessionId)) throw new Error(`Session ${sessionId} is already running.`);
    this.releasedSessions.delete(sessionId);
    const args = ["--goal", goal, "--target", projectPath, "--project-root", projectPath, "--session", sessionId];
    if (input.accessMode === "full_access") args.push("--full-access");
    const handle = this.runner.run("run", args, { sessionId, secretValues: await this.secretValues(), onLog: this.logFor(sessionId) });
    this.bindProcess(sessionId, handle);
    this.emitState();
    return { sessionId };
  }

  async resumeSession(sessionId: string): Promise<{ sessionId: string }> {
    this.assertReady();
    assertSafeId(sessionId);
    if (this.processes.has(sessionId)) throw new Error(`Session ${sessionId} is already running.`);
    this.releasedSessions.delete(sessionId);
    await this.assertResumeProviderAvailable(sessionId);
    const handle = this.runner.run("resume", ["--session", sessionId, ...(await this.projectArgs(sessionId))], { sessionId, secretValues: await this.secretValues(), onLog: this.logFor(sessionId) });
    this.bindProcess(sessionId, handle);
    this.emitState();
    return { sessionId };
  }

  private async stopSessionInternal(sessionId: string): Promise<DesktopSnapshot> {
    assertSafeId(sessionId);
    const result = await this.runner.runShort("stop", ["--session", sessionId], { timeoutMs: 15_000, onLog: this.logFor(sessionId) });
    if (result.exitCode !== 0) throw new Error(result.stderr || `Unable to stop session ${sessionId}.`);
    const process = this.processes.get(sessionId);
    if (process) await Promise.race([process.done, new Promise((resolve) => setTimeout(resolve, 3_000))]);
    const snapshot = await this.buildSnapshot(sessionId);
    this.events.emit("state", snapshot);
    return snapshot;
  }

  async stopSession(sessionId: string): Promise<DesktopSnapshot> {
    this.assertReady();
    return this.stopSessionInternal(sessionId);
  }

  async interruptSession(sessionId: string, message: string): Promise<DesktopSnapshot> {
    this.assertReady();
    assertSafeId(sessionId);
    const text = message.trim();
    if (!text || text.length > 16 * 1024) throw new Error("Interrupt message is required and must be at most 16384 characters.");
    const result = await this.runner.runShort("interrupt", ["--session", sessionId, "--message", text], { timeoutMs: 15_000, onLog: this.logFor(sessionId) });
    if (result.exitCode !== 0) throw new Error(result.stderr || `Unable to interrupt session ${sessionId}.`);
    const snapshot = await this.getSnapshot(sessionId);
    this.events.emit("state", snapshot);
    return snapshot;
  }

  async setAccessMode(sessionId: string, mode: "ask" | "full_access"): Promise<DesktopSnapshot> {
    this.assertReady();
    assertSafeId(sessionId);
    const result = await this.runner.runShort("set-access", ["--session", sessionId, "--mode", mode], { timeoutMs: 15_000 });
    if (result.exitCode !== 0) throw new Error(result.stderr || "Unable to change access mode.");
    const snapshot = await this.getSnapshot(sessionId);
    this.events.emit("state", snapshot);
    return snapshot;
  }

  async resolveAccessRequest(sessionId: string, approved: boolean): Promise<DesktopSnapshot> {
    this.assertReady();
    assertSafeId(sessionId);
    if (!approved) return this.getSnapshot(sessionId);
    this.releasedSessions.delete(sessionId);
    await this.assertResumeProviderAvailable(sessionId);
    const handle = this.runner.run("resume", ["--session", sessionId, ...(await this.projectArgs(sessionId)), "--approve-access"], { sessionId, secretValues: await this.secretValues(), onLog: this.logFor(sessionId) });
    this.bindProcess(sessionId, handle);
    return this.getSnapshot(sessionId);
  }

  async selectPlanChoice(sessionId: string, choiceId: string): Promise<{ choiceId: string }> {
    this.assertReady();
    assertSafeId(sessionId); assertSafeId(choiceId);
    const projection = await this.readProjection(sessionId);
    if (!projection?.planChoices.some((choice) => choice.id === choiceId)) throw new Error("Plan choice is not available for this session.");
    this.planDrafts.set(sessionId, choiceId);
    return { choiceId };
  }

  async approvePlan(sessionId: string, requestedChoiceId?: string): Promise<{ sessionId: string }> {
    this.assertReady();
    assertSafeId(sessionId);
    const choiceId = requestedChoiceId ?? this.planDrafts.get(sessionId);
    if (!choiceId) throw new Error("Select a plan choice before approval.");
    assertSafeId(choiceId);
    const result = await this.runner.runShort("approve-plan", ["--session", sessionId, "--choice-id", choiceId], { timeoutMs: 15_000 });
    if (result.exitCode !== 0) throw new Error(result.stderr || "Unable to approve plan.");
    this.planDrafts.delete(sessionId);
    return this.resumeSession(sessionId);
  }

  async revisePlan(sessionId: string, message: string): Promise<{ sessionId: string }> {
    this.assertReady();
    assertSafeId(sessionId);
    const text = message.trim();
    if (!text || text.length > 64 * 1024) throw new Error("Revision message is required.");
    if (this.processes.has(sessionId)) throw new Error(`Session ${sessionId} is already running.`);
    this.releasedSessions.delete(sessionId);
    await this.assertResumeProviderAvailable(sessionId);
    const handle = this.runner.run("revise-plan", ["--session", sessionId, ...(await this.projectArgs(sessionId)), "--message", text], { sessionId, secretValues: await this.secretValues(), onLog: this.logFor(sessionId) });
    this.bindProcess(sessionId, handle);
    return { sessionId };
  }

  async approveVerification(sessionId: string, requestId: string, candidateHash: string): Promise<{ sessionId: string }> {
    this.assertReady();
    assertSafeId(sessionId);
    if (!requestId.trim() || !/^[a-f0-9]{64}$/iu.test(candidateHash)) {
      throw new Error("Verification approval request and candidate hash are invalid.");
    }
    if (this.processes.has(sessionId)) throw new Error(`Session ${sessionId} is already running.`);
    this.releasedSessions.delete(sessionId);
    await this.assertResumeProviderAvailable(sessionId);
    const handle = this.runner.run(
      "approve-verification",
      ["--session", sessionId, ...(await this.projectArgs(sessionId)), "--request-id", requestId, "--candidate-hash", candidateHash],
      { sessionId, secretValues: await this.secretValues(), onLog: this.logFor(sessionId) }
    );
    this.bindProcess(sessionId, handle);
    return { sessionId };
  }

  async rejectVerification(sessionId: string, requestId: string, candidateHash: string, message: string): Promise<{ sessionId: string }> {
    this.assertReady();
    assertSafeId(sessionId);
    const text = message.trim();
    if (!requestId.trim() || !/^[a-f0-9]{64}$/iu.test(candidateHash) || !text || text.length > 16 * 1024) {
      throw new Error("Verification rejection request, candidate hash, and message are invalid.");
    }
    if (this.processes.has(sessionId)) throw new Error(`Session ${sessionId} is already running.`);
    this.releasedSessions.delete(sessionId);
    const handle = this.runner.run(
      "reject-verification",
      ["--session", sessionId, ...(await this.projectArgs(sessionId)), "--request-id", requestId, "--candidate-hash", candidateHash, "--message", text],
      { sessionId, secretValues: await this.secretValues(), onLog: this.logFor(sessionId) }
    );
    this.bindProcess(sessionId, handle);
    return { sessionId };
  }

  async discoverModels(): Promise<{ schemaVersion: 2; discoveredAt: string | null; providers: ProviderDiscoveryResultV2[]; models: string[] }> {
    this.assertReady();
    const result = await this.runner.runShort("models", ["--json"], { timeoutMs: 20_000 });
    if (result.exitCode !== 0) throw new Error(result.stderr || "Model discovery failed.");
    const lines = result.stdout.trim().split(/\r?\n/u).filter(Boolean);
    const payload = validateModelDiscoveryPayload(parseObject(lines.join("\n"), "models --json output"));
    this.emitState();
    return payload;
  }

  async getSessionBundle(sessionId: string): Promise<SessionBundle> {
    this.assertReady();
    assertSafeId(sessionId);
    const sessionDir = path.join(this.sessionsRoot(), sessionId);
    const projection = await this.readProjection(sessionId);
    if (!projection) throw new Error(`Session ${sessionId} was not found.`);
    const readOptional = async (name: string): Promise<string | null> => {
      try { return await fsp.readFile(path.join(sessionDir, name), "utf8"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    };
    const summaryText = await readOptional(this.sessionFileName("finalSummary", "final_summary.json"));
    return {
      projection,
      progress: (await readOptional(this.sessionFileName("progressNotes", "progress_notes.txt"))) ?? "",
      plan: await readOptional(this.sessionFileName("plan", "plan.md")),
      summary: summaryText ? parseObject(summaryText, "final_summary.json") : null,
    };
  }

  async revealSessionFolder(sessionId: string): Promise<void> {
    this.assertReady();
    assertSafeId(sessionId);
    const folder = path.join(this.sessionsRoot(), sessionId);
    const error = await shell.openPath(folder);
    if (error) throw new Error(error);
  }

  async deleteSession(sessionId: string): Promise<{ sessionId: string }> {
    this.assertReady();
    assertSafeId(sessionId);
    const running = this.processes.get(sessionId);
    const index = await this.readIndex();
    const projection = await this.readProjection(sessionId);
    const indexedActive = index.activeSessionIds.includes(sessionId);
    const projectionActive = projection !== null && !["SUCCESS", "STOPPED", "FAILED", "BLOCKED"].includes(projection.status);
    if (running || indexedActive || projectionActive) {
      const stopped = await this.stopSessionInternal(sessionId);
      if (!stopped.projection || !["STOPPED", "SUCCESS", "FAILED", "BLOCKED"].includes(stopped.projection.status)) throw new Error("Session is still active; deletion was cancelled.");
    }
    const sessionDir = path.join(this.sessionsRoot(), sessionId);
    const tombstone = `${sessionDir}.deleting.${Date.now().toString(36)}`;
    try {
      await fsp.rename(sessionDir, tombstone);
    } catch (error) {
      throw new Error(`Session deletion left a recoverable tombstone at ${tombstone}: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      // Keep the renamed directory recoverable until the index no longer
      // advertises it. A crash at any point leaves a useful tombstone marker.
      await this.withFileLock(this.indexLockPath(), async () => {
        const index = await this.readIndex();
        const next: SessionIndexProjectionV4 = {
          ...index,
          activeSessionIds: index.activeSessionIds.filter((id) => id !== sessionId),
          sessionMetas: index.sessionMetas.filter((meta) => meta.sessionId !== sessionId),
        };
        await this.writeIndexAtomic(next);
      });
      await fsp.rm(tombstone, { recursive: true, force: true });
    } catch (error) {
      throw new Error(`Session deletion left a recoverable tombstone at ${tombstone}: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.planDrafts.delete(sessionId);
    this.emitState();
    return { sessionId };
  }

  async saveSettings(settings: DesktopSettings, secretValues?: Record<string, string>): Promise<DesktopSettings> {
    this.assertReady();
    settings = validateDesktopSettings(settings);
    if (secretValues !== undefined) {
      if (!secretValues || typeof secretValues !== "object" || Array.isArray(secretValues)) throw new Error("Secret values must be an object.");
      for (const [key, value] of Object.entries(secretValues)) {
        if (!key || typeof value !== "string") throw new Error(`Secret ${key} must be a string.`);
      }
    }
    safeRelativePath(settings.paths?.sessionsRoot, "paths.sessionsRoot", DEFAULT_SESSIONS_ROOT);
    const singleSegmentPathDefaults: Record<string, string> = {
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
      verificationLogsDirName: "verification_logs",
    };
    for (const [key, defaultValue] of Object.entries(singleSegmentPathDefaults)) {
      safeRelativePath(settings.paths?.[key], `paths.${key}`, defaultValue, true);
    }
    for (const [group, defaults] of [
      ["sessionFileNames", {
        state: "run_projection.json", progressNotes: "progress_notes.txt", finalSummary: "final_summary.json",
        plan: "plan.md", planChoices: "plan_choices.json", planOverview: "plan_options.md", planOptionsDir: "plan_options",
        interruptMessage: "interrupt_message.txt", stopRequest: "stop_request.txt",
      }],
      ["roomFileNames", { state: "state.json", skills: "skills.json", input: "input.json", output: "output.json" }],
      ["roomDirNames", {}],
    ] as const) {
      const configured = settings.paths?.[group];
      if (!configured || typeof configured !== "object" || Array.isArray(configured)) throw new Error(`paths.${group} must be an object.`);
      for (const [key, value] of Object.entries(configured as Record<string, unknown>)) {
        safeRelativePath(value, `paths.${group}.${key}`, defaults[key as keyof typeof defaults] ?? key, true);
      }
    }
    const serialized = JSON.stringify(settings);
    if (serialized.length > 512 * 1024) throw new Error("Settings payload is too large.");
    const toolAccess = settings.toolAccess as { mcpServers?: Array<{ environment?: Record<string, string>; headers?: Record<string, string> }> };
    for (const server of toolAccess.mcpServers ?? []) {
      for (const values of [server.environment, server.headers]) {
        for (const value of Object.values(values ?? {})) {
          if (!/^\$\{(?:secret|env):[^}]+\}$/u.test(value)) throw new Error("MCP credentials must use secret or environment references.");
        }
      }
    }
    if (secretValues && Object.keys(secretValues).length > 0) await this.secrets.set(secretValues);
    const configPath = path.join(this.roots.configRoot, "loop_config.json");
    const settingsLockPath = path.join(this.roots.configRoot, "settings.lock");
    let persisted: Record<string, unknown>;
    await this.withFileLock(settingsLockPath, async () => {
      // Reload under the lock so two renderer saves cannot overwrite unrelated
      // fields from a newer configuration revision.
      let latest = this.rawConfig ?? {};
      try { latest = parseObject(await fsp.readFile(configPath, "utf8"), "loop_config.json"); }
      catch (error) { throw new Error(`Unable to update settings safely: ${error instanceof Error ? error.message : String(error)}`); }
      persisted = {
        ...latest,
        paths: settings.paths,
        providers: settings.providers,
        toolAccess: settings.toolAccess,
        defaults: settings.defaults,
        variantDefaults: settings.variantDefaults,
      };
      const temporary = `${configPath}.tmp.${process.pid}.${Date.now()}`;
      let primary: unknown;
      try {
        await fsp.writeFile(temporary, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
        await fsp.rename(temporary, configPath);
      } catch (error) {
        primary = error;
      }
      let releaseFailure: unknown;
      try { await fsp.rm(temporary, { force: true }); }
      catch (error) { releaseFailure = error; }
      if (primary !== undefined && releaseFailure !== undefined) throw new AggregateError([primary, releaseFailure], `Settings write and temporary-file release failed: ${configPath}`);
      if (primary !== undefined) throw primary;
      if (releaseFailure !== undefined) throw releaseFailure;
    });
    this.rawConfig = structuredClone(persisted!);
    this.settings = structuredClone(settings);
    this.emitState();
    return structuredClone(settings);
  }

  private asReleaseFailure(
    resource: ReleaseFailure["resource"],
    resourceId: string | null,
    error: unknown,
    code = "RELEASE_FAILED"
  ): ReleaseFailure {
    return {
      resource,
      resourceId,
      code,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  private async performRelease(): Promise<ReleaseResult> {
    const releasedSessionIds: string[] = [];
    const failures: ReleaseFailure[] = [];
    let activeFromIndex: string[] = [];
    try { activeFromIndex = (await this.readIndex()).activeSessionIds; }
    catch (error) { failures.push(this.asReleaseFailure("lock", null, error, "SESSION_INDEX_READ_FAILED")); }
    const sessionIds = new Set([...this.processes.keys(), ...activeFromIndex]);
    for (const sessionId of sessionIds) {
      if (!this.releasedSessions.has(sessionId)) {
        try {
          const snapshot = await this.stopSessionInternal(sessionId);
          if (snapshot.projection && ["STOPPED", "SUCCESS", "FAILED", "BLOCKED"].includes(snapshot.projection.status)) {
            this.releasedSessions.add(sessionId);
            releasedSessionIds.push(sessionId);
          } else {
            failures.push(this.asReleaseFailure("session", sessionId, "Core did not verify a terminal state before timeout.", "SESSION_NOT_TERMINAL"));
          }
        } catch (error) {
          failures.push(this.asReleaseFailure("session", sessionId, error));
        }
      }
      const handle = this.processes.get(sessionId);
      if (handle) {
        const waitForDone = async (timeoutMs: number): Promise<{ settled: boolean; error: unknown | null }> => {
          return Promise.race([
            handle.done.then(() => ({ settled: true, error: null }), (error) => ({ settled: true, error })),
            new Promise<{ settled: false; error: null }>((resolve) => setTimeout(() => resolve({ settled: false, error: null }), timeoutMs)),
          ]);
        };
        let processResult = await waitForDone(3_000);
        if (!processResult.settled) {
          try { handle.kill(); }
          catch (error) { failures.push(this.asReleaseFailure("process", sessionId, error)); }
          processResult = await waitForDone(1_000);
        }
        if (!processResult.settled) {
          failures.push(this.asReleaseFailure("process", sessionId, "Core process did not exit after stop and kill.", "PROCESS_STILL_RUNNING"));
        } else {
          if (processResult.error !== null) failures.push(this.asReleaseFailure("process", sessionId, processResult.error));
          this.processes.delete(sessionId);
        }
      }
    }
    for (const [sessionId, poller] of this.statePollers) {
      try { clearInterval(poller); this.statePollers.delete(sessionId); }
      catch (error) { failures.push(this.asReleaseFailure("poller", sessionId, error)); }
    }
    for (const sessionId of releasedSessionIds) this.planDrafts.delete(sessionId);
    try { this.events.removeAllListeners(); }
    catch (error) { failures.push(this.asReleaseFailure("listener", null, error)); }
    const result: ReleaseResult = { releasedSessionIds, failures };
    if (failures.length === 0) this.lifecycle = "released";
    else {
      this.lifecycle = "initialized";
      this.releasePromise = null;
    }
    return result;
  }

  async release(): Promise<ReleaseResult> {
    if (this.lifecycle === "released") return { releasedSessionIds: [], failures: [] };
    if (this.releasePromise) return this.releasePromise;
    if (this.lifecycle === "new" || this.lifecycle === "initializing") {
      throw new Error(`Desktop controller cannot be released from state ${this.lifecycle}.`);
    }
    if (this.lifecycle === "failed") {
      this.lifecycle = "released";
      return { releasedSessionIds: [], failures: [] };
    }
    this.lifecycle = "releasing";
    this.releasePromise = this.performRelease().catch((error) => {
      this.lifecycle = "initialized";
      this.releasePromise = null;
      return {
        releasedSessionIds: [],
        failures: [this.asReleaseFailure("lock", null, error, "RELEASE_UNHANDLED")],
      };
    });
    return this.releasePromise;
  }
}
