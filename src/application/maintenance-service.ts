import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { atomicWriteJson, renameWithRetry } from "../../json_file_store";
import { checkProcessLiveness, withShortFileLock } from "../../resilience";
import type { RootSet } from "../../root_set";
import { readLoopConfigForUpgrade } from "../../runtime_config";
import {
  INIT_DEFINITION_FILES,
  createInitManifest,
  hashDefinitionFiles,
  initManifestPath,
} from "./init-manifest";
import {
  createEmptySessionIndexProjection,
  validateSessionIndexProjectionV4,
} from "../interfaces/operator/contracts";

interface MaintenanceJournal {
  schemaVersion: 1;
  operationId: string;
  resetSessions: boolean;
  configRoot: string;
  dataRoot: string;
  sessionsRoot: string;
  registryPath: string;
  indexPath: string;
  historyPath: string;
  sessionIds: string[];
  deletionTargets: string[];
  tombstoneRoot: string;
  archiveRoot: string;
  stage: "planned" | "manifest_archived" | "sessions_moved" | "index_reset" | "definitions_installed" | "completed";
  createdAt: string;
  updatedAt: string;
}

type MaintenanceStage = MaintenanceJournal["stage"];

export interface MaintenancePreview {
  operationId: string;
  configRoot: string;
  dataRoot: string;
  sessionsRoot: string;
  registryPath: string;
  indexPath: string;
  historyPath: string;
  sessionIds: string[];
  deletionTargets: string[];
  preserved: string[];
  statuses: {
    registry: "missing" | "present" | "malformed" | "outside-active-root";
    index: "missing" | "current" | "legacy" | "malformed";
    history: "missing" | "present";
  };
  warnings: string[];
  definitionHash: string;
  expectedManifest: { productVersion: string; sessionIndexVersion: 4 };
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 64) || "maintenance";
}

function assertMaintenanceStorageDisjoint(dataRoot: string, sessionsRoot: string): void {
  const canonicalDataRoot = path.resolve(dataRoot);
  const maintenanceRoot = path.resolve(canonicalDataRoot, "maintenance");
  const sessionsPath = path.resolve(canonicalDataRoot, sessionsRoot);
  const inside = (parent: string, child: string): boolean => {
    const relative = path.relative(parent, child);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  };
  if (inside(maintenanceRoot, sessionsPath) || inside(sessionsPath, maintenanceRoot)) {
    throw new Error(
      `The configured sessions root must not overlap the maintenance journal: ${sessionsPath}.`
    );
  }
}

function safeSessionId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value);
}

