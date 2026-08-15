import * as crypto from "node:crypto";
import * as path from "node:path";
import * as fsp from "node:fs/promises";
import { atomicReadJson, atomicWriteJson } from "./json_file_store";
import { ArtifactReference, LoopState } from "./loop_state";
import {
  LockRecord,
  SessionLease,
  checkProcessLiveness,
  withShortFileLock,
} from "./resilience";

export type RepositoryFaultPoint = "after_wal" | "after_snapshot";

export interface AuthoritativeSessionRepositoryOptions {
  sessionDir: string;
  stateFileName: string;
  stateLockFileName: string;
  walDirName?: string;
  fenceFileName?: string;
  blockedMarkerFileName?: string;
  maxWalRecords?: number;
  ownerLockFileName?: string;
  leaseFileName?: string;
  faultInjector?: (point: RepositoryFaultPoint) => void | Promise<void>;
}

interface FenceRecord {
  epoch: number;
  updatedAt: string;
}

export class RevisionConflictError extends Error {
  constructor(readonly expectedRevision: number, readonly actualRevision: number) {
    super(`Aggregate revision conflict: expected ${expectedRevision}, actual ${actualRevision}.`);
    this.name = "RevisionConflictError";
  }
}

export class FencingConflictError extends Error {
  constructor(readonly attemptedEpoch: number, readonly currentEpoch: number) {
    super(`Fencing epoch conflict: attempted ${attemptedEpoch}, current ${currentEpoch}.`);
    this.name = "FencingConflictError";
  }
}

export class CorruptAggregateError extends Error {
  constructor(readonly sessionDir: string) {
    super(`No valid aggregate record remains for session directory: ${sessionDir}`);
    this.name = "CorruptAggregateError";
  }
}

function cloneState(state: LoopState): LoopState {
  return JSON.parse(JSON.stringify(state)) as LoopState;
}

export function aggregateChecksum(state: LoopState): string {
  const candidate = cloneState(state);
  candidate.aggregateChecksum = "";
  return crypto.createHash("sha256").update(JSON.stringify(candidate)).digest("hex");
}

export function sealAggregateState(
  state: LoopState,
  revision: number,
  fencingEpoch: number
): LoopState {
  const sealed = cloneState(state);
  sealed.aggregateFormatVersion = 1;
  sealed.aggregateRevision = revision;
  sealed.fencingEpoch = fencingEpoch;
  sealed.aggregateChecksum = "";
  sealed.aggregateChecksum = aggregateChecksum(sealed);
  return sealed;
}

export function isValidAggregateState(value: unknown): value is LoopState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Partial<LoopState>;
  return (
    state.aggregateFormatVersion === 1 &&
    Number.isSafeInteger(state.aggregateRevision) &&
    Number(state.aggregateRevision) >= 0 &&
    Number.isSafeInteger(state.fencingEpoch) &&
    Number(state.fencingEpoch) >= 0 &&
    typeof state.aggregateChecksum === "string" &&
    state.aggregateChecksum.length === 64 &&
    aggregateChecksum(state as LoopState) === state.aggregateChecksum
  );
}

function replaceState(target: LoopState, source: LoopState): void {
  for (const key of Object.keys(target) as Array<keyof LoopState>) {
    delete (target as unknown as Record<string, unknown>)[key];
  }
  Object.assign(target, source);
}

export class AuthoritativeSessionRepository {
  private readonly walDirName: string;
  private readonly fenceFileName: string;
  private readonly blockedMarkerFileName: string;
  private readonly maxWalRecords: number;

  constructor(private readonly options: AuthoritativeSessionRepositoryOptions) {
    this.walDirName = options.walDirName ?? "aggregate_wal";
    this.fenceFileName = options.fenceFileName ?? "fencing_epoch.json";
    this.blockedMarkerFileName = options.blockedMarkerFileName ?? "aggregate.blocked.json";
    this.maxWalRecords = options.maxWalRecords ?? 8;
  }

  get snapshotPath(): string {
    return path.join(this.options.sessionDir, this.options.stateFileName);
  }

  private get lockPath(): string {
    return path.join(this.options.sessionDir, this.options.stateLockFileName);
  }

  private get walRoot(): string {
    return path.join(this.options.sessionDir, this.walDirName);
  }

  private get fencePath(): string {
    return path.join(this.options.sessionDir, this.fenceFileName);
  }

  async initialize(state: LoopState): Promise<LoopState> {
    await fsp.mkdir(this.options.sessionDir, { recursive: true });
    return withShortFileLock(this.lockPath, async () => {
      const existing = await this.loadHighestUnlocked(true);
      if (existing) return existing;
      const sealed = sealAggregateState(state, 0, 0);
      await atomicWriteJson(this.walPath(0), sealed);
      await atomicWriteJson(this.snapshotPath, sealed);
      await atomicWriteJson(this.fencePath, { epoch: 0, updatedAt: new Date().toISOString() });
      return sealed;
    });
  }

