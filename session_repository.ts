import * as path from "node:path";
import { atomicReadJson, atomicWriteJson } from "./json_file_store";
import { AuthoritativeSessionRepository } from "./authoritative_session_repository";
import { LoopState } from "./loop_state";
import { SessionMetaPatch, SessionRegistry } from "./session_contracts";
import { withShortFileLock } from "./resilience";
import { LoopStatus } from "./workflow_contracts";
import { rebuildSessionsIndex } from "./session_index";

export interface SessionRepository {
  initialize(state: LoopState): Promise<LoopState>;
  load(): Promise<LoopState>;
  beginOwnership(state: LoopState): Promise<LoopState>;
  saveOffline(state: LoopState, requestId: string): Promise<LoopState>;
  saveState(state: LoopState): Promise<void>;
  saveRegistry(registry: SessionRegistry, state: LoopState): Promise<SessionRegistry>;
}

export class CurrentSessionRepository implements SessionRepository {
  constructor(
    private readonly saveStateCurrent: (state: LoopState) => Promise<void>,
    private readonly saveRegistryCurrent: (
      registry: SessionRegistry,
      state: LoopState
    ) => Promise<SessionRegistry>
  ) {}

  initialize(state: LoopState): Promise<LoopState> {
    return Promise.resolve(state);
  }

  load(): Promise<LoopState> {
    throw new Error("CurrentSessionRepository does not provide loading.");
  }

  beginOwnership(state: LoopState): Promise<LoopState> {
    return Promise.resolve(state);
  }

  saveOffline(state: LoopState, _requestId: string): Promise<LoopState> {
    return Promise.resolve(state);
  }

  saveState(state: LoopState): Promise<void> {
    return this.saveStateCurrent(state);
  }

  saveRegistry(registry: SessionRegistry, state: LoopState): Promise<SessionRegistry> {
    return this.saveRegistryCurrent(registry, state);
  }
}

export interface FileSessionRepositoryOptions {
  sessionDir: string;
  registryPath: string;
  stateFileName: string;
  stateLockFileName: string;
  registryLockFileName: string;
  ownerLockFileName?: string;
  leaseFileName?: string;
  dataRoot?: string;
  sessionsRoot?: string;
  sessionsIndexFileName?: string;
}

export class FileSessionRepository implements SessionRepository {
  private readonly aggregateRepository: AuthoritativeSessionRepository;

  constructor(private readonly options: FileSessionRepositoryOptions) {
    this.aggregateRepository = new AuthoritativeSessionRepository({
      sessionDir: options.sessionDir,
      stateFileName: options.stateFileName,
      stateLockFileName: options.stateLockFileName,
      ownerLockFileName: options.ownerLockFileName,
      leaseFileName: options.leaseFileName,
    });
  }

  initialize(state: LoopState): Promise<LoopState> {
    return this.aggregateRepository.initialize(state);
  }

  load(): Promise<LoopState> {
    return this.aggregateRepository.load();
  }

  beginOwnership(state: LoopState): Promise<LoopState> {
    return this.aggregateRepository.acquireFencingEpoch(state);
  }

  saveOffline(state: LoopState, requestId: string): Promise<LoopState> {
    return this.aggregateRepository.commitOffline(
      state,
      state.aggregateRevision,
      requestId
    );
  }

  async saveState(state: LoopState): Promise<void> {
    await this.aggregateRepository.commit(
      state,
      state.aggregateRevision,
      state.fencingEpoch
    );
  }

  async saveRegistry(registry: SessionRegistry, state: LoopState): Promise<SessionRegistry> {
    const compatibilityProjection = await mergeAndWriteSessionMeta(
      this.options.registryPath,
      registry,
      {
        sessionId: state.sessionId,
        goal: state.goal,
        targetProjectPath: state.targetProjectPath,
        status: state.status,
        createdAt: state.createdAt,
      },
      this.options.registryLockFileName
    );
    if (
      this.options.dataRoot &&
      this.options.sessionsRoot &&
      this.options.sessionsIndexFileName
    ) {
      return rebuildSessionsIndex(
        this.options.dataRoot,
        {
          sessionsRoot: this.options.sessionsRoot,
          stateFileName: this.options.stateFileName,
          stateLockFileName: this.options.stateLockFileName,
          indexFileName: this.options.sessionsIndexFileName,
        },
        compatibilityProjection
      );
    }
    return compatibilityProjection;
  }
}

export function upsertSessionMeta(registry: SessionRegistry, patch: SessionMetaPatch): void {
  const existing = registry.sessionMetas.find((meta) => meta.sessionId === patch.sessionId);
  if (existing) {
    if (patch.status !== undefined) existing.status = patch.status;
    if (patch.goal !== undefined) existing.goal = patch.goal;
    if (patch.targetProjectPath !== undefined) {
      existing.targetProjectPath = patch.targetProjectPath;
    }
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

export async function reloadRegistry(
  registryPath: string,
  fallback: SessionRegistry
): Promise<SessionRegistry> {
  return (await atomicReadJson<SessionRegistry>(registryPath)) ?? fallback;
}

export async function mergeAndWriteSessionMeta(
  registryPath: string,
  fallback: SessionRegistry,
  patch: SessionMetaPatch,
  registryLockFileName: string
): Promise<SessionRegistry> {
  const lockPath = path.join(path.dirname(registryPath), registryLockFileName);
  return withShortFileLock(lockPath, async () => {
    const merged = await reloadRegistry(registryPath, fallback);
    upsertSessionMeta(merged, patch);
    await atomicWriteJson(registryPath, merged);
    return merged;
  });
}

export async function mergeAndWriteRegistryFields(
  registryPath: string,
  fallback: SessionRegistry,
  fields: Partial<
    Pick<
      SessionRegistry,
      | "availableModels"
      | "modelsDiscoveredAt"
      | "modelsDiscoveredCli"
      | "modelVariants"
      | "providerCatalog"
    >
  >,
  registryLockFileName: string
): Promise<SessionRegistry> {
  const lockPath = path.join(path.dirname(registryPath), registryLockFileName);
  return withShortFileLock(lockPath, async () => {
    const merged = await reloadRegistry(registryPath, fallback);
    if (fields.availableModels !== undefined) merged.availableModels = fields.availableModels;
    if (fields.modelsDiscoveredAt !== undefined) {
      merged.modelsDiscoveredAt = fields.modelsDiscoveredAt;
    }
    if (fields.modelsDiscoveredCli !== undefined) {
      merged.modelsDiscoveredCli = fields.modelsDiscoveredCli;
    }
    if (fields.modelVariants !== undefined) merged.modelVariants = fields.modelVariants;
    if (fields.providerCatalog !== undefined) merged.providerCatalog = fields.providerCatalog;
    await atomicWriteJson(registryPath, merged);
    return merged;
  });
}
