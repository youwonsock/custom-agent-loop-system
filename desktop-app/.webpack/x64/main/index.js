/******/ (() => { // webpackBootstrap
/******/ 	"use strict";
/******/ 	var __webpack_modules__ = ({

/***/ "./src/controller.ts"
/*!***************************!*\
  !*** ./src/controller.ts ***!
  \***************************/
(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.DesktopController = void 0;
const path = __importStar(__webpack_require__(/*! node:path */ "node:path"));
const fsp = __importStar(__webpack_require__(/*! node:fs/promises */ "node:fs/promises"));
const node_crypto_1 = __webpack_require__(/*! node:crypto */ "node:crypto");
const node_events_1 = __webpack_require__(/*! node:events */ "node:events");
const electron_1 = __webpack_require__(/*! electron */ "electron");
const core_process_runner_1 = __webpack_require__(/*! ./core-process-runner */ "./src/core-process-runner.ts");
const paths_1 = __webpack_require__(/*! ./paths */ "./src/paths.ts");
const secret_store_1 = __webpack_require__(/*! ./secret-store */ "./src/secret-store.ts");
const shared_1 = __webpack_require__(/*! ./shared */ "./src/shared.ts");
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const DEFAULT_SESSIONS_ROOT = ".goal/sessions";
const INIT_MANIFEST_FILE_NAME = "init_manifest.v1.json";
const HASHED_DEFINITION_FILES = [
    "agents.json", "agents.schema.json", "tasks.json", "tasks.schema.json",
    "workflow.json", "workflow.schema.json", "loop_config.schema.json",
];
const PACKAGED_CONFIG_ROOT = "config";
function validateIndex(value, filePath) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error(`Session index is not an object: ${filePath}`);
    const index = value;
    if (index.version !== 4 || !Array.isArray(index.activeSessionIds) || !Array.isArray(index.sessionMetas) || !Array.isArray(index.availableModels) || index.manualModelsOverride !== null || (index.modelVariants !== null && (typeof index.modelVariants !== "object" || Array.isArray(index.modelVariants))) || !index.providerCatalog || typeof index.providerCatalog !== "object" || Array.isArray(index.providerCatalog)) {
        throw new Error(`Session index must use version 4: ${filePath}`);
    }
    for (const [providerId, discovery] of Object.entries(index.providerCatalog)) {
        const validated = (0, shared_1.validateProviderDiscoveryResultV2)(discovery);
        if (validated.providerId !== providerId)
            throw new Error(`Session index providerCatalog key mismatch: ${filePath}`);
    }
    if (index.activeSessionIds.some((id) => typeof id !== "string" || !SAFE_ID.test(id)))
        throw new Error(`Session index contains an invalid active session id: ${filePath}`);
    if (new Set(index.activeSessionIds).size !== index.activeSessionIds.length)
        throw new Error(`Session index contains duplicate active session ids: ${filePath}`);
    if (index.availableModels.some((model) => typeof model !== "string" || !model.trim()))
        throw new Error(`Session index contains an invalid model: ${filePath}`);
    if (index.modelsDiscoveredAt !== null && typeof index.modelsDiscoveredAt !== "string")
        throw new Error(`Session index modelsDiscoveredAt is invalid: ${filePath}`);
    if (index.modelsDiscoveredCli !== null && (typeof index.modelsDiscoveredCli !== "string" || !index.modelsDiscoveredCli.trim()))
        throw new Error(`Session index modelsDiscoveredCli is invalid: ${filePath}`);
    if (index.modelsDiscoveredAt !== null && !Number.isFinite(Date.parse(index.modelsDiscoveredAt)))
        throw new Error(`Session index modelsDiscoveredAt is invalid: ${filePath}`);
    if (index.modelVariants !== null) {
        for (const [providerId, models] of Object.entries(index.modelVariants)) {
            if (!Array.isArray(models) || models.some((model) => typeof model !== "string" || !model.trim()))
                throw new Error(`Session index modelVariants.${providerId} is invalid: ${filePath}`);
        }
    }
    const metadataIds = new Set();
    for (const meta of index.sessionMetas) {
        if (!meta || typeof meta !== "object" || typeof meta.sessionId !== "string" || !SAFE_ID.test(meta.sessionId) || metadataIds.has(meta.sessionId) || typeof meta.goal !== "string" || !meta.goal.trim() || typeof meta.targetProjectPath !== "string" || !meta.targetProjectPath.trim() || typeof meta.createdAt !== "string" || !Number.isFinite(Date.parse(meta.createdAt)) || !["RUNNING", "WAITING_USER", "PAUSED", "SUCCESS", "FAILED", "STOPPED", "BLOCKED"].includes(meta.status)) {
            throw new Error(`Session index contains invalid session metadata: ${filePath}`);
        }
        metadataIds.add(meta.sessionId);
    }
    if (index.activeSessionIds.some((id) => !metadataIds.has(id)))
        throw new Error(`Session index active session metadata is missing: ${filePath}`);
    return value;
}
function assertSafeId(value) {
    if (!SAFE_ID.test(value))
        throw new Error("Invalid session or choice id.");
    return value;
}
function parseObject(value, label) {
    let parsed;
    try {
        parsed = JSON.parse(value);
    }
    catch {
        throw new Error(`${label} is not valid JSON.`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error(`${label} must be an object.`);
    return parsed;
}
function validateLockOwner(value, filePath) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error(`Lock owner record is invalid: ${filePath}`);
    const record = value;
    if (!Number.isSafeInteger(record.ownerPid) || Number(record.ownerPid) <= 0 || typeof record.createdAt !== "string") {
        throw new Error(`Lock owner record is invalid: ${filePath}`);
    }
    if (typeof record.ownerId !== "string" || !record.ownerId.trim())
        throw new Error(`Lock owner record is invalid: ${filePath}`);
    const createdAt = Date.parse(record.createdAt);
    if (!Number.isFinite(createdAt))
        throw new Error(`Lock owner record timestamp is invalid: ${filePath}`);
    return { ownerPid: Number(record.ownerPid), createdAt };
}
async function hashDefinitionFiles(root) {
    const digest = (0, node_crypto_1.createHash)("sha256");
    for (const fileName of HASHED_DEFINITION_FILES) {
        digest.update(fileName);
        digest.update("\0");
        digest.update(await fsp.readFile(path.join(root, fileName)));
        digest.update("\0");
    }
    return digest.digest("hex");
}
async function verifyInitManifest(roots) {
    const filePath = path.join(roots.configRoot, INIT_MANIFEST_FILE_NAME);
    let raw;
    try {
        raw = await fsp.readFile(filePath, "utf8");
    }
    catch (error) {
        if (error.code === "ENOENT")
            return false;
        throw error;
    }
    const parsed = parseObject(raw, INIT_MANIFEST_FILE_NAME);
    if (parsed.schemaVersion !== 1 || typeof parsed.productVersion !== "string" ||
        parsed.productVersion !== "8.0.0" || typeof parsed.definitionSha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(parsed.definitionSha256) || parsed.sessionIndexVersion !== 4 ||
        typeof parsed.initAt !== "string" || !Number.isFinite(Date.parse(parsed.initAt)))
        throw new Error(`Initialization manifest is invalid: ${filePath}`);
    const packagedHash = await hashDefinitionFiles(path.join(roots.codeRoot, PACKAGED_CONFIG_ROOT));
    if (parsed.definitionSha256 !== packagedHash)
        throw new Error("Initialization manifest does not match packaged definitions.");
    const configuredHash = await hashDefinitionFiles(roots.configRoot);
    if (parsed.definitionSha256 !== configuredHash)
        throw new Error("Initialized definition files do not match the commit manifest.");
    const configuredConfig = parseObject(await fsp.readFile(path.join(roots.configRoot, "loop_config.json"), "utf8"), "loop_config.json");
    const paths = configuredConfig.paths && typeof configuredConfig.paths === "object" ? configuredConfig.paths : null;
    const indexName = safeRelativePath(paths?.sessionsIndexFileName, "paths.sessionsIndexFileName", "sessions_index.json", true);
    const indexPath = path.join(roots.dataRoot, indexName);
    const index = parseObject(await fsp.readFile(indexPath, "utf8"), indexName);
    validateIndex(index, indexPath);
    return true;
}
function safeRelativePath(value, label, defaultValue, singleSegment = false) {
    const candidate = typeof value === "string" && value.trim() ? value.trim() : defaultValue;
    if (path.isAbsolute(candidate) || path.win32.isAbsolute(candidate) || path.posix.isAbsolute(candidate) || candidate.includes("\0")) {
        throw new Error(`${label} must be a relative path.`);
    }
    const parts = candidate.replace(/\\/gu, "/").split("/");
    if (parts.some((part) => !part || part === "." || part === ".."))
        throw new Error(`${label} contains an unsafe path segment.`);
    const reserved = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/iu;
    if (parts.some((part) => /[\x00-\x1f<>:"|?*]/u.test(part) || /[ .]$/u.test(part) || reserved.test(part))) {
        throw new Error(`${label} contains a non-portable or unsafe path segment.`);
    }
    if (singleSegment && parts.length !== 1)
        throw new Error(`${label} must be a single path segment.`);
    return candidate;
}
class DesktopController {
    roots;
    events = new node_events_1.EventEmitter();
    runner;
    secrets;
    processes = new Map();
    statePollers = new Map();
    planDrafts = new Map();
    // A session that reached a verified terminal state must not be stopped a
    // second time when a different resource (for example its process handle)
    // failed during the same release attempt. Keeping this set across retries
    // makes the retry boundary resource-specific as promised by ReleaseResult.
    releasedSessions = new Set();
    settings = null;
    rawConfig = null;
    lifecycle = "new";
    initializationError = null;
    releasePromise = null;
    constructor(roots) {
        this.roots = roots;
        this.runner = new core_process_runner_1.CoreProcessRunner(roots);
        this.secrets = new secret_store_1.SecretStore(roots.configRoot);
    }
    on(event, listener) {
        if (this.lifecycle !== "initialized") {
            throw new Error(`Desktop controller is not ready for event subscriptions (state: ${this.lifecycle}).`);
        }
        this.events.on(event, listener);
        return () => this.events.off(event, listener);
    }
    async init() {
        if (this.lifecycle !== "new") {
            throw new Error(`Desktop controller cannot be initialized from state ${this.lifecycle}.`);
        }
        this.lifecycle = "initializing";
        try {
            await (0, paths_1.initDesktopRoots)(this.roots);
            const capabilityResult = await this.runner.runShort("capabilities", [], { timeoutMs: 10_000 });
            if (capabilityResult.exitCode !== 0)
                throw new Error(capabilityResult.stderr || `Unable to verify the packaged Agent Loop core (exit ${String(capabilityResult.exitCode)}, ${capabilityResult.timedOut ? "timed out" : "process failure"}).`);
            const capabilityLines = capabilityResult.stdout.trim().split(/\r?\n/u).filter(Boolean);
            const handshake = parseObject(capabilityLines.join("\n"), "core capabilities");
            const requiredCapabilities = [
                "compiled-workflow-bundle-v2",
                "read-only-projection-v2",
                "verification-proof-v1",
                "verification-reapproval-v1",
                "strict-current-contracts-v1",
                "packaged-core-layout-v2",
            ];
            const capabilityNames = Array.isArray(handshake.capabilities)
                ? handshake.capabilities.filter((value) => typeof value === "string")
                : [];
            if (handshake.protocolVersion !== 3 || handshake.stateSchemaVersion !== 2 ||
                !Array.isArray(handshake.capabilities) ||
                capabilityNames.length !== handshake.capabilities.length ||
                requiredCapabilities.some((capability) => !capabilityNames.includes(capability))) {
                throw new Error("The packaged core does not satisfy protocol v3/state 2 and the strict v8 packaged-core capabilities.");
            }
            const manifestPresent = await verifyInitManifest(this.roots);
            if (!manifestPresent) {
                const result = await this.runner.runShort("init", [], { timeoutMs: 20_000 });
                if (result.exitCode !== 0)
                    throw new Error(result.stderr || "Unable to initialize Agent Loop definitions.");
            }
            this.settings = await this.readSettings();
            this.initializationError = null;
            this.lifecycle = "initialized";
        }
        catch (error) {
            this.initializationError = error instanceof Error ? error.message : String(error);
            this.lifecycle = "failed";
            throw error;
        }
    }
    /** Expose bootstrap failures without requiring a valid run projection. */
    getStartupStatus() {
        return {
            ready: this.lifecycle === "initialized",
            lifecycle: this.lifecycle,
            error: this.initializationError,
            configRoot: this.roots.configRoot,
            dataRoot: this.roots.dataRoot,
        };
    }
    async openProfileFolder(kind) {
        const folder = kind === "config" ? this.roots.configRoot : this.roots.dataRoot;
        const error = await electron_1.shell.openPath(folder);
        if (error)
            throw new Error(error);
    }
    assertReady() {
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
    async recoverPersistedSessions() {
        this.assertReady();
        const index = await this.readIndex();
        const candidates = [...new Set(index.activeSessionIds)];
        const results = await Promise.all(candidates.map(async (sessionId) => {
            try {
                assertSafeId(sessionId);
                if (this.processes.has(sessionId))
                    return { sessionId, status: "skipped", reason: "Session is already running in this desktop process." };
                const projection = await this.readProjection(sessionId);
                if (!projection || projection.status !== "RUNNING")
                    return { sessionId, status: "skipped", reason: "Session projection is not running." };
                const action = await this.recoveryAction(sessionId);
                if (action !== "recover")
                    return { sessionId, status: "skipped", reason: "Session ownership is still live or unverifiable." };
                await this.assertResumeProviderAvailable(sessionId);
                if (await this.recoveryAction(sessionId) !== "recover")
                    return { sessionId, status: "skipped", reason: "Session ownership changed while checking recovery." };
                const handle = this.runner.run("resume", ["--session", sessionId, ...(await this.projectArgs(sessionId))], {
                    sessionId,
                    secretValues: await this.secretValues(),
                    onLog: this.logFor(sessionId),
                });
                this.bindProcess(sessionId, handle);
                return { sessionId, status: "recovered", reason: null };
            }
            catch (error) {
                const reason = error instanceof Error ? error.message : String(error);
                this.notify("warning", `Session ${sessionId} was not auto-recovered: ${reason}`);
                return { sessionId, status: "failed", reason };
            }
        }));
        if (candidates.length > 0)
            this.emitState();
        return results;
    }
    async recoveryAction(sessionId) {
        const settings = this.settings ?? await this.readSettings();
        const projection = await this.readProjection(sessionId);
        if (!projection || projection.status !== "RUNNING")
            return "ignore";
        const sessionDir = path.join(this.sessionsRoot(settings), sessionId);
        const readJson = async (name) => {
            const filePath = path.join(sessionDir, name);
            let raw;
            try {
                raw = await fsp.readFile(filePath, "utf8");
            }
            catch (error) {
                if (error.code === "ENOENT")
                    return null;
                throw error;
            }
            let parsed;
            try {
                parsed = JSON.parse(raw);
            }
            catch {
                throw new Error(`Malformed session ownership record: ${filePath}`);
            }
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
                throw new Error(`Session ownership record is invalid: ${filePath}`);
            return parsed;
        };
        const ownerName = safeRelativePath(settings.paths.ownerLockFileName, "paths.ownerLockFileName", "session_owner.lock", true);
        const leaseName = safeRelativePath(settings.paths.leaseFileName, "paths.leaseFileName", "session_lease.json", true);
        const owner = await readJson(ownerName);
        const lease = await readJson(leaseName);
        if (owner && (typeof owner.ownerId !== "string" || !owner.ownerId ||
            !Number.isSafeInteger(owner.ownerPid) || Number(owner.ownerPid) <= 0 ||
            typeof owner.createdAt !== "string" || !Number.isFinite(Date.parse(owner.createdAt))))
            throw new Error(`Session owner lock is invalid: ${sessionDir}`);
        if (lease && (!owner ||
            typeof lease.ownerId !== "string" || !lease.ownerId ||
            !Number.isSafeInteger(lease.ownerPid) || Number(lease.ownerPid) <= 0 ||
            typeof lease.acquiredAt !== "string" || !Number.isFinite(Date.parse(lease.acquiredAt)) ||
            typeof lease.heartbeatAt !== "string" || !Number.isFinite(Date.parse(lease.heartbeatAt)) ||
            typeof lease.expiresAt !== "string" || !Number.isFinite(Date.parse(lease.expiresAt)) ||
            lease.ownerId !== owner.ownerId || lease.ownerPid !== owner.ownerPid))
            throw new Error(`Session owner lock and lease are inconsistent: ${sessionDir}`);
        const ownerPid = typeof lease?.ownerPid === "number"
            ? lease.ownerPid
            : typeof owner?.ownerPid === "number" ? owner.ownerPid : null;
        let ownerLiveness = "dead";
        if (ownerPid && ownerPid > 0) {
            try {
                process.kill(ownerPid, 0);
                ownerLiveness = "alive";
            }
            catch (error) {
                const code = error.code;
                ownerLiveness = code === "ESRCH" ? "dead" : "unknown";
            }
        }
        if (ownerLiveness === "unknown")
            return "follow";
        if (lease) {
            const expiresAt = typeof lease.expiresAt === "string" ? Date.parse(lease.expiresAt) : Number.NaN;
            if (!Number.isFinite(expiresAt) || expiresAt > Date.now() || ownerLiveness === "alive")
                return "follow";
            return "recover";
        }
        if (owner) {
            const createdAt = typeof owner.createdAt === "string" ? Date.parse(owner.createdAt) : Number.NaN;
            const ttl = typeof settings.defaults.leaseTtlMs === "number" && Number.isFinite(settings.defaults.leaseTtlMs)
                ? settings.defaults.leaseTtlMs
                : 20_000;
            if (!Number.isFinite(createdAt) || Date.now() - createdAt < ttl || ownerLiveness === "alive")
                return "follow";
            return "recover";
        }
        return "recover";
    }
    sessionsRoot(settings = this.settings) {
        const relative = safeRelativePath(settings?.paths?.sessionsRoot, "paths.sessionsRoot", DEFAULT_SESSIONS_ROOT);
        return path.resolve(this.roots.dataRoot, relative);
    }
    sessionFileName(key, defaultFileName) {
        const paths = this.settings?.paths?.sessionFileNames;
        const value = paths && typeof paths === "object" ? paths[key] : undefined;
        return safeRelativePath(value, `paths.sessionFileNames.${key}`, defaultFileName, true);
    }
    async readSettings() {
        const configPath = path.join(this.roots.configRoot, "loop_config.json");
        try {
            const raw = await fsp.readFile(configPath, "utf8");
            const parsed = parseObject(raw, "loop_config.json");
            const allowedConfigKeys = new Set(["$schema", "paths", "defaults", "cliProfiles", "providers", "toolAccess", "destructivePrompts", "variantDefaults"]);
            for (const key of Object.keys(parsed)) {
                if (!allowedConfigKeys.has(key))
                    throw new Error(`loop_config.json contains unsupported field '${key}'.`);
            }
            this.rawConfig = structuredClone(parsed);
            return (0, shared_1.validateDesktopSettings)({
                paths: (parsed.paths && typeof parsed.paths === "object" ? parsed.paths : {}),
                providers: (parsed.providers && typeof parsed.providers === "object" ? parsed.providers : {}),
                toolAccess: (parsed.toolAccess && typeof parsed.toolAccess === "object" ? parsed.toolAccess : {}),
                defaults: (parsed.defaults && typeof parsed.defaults === "object" ? parsed.defaults : {}),
                variantDefaults: (parsed.variantDefaults && typeof parsed.variantDefaults === "object" ? parsed.variantDefaults : {}),
            });
        }
        catch (error) {
            throw new Error(`Unable to read Agent Loop settings: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async getSettings() {
        this.assertReady();
        this.settings = await this.readSettings();
        return structuredClone(this.settings);
    }
    async readIndex() {
        const settings = this.settings ?? await this.readSettings();
        const indexName = safeRelativePath(settings.paths?.sessionsIndexFileName, "paths.sessionsIndexFileName", "sessions_index.json", true);
        const filePath = path.join(this.roots.dataRoot, indexName);
        let raw;
        try {
            raw = await fsp.readFile(filePath, "utf8");
        }
        catch (error) {
            if (error.code === "ENOENT")
                throw new Error(`Session index is not initialized: ${filePath}`);
            throw error;
        }
        return validateIndex(parseObject(raw, "sessions_index.json"), filePath);
    }
    indexPath(settings = this.settings) {
        const current = settings ?? this.settings;
        const indexName = safeRelativePath(current?.paths?.sessionsIndexFileName, "paths.sessionsIndexFileName", "sessions_index.json", true);
        return path.join(this.roots.dataRoot, indexName);
    }
    indexLockPath(settings = this.settings) {
        const current = settings ?? this.settings;
        const lockName = safeRelativePath(current?.paths?.registryLockFileName, "paths.registryLockFileName", "registry.lock", true);
        return path.join(this.roots.dataRoot, lockName);
    }
    /** Serialize file edits with a lock that is compatible with core's lock files. */
    async withFileLock(lockPath, operation) {
        const parent = path.dirname(lockPath);
        const parentStat = await fsp.stat(parent);
        if (!parentStat.isDirectory())
            throw new Error(`Lock parent is not a directory: ${parent}`);
        let handle = null;
        for (let attempt = 0; attempt < 80; attempt += 1) {
            try {
                handle = await fsp.open(lockPath, "wx");
                await handle.writeFile(JSON.stringify({ ownerId: `desktop-${process.pid}-${(0, node_crypto_1.randomBytes)(8).toString("hex")}`, ownerPid: process.pid, createdAt: new Date().toISOString() }), "utf8");
                break;
            }
            catch (error) {
                const code = error.code;
                let closeError;
                if (handle) {
                    try {
                        await handle.close();
                    }
                    catch (releaseError) {
                        closeError = releaseError;
                    }
                    finally {
                        handle = null;
                    }
                    try {
                        await fsp.unlink(lockPath);
                    }
                    catch (releaseError) {
                        const releaseCode = releaseError.code;
                        if (releaseCode !== "ENOENT") {
                            throw new AggregateError(closeError === undefined ? [error, releaseError] : [error, closeError, releaseError], `Lock initialization failed: ${lockPath}`);
                        }
                    }
                    if (closeError !== undefined)
                        throw new AggregateError([error, closeError], `Lock handle release failed: ${lockPath}`);
                }
                if (code !== "EEXIST")
                    throw error;
                // Reclaim only a lock whose recorded owner is dead and old enough to
                // be a crashed desktop process; live operations are never stolen.
                try {
                    const raw = await fsp.readFile(lockPath, "utf8");
                    const record = validateLockOwner(JSON.parse(raw), lockPath);
                    const ownerPid = record.ownerPid;
                    const createdAt = record.createdAt;
                    let alive = ownerPid === process.pid;
                    if (ownerPid && ownerPid !== process.pid) {
                        try {
                            process.kill(ownerPid, 0);
                            alive = true;
                        }
                        catch (livenessError) {
                            const livenessCode = livenessError.code;
                            if (livenessCode === "ESRCH")
                                alive = false;
                            else if (livenessCode === "EPERM" || livenessCode === "EACCES")
                                alive = true;
                            else
                                throw livenessError;
                        }
                    }
                    if (Date.now() - createdAt > 30_000 && !alive) {
                        try {
                            await fsp.unlink(lockPath);
                        }
                        catch (reclaimError) {
                            const reclaimCode = reclaimError.code;
                            if (reclaimCode !== "ENOENT")
                                throw reclaimError;
                        }
                    }
                }
                catch (inspectError) {
                    const inspectCode = inspectError.code;
                    if (inspectCode !== "ENOENT")
                        throw inspectError;
                }
                await new Promise((resolve) => setTimeout(resolve, Math.min(250, 10 + attempt * 5)));
            }
        }
        if (!handle)
            throw new Error("Timed out acquiring the session index lock.");
        let value;
        let operationError;
        try {
            value = await operation();
        }
        catch (error) {
            operationError = error;
        }
        const releaseFailures = [];
        try {
            await handle.close();
        }
        catch (error) {
            releaseFailures.push(error);
        }
        try {
            await fsp.unlink(lockPath);
        }
        catch (error) {
            releaseFailures.push(error);
        }
        if (operationError !== undefined && releaseFailures.length > 0)
            throw new AggregateError([operationError, ...releaseFailures], `Operation and lock release failed: ${lockPath}`);
        if (operationError !== undefined)
            throw operationError;
        if (releaseFailures.length > 0)
            throw new AggregateError(releaseFailures, `Lock release failed: ${lockPath}`);
        return value;
    }
    async writeIndexAtomic(index) {
        const indexPath = this.indexPath();
        const temporary = `${indexPath}.tmp.${process.pid}.${Date.now()}`;
        let primary;
        try {
            await fsp.writeFile(temporary, `${JSON.stringify(index, null, 2)}\n`, "utf8");
            await fsp.rename(temporary, indexPath);
        }
        catch (error) {
            primary = error;
        }
        let releaseFailure;
        try {
            await fsp.rm(temporary, { force: true });
        }
        catch (error) {
            releaseFailure = error;
        }
        if (primary !== undefined && releaseFailure !== undefined)
            throw new AggregateError([primary, releaseFailure], `Index write and temporary-file cleanup failed: ${indexPath}`);
        if (primary !== undefined)
            throw primary;
        if (releaseFailure !== undefined)
            throw releaseFailure;
    }
    async readProjection(sessionId) {
        assertSafeId(sessionId);
        const sessionDirectory = path.join(this.sessionsRoot(), sessionId);
        const filePath = path.join(sessionDirectory, this.sessionFileName("state", "run_projection.json"));
        let raw;
        try {
            raw = await fsp.readFile(filePath, "utf8");
        }
        catch (error) {
            if (error.code === "ENOENT") {
                try {
                    const stat = await fsp.stat(sessionDirectory);
                    if (!stat.isDirectory())
                        throw new Error(`Session storage is not a directory: ${sessionDirectory}`);
                }
                catch (directoryError) {
                    if (directoryError.code === "ENOENT")
                        return null;
                    throw directoryError;
                }
                throw new Error(`Run projection is missing: ${filePath}`);
            }
            throw error;
        }
        const projection = (0, shared_1.validateRunProjectionV2)(parseObject(raw, "run_projection.json"));
        if (projection.runId !== sessionId || projection.sessionId !== sessionId)
            throw new Error(`Run projection session identity is invalid: ${filePath}`);
        return projection;
    }
    async providerForSession(sessionId) {
        const projection = await this.readProjection(sessionId);
        const agentId = projection?.currentAgentId;
        if (!agentId)
            return { providerId: null, configured: true };
        const agents = parseObject(await fsp.readFile(path.join(this.roots.configRoot, "agents.json"), "utf8"), "agents.json").agents;
        if (!Array.isArray(agents))
            throw new Error("agents.json must contain an agents array.");
        const agent = agents.find((entry) => entry && typeof entry === "object" && entry.id === agentId);
        if (!agent)
            throw new Error(`Agent definition ${agentId} is missing.`);
        const providerId = typeof agent.runtimeDefaults?.provider === "string" ? agent.runtimeDefaults.provider.trim() : "";
        return { providerId: providerId || null, configured: Boolean(providerId) };
    }
    async projectArgs(sessionId) {
        const projection = await this.readProjection(sessionId);
        if (!projection)
            throw new Error(`Session ${sessionId} was not found.`);
        // Keep the core RootSet's projectRoot aligned with the session target;
        // the target is still carried separately in the aggregate contract.
        const projectPath = await (0, paths_1.validateProjectPath)(projection.targetProjectPath, this.roots);
        return ["--project-root", projectPath];
    }
    /** Avoid replaying a session when a previously discovered provider vanished. */
    async assertResumeProviderAvailable(sessionId) {
        const provider = await this.providerForSession(sessionId);
        if (!provider.configured) {
            throw new Error(`The provider for the current agent is not configured; session ${sessionId} will not be replayed.`);
        }
        const providerId = provider.providerId;
        if (!providerId)
            return;
        let discovery;
        try {
            // Re-check the executable immediately before replay. A cached catalog is
            // useful for display, but it cannot prove that an external CLI still
            // exists after a restart or uninstall.
            const fresh = await this.discoverModels();
            discovery = fresh.providers.find((entry) => entry.providerId === providerId);
        }
        catch (error) {
            throw new Error(`Unable to verify provider '${providerId}' before resuming session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (!discovery)
            throw new Error(`Provider '${providerId}' is not configured; session ${sessionId} will not be replayed.`);
        if (discovery && !discovery.available) {
            const code = discovery.error?.code ? ` (${discovery.error.code})` : "";
            throw new Error(`Provider '${providerId}' is unavailable${code}; install or configure it before resuming session ${sessionId}.`);
        }
    }
    async buildSnapshot(sessionId) {
        const index = await this.readIndex();
        let selected = sessionId;
        if (!selected)
            selected = index.activeSessionIds[0] ?? index.sessionMetas[index.sessionMetas.length - 1]?.sessionId;
        const projection = selected ? await this.readProjection(selected) : null;
        if (selected && index.activeSessionIds.includes(selected) && projection === null) {
            throw new Error(`Active session ${selected} has no readable run projection.`);
        }
        const catalog = index.providerCatalog;
        return (0, shared_1.validateDesktopSnapshot)({
            schemaVersion: 3,
            capturedAt: new Date().toISOString(),
            projection,
            sessionIndex: index,
            settings: this.settings ? structuredClone(this.settings) : null,
            providerDiscovery: Object.values(catalog).filter((entry) => {
                try {
                    (0, shared_1.validateModelDiscoveryPayload)({ schemaVersion: 2, discoveredAt: null, providers: [entry], models: [] });
                    return true;
                }
                catch {
                    return false;
                }
            }),
        });
    }
    async getSnapshot(sessionId) {
        this.assertReady();
        return this.buildSnapshot(sessionId);
    }
    emitState(sessionId) {
        void this.getSnapshot(sessionId).then((snapshot) => this.events.emit("state", snapshot)).catch((error) => this.notify("error", error instanceof Error ? error.message : String(error)));
    }
    notify(level, message) {
        this.events.emit("notification", { level, message });
    }
    bindProcess(sessionId, handle) {
        this.processes.set(sessionId, handle);
        // The core projection is updated independently of the utility-process
        // stdout stream. Poll while a long-running command owns the session so a
        // renderer sees planning gates, progress, and terminal state promptly.
        if (!this.statePollers.has(sessionId)) {
            const poller = setInterval(() => this.emitState(sessionId), 750);
            this.statePollers.set(sessionId, poller);
        }
        void handle.done.then((result) => {
            if (this.processes.get(sessionId) === handle)
                this.processes.delete(sessionId);
            const poller = this.statePollers.get(sessionId);
            if (poller) {
                clearInterval(poller);
                this.statePollers.delete(sessionId);
            }
            if (result.exitCode !== 0 && result.exitCode !== null)
                this.notify("error", `Session ${sessionId} core process exited with code ${result.exitCode}.`);
            this.emitState(sessionId);
        });
    }
    logFor(sessionId) {
        return (event) => this.events.emit("log", { sessionId, ...event });
    }
    async secretValues() {
        // SecretStore fails closed when encryption is unavailable or the document
        // is corrupt. Never continue with plaintext or silently missing values.
        const required = new Set();
        const servers = this.settings?.toolAccess?.mcpServers;
        for (const server of servers ?? []) {
            if (!server || typeof server !== "object" || Array.isArray(server))
                continue;
            for (const field of ["environment", "headers"]) {
                const values = server[field];
                if (!values || typeof values !== "object" || Array.isArray(values))
                    continue;
                for (const value of Object.values(values)) {
                    const match = typeof value === "string" ? value.match(/^\$\{secret:([^}]+)\}$/u) : null;
                    if (match)
                        required.add(match[1]);
                }
            }
        }
        return this.secrets.getAll([...required]);
    }
    async startSession(input) {
        this.assertReady();
        const goal = input.goal.trim();
        if (!goal || goal.length > 64 * 1024)
            throw new Error("Goal must be between 1 and 65536 characters.");
        const projectPath = await (0, paths_1.validateProjectPath)(input.projectPath, this.roots);
        const sessionId = assertSafeId(input.sessionId?.trim() || `run_${Date.now().toString(36)}_${(0, node_crypto_1.randomBytes)(4).toString("hex")}`);
        if (this.processes.has(sessionId))
            throw new Error(`Session ${sessionId} is already running.`);
        this.releasedSessions.delete(sessionId);
        const args = ["--goal", goal, "--target", projectPath, "--project-root", projectPath, "--session", sessionId];
        if (input.accessMode === "full_access")
            args.push("--full-access");
        const handle = this.runner.run("run", args, { sessionId, secretValues: await this.secretValues(), onLog: this.logFor(sessionId) });
        this.bindProcess(sessionId, handle);
        this.emitState();
        return { sessionId };
    }
    async resumeSession(sessionId) {
        this.assertReady();
        assertSafeId(sessionId);
        if (this.processes.has(sessionId))
            throw new Error(`Session ${sessionId} is already running.`);
        this.releasedSessions.delete(sessionId);
        await this.assertResumeProviderAvailable(sessionId);
        const handle = this.runner.run("resume", ["--session", sessionId, ...(await this.projectArgs(sessionId))], { sessionId, secretValues: await this.secretValues(), onLog: this.logFor(sessionId) });
        this.bindProcess(sessionId, handle);
        this.emitState();
        return { sessionId };
    }
    async stopSessionInternal(sessionId) {
        assertSafeId(sessionId);
        const result = await this.runner.runShort("stop", ["--session", sessionId], { timeoutMs: 15_000, onLog: this.logFor(sessionId) });
        if (result.exitCode !== 0)
            throw new Error(result.stderr || `Unable to stop session ${sessionId}.`);
        const process = this.processes.get(sessionId);
        if (process)
            await Promise.race([process.done, new Promise((resolve) => setTimeout(resolve, 3_000))]);
        const snapshot = await this.buildSnapshot(sessionId);
        this.events.emit("state", snapshot);
        return snapshot;
    }
    async stopSession(sessionId) {
        this.assertReady();
        return this.stopSessionInternal(sessionId);
    }
    async interruptSession(sessionId, message) {
        this.assertReady();
        assertSafeId(sessionId);
        const text = message.trim();
        if (!text || text.length > 16 * 1024)
            throw new Error("Interrupt message is required and must be at most 16384 characters.");
        const result = await this.runner.runShort("interrupt", ["--session", sessionId, "--message", text], { timeoutMs: 15_000, onLog: this.logFor(sessionId) });
        if (result.exitCode !== 0)
            throw new Error(result.stderr || `Unable to interrupt session ${sessionId}.`);
        const snapshot = await this.getSnapshot(sessionId);
        this.events.emit("state", snapshot);
        return snapshot;
    }
    async setAccessMode(sessionId, mode) {
        this.assertReady();
        assertSafeId(sessionId);
        const result = await this.runner.runShort("set-access", ["--session", sessionId, "--mode", mode], { timeoutMs: 15_000 });
        if (result.exitCode !== 0)
            throw new Error(result.stderr || "Unable to change access mode.");
        const snapshot = await this.getSnapshot(sessionId);
        this.events.emit("state", snapshot);
        return snapshot;
    }
    async resolveAccessRequest(sessionId, approved) {
        this.assertReady();
        assertSafeId(sessionId);
        if (!approved)
            return this.getSnapshot(sessionId);
        this.releasedSessions.delete(sessionId);
        await this.assertResumeProviderAvailable(sessionId);
        const handle = this.runner.run("resume", ["--session", sessionId, ...(await this.projectArgs(sessionId)), "--approve-access"], { sessionId, secretValues: await this.secretValues(), onLog: this.logFor(sessionId) });
        this.bindProcess(sessionId, handle);
        return this.getSnapshot(sessionId);
    }
    async selectPlanChoice(sessionId, choiceId) {
        this.assertReady();
        assertSafeId(sessionId);
        assertSafeId(choiceId);
        const projection = await this.readProjection(sessionId);
        if (!projection?.planChoices.some((choice) => choice.id === choiceId))
            throw new Error("Plan choice is not available for this session.");
        this.planDrafts.set(sessionId, choiceId);
        return { choiceId };
    }
    async approvePlan(sessionId, requestedChoiceId) {
        this.assertReady();
        assertSafeId(sessionId);
        const choiceId = requestedChoiceId ?? this.planDrafts.get(sessionId);
        if (!choiceId)
            throw new Error("Select a plan choice before approval.");
        assertSafeId(choiceId);
        const result = await this.runner.runShort("approve-plan", ["--session", sessionId, "--choice-id", choiceId], { timeoutMs: 15_000 });
        if (result.exitCode !== 0)
            throw new Error(result.stderr || "Unable to approve plan.");
        this.planDrafts.delete(sessionId);
        return this.resumeSession(sessionId);
    }
    async revisePlan(sessionId, message) {
        this.assertReady();
        assertSafeId(sessionId);
        const text = message.trim();
        if (!text || text.length > 64 * 1024)
            throw new Error("Revision message is required.");
        if (this.processes.has(sessionId))
            throw new Error(`Session ${sessionId} is already running.`);
        this.releasedSessions.delete(sessionId);
        await this.assertResumeProviderAvailable(sessionId);
        const handle = this.runner.run("revise-plan", ["--session", sessionId, ...(await this.projectArgs(sessionId)), "--message", text], { sessionId, secretValues: await this.secretValues(), onLog: this.logFor(sessionId) });
        this.bindProcess(sessionId, handle);
        return { sessionId };
    }
    async approveVerification(sessionId, requestId, candidateHash) {
        this.assertReady();
        assertSafeId(sessionId);
        if (!requestId.trim() || !/^[a-f0-9]{64}$/iu.test(candidateHash)) {
            throw new Error("Verification approval request and candidate hash are invalid.");
        }
        if (this.processes.has(sessionId))
            throw new Error(`Session ${sessionId} is already running.`);
        this.releasedSessions.delete(sessionId);
        await this.assertResumeProviderAvailable(sessionId);
        const handle = this.runner.run("approve-verification", ["--session", sessionId, ...(await this.projectArgs(sessionId)), "--request-id", requestId, "--candidate-hash", candidateHash], { sessionId, secretValues: await this.secretValues(), onLog: this.logFor(sessionId) });
        this.bindProcess(sessionId, handle);
        return { sessionId };
    }
    async rejectVerification(sessionId, requestId, candidateHash, message) {
        this.assertReady();
        assertSafeId(sessionId);
        const text = message.trim();
        if (!requestId.trim() || !/^[a-f0-9]{64}$/iu.test(candidateHash) || !text || text.length > 16 * 1024) {
            throw new Error("Verification rejection request, candidate hash, and message are invalid.");
        }
        if (this.processes.has(sessionId))
            throw new Error(`Session ${sessionId} is already running.`);
        this.releasedSessions.delete(sessionId);
        const handle = this.runner.run("reject-verification", ["--session", sessionId, ...(await this.projectArgs(sessionId)), "--request-id", requestId, "--candidate-hash", candidateHash, "--message", text], { sessionId, secretValues: await this.secretValues(), onLog: this.logFor(sessionId) });
        this.bindProcess(sessionId, handle);
        return { sessionId };
    }
    async discoverModels() {
        this.assertReady();
        const result = await this.runner.runShort("models", ["--json"], { timeoutMs: 20_000 });
        if (result.exitCode !== 0)
            throw new Error(result.stderr || "Model discovery failed.");
        const lines = result.stdout.trim().split(/\r?\n/u).filter(Boolean);
        const payload = (0, shared_1.validateModelDiscoveryPayload)(parseObject(lines.join("\n"), "models --json output"));
        this.emitState();
        return payload;
    }
    async getSessionBundle(sessionId) {
        this.assertReady();
        assertSafeId(sessionId);
        const sessionDir = path.join(this.sessionsRoot(), sessionId);
        const projection = await this.readProjection(sessionId);
        if (!projection)
            throw new Error(`Session ${sessionId} was not found.`);
        const readOptional = async (name) => {
            try {
                return await fsp.readFile(path.join(sessionDir, name), "utf8");
            }
            catch (error) {
                if (error.code === "ENOENT")
                    return null;
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
    async revealSessionFolder(sessionId) {
        this.assertReady();
        assertSafeId(sessionId);
        const folder = path.join(this.sessionsRoot(), sessionId);
        const error = await electron_1.shell.openPath(folder);
        if (error)
            throw new Error(error);
    }
    async deleteSession(sessionId) {
        this.assertReady();
        assertSafeId(sessionId);
        const running = this.processes.get(sessionId);
        const index = await this.readIndex();
        const projection = await this.readProjection(sessionId);
        const indexedActive = index.activeSessionIds.includes(sessionId);
        const projectionActive = projection !== null && !["SUCCESS", "STOPPED", "FAILED", "BLOCKED"].includes(projection.status);
        if (running || indexedActive || projectionActive) {
            const stopped = await this.stopSessionInternal(sessionId);
            if (!stopped.projection || !["STOPPED", "SUCCESS", "FAILED", "BLOCKED"].includes(stopped.projection.status))
                throw new Error("Session is still active; deletion was cancelled.");
        }
        const sessionDir = path.join(this.sessionsRoot(), sessionId);
        const tombstone = `${sessionDir}.deleting.${Date.now().toString(36)}`;
        try {
            await fsp.rename(sessionDir, tombstone);
        }
        catch (error) {
            throw new Error(`Session deletion left a recoverable tombstone at ${tombstone}: ${error instanceof Error ? error.message : String(error)}`);
        }
        try {
            // Keep the renamed directory recoverable until the index no longer
            // advertises it. A crash at any point leaves a useful tombstone marker.
            await this.withFileLock(this.indexLockPath(), async () => {
                const index = await this.readIndex();
                const next = {
                    ...index,
                    activeSessionIds: index.activeSessionIds.filter((id) => id !== sessionId),
                    sessionMetas: index.sessionMetas.filter((meta) => meta.sessionId !== sessionId),
                };
                await this.writeIndexAtomic(next);
            });
            await fsp.rm(tombstone, { recursive: true, force: true });
        }
        catch (error) {
            throw new Error(`Session deletion left a recoverable tombstone at ${tombstone}: ${error instanceof Error ? error.message : String(error)}`);
        }
        this.planDrafts.delete(sessionId);
        this.emitState();
        return { sessionId };
    }
    async saveSettings(settings, secretValues) {
        this.assertReady();
        settings = (0, shared_1.validateDesktopSettings)(settings);
        if (secretValues !== undefined) {
            if (!secretValues || typeof secretValues !== "object" || Array.isArray(secretValues))
                throw new Error("Secret values must be an object.");
            for (const [key, value] of Object.entries(secretValues)) {
                if (!key || typeof value !== "string")
                    throw new Error(`Secret ${key} must be a string.`);
            }
        }
        safeRelativePath(settings.paths?.sessionsRoot, "paths.sessionsRoot", DEFAULT_SESSIONS_ROOT);
        const singleSegmentPathDefaults = {
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
        ]) {
            const configured = settings.paths?.[group];
            if (!configured || typeof configured !== "object" || Array.isArray(configured))
                throw new Error(`paths.${group} must be an object.`);
            for (const [key, value] of Object.entries(configured)) {
                safeRelativePath(value, `paths.${group}.${key}`, defaults[key] ?? key, true);
            }
        }
        const serialized = JSON.stringify(settings);
        if (serialized.length > 512 * 1024)
            throw new Error("Settings payload is too large.");
        const toolAccess = settings.toolAccess;
        for (const server of toolAccess.mcpServers ?? []) {
            for (const values of [server.environment, server.headers]) {
                for (const value of Object.values(values ?? {})) {
                    if (!/^\$\{(?:secret|env):[^}]+\}$/u.test(value))
                        throw new Error("MCP credentials must use secret or environment references.");
                }
            }
        }
        if (secretValues && Object.keys(secretValues).length > 0)
            await this.secrets.set(secretValues);
        const configPath = path.join(this.roots.configRoot, "loop_config.json");
        const settingsLockPath = path.join(this.roots.configRoot, "settings.lock");
        let persisted;
        await this.withFileLock(settingsLockPath, async () => {
            // Reload under the lock so two renderer saves cannot overwrite unrelated
            // fields from a newer configuration revision.
            let latest = this.rawConfig ?? {};
            try {
                latest = parseObject(await fsp.readFile(configPath, "utf8"), "loop_config.json");
            }
            catch (error) {
                throw new Error(`Unable to update settings safely: ${error instanceof Error ? error.message : String(error)}`);
            }
            persisted = {
                ...latest,
                paths: settings.paths,
                providers: settings.providers,
                toolAccess: settings.toolAccess,
                defaults: settings.defaults,
                variantDefaults: settings.variantDefaults,
            };
            const temporary = `${configPath}.tmp.${process.pid}.${Date.now()}`;
            let primary;
            try {
                await fsp.writeFile(temporary, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
                await fsp.rename(temporary, configPath);
            }
            catch (error) {
                primary = error;
            }
            let releaseFailure;
            try {
                await fsp.rm(temporary, { force: true });
            }
            catch (error) {
                releaseFailure = error;
            }
            if (primary !== undefined && releaseFailure !== undefined)
                throw new AggregateError([primary, releaseFailure], `Settings write and temporary-file release failed: ${configPath}`);
            if (primary !== undefined)
                throw primary;
            if (releaseFailure !== undefined)
                throw releaseFailure;
        });
        this.rawConfig = structuredClone(persisted);
        this.settings = structuredClone(settings);
        this.emitState();
        return structuredClone(settings);
    }
    asReleaseFailure(resource, resourceId, error, code = "RELEASE_FAILED") {
        return {
            resource,
            resourceId,
            code,
            message: error instanceof Error ? error.message : String(error),
        };
    }
    async performRelease() {
        const releasedSessionIds = [];
        const failures = [];
        let activeFromIndex = [];
        try {
            activeFromIndex = (await this.readIndex()).activeSessionIds;
        }
        catch (error) {
            failures.push(this.asReleaseFailure("lock", null, error, "SESSION_INDEX_READ_FAILED"));
        }
        const sessionIds = new Set([...this.processes.keys(), ...activeFromIndex]);
        for (const sessionId of sessionIds) {
            if (!this.releasedSessions.has(sessionId)) {
                try {
                    const snapshot = await this.stopSessionInternal(sessionId);
                    if (snapshot.projection && ["STOPPED", "SUCCESS", "FAILED", "BLOCKED"].includes(snapshot.projection.status)) {
                        this.releasedSessions.add(sessionId);
                        releasedSessionIds.push(sessionId);
                    }
                    else {
                        failures.push(this.asReleaseFailure("session", sessionId, "Core did not verify a terminal state before timeout.", "SESSION_NOT_TERMINAL"));
                    }
                }
                catch (error) {
                    failures.push(this.asReleaseFailure("session", sessionId, error));
                }
            }
            const handle = this.processes.get(sessionId);
            if (handle) {
                const waitForDone = async (timeoutMs) => {
                    return Promise.race([
                        handle.done.then(() => ({ settled: true, error: null }), (error) => ({ settled: true, error })),
                        new Promise((resolve) => setTimeout(() => resolve({ settled: false, error: null }), timeoutMs)),
                    ]);
                };
                let processResult = await waitForDone(3_000);
                if (!processResult.settled) {
                    try {
                        handle.kill();
                    }
                    catch (error) {
                        failures.push(this.asReleaseFailure("process", sessionId, error));
                    }
                    processResult = await waitForDone(1_000);
                }
                if (!processResult.settled) {
                    failures.push(this.asReleaseFailure("process", sessionId, "Core process did not exit after stop and kill.", "PROCESS_STILL_RUNNING"));
                }
                else {
                    if (processResult.error !== null)
                        failures.push(this.asReleaseFailure("process", sessionId, processResult.error));
                    this.processes.delete(sessionId);
                }
            }
        }
        for (const [sessionId, poller] of this.statePollers) {
            try {
                clearInterval(poller);
                this.statePollers.delete(sessionId);
            }
            catch (error) {
                failures.push(this.asReleaseFailure("poller", sessionId, error));
            }
        }
        for (const sessionId of releasedSessionIds)
            this.planDrafts.delete(sessionId);
        try {
            this.events.removeAllListeners();
        }
        catch (error) {
            failures.push(this.asReleaseFailure("listener", null, error));
        }
        const result = { releasedSessionIds, failures };
        if (failures.length === 0)
            this.lifecycle = "released";
        else {
            this.lifecycle = "initialized";
            this.releasePromise = null;
        }
        return result;
    }
    async release() {
        if (this.lifecycle === "released")
            return { releasedSessionIds: [], failures: [] };
        if (this.releasePromise)
            return this.releasePromise;
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
exports.DesktopController = DesktopController;


/***/ },

/***/ "./src/core-process-runner.ts"
/*!************************************!*\
  !*** ./src/core-process-runner.ts ***!
  \************************************/
(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.CoreProcessRunner = void 0;
const path = __importStar(__webpack_require__(/*! node:path */ "node:path"));
const electron_1 = __webpack_require__(/*! electron */ "electron");
function appendBounded(current, chunk, limit) {
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    const remaining = Math.max(0, limit - Buffer.byteLength(current, "utf8"));
    if (remaining === 0)
        return current;
    // Slice bytes rather than UTF-16 code units so a multibyte provider output
    // cannot exceed the configured bound. Buffer#toString safely drops a
    // partial trailing code point.
    return current + Buffer.from(text, "utf8").subarray(0, remaining).toString("utf8");
}
/**
 * Adapter around Electron utilityProcess. The rest of the desktop app uses
 * the same result/kill semantics for short and long core commands.
 */
class CoreProcessRunner {
    roots;
    maxOutputBytes;
    entryPoint;
    constructor(roots, maxOutputBytes = 512 * 1024) {
        this.roots = roots;
        this.maxOutputBytes = maxOutputBytes;
        this.entryPoint = path.join(roots.codeRoot, "dist", "entrypoints", "loop-orchestrator.js");
    }
    run(command, args, options = {}) {
        const commandArgs = [
            command,
            ...args,
            "--code-root", this.roots.codeRoot,
            "--config-root", this.roots.configRoot,
            "--data-root", this.roots.dataRoot,
        ];
        const environment = { ...process.env };
        delete environment.AGENT_LOOP_SECRET_VALUES;
        // Do not let a host launch override turn a packaged utility process into
        // a plain Node inspector/runtime or inject arbitrary startup code.
        delete environment.NODE_OPTIONS;
        delete environment.ELECTRON_RUN_AS_NODE;
        environment.AGENT_LOOP_UTILITY_PROCESS = "1";
        if (options.secretValues && Object.keys(options.secretValues).length > 0) {
            environment.AGENT_LOOP_SECRET_VALUES = JSON.stringify(options.secretValues);
        }
        let child;
        try {
            child = electron_1.utilityProcess.fork(this.entryPoint, commandArgs, {
                stdio: "pipe",
                env: environment,
                serviceName: "agent-loop-core",
            });
        }
        catch (error) {
            const failure = {
                exitCode: -1,
                signal: null,
                stdout: "",
                stderr: error instanceof Error ? error.message : String(error),
                timedOut: false,
            };
            return { done: Promise.resolve(failure), kill: () => undefined };
        }
        let stdout = "";
        let stderr = "";
        let settled = false;
        let timer = null;
        let resolveDone;
        const done = new Promise((resolve) => { resolveDone = resolve; });
        const finish = (exitCode, signal, timedOut = false) => {
            if (settled)
                return;
            settled = true;
            if (timer)
                clearTimeout(timer);
            resolveDone({ exitCode, signal, stdout, stderr, timedOut });
        };
        child.stdout?.on("data", (chunk) => {
            stdout = appendBounded(stdout, chunk, this.maxOutputBytes);
            options.onLog?.({ stream: "stdout", text: appendBounded("", chunk, this.maxOutputBytes) });
        });
        child.stderr?.on("data", (chunk) => {
            stderr = appendBounded(stderr, chunk, this.maxOutputBytes);
            options.onLog?.({ stream: "stderr", text: appendBounded("", chunk, this.maxOutputBytes) });
        });
        child.once("error", (error) => {
            const message = error instanceof Error ? error.message : String(error);
            stderr = appendBounded(stderr, message, this.maxOutputBytes);
            options.onLog?.({ stream: "stderr", text: message });
            finish(-1, null, false);
        });
        child.once("exit", (code, signal) => {
            finish(typeof code === "number" ? code : null, typeof signal === "string" ? signal : null);
        });
        if (options.timeoutMs && options.timeoutMs > 0) {
            timer = setTimeout(() => {
                try {
                    child.kill();
                }
                catch (error) {
                    const code = error.code;
                    if (code !== "ENOENT" && code !== "ESRCH") {
                        stderr = appendBounded(stderr, error instanceof Error ? error.message : String(error), this.maxOutputBytes);
                    }
                }
                finish(null, "TIMEOUT", true);
            }, options.timeoutMs);
        }
        return {
            done,
            kill: () => {
                try {
                    child.kill();
                }
                catch (error) {
                    const code = error.code;
                    if (code !== "ENOENT" && code !== "ESRCH")
                        throw error;
                }
            },
        };
    }
    runShort(command, args = [], options = {}) {
        return this.run(command, args, options).done;
    }
}
exports.CoreProcessRunner = CoreProcessRunner;


/***/ },

/***/ "./src/main.ts"
/*!*********************!*\
  !*** ./src/main.ts ***!
  \*********************/
(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.initDesktopApplication = initDesktopApplication;
const path = __importStar(__webpack_require__(/*! node:path */ "node:path"));
const fs = __importStar(__webpack_require__(/*! node:fs */ "node:fs"));
const electron_1 = __webpack_require__(/*! electron */ "electron");
const controller_1 = __webpack_require__(/*! ./controller */ "./src/controller.ts");
const paths_1 = __webpack_require__(/*! ./paths */ "./src/paths.ts");
let mainWindow = null;
let tray = null;
let controller = null;
let quitting = false;
let trayNoticeShown = false;
let detachState = null;
let detachLog = null;
let detachNotification = null;
const TRAY_ICON_DATA = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIzMiIgaGVpZ2h0PSIzMiIgdmlld0JveD0iMCAwIDMyIDMyIj48cmVjdCB3aWR0aD0iMzIiIGhlaWdodD0iMzIiIHJ4PSI3IiBmaWxsPSIjNGY4Y2ZmIi8+PHBhdGggZD0iTTggMTBoMTZ2M0g4em0wIDVoMTZ2M0g4em0wIDVoMTB2M0g4eiIgZmlsbD0iI2ZmZiIvPjwvc3ZnPg==";
function dialogParent() {
    if (!mainWindow)
        throw new Error("The desktop window is not ready.");
    return mainWindow;
}
function result(value) { return { ok: true, value }; }
function failure(error) {
    return { ok: false, error: { code: "request-failed", message: error instanceof Error ? error.message : String(error) } };
}
function assertRenderer(event, payload, maxBytes = 1_024 * 1_024) {
    const url = event.senderFrame?.url ?? "";
    let trusted = false;
    try {
        const parsed = new URL(url);
        trusted = (parsed.protocol === "file:" && (parsed.hostname === "" || parsed.hostname === "localhost"))
            || (parsed.protocol === "http:" && parsed.hostname === "localhost");
    }
    catch {
        trusted = false;
    }
    if (!trusted)
        throw new Error("Renderer origin is not trusted.");
    if (payload !== undefined && Buffer.byteLength(JSON.stringify(payload), "utf8") > maxBytes)
        throw new Error("IPC payload is too large.");
}
function payloadObject(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
        throw new Error("IPC payload must be an object.");
    return payload;
}
function assertPayloadKeys(payload, allowed) {
    const fields = new Set(allowed);
    for (const key of Object.keys(payload))
        if (!fields.has(key))
            throw new Error(`IPC payload contains unsupported field '${key}'.`);
}
function assertNoPayload(payload) {
    if (payload !== undefined)
        throw new Error("This IPC operation does not accept a payload.");
}
function stringField(payload, field) {
    if (typeof payload[field] !== "string" || !payload[field])
        throw new Error(`${field} is required.`);
    return payload[field];
}
function optionalStringField(payload, field) {
    if (payload[field] === undefined)
        return undefined;
    if (typeof payload[field] !== "string" || !payload[field])
        throw new Error(`${field} must be a non-empty string when provided.`);
    return payload[field];
}
function getController() {
    if (!controller)
        throw new Error("Desktop controller is not initialized.");
    return controller;
}
function registerIpc() {
    const handle = (channel, callback) => {
        electron_1.ipcMain.handle(channel, async (event, payload) => {
            try {
                assertRenderer(event, payload);
                return result(await callback(payload));
            }
            catch (error) {
                return failure(error);
            }
        });
    };
    handle("desktop:getStartupStatus", (raw) => { assertNoPayload(raw); return getController().getStartupStatus(); });
    handle("desktop:openProfileFolder", (raw) => {
        const payload = payloadObject(raw);
        assertPayloadKeys(payload, ["kind"]);
        if (payload.kind !== "config" && payload.kind !== "data")
            throw new Error("kind must be config or data.");
        return getController().openProfileFolder(payload.kind);
    });
    handle("desktop:getSnapshot", async (raw) => {
        if (raw === undefined)
            return getController().getSnapshot();
        const payload = payloadObject(raw);
        assertPayloadKeys(payload, ["sessionId"]);
        return getController().getSnapshot(optionalStringField(payload, "sessionId"));
    });
    handle("desktop:getSessionBundle", (raw) => { const payload = payloadObject(raw); assertPayloadKeys(payload, ["sessionId"]); return getController().getSessionBundle(stringField(payload, "sessionId")); });
    handle("desktop:getSettings", (raw) => { assertNoPayload(raw); return getController().getSettings(); });
    handle("desktop:chooseProjectDirectory", async (raw) => {
        assertNoPayload(raw);
        const chosen = await electron_1.dialog.showOpenDialog(dialogParent(), { properties: ["openDirectory", "createDirectory"] });
        return chosen.canceled ? null : (chosen.filePaths[0] ?? null);
    });
    handle("desktop:chooseProviderBinary", async (raw) => {
        assertNoPayload(raw);
        const chosen = await electron_1.dialog.showOpenDialog(dialogParent(), { properties: ["openFile"], filters: [{ name: "Executables", extensions: ["exe", "cmd", "bat", "com"] }] });
        return chosen.canceled ? null : (chosen.filePaths[0] ?? null);
    });
    handle("desktop:startSession", (raw) => {
        const payload = payloadObject(raw);
        assertPayloadKeys(payload, ["goal", "projectPath", "accessMode", "sessionId"]);
        if (payload.accessMode !== undefined && payload.accessMode !== "ask" && payload.accessMode !== "full_access")
            throw new Error("accessMode must be ask or full_access.");
        const accessMode = payload.accessMode === "full_access" ? "full_access" : "ask";
        if (accessMode === "full_access") {
            return electron_1.dialog.showMessageBox(dialogParent(), { type: "warning", buttons: ["Enable Full Access", "Cancel"], defaultId: 1, cancelId: 1, title: "Enable Full Access", message: "Allow the provider to modify the selected project?" }).then((confirmation) => {
                if (confirmation.response !== 0)
                    throw new Error("Full Access was not enabled.");
                return getController().startSession({ goal: stringField(payload, "goal"), projectPath: stringField(payload, "projectPath"), accessMode, sessionId: optionalStringField(payload, "sessionId") });
            });
        }
        return getController().startSession({
            goal: stringField(payload, "goal"),
            projectPath: stringField(payload, "projectPath"),
            accessMode,
            sessionId: optionalStringField(payload, "sessionId"),
        });
    });
    handle("desktop:resumeSession", (raw) => { const payload = payloadObject(raw); assertPayloadKeys(payload, ["sessionId"]); return getController().resumeSession(stringField(payload, "sessionId")); });
    handle("desktop:stopSession", async (raw) => {
        const payload = payloadObject(raw);
        assertPayloadKeys(payload, ["sessionId"]);
        const sessionId = stringField(payload, "sessionId");
        const confirmation = await electron_1.dialog.showMessageBox(dialogParent(), {
            type: "warning",
            buttons: ["Stop session", "Cancel"],
            defaultId: 1,
            cancelId: 1,
            title: "Stop session",
            message: "Stop this active session?",
            detail: "The session can be resumed later if its provider and state remain available.",
        });
        if (confirmation.response !== 0)
            throw new Error("Stop cancelled.");
        return getController().stopSession(sessionId);
    });
    handle("desktop:interruptSession", (raw) => { const payload = payloadObject(raw); assertPayloadKeys(payload, ["sessionId", "message"]); return getController().interruptSession(stringField(payload, "sessionId"), stringField(payload, "message")); });
    handle("desktop:deleteSession", async (raw) => {
        const payload = payloadObject(raw);
        assertPayloadKeys(payload, ["sessionId"]);
        const id = stringField(payload, "sessionId");
        const confirmation = await electron_1.dialog.showMessageBox(dialogParent(), { type: "warning", buttons: ["Delete", "Cancel"], defaultId: 1, cancelId: 1, title: "Delete session", message: "Delete this session and its logs?", detail: "Session data is removed after a recoverable tombstone rename." });
        if (confirmation.response !== 0)
            throw new Error("Deletion cancelled.");
        return getController().deleteSession(id);
    });
    handle("desktop:resolveAccessRequest", async (raw) => {
        const payload = payloadObject(raw);
        assertPayloadKeys(payload, ["sessionId", "approved"]);
        if (typeof payload.approved !== "boolean")
            throw new Error("approved must be a boolean.");
        const approved = payload.approved === true;
        if (approved) {
            const confirmation = await electron_1.dialog.showMessageBox(dialogParent(), { type: "warning", buttons: ["Allow", "Cancel"], defaultId: 1, cancelId: 1, title: "Provider access request", message: "Allow this provider attempt to access the project?" });
            if (confirmation.response !== 0)
                return getController().resolveAccessRequest(stringField(payload, "sessionId"), false);
        }
        return getController().resolveAccessRequest(stringField(payload, "sessionId"), approved);
    });
    handle("desktop:setAccessMode", async (raw) => {
        const payload = payloadObject(raw);
        assertPayloadKeys(payload, ["sessionId", "mode"]);
        if (payload.mode !== "ask" && payload.mode !== "full_access")
            throw new Error("mode must be ask or full_access.");
        const mode = payload.mode === "full_access" ? "full_access" : "ask";
        if (mode === "full_access") {
            const confirmation = await electron_1.dialog.showMessageBox(dialogParent(), { type: "warning", buttons: ["Enable Full Access", "Cancel"], defaultId: 1, cancelId: 1, title: "Enable Full Access", message: "Allow the provider to modify the selected project?" });
            if (confirmation.response !== 0)
                throw new Error("Full Access was not enabled.");
        }
        return getController().setAccessMode(stringField(payload, "sessionId"), mode);
    });
    handle("desktop:selectPlanChoice", (raw) => { const payload = payloadObject(raw); assertPayloadKeys(payload, ["sessionId", "choiceId"]); return getController().selectPlanChoice(stringField(payload, "sessionId"), stringField(payload, "choiceId")); });
    handle("desktop:approvePlan", (raw) => { const payload = payloadObject(raw); assertPayloadKeys(payload, ["sessionId", "choiceId"]); return getController().approvePlan(stringField(payload, "sessionId"), optionalStringField(payload, "choiceId")); });
    handle("desktop:revisePlan", (raw) => { const payload = payloadObject(raw); assertPayloadKeys(payload, ["sessionId", "message"]); return getController().revisePlan(stringField(payload, "sessionId"), stringField(payload, "message")); });
    handle("desktop:approveVerification", (raw) => { const payload = payloadObject(raw); assertPayloadKeys(payload, ["sessionId", "requestId", "candidateHash"]); return getController().approveVerification(stringField(payload, "sessionId"), stringField(payload, "requestId"), stringField(payload, "candidateHash")); });
    handle("desktop:rejectVerification", (raw) => { const payload = payloadObject(raw); assertPayloadKeys(payload, ["sessionId", "requestId", "candidateHash", "message"]); return getController().rejectVerification(stringField(payload, "sessionId"), stringField(payload, "requestId"), stringField(payload, "candidateHash"), stringField(payload, "message")); });
    handle("desktop:saveSettings", (raw) => { const payload = payloadObject(raw); assertPayloadKeys(payload, ["settings", "secrets"]); return getController().saveSettings(payload.settings, payload.secrets); });
    handle("desktop:discoverModels", (raw) => { assertNoPayload(raw); return getController().discoverModels(); });
    handle("desktop:revealSessionFolder", (raw) => { const payload = payloadObject(raw); assertPayloadKeys(payload, ["sessionId"]); return getController().revealSessionFolder(stringField(payload, "sessionId")); });
    handle("desktop:openExternal", async (raw) => {
        const payload = payloadObject(raw);
        assertPayloadKeys(payload, ["url"]);
        const url = stringField(payload, "url");
        if (!/^https?:\/\//iu.test(url))
            throw new Error("Only HTTP(S) links can be opened.");
        const confirmation = await electron_1.dialog.showMessageBox(dialogParent(), { type: "question", buttons: ["Open", "Cancel"], defaultId: 1, cancelId: 1, title: "Open external link", message: url });
        if (confirmation.response !== 0)
            throw new Error("Opening the link was cancelled.");
        await electron_1.shell.openExternal(url);
    });
    handle("desktop:requestQuit", async (raw) => {
        assertNoPayload(raw);
        const confirmation = await electron_1.dialog.showMessageBox(dialogParent(), { type: "warning", buttons: ["Stop & Quit", "Cancel"], defaultId: 1, cancelId: 1, title: "Quit Agent Loop Orchestrator", message: "Stop all active sessions and quit?" });
        if (confirmation.response !== 0)
            throw new Error("Quit cancelled.");
        const released = await getController().release();
        if (released.failures.length > 0)
            throw new Error(`Quit cancelled: ${released.failures.map((entry) => `${entry.resource}${entry.resourceId ? `(${entry.resourceId})` : ""}: ${entry.message}`).join("; ")}`);
        quitting = true;
        electron_1.app.quit();
        return released;
    });
}
function refreshTray() {
    if (!tray || !controller)
        return;
    void controller.getSnapshot().then((snapshot) => {
        const active = snapshot.sessionIndex.activeSessionIds.length;
        tray?.setContextMenu(electron_1.Menu.buildFromTemplate([
            { label: "Open", click: () => { mainWindow?.show(); mainWindow?.focus(); } },
            { label: `${active} active session${active === 1 ? "" : "s"}`, enabled: false },
            { type: "separator" },
            { label: "Quit", click: () => { void mainWindow?.webContents.executeJavaScript("window.desktopBridge.requestQuit()", true); } },
        ]));
    }).catch((error) => {
        console.error(`[desktop-tray] ${error instanceof Error ? error.message : String(error)}`);
    });
}
function createWindow() {
    mainWindow = new electron_1.BrowserWindow({
        width: 1440,
        height: 920,
        minWidth: 960,
        minHeight: 640,
        show: false,
        webPreferences: {
            preload: electron_1.app.isPackaged
                ? path.join(process.resourcesPath, "renderer", "main_window", "preload.js")
                : typeof require('path').resolve(__dirname, '../renderer', 'main_window', 'preload.js') === "string"
                    ? require('path').resolve(__dirname, '../renderer', 'main_window', 'preload.js')
                    : path.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            webSecurity: true,
        },
    });
    // Forge's renderer entry is a file URL during development.  In a packaged
    // ASAR, loadFile keeps the path in the native Windows form so Electron's
    // ASAR resolver can address the renderer entry even when the archive header
    // uses platform separators.
    const rendererEntry = !electron_1.app.isPackaged && typeof `file://${require('path').resolve(__dirname, '..', 'renderer', 'main_window', 'index.html')}` === "string"
        ? `file://${require('path').resolve(__dirname, '..', 'renderer', 'main_window', 'index.html')}`
        : null;
    const smokeNonce = electron_1.app.isPackaged && /^[0-9a-f]{16,128}$/iu.test(process.env.AGENT_LOOP_PACKAGED_SMOKE_NONCE ?? "")
        ? process.env.AGENT_LOOP_PACKAGED_SMOKE_NONCE
        : null;
    let rendererLoaded = false;
    let windowReady = false;
    let markerWritten = false;
    const writeSmokeMarker = () => {
        if (!smokeNonce || markerWritten || !rendererLoaded || !windowReady)
            return;
        const markerPath = path.join(electron_1.app.getPath("temp"), `agent-loop-orchestrator-ready-${smokeNonce}.json`);
        try {
            fs.writeFileSync(markerPath, `${JSON.stringify({ nonce: smokeNonce, pid: process.pid, version: electron_1.app.getVersion(), startupReady: controller?.getStartupStatus().ready === true })}\n`, { encoding: "utf8", flag: "wx" });
            markerWritten = true;
        }
        catch (error) {
            console.error(`[desktop-smoke] unable to write readiness marker: ${error instanceof Error ? error.message : String(error)}`);
        }
    };
    const packagedRenderer = path.join(process.resourcesPath, "renderer", "main_window", "index.html");
    const developmentRenderer = path.join(__dirname, "..", "renderer", "index.html");
    const load = rendererEntry
        ? mainWindow.loadURL(rendererEntry)
        : mainWindow.loadFile(electron_1.app.isPackaged ? packagedRenderer : developmentRenderer);
    load.catch((error) => electron_1.dialog.showErrorBox("Agent Loop Orchestrator", String(error)));
    mainWindow.webContents.once("did-finish-load", () => { rendererLoaded = true; writeSmokeMarker(); });
    mainWindow.webContents.once("did-fail-load", (_event, errorCode, errorDescription) => {
        console.error(`[desktop-bootstrap] renderer load failed (${errorCode}): ${errorDescription}`);
    });
    mainWindow.once("ready-to-show", () => { windowReady = true; mainWindow?.show(); writeSmokeMarker(); });
    mainWindow.on("close", (event) => {
        if (quitting)
            return;
        event.preventDefault();
        mainWindow?.hide();
        if (!trayNoticeShown) {
            trayNoticeShown = true;
            void electron_1.dialog.showMessageBox({ type: "info", buttons: ["OK"], title: "Agent Loop Orchestrator", message: "The window was hidden to the system tray. Active sessions continue running." });
        }
    });
    mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
    mainWindow.webContents.on("will-redirect", (event) => event.preventDefault());
    mainWindow.webContents.on("will-attach-webview", (event) => event.preventDefault());
    mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    // The renderer never needs arbitrary browser permissions or file downloads.
    // Keep these denied even if a future dependency attempts to request them.
    const webSession = mainWindow.webContents.session;
    webSession.setPermissionCheckHandler(() => false);
    webSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    webSession.on("will-download", (event) => event.preventDefault());
    // Windows sends these window lifecycle events for shutdown/logoff, where
    // app.before-quit is intentionally skipped. Pause the shutdown long enough
    // for a best-effort control request; lease/fencing recovery handles crashes.
    mainWindow.on("query-session-end", () => {
        if (quitting || !controller)
            return;
        // Do not prevent the Windows shutdown/logoff from completing. Mark the
        // process as quitting immediately so before-quit cannot turn this best-
        // effort cleanup into a second blocking confirmation. Any remaining
        // lease/process is reconciled by fencing recovery on the next start.
        quitting = true;
        void controller.release().then((released) => {
            if (released.failures.length > 0) {
                console.error(`[desktop-session-end] ${released.failures.length} resource(s) could not be released before Windows ended the session.`);
            }
        }).catch((error) => {
            console.error(`[desktop-session-end] release failed during Windows shutdown/logoff: ${error instanceof Error ? error.message : String(error)}`);
        });
    });
    mainWindow.on("session-end", () => {
        if (!quitting && controller)
            void controller.release().catch((error) => {
                console.error(`[desktop-session-end] ${error instanceof Error ? error.message : String(error)}`);
            });
    });
}
async function initDesktopApplication() {
    // Electron's default user-data directory is the generic `Electron` folder;
    // isolate this app so another Electron product cannot steal our instance
    // lock or profile during development and packaged execution.
    const smokeOverride = electron_1.app.isPackaged && /^[0-9a-f]{16,128}$/iu.test(process.env.AGENT_LOOP_PACKAGED_SMOKE_NONCE ?? "");
    const allowRootOverrides = !electron_1.app.isPackaged || smokeOverride;
    const configuredAppData = allowRootOverrides && process.env.AGENT_LOOP_APP_DATA_ROOT
        ? path.resolve(process.env.AGENT_LOOP_APP_DATA_ROOT)
        : electron_1.app.getPath("appData");
    electron_1.app.setPath("userData", path.join(configuredAppData, paths_1.PRODUCT_FOLDER, "user-data"));
    if (!electron_1.app.requestSingleInstanceLock()) {
        electron_1.app.quit();
        return;
    }
    electron_1.app.on("second-instance", () => { mainWindow?.show(); mainWindow?.focus(); });
    await electron_1.app.whenReady();
    const localAppData = allowRootOverrides && process.env.AGENT_LOOP_LOCAL_DATA_ROOT
        ? path.resolve(process.env.AGENT_LOOP_LOCAL_DATA_ROOT)
        : process.env.LOCALAPPDATA ?? electron_1.app.getPath("appData");
    const developmentAppRoot = !electron_1.app.isPackaged && process.env.AGENT_LOOP_APP_ROOT
        ? process.env.AGENT_LOOP_APP_ROOT
        : electron_1.app.getAppPath();
    const roots = (0, paths_1.resolveDesktopRoots)(developmentAppRoot, configuredAppData, localAppData);
    controller = new controller_1.DesktopController(roots);
    let initializationError = null;
    try {
        await controller.init();
    }
    catch (error) {
        // Keep the operator console available so the renderer can show the exact
        // current-contract failure and expose read-only profile-folder actions.
        initializationError = error instanceof Error ? error : new Error(String(error));
    }
    registerIpc();
    createWindow();
    // Register shutdown handling before the failed-initialization early return
    // so the validation-error screen can still be closed cleanly.
    electron_1.app.on("before-quit", (event) => {
        if (quitting || !controller)
            return;
        event.preventDefault();
        void controller.release().then((released) => {
            if (released.failures.length > 0) {
                const details = released.failures.map((entry) => `${entry.resource}${entry.resourceId ? `(${entry.resourceId})` : ""}: ${entry.message}`).join("; ");
                electron_1.dialog.showErrorBox("Quit cancelled", `Some resources could not be released. Repair them and try again.\n\n${details}`);
                return;
            }
            quitting = true;
            electron_1.app.quit();
        }).catch((error) => {
            electron_1.dialog.showErrorBox("Quit cancelled", error instanceof Error ? error.message : String(error));
        });
    });
    electron_1.app.on("window-all-closed", () => undefined);
    if (initializationError) {
        // Renderer bootstrap reads getStartupStatus and presents the read-only
        // validation error. No session listeners or tray are attached because
        // the core has not passed its version/manifest checks.
        return;
    }
    detachState = controller.on("state", (snapshot) => { mainWindow?.webContents.send("desktop:state-invalidated", snapshot); refreshTray(); });
    detachLog = controller.on("log", (event) => mainWindow?.webContents.send("desktop:log", event));
    detachNotification = controller.on("notification", (event) => mainWindow?.webContents.send("desktop:notification", event));
    tray = new electron_1.Tray(electron_1.nativeImage.createFromDataURL(TRAY_ICON_DATA));
    tray.setToolTip("Agent Loop Orchestrator");
    tray.on("click", () => { mainWindow?.show(); mainWindow?.focus(); });
    refreshTray();
    // Recover stale sessions only after the bridge listeners and window exist so
    // provider-missing/recovery notifications are visible to the operator.
    void controller.recoverPersistedSessions();
}
void initDesktopApplication().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[desktop-bootstrap] ${message}`);
    if (process.env.AGENT_LOOP_E2E === "1") {
        electron_1.app.exit(1);
        return;
    }
    electron_1.dialog.showErrorBox("Agent Loop Orchestrator failed to start", message);
    electron_1.app.quit();
});
process.once("exit", () => { detachState?.(); detachLog?.(); detachNotification?.(); tray?.destroy(); });


/***/ },

/***/ "./src/paths.ts"
/*!**********************!*\
  !*** ./src/paths.ts ***!
  \**********************/
(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.PRODUCT_FOLDER = void 0;
exports.resolveDesktopRoots = resolveDesktopRoots;
exports.canonicalPath = canonicalPath;
exports.validateProjectPath = validateProjectPath;
exports.initDesktopRoots = initDesktopRoots;
const path = __importStar(__webpack_require__(/*! node:path */ "node:path"));
const fsp = __importStar(__webpack_require__(/*! node:fs/promises */ "node:fs/promises"));
exports.PRODUCT_FOLDER = "AgentLoopOrchestrator";
function resolveDesktopRoots(appPath, appData, localAppData) {
    return {
        codeRoot: path.resolve(appPath, "core"),
        configRoot: path.resolve(appData, exports.PRODUCT_FOLDER),
        dataRoot: path.resolve(localAppData, exports.PRODUCT_FOLDER),
    };
}
function isUncOrDevicePath(value) {
    const normalized = value.replace(/\//gu, "\\");
    return normalized.startsWith("\\\\");
}
function containsPath(parent, candidate) {
    const relative = path.relative(parent, candidate);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
function overlapsPath(left, right) {
    return containsPath(left, right) || containsPath(right, left);
}
async function canonicalPath(value) {
    const absolute = path.resolve(value);
    try {
        return await fsp.realpath(absolute);
    }
    catch (error) {
        if (error.code === "ENOENT")
            return absolute;
        throw error;
    }
}
/** Project roots must be local and separate from application-owned data. */
async function validateProjectPath(projectPath, roots) {
    if (typeof projectPath !== "string" || !projectPath.trim())
        throw new Error("A project directory is required.");
    const candidate = await canonicalPath(projectPath);
    if (isUncOrDevicePath(candidate))
        throw new Error("UNC and device paths are not supported.");
    const [configRoot, dataRoot] = await Promise.all([canonicalPath(roots.configRoot), canonicalPath(roots.dataRoot)]);
    if (overlapsPath(configRoot, candidate) || overlapsPath(dataRoot, candidate)) {
        throw new Error("The project directory cannot be inside Agent Loop configuration or data roots.");
    }
    let stat;
    try {
        stat = await fsp.stat(candidate);
    }
    catch (error) {
        if (error.code === "ENOENT")
            throw new Error("The selected project directory does not exist.");
        throw error;
    }
    if (!stat.isDirectory())
        throw new Error("The selected project path is not a directory.");
    return candidate;
}
async function initDesktopRoots(roots) {
    for (const [label, root] of [["configRoot", roots.configRoot], ["dataRoot", roots.dataRoot]]) {
        if (typeof root !== "string" || !root.trim() || isUncOrDevicePath(root)) {
            throw new Error(`${label} must be a local filesystem path.`);
        }
    }
    const configRoot = path.resolve(roots.configRoot);
    const dataRoot = path.resolve(roots.dataRoot);
    if (overlapsPath(configRoot, dataRoot)) {
        throw new Error("Configuration and data roots must be separate and non-overlapping.");
    }
    const codeRoot = path.resolve(roots.codeRoot);
    if (overlapsPath(codeRoot, configRoot) || overlapsPath(codeRoot, dataRoot)) {
        throw new Error("Packaged code root must be separate from configuration and data roots.");
    }
    await Promise.all([
        fsp.mkdir(configRoot, { recursive: true }),
        fsp.mkdir(dataRoot, { recursive: true }),
    ]);
    for (const [label, root] of [["configRoot", configRoot], ["dataRoot", dataRoot]]) {
        const stat = await fsp.stat(root);
        if (!stat.isDirectory())
            throw new Error(`${label} is not a directory: ${root}`);
    }
    // Resolve all three roots after creation.  The packaged code tree is
    // normally inside an immutable ASAR, but development launchers and test
    // harnesses can provide it through a junction/symlink; lexical path checks
    // alone would allow that tree to alias the user-owned config/data roots.
    const [canonicalCode, canonicalConfig, canonicalData] = await Promise.all([
        canonicalPath(codeRoot),
        fsp.realpath(configRoot),
        fsp.realpath(dataRoot),
    ]);
    if (overlapsPath(canonicalCode, canonicalConfig) || overlapsPath(canonicalCode, canonicalData)) {
        throw new Error("Packaged code root resolves to a configuration or data root.");
    }
    if (overlapsPath(canonicalConfig, canonicalData)) {
        throw new Error("Configuration and data roots resolve to overlapping locations.");
    }
}


/***/ },

/***/ "./src/secret-store.ts"
/*!*****************************!*\
  !*** ./src/secret-store.ts ***!
  \*****************************/
(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.SecretStore = void 0;
const path = __importStar(__webpack_require__(/*! node:path */ "node:path"));
const fsp = __importStar(__webpack_require__(/*! node:fs/promises */ "node:fs/promises"));
const node_crypto_1 = __webpack_require__(/*! node:crypto */ "node:crypto");
const electron_1 = __webpack_require__(/*! electron */ "electron");
function assertKey(key) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(key))
        throw new Error("Invalid secret key.");
}
function validateLockRecord(value, filePath) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error(`Secret lock owner record is invalid: ${filePath}`);
    const record = value;
    if (typeof record.ownerId !== "string" || !record.ownerId ||
        !Number.isSafeInteger(record.ownerPid) || Number(record.ownerPid) <= 0 ||
        typeof record.createdAt !== "string" || !Number.isFinite(Date.parse(record.createdAt)))
        throw new Error(`Secret lock owner record is invalid: ${filePath}`);
    return record;
}
class SecretStore {
    filePath;
    lockPath;
    constructor(configRoot) {
        this.filePath = path.join(configRoot, "secrets.v1.json");
        this.lockPath = `${this.filePath}.lock`;
    }
    async withLock(operation) {
        const deadline = Date.now() + 5_000;
        const ownerId = `secret-${process.pid}-${(0, node_crypto_1.randomBytes)(8).toString("hex")}`;
        const parentStat = await fsp.stat(path.dirname(this.lockPath));
        if (!parentStat.isDirectory())
            throw new Error(`Secret store parent is not a directory: ${path.dirname(this.lockPath)}`);
        let handle = null;
        while (!handle) {
            let lockCreated = false;
            try {
                handle = await fsp.open(this.lockPath, "wx");
                lockCreated = true;
                await handle.writeFile(JSON.stringify({ ownerId, ownerPid: process.pid, createdAt: new Date().toISOString() }), "utf8");
            }
            catch (error) {
                const code = error.code;
                if (handle) {
                    let closeError;
                    try {
                        await handle.close();
                    }
                    catch (releaseError) {
                        closeError = releaseError;
                    }
                    finally {
                        handle = null;
                    }
                    let unlinkError;
                    try {
                        await fsp.unlink(this.lockPath);
                    }
                    catch (releaseError) {
                        const releaseCode = releaseError.code;
                        if (releaseCode !== "ENOENT")
                            unlinkError = releaseError;
                    }
                    if (closeError !== undefined || unlinkError !== undefined) {
                        throw new AggregateError([error, ...[closeError, unlinkError].filter((entry) => entry !== undefined)], `Secret lock initialization failed: ${this.lockPath}`);
                    }
                }
                if (lockCreated) {
                    try {
                        await fsp.rm(this.lockPath, { force: true });
                    }
                    catch (releaseError) {
                        throw new AggregateError([error, releaseError], `Secret lock cleanup failed: ${this.lockPath}`);
                    }
                }
                if (code !== "EEXIST")
                    throw error;
                if (Date.now() >= deadline)
                    throw new Error("Secret store is locked.");
                try {
                    const record = validateLockRecord(JSON.parse(await fsp.readFile(this.lockPath, "utf8")), this.lockPath);
                    const ownerPid = record.ownerPid;
                    const createdAt = Date.parse(record.createdAt);
                    let alive = ownerPid === process.pid;
                    if (ownerPid && ownerPid !== process.pid) {
                        try {
                            process.kill(ownerPid, 0);
                            alive = true;
                        }
                        catch (livenessError) {
                            const livenessCode = livenessError.code;
                            if (livenessCode === "ESRCH")
                                alive = false;
                            else if (livenessCode === "EPERM" || livenessCode === "EACCES")
                                alive = true;
                            else
                                throw livenessError;
                        }
                    }
                    if (Date.now() - createdAt > 30_000 && !alive) {
                        try {
                            await fsp.unlink(this.lockPath);
                        }
                        catch (releaseError) {
                            const releaseCode = releaseError.code;
                            if (releaseCode !== "ENOENT")
                                throw releaseError;
                        }
                    }
                }
                catch (inspectError) {
                    const inspectCode = inspectError.code;
                    if (inspectCode !== "ENOENT")
                        throw inspectError;
                }
                await new Promise((resolve) => setTimeout(resolve, 40));
            }
        }
        let value;
        let operationError;
        try {
            value = await operation();
        }
        catch (error) {
            operationError = error;
        }
        const releaseFailures = [];
        try {
            await handle.close();
        }
        catch (error) {
            releaseFailures.push(error);
        }
        try {
            await fsp.rm(this.lockPath);
        }
        catch (error) {
            releaseFailures.push(error);
        }
        if (operationError !== undefined && releaseFailures.length > 0)
            throw new AggregateError([operationError, ...releaseFailures], `Secret operation and lock release failed: ${this.lockPath}`);
        if (operationError !== undefined)
            throw operationError;
        if (releaseFailures.length > 0)
            throw new AggregateError(releaseFailures, `Secret lock release failed: ${this.lockPath}`);
        return value;
    }
    async readDocument() {
        try {
            const parsed = JSON.parse(await fsp.readFile(this.filePath, "utf8"));
            if (parsed.version !== 1 || !parsed.secrets || typeof parsed.secrets !== "object" || Array.isArray(parsed.secrets))
                throw new Error("Secret store is corrupt.");
            for (const [key, value] of Object.entries(parsed.secrets)) {
                assertKey(key);
                if (typeof value !== "string" || !/^[A-Za-z0-9+/]+=*$/u.test(value))
                    throw new Error("Secret store ciphertext is corrupt.");
            }
            return { version: 1, secrets: { ...parsed.secrets } };
        }
        catch (error) {
            if (error.code === "ENOENT")
                return { version: 1, secrets: {} };
            throw new Error(`Secret store cannot be read safely: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async getAll(requiredKeys = []) {
        if (!electron_1.safeStorage.isEncryptionAvailable())
            throw new Error("Windows secure storage is unavailable; refusing to use plaintext secrets.");
        let document;
        try {
            document = await this.readDocument();
        }
        catch (error) {
            throw error;
        }
        for (const key of requiredKeys) {
            assertKey(key);
            if (!Object.prototype.hasOwnProperty.call(document.secrets, key)) {
                throw new Error(`Secret '${key}' is missing; re-enter it in Agent Loop tool settings.`);
            }
        }
        const values = {};
        for (const [key, encoded] of Object.entries(document.secrets)) {
            try {
                values[key] = electron_1.safeStorage.decryptString(Buffer.from(encoded, "base64"));
            }
            catch {
                throw new Error("Secret store decryption failed; re-enter the affected secret.");
            }
        }
        return values;
    }
    async set(values) {
        if (!electron_1.safeStorage.isEncryptionAvailable())
            throw new Error("Windows secure storage is unavailable; refusing to store plaintext secrets.");
        await this.withLock(async () => {
            const document = await this.readDocument();
            for (const [key, value] of Object.entries(values)) {
                assertKey(key);
                if (typeof value !== "string")
                    throw new Error(`Secret ${key} must be a string.`);
                document.secrets[key] = electron_1.safeStorage.encryptString(value).toString("base64");
            }
            const temporary = `${this.filePath}.tmp.${process.pid}.${Date.now()}`;
            try {
                await fsp.writeFile(temporary, JSON.stringify(document, null, 2), "utf8");
                await fsp.rename(temporary, this.filePath);
            }
            catch (error) {
                try {
                    await fsp.rm(temporary, { force: true });
                }
                catch (releaseError) {
                    throw new AggregateError([error, releaseError], `Secret write and temporary-file release failed: ${this.filePath}`);
                }
                throw error;
            }
        });
    }
    async remove(key) {
        assertKey(key);
        if (!electron_1.safeStorage.isEncryptionAvailable())
            throw new Error("Windows secure storage is unavailable; refusing to modify plaintext secrets.");
        await this.withLock(async () => {
            const document = await this.readDocument();
            delete document.secrets[key];
            const temporary = `${this.filePath}.tmp.${process.pid}.${Date.now()}`;
            try {
                await fsp.writeFile(temporary, JSON.stringify(document, null, 2), "utf8");
                await fsp.rename(temporary, this.filePath);
            }
            catch (error) {
                try {
                    await fsp.rm(temporary, { force: true });
                }
                catch (releaseError) {
                    throw new AggregateError([error, releaseError], `Secret removal and temporary-file release failed: ${this.filePath}`);
                }
                throw error;
            }
        });
    }
}
exports.SecretStore = SecretStore;


/***/ },

/***/ "./src/shared.ts"
/*!***********************!*\
  !*** ./src/shared.ts ***!
  \***********************/
(__unused_webpack_module, exports) {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.validateRunProjectionV2 = validateRunProjectionV2;
exports.validateSessionIndexProjectionV4 = validateSessionIndexProjectionV4;
exports.validateProviderDiscoveryResultV2 = validateProviderDiscoveryResultV2;
exports.validateModelDiscoveryPayload = validateModelDiscoveryPayload;
exports.validateDesktopSnapshot = validateDesktopSnapshot;
exports.validateDesktopSettings = validateDesktopSettings;
const PROVIDER_KEYS = new Set(["label", "adapter", "binary", "enabled", "modelCatalog", "interactionWhitelist", "capabilities"]);
const PROVIDER_ADAPTERS = new Set(["opencode", "kilo", "codex", "claude"]);
const PATH_KEYS = new Set(["sessionsRoot", "registryFileName", "sessionsIndexFileName", "variantsConfigFileName", "loopHistoryDirName", "sessionFileNames", "roomFileNames", "roomDirNames", "controlDirName", "ownerLockFileName", "stateLockFileName", "leaseFileName", "registryLockFileName", "attemptLogsDirName", "verificationLogsDirName"]);
const DEFAULT_KEYS = new Set(["cliBinary", "maxCycles", "phaseTimeoutMs", "idleTimeoutMs", "ptyCols", "ptyRows", "transportTimeoutMs", "toolTimeoutMs", "maxAgentAttempts", "retryBackoffMs", "terminationGraceMs", "killTimeoutMs", "heartbeatIntervalMs", "leaseTtlMs", "maxInMemoryOutputBytes"]);
const MCP_KEYS = new Set(["id", "name", "enabled", "type", "command", "args", "url", "environment", "headers", "timeoutMs", "tools", "allowedTools"]);
const SETTINGS_KEYS = new Set(["paths", "providers", "toolAccess", "defaults", "variantDefaults"]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const SAFE_PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
function validateProviderSettings(value, providerId) {
    const provider = recordValue(value, `settings.providers.${providerId}`);
    for (const key of Object.keys(provider)) {
        if (!PROVIDER_KEYS.has(key))
            throw new Error(`settings.providers.${providerId} contains unsupported field '${key}'.`);
    }
    if (typeof provider.label !== "string" || !provider.label.trim())
        throw new Error(`settings.providers.${providerId}.label must be a non-empty string.`);
    if (typeof provider.adapter !== "string" || !PROVIDER_ADAPTERS.has(provider.adapter))
        throw new Error(`settings.providers.${providerId}.adapter is invalid.`);
    if (typeof provider.binary !== "string" || !provider.binary.trim())
        throw new Error(`settings.providers.${providerId}.binary must be a non-empty string.`);
    if (provider.enabled !== undefined && typeof provider.enabled !== "boolean")
        throw new Error(`settings.providers.${providerId}.enabled must be boolean.`);
    const catalog = recordValue(provider.modelCatalog, `settings.providers.${providerId}.modelCatalog`);
    for (const key of Object.keys(catalog)) {
        if (catalog.source === "command" && key !== "source" && key !== "args")
            throw new Error(`settings.providers.${providerId}.modelCatalog contains unsupported field '${key}'.`);
        if (catalog.source === "configured" && key !== "source" && key !== "models")
            throw new Error(`settings.providers.${providerId}.modelCatalog contains unsupported field '${key}'.`);
    }
    if (catalog.source === "command") {
        if (provider.adapter !== "opencode" && provider.adapter !== "kilo")
            throw new Error(`settings.providers.${providerId}.modelCatalog must use configured models for ${provider.adapter}.`);
        if (!Array.isArray(catalog.args) || catalog.args.length === 0 || catalog.args.some((entry) => typeof entry !== "string" || !entry.trim()))
            throw new Error(`settings.providers.${providerId}.modelCatalog.args must be a non-empty string array.`);
    }
    else if (catalog.source === "configured") {
        if (provider.adapter !== "codex" && provider.adapter !== "claude")
            throw new Error(`settings.providers.${providerId}.modelCatalog must use command discovery for ${provider.adapter}.`);
        if (!Array.isArray(catalog.models) || catalog.models.length === 0 || catalog.models.some((entry) => typeof entry !== "string" || !entry.trim()))
            throw new Error(`settings.providers.${providerId}.modelCatalog.models must be a non-empty string array.`);
    }
    else {
        throw new Error(`settings.providers.${providerId}.modelCatalog.source is invalid.`);
    }
    if (provider.interactionWhitelist !== undefined && (!Array.isArray(provider.interactionWhitelist) || provider.interactionWhitelist.some((entry) => typeof entry !== "string")))
        throw new Error(`settings.providers.${providerId}.interactionWhitelist must be an array of strings.`);
    if (provider.capabilities !== undefined)
        recordValue(provider.capabilities, `settings.providers.${providerId}.capabilities`);
    return provider;
}
function validatePathSettings(value) {
    for (const key of Object.keys(value))
        if (!PATH_KEYS.has(key))
            throw new Error(`settings.paths contains unsupported field '${key}'.`);
    for (const key of ["sessionsRoot", "registryFileName", "sessionsIndexFileName", "variantsConfigFileName", "loopHistoryDirName", "controlDirName", "ownerLockFileName", "stateLockFileName", "leaseFileName", "registryLockFileName", "attemptLogsDirName", "verificationLogsDirName"]) {
        if (typeof value[key] !== "string" || !String(value[key]).trim())
            throw new Error(`settings.paths.${key} must be a non-empty string.`);
    }
    for (const key of ["sessionFileNames", "roomFileNames", "roomDirNames"]) {
        const child = recordValue(value[key], `settings.paths.${key}`);
        if (key === "sessionFileNames") {
            const allowed = new Set(["state", "progressNotes", "finalSummary", "plan", "planChoices", "planOverview", "planOptionsDir", "interruptMessage", "stopRequest"]);
            for (const childKey of Object.keys(child))
                if (!allowed.has(childKey))
                    throw new Error(`settings.paths.sessionFileNames contains unsupported field '${childKey}'.`);
            for (const childKey of ["state", "progressNotes", "finalSummary", "plan", "planChoices", "planOverview", "planOptionsDir", "interruptMessage", "stopRequest"])
                if (typeof child[childKey] !== "string" || !String(child[childKey]).trim())
                    throw new Error(`settings.paths.sessionFileNames.${childKey} must be a non-empty string.`);
        }
        if (key === "roomFileNames") {
            const allowed = new Set(["state", "skills", "input", "output"]);
            for (const childKey of Object.keys(child))
                if (!allowed.has(childKey))
                    throw new Error(`settings.paths.roomFileNames contains unsupported field '${childKey}'.`);
            for (const childKey of ["state", "skills", "input", "output"])
                if (typeof child[childKey] !== "string" || !String(child[childKey]).trim())
                    throw new Error(`settings.paths.roomFileNames.${childKey} must be a non-empty string.`);
        }
        for (const childValue of Object.values(child))
            if (typeof childValue !== "string" || !childValue.trim())
                throw new Error(`settings.paths.${key} values must be non-empty strings.`);
    }
}
function validateToolSettings(value) {
    for (const key of Object.keys(value))
        if (key !== "webSearch" && key !== "mcpServers")
            throw new Error(`settings.toolAccess contains unsupported field '${key}'.`);
    const web = recordValue(value.webSearch, "settings.toolAccess.webSearch");
    for (const key of Object.keys(web))
        if (key !== "enabled" && key !== "mode")
            throw new Error(`settings.toolAccess.webSearch contains unsupported field '${key}'.`);
    if (typeof web.enabled !== "boolean" || (web.mode !== "cached" && web.mode !== "live"))
        throw new Error("settings.toolAccess.webSearch is invalid.");
    if (!Array.isArray(value.mcpServers))
        throw new Error("settings.toolAccess.mcpServers must be an array.");
    const ids = new Set();
    value.mcpServers.forEach((raw, index) => {
        const server = recordValue(raw, `settings.toolAccess.mcpServers[${index}]`);
        for (const key of Object.keys(server))
            if (!MCP_KEYS.has(key))
                throw new Error(`MCP server contains unsupported field '${key}'.`);
        if (typeof server.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(server.id) || ids.has(server.id))
            throw new Error(`settings.toolAccess.mcpServers[${index}].id is invalid.`);
        ids.add(server.id);
        if (typeof server.name !== "string" || !server.name.trim() || typeof server.enabled !== "boolean" || (server.type !== "local" && server.type !== "remote"))
            throw new Error(`settings.toolAccess.mcpServers[${index}] identity is invalid.`);
        if (server.type === "local" && (typeof server.command !== "string" || !server.command.trim()))
            throw new Error(`MCP server ${server.id} needs a command.`);
        if (server.type === "remote" && (typeof server.url !== "string" || !/^https?:\/\//iu.test(server.url)))
            throw new Error(`MCP server ${server.id} needs an http(s) URL.`);
        for (const field of ["environment", "headers"]) {
            if (server[field] === undefined)
                continue;
            const values = recordValue(server[field], `MCP server ${server.id}.${field}`);
            for (const [name, configured] of Object.entries(values)) {
                if (field === "environment" && !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name))
                    throw new Error(`MCP server ${server.id} has an invalid environment name.`);
                if (typeof configured !== "string" || !/^\$\{(?:secret|env):[^}]+\}$/u.test(configured))
                    throw new Error(`MCP server ${server.id} credentials must use references.`);
            }
        }
        if (server.args !== undefined && (!Array.isArray(server.args) || server.args.some((entry) => typeof entry !== "string")))
            throw new Error(`MCP server ${server.id}.args must be an array of strings.`);
        if (server.timeoutMs !== undefined && (!Number.isSafeInteger(server.timeoutMs) || Number(server.timeoutMs) <= 0))
            throw new Error(`MCP server ${server.id}.timeoutMs must be positive.`);
        if (server.tools !== undefined && (!Array.isArray(server.tools) || server.tools.some((tool) => {
            const candidate = tool && typeof tool === "object" && !Array.isArray(tool) ? tool : null;
            if (candidate)
                for (const key of Object.keys(candidate))
                    if (key !== "name" && key !== "sideEffect")
                        return true;
            return !candidate || typeof candidate.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(candidate.name) || !["read_only", "write", "unknown"].includes(String(candidate.sideEffect));
        })))
            throw new Error(`MCP server ${server.id}.tools is invalid.`);
        if (server.allowedTools !== undefined && !Array.isArray(server.tools))
            throw new Error(`MCP server ${server.id} must classify tools before setting allowedTools.`);
        if (server.allowedTools !== undefined && (!Array.isArray(server.allowedTools) || server.allowedTools.some((entry) => typeof entry !== "string")))
            throw new Error(`MCP server ${server.id}.allowedTools is invalid.`);
        if (Array.isArray(server.allowedTools) && Array.isArray(server.tools)) {
            const declared = new Set(server.tools.flatMap((tool) => {
                if (!tool || typeof tool !== "object" || Array.isArray(tool))
                    return [];
                const name = tool.name;
                return typeof name === "string" ? [name] : [];
            }));
            if (server.allowedTools.some((entry) => !declared.has(entry)))
                throw new Error(`MCP server ${server.id}.allowedTools contains an undeclared tool.`);
        }
    });
}
function validateDefaultSettings(value) {
    for (const key of Object.keys(value))
        if (!DEFAULT_KEYS.has(key))
            throw new Error(`settings.defaults contains unsupported field '${key}'.`);
    if (typeof value.cliBinary !== "string" || !value.cliBinary.trim())
        throw new Error("settings.defaults.cliBinary must be a non-empty string.");
    for (const key of ["maxCycles", "phaseTimeoutMs", "idleTimeoutMs", "ptyCols", "ptyRows", "transportTimeoutMs", "toolTimeoutMs", "maxAgentAttempts", "terminationGraceMs", "killTimeoutMs", "heartbeatIntervalMs", "leaseTtlMs", "maxInMemoryOutputBytes"])
        if (!Number.isSafeInteger(value[key]) || Number(value[key]) < 1)
            throw new Error(`settings.defaults.${key} must be a positive integer.`);
    if (!Array.isArray(value.retryBackoffMs) || value.retryBackoffMs.some((entry) => !Number.isSafeInteger(entry) || Number(entry) < 0))
        throw new Error("settings.defaults.retryBackoffMs is invalid.");
    if (Number(value.transportTimeoutMs) > Number(value.phaseTimeoutMs) || Number(value.idleTimeoutMs) > Number(value.phaseTimeoutMs) || Number(value.toolTimeoutMs) > Number(value.phaseTimeoutMs))
        throw new Error("Provider timeouts must not exceed phaseTimeoutMs.");
    if (Number(value.heartbeatIntervalMs) >= Number(value.leaseTtlMs))
        throw new Error("heartbeatIntervalMs must be lower than leaseTtlMs.");
    if (Number(value.terminationGraceMs) > Number(value.killTimeoutMs))
        throw new Error("terminationGraceMs must not exceed killTimeoutMs.");
    if (Number(value.maxInMemoryOutputBytes) < 1024)
        throw new Error("maxInMemoryOutputBytes must be at least 1024 bytes.");
}
function recordValue(value, field) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error(`${field} must be an object.`);
    return value;
}
function stringValue(value, field) {
    if (typeof value !== "string")
        throw new Error(`${field} must be a string.`);
    return value;
}
function nullableString(value, field) {
    if (value !== null && typeof value !== "string")
        throw new Error(`${field} must be a string or null.`);
}
function validateRunProjectionV2(value) {
    const candidate = recordValue(value, "projection");
    if (candidate.projectionSchemaVersion !== 2 || candidate.stateVersion !== 5)
        throw new Error("Desktop projection must use schema 2/state 5.");
    for (const field of ["sessionId", "runId", "definitionHash", "goal", "targetProjectPath", "phase", "currentNodeId", "createdAt", "updatedAt"])
        stringValue(candidate[field], `projection.${field}`);
    if (!SAFE_ID.test(String(candidate.sessionId)) || candidate.sessionId !== candidate.runId)
        throw new Error("projection session identity is invalid.");
    for (const field of ["createdAt", "updatedAt"])
        if (!Number.isFinite(Date.parse(String(candidate[field]))))
            throw new Error(`projection.${field} is invalid.`);
    for (const field of ["revision", "fencingEpoch"]) {
        if (!Number.isSafeInteger(candidate[field]) || Number(candidate[field]) < 0)
            throw new Error(`projection.${field} must be a non-negative integer.`);
    }
    if (!["RUNNING", "WAITING_USER", "PAUSED", "SUCCESS", "FAILED", "STOPPED", "BLOCKED"].includes(String(candidate.status)))
        throw new Error("projection.status is invalid.");
    for (const field of ["statusReason", "currentAgentId", "selectedPlanChoiceId", "interruptBriefing"])
        nullableString(candidate[field], `projection.${field}`);
    if (candidate.accessMode !== "ask" && candidate.accessMode !== "full_access")
        throw new Error("projection.accessMode is invalid.");
    if (typeof candidate.awaitingPlanApproval !== "boolean" || typeof candidate.planApproved !== "boolean")
        throw new Error("projection plan flags are invalid.");
    for (const field of ["pendingInput", "latestEvent"]) {
        if (candidate[field] !== null)
            recordValue(candidate[field], `projection.${field}`);
    }
    const paths = candidate.additionalAllowedPaths;
    if (!Array.isArray(paths) || paths.some((entry) => typeof entry !== "string"))
        throw new Error("projection.additionalAllowedPaths is invalid.");
    for (const field of ["requirements", "requirementEvidence", "events"]) {
        const values = candidate[field];
        if (!Array.isArray(values) || values.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry)))
            throw new Error(`projection.${field} is invalid.`);
    }
    if (candidate.activeActivation !== null) {
        const active = recordValue(candidate.activeActivation, "projection.activeActivation");
        for (const field of ["activationId", "nodeId", "status"])
            stringValue(active[field], `projection.activeActivation.${field}`);
        if (!Number.isSafeInteger(active.workflowStep) || Number(active.workflowStep) < 0 || !Array.isArray(active.attemptIds) || active.attemptIds.some((entry) => typeof entry !== "string") || (active.sideEffect !== "none" && active.sideEffect !== "workspace_mutation"))
            throw new Error("projection.activeActivation is invalid.");
    }
    if (candidate.verification !== undefined) {
        const verification = recordValue(candidate.verification, "projection.verification");
        if (verification.contract !== undefined && verification.contract !== null) {
            const contract = recordValue(verification.contract, "projection.verification.contract");
            if (!Number.isSafeInteger(contract.revision) || Number(contract.revision) < 1 ||
                typeof contract.contractHash !== "string" || !/^[a-f0-9]{64}$/u.test(contract.contractHash) ||
                typeof contract.baselineArtifactId !== "string" || !contract.baselineArtifactId.trim() ||
                typeof contract.baselineFingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(contract.baselineFingerprint)) {
                throw new Error("projection.verification.contract metadata is invalid.");
            }
            if (!Array.isArray(contract.commands) || !Number.isSafeInteger(contract.totalTimeoutMs) || Number(contract.totalTimeoutMs) < 1) {
                throw new Error("projection.verification.contract is invalid.");
            }
            for (const [index, rawCommand] of contract.commands.entries()) {
                const command = recordValue(rawCommand, `projection.verification.contract.commands[${index}]`);
                for (const field of ["id", "label", "executable", "cwd"])
                    stringValue(command[field], `projection.verification.contract.commands[${index}].${field}`);
                if (!Array.isArray(command.args) || command.args.some((arg) => typeof arg !== "string") ||
                    !Number.isSafeInteger(command.timeoutMs) || Number(command.timeoutMs) < 1 ||
                    !Array.isArray(command.requirementIds) || command.requirementIds.some((id) => typeof id !== "string")) {
                    throw new Error(`projection.verification.contract.commands[${index}] is invalid.`);
                }
            }
            for (const field of ["protectedPaths", "testRoots", "allowedNewTestRoots", "generatedOutputPaths"]) {
                if (!Array.isArray(contract[field]) || contract[field].some((entry) => typeof entry !== "string")) {
                    throw new Error(`projection.verification.contract.${field} is invalid.`);
                }
            }
        }
        if (verification.elapsedMs !== undefined &&
            (!Number.isSafeInteger(verification.elapsedMs) || Number(verification.elapsedMs) < 0)) {
            throw new Error("projection.verification.elapsedMs is invalid.");
        }
        if (verification.contractRevision !== null &&
            (!Number.isSafeInteger(verification.contractRevision) || Number(verification.contractRevision) < 0)) {
            throw new Error("projection.verification.contractRevision is invalid.");
        }
        if (verification.contractHash !== null && typeof verification.contractHash !== "string") {
            throw new Error("projection.verification.contractHash is invalid.");
        }
        if (typeof verification.proofValid !== "boolean")
            throw new Error("projection.verification.proofValid is invalid.");
        if (verification.criteriaChanges !== undefined &&
            (!Array.isArray(verification.criteriaChanges) ||
                verification.criteriaChanges.some((entry) => typeof entry !== "string" || !entry.trim()))) {
            throw new Error("projection.verification.criteriaChanges is invalid.");
        }
        if (verification.resultArtifactId !== undefined && verification.resultArtifactId !== null && typeof verification.resultArtifactId !== "string") {
            throw new Error("projection.verification.resultArtifactId is invalid.");
        }
        if (!Array.isArray(verification.commands))
            throw new Error("projection.verification.commands is invalid.");
        verification.commands.forEach((command, commandIndex) => {
            const item = recordValue(command, `projection.verification.commands[${commandIndex}]`);
            stringValue(item.commandId, `projection.verification.commands[${commandIndex}].commandId`);
            stringValue(item.status, `projection.verification.commands[${commandIndex}].status`);
            if (item.executable !== undefined)
                stringValue(item.executable, `projection.verification.commands[${commandIndex}].executable`);
            if (item.args !== undefined && (!Array.isArray(item.args) || item.args.some((arg) => typeof arg !== "string")))
                throw new Error(`projection.verification.commands[${commandIndex}].args is invalid.`);
            if (item.cwd !== undefined)
                stringValue(item.cwd, `projection.verification.commands[${commandIndex}].cwd`);
            if (item.exitCode !== null && !Number.isSafeInteger(item.exitCode))
                throw new Error(`projection.verification.commands[${commandIndex}].exitCode is invalid.`);
            nullableString(item.signal, `projection.verification.commands[${commandIndex}].signal`);
            if (typeof item.timedOut !== "boolean" || (item.processTreeClean !== null && typeof item.processTreeClean !== "boolean"))
                throw new Error(`projection.verification.commands[${commandIndex}] process state is invalid.`);
            stringValue(item.summary, `projection.verification.commands[${commandIndex}].summary`);
            if (item.elapsedMs !== undefined && (!Number.isSafeInteger(item.elapsedMs) || Number(item.elapsedMs) < 0))
                throw new Error(`projection.verification.commands[${commandIndex}].elapsedMs is invalid.`);
            if (item.outputTruncated !== undefined && typeof item.outputTruncated !== "boolean")
                throw new Error(`projection.verification.commands[${commandIndex}].outputTruncated is invalid.`);
        });
    }
    if (!Array.isArray(candidate.planChoices))
        throw new Error("projection.planChoices is invalid.");
    candidate.planChoices.forEach((choice, index) => {
        const item = recordValue(choice, `projection.planChoices[${index}]`);
        for (const field of ["id", "title", "body"])
            stringValue(item[field], `projection.planChoices[${index}].${field}`);
        if (item.verification !== undefined) {
            const verification = recordValue(item.verification, `projection.planChoices[${index}].verification`);
            if (!Array.isArray(verification.commands) || verification.commands.length < 1 || verification.commands.length > 10)
                throw new Error(`projection.planChoices[${index}].verification.commands is invalid.`);
            verification.commands.forEach((command, commandIndex) => {
                const candidate = recordValue(command, `projection.planChoices[${index}].verification.commands[${commandIndex}]`);
                for (const field of ["id", "label"])
                    stringValue(candidate[field], `projection.planChoices[${index}].verification.commands[${commandIndex}].${field}`);
                stringValue(candidate.executable, `projection.planChoices[${index}].verification.commands[${commandIndex}].executable`);
                stringValue(candidate.cwd, `projection.planChoices[${index}].verification.commands[${commandIndex}].cwd`);
                if (!Array.isArray(candidate.args) || !Array.isArray(candidate.requirementIds) || !Number.isSafeInteger(candidate.timeoutMs) || Number(candidate.timeoutMs) < 1)
                    throw new Error(`projection.planChoices[${index}].verification.commands[${commandIndex}] is invalid.`);
                if (candidate.args.some((arg) => typeof arg !== "string"))
                    throw new Error(`projection.planChoices[${index}].verification.commands[${commandIndex}].args is invalid.`);
                if (candidate.requirementIds.some((id) => typeof id !== "string"))
                    throw new Error(`projection.planChoices[${index}].verification.commands[${commandIndex}].requirementIds is invalid.`);
            });
        }
    });
    const budgets = recordValue(candidate.budgets, "projection.budgets");
    for (const field of ["workflowSteps", "cycles"]) {
        const budget = recordValue(budgets[field], `projection.budgets.${field}`);
        for (const numberField of ["consumed", "limit", "remaining"]) {
            if (!Number.isSafeInteger(budget[numberField]) || Number(budget[numberField]) < 0)
                throw new Error(`projection.budgets.${field}.${numberField} is invalid.`);
        }
        if (field === "cycles" && (!Number.isSafeInteger(budget.completed) || Number(budget.completed) < 0))
            throw new Error("projection.budgets.cycles.completed is invalid.");
    }
    const verification = recordValue(candidate.verification, "projection.verification");
    if (verification.contract === undefined || verification.elapsedMs === undefined) {
        throw new Error("Desktop v2 verification projection is missing contract progress fields.");
    }
    const commands = verification.commands;
    if (!Array.isArray(commands))
        throw new Error("projection.verification.commands is invalid.");
    commands.forEach((command, commandIndex) => {
        const item = recordValue(command, `projection.verification.commands[${commandIndex}]`);
        stringValue(item.executable, `projection.verification.commands[${commandIndex}].executable`);
        if (!Array.isArray(item.args) || item.args.some((arg) => typeof arg !== "string"))
            throw new Error(`projection.verification.commands[${commandIndex}].args is invalid.`);
        stringValue(item.cwd, `projection.verification.commands[${commandIndex}].cwd`);
    });
    return value;
}
function validateSessionIndexProjectionV4(value) {
    const index = recordValue(value, "session index");
    if (index.version !== 4 || !Array.isArray(index.activeSessionIds) || !Array.isArray(index.sessionMetas) || !Array.isArray(index.availableModels) || index.manualModelsOverride !== null || (index.modelVariants !== null && (typeof index.modelVariants !== "object" || Array.isArray(index.modelVariants))) || !index.providerCatalog || typeof index.providerCatalog !== "object" || Array.isArray(index.providerCatalog))
        throw new Error("Desktop session index must use the strict version 4 contract.");
    if (index.activeSessionIds.some((entry) => typeof entry !== "string" || !SAFE_ID.test(String(entry))) || new Set(index.activeSessionIds).size !== index.activeSessionIds.length || index.availableModels.some((entry) => typeof entry !== "string" || !String(entry).trim()))
        throw new Error("Desktop session index contains invalid identifiers.");
    if (index.modelsDiscoveredAt !== null && (typeof index.modelsDiscoveredAt !== "string" || !Number.isFinite(Date.parse(index.modelsDiscoveredAt))))
        throw new Error("Desktop session index modelsDiscoveredAt is invalid.");
    if (index.modelsDiscoveredCli !== null && (typeof index.modelsDiscoveredCli !== "string" || !index.modelsDiscoveredCli.trim()))
        throw new Error("Desktop session index modelsDiscoveredCli is invalid.");
    const ids = new Set();
    index.sessionMetas.forEach((meta, indexNumber) => {
        const item = recordValue(meta, `session index sessionMetas[${indexNumber}]`);
        for (const field of ["sessionId", "goal", "targetProjectPath", "createdAt"])
            stringValue(item[field], `sessionMetas[${indexNumber}].${field}`);
        if (!String(item.goal).trim() || !String(item.targetProjectPath).trim() || !Number.isFinite(Date.parse(String(item.createdAt))) || !["RUNNING", "WAITING_USER", "PAUSED", "SUCCESS", "FAILED", "STOPPED", "BLOCKED"].includes(String(item.status)) || ids.has(String(item.sessionId)))
            throw new Error(`Desktop session index sessionMetas[${indexNumber}] is invalid.`);
        ids.add(String(item.sessionId));
    });
    if (index.activeSessionIds.some((entry) => !ids.has(String(entry))))
        throw new Error("Desktop session index active metadata is missing.");
    if (index.modelVariants !== null) {
        for (const [provider, models] of Object.entries(index.modelVariants)) {
            if (!Array.isArray(models) || models.some((entry) => typeof entry !== "string" || !entry.trim()))
                throw new Error(`Desktop session index modelVariants.${provider} is invalid.`);
        }
    }
    for (const [providerId, discovery] of Object.entries(index.providerCatalog)) {
        validateProviderDiscoveryResultV2(discovery);
        if (discovery.providerId !== providerId)
            throw new Error(`Desktop session index providerCatalog key mismatch: ${providerId}.`);
    }
    return value;
}
/** Validate data crossing the packaged core/desktop boundary before rendering. */
function validateProviderDiscoveryResultV2(value) {
    const candidate = recordValue(value, "provider discovery");
    if (candidate.schemaVersion !== 2)
        throw new Error("Provider discovery schema must be version 2.");
    for (const field of ["providerId", "label", "adapter", "binary", "discoveredAt"])
        stringValue(candidate[field], field);
    if (!PROVIDER_ADAPTERS.has(String(candidate.adapter)))
        throw new Error("Provider discovery adapter is invalid.");
    if (!SAFE_ID.test(String(candidate.providerId)) || !String(candidate.label).trim() || !String(candidate.binary).trim())
        throw new Error("Provider discovery identity is invalid.");
    if (typeof candidate.enabled !== "boolean" || typeof candidate.available !== "boolean")
        throw new Error("Provider discovery availability fields must be boolean.");
    if (!Array.isArray(candidate.models) || candidate.models.some((model) => typeof model !== "string" || !model.trim()))
        throw new Error("Provider discovery models must be strings.");
    if (candidate.catalogSource !== "command" && candidate.catalogSource !== "configured")
        throw new Error("Provider discovery catalogSource is invalid.");
    if ((candidate.adapter === "opencode" || candidate.adapter === "kilo") && candidate.catalogSource !== "command")
        throw new Error("OpenCode/Kilo discovery must use a command catalog.");
    if ((candidate.adapter === "codex" || candidate.adapter === "claude") && candidate.catalogSource !== "configured")
        throw new Error("Codex/Claude discovery must use a configured catalog.");
    nullableString(candidate.command, "command");
    if (!Number.isFinite(Date.parse(String(candidate.discoveredAt))))
        throw new Error("discoveredAt is invalid.");
    if (candidate.catalogSource === "command" && candidate.available && typeof candidate.command !== "string")
        throw new Error("Command catalog discovery must include its command.");
    if (candidate.catalogSource === "configured" && candidate.command !== null)
        throw new Error("Configured catalog discovery cannot include a command.");
    if (candidate.catalogSource === "command" && typeof candidate.command === "string" && !candidate.command.trim())
        throw new Error("Provider discovery command must not be empty.");
    if (candidate.error !== null) {
        const error = recordValue(candidate.error, "error");
        stringValue(error.code, "error.code");
        stringValue(error.message, "error.message");
        if (!String(error.code).trim() || !String(error.message).trim())
            throw new Error("Provider discovery error code/message must not be empty.");
    }
    if (candidate.available && candidate.error !== null)
        throw new Error("Available provider discovery cannot contain an error.");
    if (!candidate.available && candidate.error === null)
        throw new Error("Unavailable provider discovery must contain an error.");
    if (candidate.available && candidate.models.length === 0)
        throw new Error("Available provider discovery must contain at least one model.");
    if (!candidate.available && candidate.models.length > 0)
        throw new Error("Unavailable provider discovery cannot contain models.");
    return value;
}
function validateModelDiscoveryPayload(value) {
    const candidate = recordValue(value, "models discovery");
    if (candidate.schemaVersion !== 2)
        throw new Error("Models discovery schema must be version 2.");
    nullableString(candidate.discoveredAt, "discoveredAt");
    if (candidate.discoveredAt !== null && !Number.isFinite(Date.parse(String(candidate.discoveredAt))))
        throw new Error("Models discovery discoveredAt is invalid.");
    if (!Array.isArray(candidate.providers))
        throw new Error("Models discovery providers must be an array.");
    const providers = candidate.providers.map(validateProviderDiscoveryResultV2);
    const providerIds = new Set();
    for (const provider of providers) {
        if (providerIds.has(provider.providerId))
            throw new Error(`Models discovery contains duplicate provider id: ${provider.providerId}`);
        providerIds.add(provider.providerId);
    }
    if (!Array.isArray(candidate.models) || candidate.models.some((model) => typeof model !== "string" || !model.trim()))
        throw new Error("Models discovery models must be non-empty strings.");
    return { schemaVersion: 2, discoveredAt: candidate.discoveredAt, providers, models: candidate.models };
}
function validateDesktopSnapshot(value) {
    const candidate = recordValue(value, "desktop snapshot");
    if (candidate.schemaVersion !== 3)
        throw new Error("Desktop snapshot schema must be version 3.");
    stringValue(candidate.capturedAt, "capturedAt");
    if (!Number.isFinite(Date.parse(String(candidate.capturedAt))))
        throw new Error("capturedAt is invalid.");
    if (candidate.projection !== null) {
        validateRunProjectionV2(candidate.projection);
    }
    validateSessionIndexProjectionV4(candidate.sessionIndex);
    if (!Array.isArray(candidate.providerDiscovery))
        throw new Error("Desktop snapshot provider discovery must be an array.");
    candidate.providerDiscovery.forEach(validateProviderDiscoveryResultV2);
    if (candidate.settings !== null)
        validateDesktopSettings(candidate.settings);
    return value;
}
/** Runtime schema guard used for IPC settings payloads before persistence. */
function validateDesktopSettings(value) {
    const candidate = recordValue(value, "settings");
    for (const key of Object.keys(candidate))
        if (!SETTINGS_KEYS.has(key))
            throw new Error(`settings contains unsupported field '${key}'.`);
    const paths = recordValue(candidate.paths, "settings.paths");
    const providers = recordValue(candidate.providers, "settings.providers");
    const toolAccess = recordValue(candidate.toolAccess, "settings.toolAccess");
    const defaults = recordValue(candidate.defaults, "settings.defaults");
    const variants = recordValue(candidate.variantDefaults, "settings.variantDefaults");
    validatePathSettings(paths);
    validateToolSettings(toolAccess);
    validateDefaultSettings(defaults);
    for (const [id, provider] of Object.entries(providers)) {
        if (!SAFE_PROVIDER_ID.test(id))
            throw new Error(`settings.providers.${id} has an unsafe provider id.`);
        validateProviderSettings(provider, id);
    }
    for (const [id, values] of Object.entries(variants)) {
        if (!Array.isArray(values) || values.some((entry) => typeof entry !== "string" || !entry.trim()))
            throw new Error(`settings.variantDefaults.${id} must be an array of non-empty strings.`);
    }
    return { paths, providers: providers, toolAccess, defaults, variantDefaults: variants };
}


/***/ },

/***/ "electron"
/*!***************************!*\
  !*** external "electron" ***!
  \***************************/
(module) {

module.exports = require("electron");

/***/ },

/***/ "node:crypto"
/*!******************************!*\
  !*** external "node:crypto" ***!
  \******************************/
(module) {

module.exports = require("node:crypto");

/***/ },

/***/ "node:events"
/*!******************************!*\
  !*** external "node:events" ***!
  \******************************/
(module) {

module.exports = require("node:events");

/***/ },

/***/ "node:fs"
/*!**************************!*\
  !*** external "node:fs" ***!
  \**************************/
(module) {

module.exports = require("node:fs");

/***/ },

/***/ "node:fs/promises"
/*!***********************************!*\
  !*** external "node:fs/promises" ***!
  \***********************************/
(module) {

module.exports = require("node:fs/promises");

/***/ },

/***/ "node:path"
/*!****************************!*\
  !*** external "node:path" ***!
  \****************************/
(module) {

module.exports = require("node:path");

/***/ }

/******/ 	});
/************************************************************************/
/******/ 	// The module cache
/******/ 	const __webpack_module_cache__ = {};
/******/ 	
/******/ 	// The require function
/******/ 	function __webpack_require__(moduleId) {
/******/ 		// Check if module is in cache
/******/ 		const cachedModule = __webpack_module_cache__[moduleId];
/******/ 		if (cachedModule !== undefined) {
/******/ 			return cachedModule.exports;
/******/ 		}
/******/ 		// Create a new module (and put it into the cache)
/******/ 		const module = __webpack_module_cache__[moduleId] = {
/******/ 			// no module.id needed
/******/ 			// no module.loaded needed
/******/ 			exports: {}
/******/ 		};
/******/ 	
/******/ 		// Execute the module function
/******/ 		if (!(moduleId in __webpack_modules__)) {
/******/ 			delete __webpack_module_cache__[moduleId];
/******/ 			const e = new Error("Cannot find module '" + moduleId + "'");
/******/ 			e.code = 'MODULE_NOT_FOUND';
/******/ 			throw e;
/******/ 		}
/******/ 		__webpack_modules__[moduleId].call(module.exports, module, module.exports, __webpack_require__);
/******/ 	
/******/ 		// Return the exports of the module
/******/ 		return module.exports;
/******/ 	}
/******/ 	
/************************************************************************/
/******/ 	
/******/ 	// startup
/******/ 	// Load entry module and return exports
/******/ 	// This entry module is referenced by other modules so it can't be inlined
/******/ 	let __webpack_exports__ = __webpack_require__("./src/main.ts");
/******/ 	module.exports = __webpack_exports__;
/******/ 	
/******/ })()
;
//# sourceMappingURL=index.js.map