  async load(): Promise<LoopState> {
    return withShortFileLock(this.lockPath, async () => {
      const loaded = await this.loadHighestUnlocked(true);
      if (!loaded) throw new CorruptAggregateError(this.options.sessionDir);
      return loaded;
    });
  }

  async acquireFencingEpoch(state: LoopState): Promise<LoopState> {
    return withShortFileLock(this.lockPath, async () => {
      const latest = await this.requireHighestUnlocked();
      const fence = await atomicReadJson<FenceRecord>(this.fencePath);
      const nextEpoch = Math.max(latest.fencingEpoch, fence?.epoch ?? 0) + 1;
      await atomicWriteJson(this.fencePath, {
        epoch: nextEpoch,
        updatedAt: new Date().toISOString(),
      });
      const committed = await this.persistUnlocked(
        { ...latest, ...cloneState(state) },
        latest.aggregateRevision + 1,
        nextEpoch
      );
      replaceState(state, committed);
      return committed;
    });
  }

  async commit(
    nextState: LoopState,
    expectedRevision: number,
    fencingEpoch: number
  ): Promise<LoopState> {
    return withShortFileLock(this.lockPath, async () => {
      const latest = await this.requireHighestUnlocked();
      if (latest.aggregateRevision !== expectedRevision) {
        throw new RevisionConflictError(expectedRevision, latest.aggregateRevision);
      }
      const fence = await atomicReadJson<FenceRecord>(this.fencePath);
      const currentEpoch = Math.max(latest.fencingEpoch, fence?.epoch ?? 0);
      if (fencingEpoch !== currentEpoch) {
        throw new FencingConflictError(fencingEpoch, currentEpoch);
      }
      const committed = await this.persistUnlocked(
        nextState,
        expectedRevision + 1,
        fencingEpoch
      );
      replaceState(nextState, committed);
      return committed;
    });
  }