function assertInside(parent: string, child: string, label: string): void {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes the configured maintenance root: ${child}`);
  }
}

async function scanLegacySessionIds(runsRoot: string): Promise<string[]> {
  try {
    const entries = await fsp.readdir(runsRoot, { withFileTypes: true });
    const ids: string[] = [];
    for (const entry of entries) {
      const candidate = path.join(runsRoot, entry.name);
      assertInside(runsRoot, candidate, "Session path");
      if (entry.isSymbolicLink()) throw new Error(`Session root contains a symbolic link: ${candidate}`);
      if (!safeSessionId(entry.name)) {
        throw new Error(`Session root contains an unsafe session id: ${entry.name}`);
      }
      if (entry.isDirectory()) ids.push(entry.name);
      else if (entry.isFile()) throw new Error(`Session id path is not a directory: ${candidate}`);
    }
    return ids.sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function sessionIds(
  runsRoot: string,
  indexPath?: string
): Promise<{ ids: string[]; status: MaintenancePreview["statuses"]["index"]; warnings: string[] }> {
  const warnings: string[] = [];
  if (indexPath) {
    try {
      const parsed = JSON.parse(await fsp.readFile(indexPath, "utf8")) as unknown;
      const version = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as { version?: unknown }).version
        : undefined;
      if (version !== 4) {
        warnings.push(`Legacy session index version ${String(version ?? "unknown")} was scanned without normalization.`);
        return { ids: await scanLegacySessionIds(runsRoot), status: "legacy", warnings };
      }
      const index = validateSessionIndexProjectionV4(parsed);
      // The index is authoritative. Include both active and terminal metadata
      // entries, while the upgrade loop below still checks that each target is
      // a directory before moving it.
      return { ids: [...new Set([
        ...index.activeSessionIds,
        ...index.sessionMetas.map((meta) => meta.sessionId),
      ])].sort(), status: "current", warnings };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        if (error instanceof SyntaxError) throw new Error(`Session index is malformed and cannot be safely migrated: ${indexPath}`);
        if (error instanceof Error && /Session index must use version 4/u.test(error.message)) {
          return { ids: await scanLegacySessionIds(runsRoot), status: "legacy", warnings };
        }
        throw error;
      }
      warnings.push(`Session index is missing: ${indexPath}`);
      return { ids: await scanLegacySessionIds(runsRoot), status: "missing", warnings };
    }
  }
  return { ids: await scanLegacySessionIds(runsRoot), status: "missing", warnings };
}

async function exists(filePath: string): Promise<boolean> {
  return fsp.stat(filePath).then(() => true).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  });
}

async function readUnfinishedJournal(
  maintenanceRoot: string,
  roots: RootSet,
  sessionsRoot: string,
  registryPath: string,
  indexPath: string,
  historyPath: string
): Promise<{ path: string; journal: MaintenanceJournal } | null> {
  let entries: import("node:fs").Dirent[];
  try { entries = await fsp.readdir(maintenanceRoot, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const candidates: Array<{ path: string; journal: MaintenanceJournal }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".journal.json")) continue;
    const journalPath = path.join(maintenanceRoot, entry.name);
    try {
      const value = JSON.parse(await fsp.readFile(journalPath, "utf8")) as Partial<MaintenanceJournal>;
      if (value.schemaVersion !== 1 || value.stage === "completed") continue;
      const insideMaintenance = (candidate: string): boolean => {
        const relative = path.relative(path.resolve(maintenanceRoot), path.resolve(candidate));
        return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
      };
      const normalizedSessionsRoot = value.sessionsRoot ?? sessionsRoot;
      const normalizedRegistryPath = value.registryPath ?? registryPath;
      const normalizedIndexPath = value.indexPath ?? indexPath;
      const normalizedHistoryPath = value.historyPath ?? historyPath;
      const normalizedDeletionTargets = value.deletionTargets ?? [
        path.resolve(roots.dataRoot, normalizedSessionsRoot),
        normalizedRegistryPath,
        normalizedIndexPath,
        normalizedHistoryPath,
        ...(Array.isArray(value.sessionIds)
          ? value.sessionIds.map((id) => path.join(path.resolve(roots.dataRoot, normalizedSessionsRoot), id))
          : []),
      ];
      const normalized = {
        ...value,
        sessionsRoot: normalizedSessionsRoot,
        registryPath: normalizedRegistryPath,
        indexPath: normalizedIndexPath,
        historyPath: normalizedHistoryPath,
        deletionTargets: normalizedDeletionTargets,
      } as Partial<MaintenanceJournal>;
      if (
        typeof value.operationId !== "string" || !value.operationId ||
        value.resetSessions !== true ||
        value.configRoot !== path.resolve(roots.configRoot) ||
        value.dataRoot !== path.resolve(roots.dataRoot) ||
        value.sessionsRoot !== undefined && typeof value.sessionsRoot !== "string" ||
        !Array.isArray(value.sessionIds) ||
        value.sessionIds.some((id) => typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(id)) ||
        typeof value.tombstoneRoot !== "string" || !path.isAbsolute(value.tombstoneRoot) ||
        typeof value.archiveRoot !== "string" || !path.isAbsolute(value.archiveRoot) ||
        !insideMaintenance(value.tombstoneRoot) || !insideMaintenance(value.archiveRoot) ||
        !["planned", "manifest_archived", "sessions_moved", "index_reset", "definitions_installed"].includes(String(value.stage)) ||
        typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)) ||
        typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt))
      ) {
        throw new Error("journal fields are invalid");
      }
      if (![normalized.registryPath, normalized.indexPath, normalized.historyPath].every((candidate): candidate is string => typeof candidate === "string" && path.isAbsolute(candidate))) {
        throw new Error("journal runtime paths are invalid");
      }
      if (!Array.isArray(normalized.deletionTargets) || normalized.deletionTargets.some((candidate) => typeof candidate !== "string" || !path.isAbsolute(candidate))) {
        throw new Error("journal deletion targets are invalid");
      }
      const dataRoot = path.resolve(roots.dataRoot);
      const resolvedJournalSessionsRoot = path.resolve(dataRoot, String(normalized.sessionsRoot));
      assertInside(dataRoot, resolvedJournalSessionsRoot, "journal sessions root");
      for (const [label, candidate] of [
        ["journal registry path", normalized.registryPath],
        ["journal index path", normalized.indexPath],
        ["journal history path", normalized.historyPath],
      ] as const) {
        assertInside(dataRoot, candidate as string, label);
      }
      for (const candidate of normalized.deletionTargets) {
        assertInside(dataRoot, candidate, "journal deletion target");
        if (path.resolve(candidate) === dataRoot) {
          throw new Error("journal deletion targets must not be the entire data root");
        }
      }
      candidates.push({ path: journalPath, journal: normalized as MaintenanceJournal });
    } catch (error) {
      // A malformed or partially-written journal is an ambiguous maintenance
      // state. Starting a new reset could delete a different session set, so
      // fail closed and leave the file available for operator repair.
      throw new Error(
        `Maintenance journal is malformed; operator repair is required before retrying: ${journalPath} ` +
        `(${error instanceof Error ? error.message : String(error)})`
      );
    }
  }
  candidates.sort((left, right) => left.journal.createdAt.localeCompare(right.journal.createdAt));
  return candidates[0] ?? null;
}

/**
 * Prevent normal commands from racing a reset that was interrupted between
 * journal commits.  The maintenance lock is deliberately treated as an
 * active safety marker even when its owner is stale: `upgrade` is the only
 * command allowed to reacquire that lock and resume the fixed journal.  A
 * completed journal is retained for auditability and therefore does not
 * block startup.
 */
export async function assertNoMaintenanceInProgress(dataRoot: string): Promise<void> {
  const maintenanceRoot = path.join(path.resolve(dataRoot), "maintenance");
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fsp.readdir(maintenanceRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (entries.some((entry) => entry.isFile() && entry.name === "maintenance.lock")) {
    throw new Error(`Maintenance is in progress or requires recovery: ${maintenanceRoot}`);
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".journal.json")) continue;
    const journalPath = path.join(maintenanceRoot, entry.name);
    let value: unknown;
    try {
      value = JSON.parse(await fsp.readFile(journalPath, "utf8"));
    } catch (error) {
      throw new Error(
        `Maintenance journal is malformed; operator repair is required before startup: ${journalPath} ` +
        `(${error instanceof Error ? error.message : String(error)})`
      );
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Maintenance journal is invalid; operator repair is required before startup: ${journalPath}`);
    }
    const stage = (value as { stage?: unknown }).stage;
    if (stage !== "completed") {
      throw new Error(`Maintenance is incomplete (${String(stage ?? "unknown")}); resume with upgrade: ${journalPath}`);
    }
  }
}

