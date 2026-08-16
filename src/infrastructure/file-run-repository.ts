import { createHash } from "node:crypto";
import * as path from "node:path";
import * as fsp from "node:fs/promises";
import type { RunRepositoryPort } from "../application/ports/run-repository";
import type { RunAggregate } from "../domain/run-aggregate";
import { atomicWriteJson } from "../../json_file_store";
import { withShortFileLock } from "../../resilience";

const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

interface FenceRecord {
  epoch: number;
  updatedAt: string;
}

export class RunRevisionConflictError extends Error {
  constructor(readonly expected: number, readonly actual: number) {
    super(`Run revision conflict: expected ${expected}, actual ${actual}.`);
    this.name = "RunRevisionConflictError";
  }
}

export class RunFencingConflictError extends Error {
  constructor(readonly attempted: number, readonly actual: number) {
    super(`Run fencing conflict: attempted ${attempted}, actual ${actual}.`);
    this.name = "RunFencingConflictError";
  }
}

function clone(aggregate: Readonly<RunAggregate>): RunAggregate {
  return JSON.parse(JSON.stringify(aggregate)) as RunAggregate;
}

export function runChecksum(aggregate: Readonly<RunAggregate>): string {
  const candidate = clone(aggregate);
  candidate.checksum = "";
  return createHash("sha256").update(JSON.stringify(candidate)).digest("hex");
}

function seal(
  aggregate: Readonly<RunAggregate>,
  revision: number,
  fencingEpoch: number
): RunAggregate {
  const sealed = clone(aggregate);
  sealed.schemaVersion = 1;
  sealed.revision = revision;
  sealed.fencingEpoch = fencingEpoch;
  sealed.checksum = "";
  sealed.checksum = runChecksum(sealed);
  return sealed;
}

function isValid(value: unknown): value is RunAggregate {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const aggregate = value as Partial<RunAggregate>;
  return (
    aggregate.schemaVersion === 1 &&
    typeof aggregate.runId === "string" &&
    Number.isSafeInteger(aggregate.revision) &&
    Number(aggregate.revision) >= 0 &&
    Number.isSafeInteger(aggregate.fencingEpoch) &&
    Number(aggregate.fencingEpoch) >= 0 &&
    typeof aggregate.checksum === "string" &&
    aggregate.checksum.length === 64 &&
    runChecksum(aggregate as RunAggregate) === aggregate.checksum
  );
}

export interface FileRunRepositoryOptions {
  runsRoot: string;
  snapshotFileName?: string;
  lockFileName?: string;
  walDirectoryName?: string;
  fenceFileName?: string;
  maxWalRecords?: number;
}

export class FileRunRepository implements RunRepositoryPort {
  private readonly snapshotFileName: string;
  private readonly lockFileName: string;
  private readonly walDirectoryName: string;
  private readonly fenceFileName: string;
  private readonly maxWalRecords: number;

  constructor(private readonly options: FileRunRepositoryOptions) {
    this.snapshotFileName = options.snapshotFileName ?? "run.json";
    this.lockFileName = options.lockFileName ?? "run.lock";
    this.walDirectoryName = options.walDirectoryName ?? "run_wal";
    this.fenceFileName = options.fenceFileName ?? "fencing_epoch.json";
    this.maxWalRecords = options.maxWalRecords ?? 8;
  }

  async initialize(aggregate: RunAggregate): Promise<RunAggregate> {
    const paths = this.paths(aggregate.runId);
    await fsp.mkdir(paths.runDir, { recursive: true });
    return withShortFileLock(paths.lock, async () => {
      const existing = await this.loadHighestUnlocked(paths);
      if (existing) throw new Error(`Run ${aggregate.runId} already exists.`);
      const sealed = seal(aggregate, 0, 0);
      await atomicWriteJson(this.walPath(paths, 0), sealed);
      await atomicWriteJson(paths.snapshot, sealed);
      await atomicWriteJson(paths.fence, { epoch: 0, updatedAt: aggregate.createdAt });
      return sealed;
    });
  }

  async load(runId: string): Promise<RunAggregate> {
    const paths = this.paths(runId);
    return withShortFileLock(paths.lock, async () => {
      const loaded = await this.loadHighestUnlocked(paths);
      if (!loaded) throw new Error(`No valid v1 run aggregate exists for ${runId}.`);
      return loaded;
    });
  }

  async acquireFencingEpoch(runId: string): Promise<RunAggregate> {
    const paths = this.paths(runId);
    return withShortFileLock(paths.lock, async () => {
      const latest = await this.requireHighestUnlocked(paths, runId);
      const fence = await this.readUnknown(paths.fence) as FenceRecord | null;
      const nextEpoch = Math.max(latest.fencingEpoch, fence?.epoch ?? 0) + 1;
      await atomicWriteJson(paths.fence, {
        epoch: nextEpoch,
        updatedAt: new Date().toISOString(),
      });
      return this.persistUnlocked(paths, latest, latest.revision + 1, nextEpoch);
    });
  }