  async commitOffline(
    nextState: LoopState,
    expectedRevision: number,
    requestId: string
  ): Promise<LoopState> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(requestId)) {
      throw new Error(`Invalid offline request id: ${requestId}`);
    }
    return withShortFileLock(this.lockPath, async () => {
      const latest = await this.requireHighestUnlocked();
      if (latest.processedRequestIds.includes(requestId)) {
        replaceState(nextState, latest);
        return latest;
      }
      if (latest.aggregateRevision !== expectedRevision) {
        throw new RevisionConflictError(expectedRevision, latest.aggregateRevision);
      }
      await this.assertNoLiveOwnerUnlocked();
      const candidate = cloneState(nextState);
      candidate.processedRequestIds = [
        ...latest.processedRequestIds,
        requestId,
      ].slice(-256);
      const committed = await this.persistUnlocked(
        candidate,
        expectedRevision + 1,
        latest.fencingEpoch
      );
      replaceState(nextState, committed);
      return committed;
    });
  }

  private async requireHighestUnlocked(): Promise<LoopState> {
    const latest = await this.loadHighestUnlocked(true);
    if (!latest) throw new CorruptAggregateError(this.options.sessionDir);
    return latest;
  }

  private async loadHighestUnlocked(allowLegacyMigration: boolean): Promise<LoopState | null> {
    const snapshotRaw = await this.readJsonUnknown(this.snapshotPath);
    const candidates: LoopState[] = [];
    if (isValidAggregateState(snapshotRaw)) candidates.push(snapshotRaw);

    await fsp.mkdir(this.walRoot, { recursive: true });
    const walNames = (await fsp.readdir(this.walRoot).catch(() => [] as string[])).filter(
      (name) => /^revision_\d+\.json$/.test(name)
    );
    let invalidWal = false;
    for (const name of walNames) {
      const value = await this.readJsonUnknown(path.join(this.walRoot, name));
      if (isValidAggregateState(value)) candidates.push(value);
      else invalidWal = true;
    }

    if (candidates.length === 0) {
      if (
        allowLegacyMigration &&
        snapshotRaw &&
        typeof snapshotRaw === "object" &&
        !Array.isArray(snapshotRaw) &&
        (snapshotRaw as Partial<LoopState>).stateVersion !== undefined
      ) {
        const backupPath = `${this.snapshotPath}.pre-aggregate.backup`;
        await fsp.copyFile(this.snapshotPath, backupPath).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        });
        const legacy = snapshotRaw as LoopState;
        legacy.processedRequestIds = Array.isArray(legacy.processedRequestIds)
          ? legacy.processedRequestIds
          : [];
        legacy.artifactRefs = legacy.artifactRefs ?? {};
        const migrated = sealAggregateState(legacy, 0, 0);
        await atomicWriteJson(this.walPath(0), migrated);
        await atomicWriteJson(this.snapshotPath, migrated);
        await atomicWriteJson(this.fencePath, {
          epoch: 0,
          updatedAt: new Date().toISOString(),
        });
        return migrated;
      }
      const aggregateFilesExist = snapshotRaw !== null || walNames.length > 0 || invalidWal;
      if (aggregateFilesExist) await this.quarantineCorruptAggregate(walNames);
      return null;
    }

    const highest = candidates.sort(
      (left, right) => right.aggregateRevision - left.aggregateRevision
    )[0];
    if (!isValidAggregateState(snapshotRaw) || snapshotRaw.aggregateRevision < highest.aggregateRevision) {
      await atomicWriteJson(this.snapshotPath, highest);
    }
    return cloneState(highest);
  }

  private async persistUnlocked(
    state: LoopState,
    revision: number,
    fencingEpoch: number
  ): Promise<LoopState> {
    const sealed = sealAggregateState(state, revision, fencingEpoch);
    await atomicWriteJson(this.walPath(revision), sealed);
    await this.options.faultInjector?.("after_wal");
    await atomicWriteJson(this.snapshotPath, sealed);
    await this.options.faultInjector?.("after_snapshot");
    await this.pruneWalUnlocked();
    return sealed;
  }

  private async assertNoLiveOwnerUnlocked(): Promise<void> {
    const leaseFileName = this.options.leaseFileName ?? "session_lease.json";
    const ownerLockFileName = this.options.ownerLockFileName ?? "session_owner.lock";
    const lease = await atomicReadJson<SessionLease>(
      path.join(this.options.sessionDir, leaseFileName)
    );
    if (lease && Date.parse(lease.expiresAt) > Date.now()) {
      throw new Error(`Session has an active owner lease for pid ${lease.ownerPid}.`);
    }
    const owner = await atomicReadJson<LockRecord>(
      path.join(this.options.sessionDir, ownerLockFileName)
    );
    if (owner && checkProcessLiveness(owner.ownerPid) !== "dead") {
      throw new Error(`Session owner pid ${owner.ownerPid} may still be alive.`);
    }
  }

  private walPath(revision: number): string {
    return path.join(this.walRoot, `revision_${String(revision).padStart(12, "0")}.json`);
  }

  private async pruneWalUnlocked(): Promise<void> {
    const names = (await fsp.readdir(this.walRoot).catch(() => [] as string[]))
      .filter((name) => /^revision_\d+\.json$/.test(name))
      .sort();
    for (const name of names.slice(0, Math.max(0, names.length - this.maxWalRecords))) {
      await fsp.rm(path.join(this.walRoot, name), { force: true });
    }
  }

  private async readJsonUnknown(filePath: string): Promise<unknown | null> {
    try {
      return JSON.parse(await fsp.readFile(filePath, "utf8")) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      return { corrupt: true };
    }
  }

  private async quarantineCorruptAggregate(walNames: readonly string[]): Promise<void> {
    const timestamp = Date.now();
    await fsp.rename(this.snapshotPath, `${this.snapshotPath}.corrupt.${timestamp}`).catch(() => {});
    for (const name of walNames) {
      const source = path.join(this.walRoot, name);
      await fsp.rename(source, `${source}.corrupt.${timestamp}`).catch(() => {});
    }
    await atomicWriteJson(path.join(this.options.sessionDir, this.blockedMarkerFileName), {
      status: "BLOCKED",
      reason: "No valid aggregate snapshot or WAL record remains.",
      detectedAt: new Date().toISOString(),
    });
  }
}

export class ImmutableArtifactStore {
  constructor(private readonly rootDir: string) {}

  async put(content: string | Buffer, mediaType: string): Promise<ArtifactReference> {
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    const filePath = path.join(this.rootDir, "sha256", sha256.slice(0, 2), sha256);
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    try {
      const handle = await fsp.open(filePath, "wx", 0o600);
      try {
        await handle.writeFile(bytes);
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await fsp.readFile(filePath);
      if (!existing.equals(bytes)) throw new Error(`Artifact hash collision at ${sha256}.`);
    }
    return { sha256, mediaType, bytes: bytes.length };
  }

  read(reference: ArtifactReference): Promise<Buffer> {
    return fsp.readFile(
      path.join(this.rootDir, "sha256", reference.sha256.slice(0, 2), reference.sha256)
    );
  }
}