async function moveIfPresent(source: string, destination: string): Promise<void> {
  const sourceExists = await exists(source);
  const destinationExists = await exists(destination);
  if (!sourceExists) {
    if (destinationExists) return;
    return;
  }
  if (destinationExists) {
    throw new Error(`Maintenance destination already exists while source is present: ${destination}`);
  }
  await renameWithRetry(source, destination);
}

async function assertNoLiveSessionOwner(
  sessionDirectory: string,
  ownerLockFileName: string,
  leaseFileName: string
): Promise<void> {
  for (const fileName of [ownerLockFileName, leaseFileName]) {
    const filePath = path.join(sessionDirectory, fileName);
    if (!await exists(filePath)) continue;
    let value: unknown;
    try { value = JSON.parse(await fsp.readFile(filePath, "utf8")); }
    catch { throw new Error(`Cannot verify active session owner: ${filePath}`); }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Cannot verify active session owner: ${filePath}`);
    }
    const candidate = value as Record<string, unknown>;
    const pid = typeof candidate.ownerPid === "number"
      ? candidate.ownerPid
      : typeof candidate.pid === "number" ? candidate.pid : null;
    if (!pid || !Number.isSafeInteger(pid) || pid <= 0) {
      throw new Error(`Cannot verify active session owner pid: ${filePath}`);
    }
    const liveness = checkProcessLiveness(pid);
    if (liveness !== "dead") {
      throw new Error(`Session ${path.basename(sessionDirectory)} is still owned by pid ${pid}.`);
    }
    // The session lease records the provider/verification child separately.
    // A dead core PID is not sufficient evidence that the mutation process
    // has exited; refuse to move the session until every recorded child is
    // gone (or the record is repaired by the operator).
    const childPid = candidate.childPid;
    if (childPid !== undefined && childPid !== null) {
      if (typeof childPid !== "number" || !Number.isSafeInteger(childPid) || childPid <= 0) {
        throw new Error(`Cannot verify active session child pid: ${filePath}`);
      }
      const childLiveness = checkProcessLiveness(childPid);
      if (childLiveness !== "dead") {
        throw new Error(`Session ${path.basename(sessionDirectory)} still has child pid ${childPid}.`);
      }
    }
  }
}

/** Performs the destructive session reset as a journaled, resumable operation. */
export class MaintenanceService {
  constructor(private readonly codeRoot: string) {}

  private async previewFromJournal(roots: RootSet, journal: MaintenanceJournal): Promise<MaintenancePreview> {
    // Once a journal exists, its roots and target list are authoritative. Do
    // not re-read the current index or scan the sessions directory: either may
    // have changed after the freeze, and using them here could expand or
    // invalidate the original deletion set during recovery.
    const sessionsRoot = path.resolve(roots.dataRoot, journal.sessionsRoot);
    return {
      operationId: journal.operationId,
      configRoot: path.resolve(roots.configRoot),
      dataRoot: path.resolve(roots.dataRoot),
      sessionsRoot,
      registryPath: journal.registryPath,
      indexPath: journal.indexPath,
      historyPath: journal.historyPath,
      sessionIds: [...journal.sessionIds],
      deletionTargets: [...journal.deletionTargets],
      preserved: [
        "loop_config.json settings",
        "secure authentication storage",
        "model_variants.json and other user settings",
        "project source trees",
        "working-tree changes outside registered session directories",
      ],
      statuses: { registry: "missing", index: "missing", history: "missing" },
      warnings: ["Resuming the frozen maintenance target list from its journal."],
      definitionHash: await hashDefinitionFiles(this.codeRoot),
      expectedManifest: { productVersion: "7.0.0", sessionIndexVersion: 4 },
    };
  }

  async preview(
    roots: RootSet,
    sessionsRoot = "runs",
    sessionsIndexFileName = "sessions_index.json",
    registryFileName = "sessions_registry.json",
    loopHistoryDirName = "loop_history"
  ): Promise<MaintenancePreview> {
    assertMaintenanceStorageDisjoint(roots.dataRoot, sessionsRoot);
    const runsRoot = path.resolve(roots.dataRoot, sessionsRoot);
    const registryPath = path.resolve(roots.dataRoot, registryFileName);
    const indexPath = path.resolve(roots.dataRoot, sessionsIndexFileName);
    const historyPath = path.resolve(roots.dataRoot, loopHistoryDirName);
    assertInside(path.resolve(roots.dataRoot), runsRoot, "sessionsRoot");
    assertInside(path.resolve(roots.dataRoot), registryPath, "registry path");
    assertInside(path.resolve(roots.dataRoot), indexPath, "index path");
    assertInside(path.resolve(roots.dataRoot), historyPath, "history path");
    const scanned = await sessionIds(runsRoot, indexPath);
    const registryStatus = await (async (): Promise<MaintenancePreview["statuses"]["registry"]> => {
      try {
        const stat = await fsp.lstat(registryPath);
        if (stat.isSymbolicLink()) return "outside-active-root";
        if (!stat.isFile()) return "malformed";
        try { JSON.parse(await fsp.readFile(registryPath, "utf8")); return "present"; }
        catch { return "malformed"; }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
        throw error;
      }
    })();
    const historyStatus = await exists(historyPath) ? "present" : "missing";
    const definitionHash = await hashDefinitionFiles(this.codeRoot);
    const deletionTargets = [...new Set([runsRoot, registryPath, indexPath, historyPath, ...scanned.ids.map((id) => path.join(runsRoot, id))])];
    return {
      operationId: `upgrade_${Date.now().toString(36)}`,
      configRoot: path.resolve(roots.configRoot),
      dataRoot: path.resolve(roots.dataRoot),
      sessionsRoot: runsRoot,
      registryPath,
      indexPath,
      historyPath,
      sessionIds: scanned.ids,
      deletionTargets,
      preserved: [
        "loop_config.json settings",
        "secure authentication storage",
        "model_variants.json and other user settings",
        "project source trees",
        "working-tree changes outside registered session directories",
      ],
      statuses: { registry: registryStatus, index: scanned.status, history: historyStatus },
      warnings: scanned.warnings,
      definitionHash,
      expectedManifest: { productVersion: "7.0.0", sessionIndexVersion: 4 },
    };
  }

  async upgrade(
    roots: RootSet,
    options: {
      resetSessions: boolean;
      sessionsRoot?: string;
      sessionsIndexFileName?: string;
      registryFileName?: string;
      loopHistoryDirName?: string;
      ownerLockFileName?: string;
      leaseFileName?: string;
      /** Test-only stage fault injection; production callers leave this unset. */
      faultInjector?: (stage: MaintenanceStage) => void | Promise<void>;
    }
  ): Promise<MaintenancePreview> {
    if (!options.resetSessions) {
      throw new Error("upgrade requires --reset-sessions; use --dry-run to preview the target list.");
    }
    const sessionsRootName = options.sessionsRoot ?? "runs";
    const indexName = options.sessionsIndexFileName ?? "sessions_index.json";
    const registryName = options.registryFileName ?? "sessions_registry.json";
    const historyName = options.loopHistoryDirName ?? "loop_history";
    assertMaintenanceStorageDisjoint(roots.dataRoot, sessionsRootName);
    const maintenanceRoot = path.join(roots.dataRoot, "maintenance");
    await fsp.mkdir(maintenanceRoot, { recursive: true });
    const lockPath = path.join(maintenanceRoot, "maintenance.lock");
    return withShortFileLock(lockPath, async () => {
      const existing = await readUnfinishedJournal(
        maintenanceRoot,
        roots,
        sessionsRootName,
        path.resolve(roots.dataRoot, registryName),
        path.resolve(roots.dataRoot, indexName),
        path.resolve(roots.dataRoot, historyName)
      );
      const preview = existing
        ? await this.previewFromJournal(roots, existing.journal)
        : await this.preview(roots, sessionsRootName, indexName, registryName, historyName);
      const operationId = existing?.journal.operationId ?? preview.operationId;
      const archiveRoot = existing?.journal.archiveRoot ?? path.join(maintenanceRoot, `${safeName(operationId)}-archive`);
      const tombstoneRoot = existing?.journal.tombstoneRoot ?? path.join(maintenanceRoot, `${safeName(operationId)}-sessions`);
      const journalPath = existing?.path ?? path.join(maintenanceRoot, `${safeName(operationId)}.journal.json`);
      const journal: MaintenanceJournal = existing?.journal ?? {
        schemaVersion: 1,
        operationId,
        resetSessions: true,
        configRoot: path.resolve(roots.configRoot),
        dataRoot: path.resolve(roots.dataRoot),
        sessionsRoot: sessionsRootName,
        registryPath: path.resolve(roots.dataRoot, registryName),
        indexPath: path.resolve(roots.dataRoot, indexName),
        historyPath: path.resolve(roots.dataRoot, historyName),
        sessionIds: [...preview.sessionIds],
        deletionTargets: [...preview.deletionTargets],
        tombstoneRoot,
        archiveRoot,
        stage: "planned",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const persist = async (stage: MaintenanceStage): Promise<void> => {
        if (options.faultInjector) await options.faultInjector(stage);
        journal.stage = stage;
        journal.updatedAt = new Date().toISOString();
        await atomicWriteJson(journalPath, journal);
      };
      await atomicWriteJson(journalPath, journal);
      await fsp.mkdir(archiveRoot, { recursive: true });
      const manifestPath = initManifestPath(roots.configRoot);
      // Only the planned stage owns the old-manifest move.  On a retry after
      // the new manifest was written (for example if tombstone cleanup was
      // interrupted), moving it into the archive again would collide with the
      // archived copy and make the journal non-resumable.
      if (journal.stage === "planned") {
        if (await exists(manifestPath)) {
          await moveIfPresent(manifestPath, path.join(archiveRoot, path.basename(manifestPath)));
        }
        await persist("manifest_archived");
      }
      const runsRoot = path.resolve(roots.dataRoot, journal.sessionsRoot);
      await fsp.mkdir(tombstoneRoot, { recursive: true });
      if (journal.stage === "manifest_archived") {
        for (const id of journal.sessionIds) {
          const source = path.join(runsRoot, id);
          if (await exists(source)) {
            await assertNoLiveSessionOwner(
              source,
              options.ownerLockFileName ?? "session_owner.lock",
              options.leaseFileName ?? "session_lease.json"
            );
          }
          await moveIfPresent(source, path.join(tombstoneRoot, id));
        }
        // The configured sessions root is itself a deletion target. Anything
        // outside the fixed session list means the profile changed after the
        // target set was frozen; fail closed rather than silently leaving or
        // deleting an unregistered runtime file.
        try {
          const residual = await fsp.readdir(runsRoot);
          if (residual.length > 0) {
            throw new Error(`Sessions root changed after target freeze: ${runsRoot}`);
          }
          await fsp.rmdir(runsRoot);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        await persist("sessions_moved");
      }
      await fsp.mkdir(runsRoot, { recursive: true });
      if (journal.stage === "sessions_moved") {
        await atomicWriteJson(journal.indexPath, createEmptySessionIndexProjection());
        await fsp.rm(journal.registryPath, { force: true });
        await fsp.rm(journal.historyPath, { recursive: true, force: true });
        await persist("index_reset");
      }
      await fsp.mkdir(roots.configRoot, { recursive: true });
      if (journal.stage === "index_reset") {
        const upgradeConfig = await readLoopConfigForUpgrade(roots.configRoot);
        for (const fileName of INIT_DEFINITION_FILES) {
          const source = path.join(this.codeRoot, fileName);
          const destination = path.join(roots.configRoot, fileName);
          // User settings and secure credential references live in the
          // configured loop file. Preserve an existing file verbatim; when a
          // damaged/old profile has no loop file, install the packaged
          // default so the upgraded profile remains runnable.
          if (fileName === "loop_config.json" && await exists(destination)) {
            // Preserve supported user settings while dropping only fields
            // that the v7 loader no longer recognizes.  This lets a profile
            // with stale runtime options start after the reset without
            // changing provider credentials or path choices.
            if (upgradeConfig?.changed) {
              await atomicWriteJson(destination, upgradeConfig.source);
            }
            continue;
          }
          const temporary = `${destination}.maintenance.${process.pid}.${Date.now()}`;
          await fsp.copyFile(source, temporary);
          if (await exists(destination)) await fsp.rm(destination, { force: true });
          await renameWithRetry(temporary, destination);
        }
        await persist("definitions_installed");
      }
      if (journal.stage === "definitions_installed") {
        const definitionHash = await hashDefinitionFiles(this.codeRoot);
        await atomicWriteJson(
          initManifestPath(roots.configRoot),
          createInitManifest("7.0.0", definitionHash)
        );
        // Session directories are intentionally not migrated.  Keep the
        // tombstone until the new manifest is durable, then remove it as the
        // final destructive step.  If the process stops before this point,
        // the journal can safely repeat the same fixed deletion set.
        await fsp.rm(tombstoneRoot, { recursive: true, force: true });
        await persist("completed");
      }
      return {
        ...preview,
        operationId,
        // The journal is authoritative once a reset has started. Returning
        // the original target list keeps dry-run/operator output stable even
        // after the session directories have moved to the tombstone.
        sessionIds: [...journal.sessionIds],
      };
    });
  }
}