  async commit(
    aggregate: RunAggregate,
    expectedRevision: number,
    fencingEpoch: number
  ): Promise<RunAggregate> {
    const paths = this.paths(aggregate.runId);
    return withShortFileLock(paths.lock, async () => {
      const latest = await this.requireHighestUnlocked(paths, aggregate.runId);
      if (latest.revision !== expectedRevision) {
        throw new RunRevisionConflictError(expectedRevision, latest.revision);
      }
      const fence = await this.readUnknown(paths.fence) as FenceRecord | null;
      const currentEpoch = Math.max(latest.fencingEpoch, fence?.epoch ?? 0);
      if (fencingEpoch !== currentEpoch) {
        throw new RunFencingConflictError(fencingEpoch, currentEpoch);
      }
      return this.persistUnlocked(paths, aggregate, expectedRevision + 1, fencingEpoch);
    });
  }

  async commitOffline(
    aggregate: RunAggregate,
    expectedRevision: number,
    requestId: string
  ): Promise<RunAggregate> {
    if (!SAFE_RUN_ID.test(requestId)) throw new Error(`Invalid request id: ${requestId}.`);
    const paths = this.paths(aggregate.runId);
    return withShortFileLock(paths.lock, async () => {
      const latest = await this.requireHighestUnlocked(paths, aggregate.runId);
      if (latest.processedRequestIds.includes(requestId)) return latest;
      if (latest.revision !== expectedRevision) {
        throw new RunRevisionConflictError(expectedRevision, latest.revision);
      }
      const candidate = clone(aggregate);
      candidate.processedRequestIds = [
        ...new Set([...candidate.processedRequestIds, requestId]),
      ].slice(-256);
      return this.persistUnlocked(
        paths,
        candidate,
        expectedRevision + 1,
        latest.fencingEpoch
      );
    });
  }

  private paths(runId: string): {
    runDir: string;
    snapshot: string;
    lock: string;
    wal: string;
    fence: string;
  } {
    if (!SAFE_RUN_ID.test(runId)) throw new Error(`Unsafe run id: ${runId}.`);
    const root = path.resolve(this.options.runsRoot);
    const runDir = path.resolve(root, runId);
    const relative = path.relative(root, runDir);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Run path escapes configured runs root: ${runId}.`);
    }
    return {
      runDir,
      snapshot: path.join(runDir, this.snapshotFileName),
      lock: path.join(runDir, this.lockFileName),
      wal: path.join(runDir, this.walDirectoryName),
      fence: path.join(runDir, this.fenceFileName),
    };
  }

  private walPath(paths: ReturnType<FileRunRepository["paths"]>, revision: number): string {
    return path.join(paths.wal, `revision_${String(revision).padStart(12, "0")}.json`);
  }

  private async requireHighestUnlocked(
    paths: ReturnType<FileRunRepository["paths"]>,
    runId: string
  ): Promise<RunAggregate> {
    const latest = await this.loadHighestUnlocked(paths);
    if (!latest) throw new Error(`No valid v1 run aggregate exists for ${runId}.`);
    return latest;
  }

  private async loadHighestUnlocked(
    paths: ReturnType<FileRunRepository["paths"]>
  ): Promise<RunAggregate | null> {
    const candidates: RunAggregate[] = [];
    const snapshot = await this.readUnknown(paths.snapshot);
    if (isValid(snapshot)) candidates.push(snapshot);
    await fsp.mkdir(paths.wal, { recursive: true });
    const names = (await fsp.readdir(paths.wal).catch(() => [] as string[])).filter((name) =>
      /^revision_\d+\.json$/u.test(name)
    );
    for (const name of names) {
      const candidate = await this.readUnknown(path.join(paths.wal, name));
      if (isValid(candidate)) candidates.push(candidate);
    }
    if (candidates.length === 0) return null;
    const highest = candidates.sort((left, right) => right.revision - left.revision)[0];
    if (!isValid(snapshot) || snapshot.revision < highest.revision) {
      await atomicWriteJson(paths.snapshot, highest);
    }
    return clone(highest);
  }

  private async persistUnlocked(
    paths: ReturnType<FileRunRepository["paths"]>,
    aggregate: Readonly<RunAggregate>,
    revision: number,
    fencingEpoch: number
  ): Promise<RunAggregate> {
    const sealed = seal(aggregate, revision, fencingEpoch);
    await atomicWriteJson(this.walPath(paths, revision), sealed);
    await atomicWriteJson(paths.snapshot, sealed);
    const names = (await fsp.readdir(paths.wal)).filter((name) =>
      /^revision_\d+\.json$/u.test(name)
    ).sort();
    for (const name of names.slice(0, Math.max(0, names.length - this.maxWalRecords))) {
      await fsp.rm(path.join(paths.wal, name), { force: true });
    }
    return sealed;
  }

  private async readUnknown(filePath: string): Promise<unknown | null> {
    try {
      return JSON.parse(await fsp.readFile(filePath, "utf8")) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      return null;
    }
  }
}
