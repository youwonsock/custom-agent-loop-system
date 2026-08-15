import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { ArtifactReference, LoopState } from "./types";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function cloneState(state: LoopState): LoopState {
  return JSON.parse(JSON.stringify(state)) as LoopState;
}

export function aggregateChecksum(state: LoopState): string {
  const candidate = cloneState(state);
  candidate.aggregateChecksum = "";
  return createHash("sha256").update(JSON.stringify(candidate)).digest("hex");
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
  sealed.processedRequestIds = Array.isArray(sealed.processedRequestIds)
    ? sealed.processedRequestIds
    : [];
  sealed.artifactRefs = sealed.artifactRefs ?? {};
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

async function renameWithRetry(src: string, dest: string, maxRetries = 5): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    try {
      await fs.rename(src, dest);
      return;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
    }
  }
  throw lastError;
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random()
    .toString(36)
    .slice(2, 10)}`;
  await fs.writeFile(temporaryPath, JSON.stringify(value, null, 2), "utf8");
  await renameWithRetry(temporaryPath, filePath);
}

async function readJsonUnknown(filePath: string): Promise<unknown | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return { corrupt: true };
  }
}

export interface OfflineAggregateUpdate {
  expectedRevision: number;
  requestId: string;
  mutate: (state: LoopState) => void;
  assertNoLiveOwner: () => void | Promise<void>;
}

/**
 * Filesystem aggregate operations that must be called while holding state_write.lock.
 * The core and extension intentionally use the same snapshot, WAL and checksum format.
 */
export class ExtensionAggregateStore {
  private readonly walRoot: string;

  constructor(
    private readonly sessionDir: string,
    private readonly stateFileName: string,
    private readonly maxWalRecords = 8
  ) {
    this.walRoot = path.join(sessionDir, "aggregate_wal");
  }

  get snapshotPath(): string {
    return path.join(this.sessionDir, this.stateFileName);
  }

  async loadUnlocked(allowLegacyMigration = true): Promise<LoopState | null> {
    const snapshotRaw = await readJsonUnknown(this.snapshotPath);
    const candidates: LoopState[] = [];
    if (isValidAggregateState(snapshotRaw)) candidates.push(snapshotRaw);

    await fs.mkdir(this.walRoot, { recursive: true });
    const walNames = (await fs.readdir(this.walRoot).catch(() => [] as string[])).filter(
      (name) => /^revision_\d+\.json$/.test(name)
    );
    let invalidWal = false;
    for (const name of walNames) {
      const value = await readJsonUnknown(path.join(this.walRoot, name));
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
        await fs.copyFile(this.snapshotPath, backupPath, fsConstants.COPYFILE_EXCL).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        });
        const legacy = cloneState(snapshotRaw as LoopState);
        const migrated = sealAggregateState(legacy, 0, 0);
        await writeJsonAtomic(this.walPath(0), migrated);
        await writeJsonAtomic(this.snapshotPath, migrated);
        await writeJsonAtomic(path.join(this.sessionDir, "fencing_epoch.json"), {
          epoch: 0,
          updatedAt: new Date().toISOString(),
        });
        return migrated;
      }
      if (snapshotRaw !== null || walNames.length > 0 || invalidWal) {
        await this.quarantineCorruptAggregate(walNames);
      }
      return null;
    }

    const highest = candidates.sort(
      (left, right) => Number(right.aggregateRevision) - Number(left.aggregateRevision)
    )[0];
    if (
      !isValidAggregateState(snapshotRaw) ||
      Number(snapshotRaw.aggregateRevision) < Number(highest.aggregateRevision)
    ) {
      await writeJsonAtomic(this.snapshotPath, highest);
    }
    return cloneState(highest);
  }

  async updateOfflineUnlocked(update: OfflineAggregateUpdate): Promise<LoopState> {
    if (!REQUEST_ID_PATTERN.test(update.requestId)) {
      throw new Error(`Invalid offline request id: ${update.requestId}`);
    }
    const latest = await this.loadUnlocked(true);
    if (!latest) throw new Error(`Session state not found: ${this.sessionDir}`);
    if ((latest.processedRequestIds ?? []).includes(update.requestId)) return latest;
    if (latest.aggregateRevision !== update.expectedRevision) {
      throw new Error(
        `Aggregate revision conflict: expected ${update.expectedRevision}, ` +
          `actual ${String(latest.aggregateRevision)}.`
      );
    }
    await update.assertNoLiveOwner();
    const candidate = cloneState(latest);
    update.mutate(candidate);
    candidate.updatedAt = new Date().toISOString();
    candidate.processedRequestIds = [
      ...(latest.processedRequestIds ?? []),
      update.requestId,
    ].slice(-256);
    return this.persistUnlocked(
      candidate,
      update.expectedRevision + 1,
      latest.fencingEpoch ?? 0
    );
  }

  private async persistUnlocked(
    state: LoopState,
    revision: number,
    fencingEpoch: number
  ): Promise<LoopState> {
    const sealed = sealAggregateState(state, revision, fencingEpoch);
    await writeJsonAtomic(this.walPath(revision), sealed);
    await writeJsonAtomic(this.snapshotPath, sealed);
    await this.pruneWalUnlocked();
    return sealed;
  }

  private walPath(revision: number): string {
    return path.join(
      this.walRoot,
      `revision_${String(revision).padStart(12, "0")}.json`
    );
  }

  private async pruneWalUnlocked(): Promise<void> {
    const names = (await fs.readdir(this.walRoot).catch(() => [] as string[]))
      .filter((name) => /^revision_\d+\.json$/.test(name))
      .sort();
    for (const name of names.slice(0, Math.max(0, names.length - this.maxWalRecords))) {
      await fs.rm(path.join(this.walRoot, name), { force: true });
    }
  }

  private async quarantineCorruptAggregate(walNames: readonly string[]): Promise<void> {
    const timestamp = Date.now();
    await fs
      .rename(this.snapshotPath, `${this.snapshotPath}.corrupt.${timestamp}`)
      .catch(() => {});
    for (const name of walNames) {
      const source = path.join(this.walRoot, name);
      await fs.rename(source, `${source}.corrupt.${timestamp}`).catch(() => {});
    }
    await writeJsonAtomic(path.join(this.sessionDir, "aggregate.blocked.json"), {
      status: "BLOCKED",
      reason: "No valid aggregate snapshot or WAL record remains.",
      detectedAt: new Date().toISOString(),
    });
  }
}

export class ExtensionImmutableArtifactStore {
  constructor(private readonly rootDir: string) {}

  async put(content: string | Buffer, mediaType: string): Promise<ArtifactReference> {
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const filePath = path.join(this.rootDir, "sha256", sha256.slice(0, 2), sha256);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    try {
      const handle = await fs.open(filePath, "wx", 0o600);
      try {
        await handle.writeFile(bytes);
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await fs.readFile(filePath);
      if (!existing.equals(bytes)) throw new Error(`Artifact hash collision at ${sha256}.`);
    }
    return { sha256, mediaType, bytes: bytes.length };
  }
}
