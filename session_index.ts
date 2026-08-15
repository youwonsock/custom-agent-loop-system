import * as path from "node:path";
import * as fsp from "node:fs/promises";
import { AuthoritativeSessionRepository } from "./authoritative_session_repository";
import { atomicReadJson, atomicWriteJson } from "./json_file_store";
import { SessionRegistry } from "./session_contracts";
import { LoopStatus } from "./workflow_contracts";

export interface SessionsIndex extends SessionRegistry {
  projectionVersion: 1;
  rebuiltAt: string;
  source: "session-aggregates";
}

export interface SessionIndexPaths {
  sessionsRoot: string;
  stateFileName: string;
  stateLockFileName: string;
  indexFileName: string;
}

function emptyProjection(fallback?: SessionRegistry | null): SessionsIndex {
  return {
    version: fallback?.version ?? 1,
    projectionVersion: 1,
    rebuiltAt: new Date().toISOString(),
    source: "session-aggregates",
    activeSessionIds: [],
    availableModels: fallback?.availableModels ?? [],
    modelsDiscoveredAt: fallback?.modelsDiscoveredAt ?? null,
    modelsDiscoveredCli: fallback?.modelsDiscoveredCli ?? null,
    sessionMetas: [],
    manualModelsOverride: fallback?.manualModelsOverride ?? null,
    modelVariants: fallback?.modelVariants ?? null,
    providerCatalog: fallback?.providerCatalog,
  };
}

export async function rebuildSessionsIndex(
  dataRoot: string,
  paths: SessionIndexPaths,
  fallback?: SessionRegistry | null
): Promise<SessionsIndex> {
  const projection = emptyProjection(fallback);
  const sessionsRoot = path.join(dataRoot, paths.sessionsRoot);
  const entries = await fsp.readdir(sessionsRoot, { withFileTypes: true }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(entry.name)) continue;
    const sessionDir = path.join(sessionsRoot, entry.name);
    const repository = new AuthoritativeSessionRepository({
      sessionDir,
      stateFileName: paths.stateFileName,
      stateLockFileName: paths.stateLockFileName,
    });
    try {
      const state = await repository.load();
      projection.sessionMetas.push({
        sessionId: state.sessionId,
        goal: state.goal,
        targetProjectPath: state.targetProjectPath,
        status: state.status,
        createdAt: state.createdAt,
      });
      projection.activeSessionIds.push(state.sessionId);
    } catch {
      const blocked = await atomicReadJson<{ detectedAt?: string }>(
        path.join(sessionDir, "aggregate.blocked.json")
      );
      if (!blocked) continue;
      projection.sessionMetas.push({
        sessionId: entry.name,
        goal: "",
        targetProjectPath: "",
        status: LoopStatus.BLOCKED,
        createdAt: blocked.detectedAt ?? new Date().toISOString(),
      });
      projection.activeSessionIds.push(entry.name);
    }
  }
  projection.rebuiltAt = new Date().toISOString();
  await atomicWriteJson(path.join(dataRoot, paths.indexFileName), projection);
  return projection;
}

