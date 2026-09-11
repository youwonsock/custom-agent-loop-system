import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import * as path from "node:path";
import * as fsp from "node:fs/promises";
import type { RunRepositoryPort } from "../application/ports/run-repository";
import type { RunAggregate } from "../domain/run-aggregate";
import { atomicWriteJson } from "../../json_file_store";
import { withShortFileLock } from "../../resilience";

const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const WINDOWS_RESERVED_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/iu;

function safePathSegment(value: string, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty path segment.`);
  const candidate = value.trim();
  if (path.isAbsolute(candidate) || path.win32.isAbsolute(candidate) || path.posix.isAbsolute(candidate) || candidate.includes("\0")) {
    throw new Error(`${label} must be a relative path segment.`);
  }
  const normalized = candidate.replace(/\\/gu, "/");
  const parts = normalized.split("/");
  if (parts.length !== 1 || parts[0] === "." || parts[0] === ".." || !parts[0]) {
    throw new Error(`${label} contains an unsafe path segment.`);
  }
  if (/[\x00-\x1f<>:"|?*]/u.test(parts[0]) || /[ .]$/u.test(parts[0]) || WINDOWS_RESERVED_NAME.test(parts[0])) {
    throw new Error(`${label} contains a non-portable path segment.`);
  }
  return parts[0];
}

interface FenceRecord {
  epoch: number;
  updatedAt: string;
}

function validateFenceRecord(value: unknown, filePath: string): FenceRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Fencing record is invalid: ${filePath}`);
  const record = value as Partial<FenceRecord>;
  if (!Number.isSafeInteger(record.epoch) || Number(record.epoch) < 0 || typeof record.updatedAt !== "string" || !Number.isFinite(Date.parse(record.updatedAt))) {
    throw new Error(`Fencing record is invalid: ${filePath}`);
  }
  return record as FenceRecord;
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
  sealed.schemaVersion = 2;
  sealed.revision = revision;
  sealed.fencingEpoch = fencingEpoch;
  sealed.checksum = "";
  sealed.checksum = runChecksum(sealed);
  return sealed;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasStrictCurrentAggregateShape(aggregate: RunAggregate): boolean {
  const definition = recordValue(aggregate.definition);
  const policy = definition ? recordValue(definition.applicationPolicy) : null;
  if (!definition || !policy || [
    "implementationNodeId", "testNodeId", "verificationNodeId", "qaNodeId", "completionApprovalNodeId",
  ].some((key) => typeof policy[key] !== "string" || !(policy[key] as string).trim())) return false;
  const context = recordValue(aggregate.context);
  if (!context || !Number.isSafeInteger(context.requestSequence) || Number(context.requestSequence) < 0) return false;
  const contract = context.verificationContract;
  if (contract !== null) {
    const item = recordValue(contract);
    if (!item || !Array.isArray(item.baselinePaths) || !recordValue(item.baselineFileHashes) || !recordValue(item.baselineFileModes) || typeof item.baselineFingerprint !== "string" || typeof item.baselineArtifactId !== "string" || !Array.isArray(item.commands)) return false;
    for (const command of item.commands) {
      const value = recordValue(command);
      if (!value || typeof value.id !== "string" || typeof value.executable !== "string" || !Array.isArray(value.args) || typeof value.cwd !== "string") return false;
    }
  }
  if (!Array.isArray(context.verificationRecords) || !Array.isArray(context.verificationCriteriaChanges) || !Array.isArray(context.reviewApprovals) || !Array.isArray(context.findings) || !Array.isArray(context.verificationFeedback)) return false;
  for (const record of context.verificationRecords) {
    const value = recordValue(record);
    if (!value || typeof value.approvedExecutable !== "string" || !Array.isArray(value.approvedArgs) || value.approvedArgs.some((arg) => typeof arg !== "string") || typeof value.approvedCwd !== "string") return false;
  }
  const candidate = context.verificationCandidate;
  if (candidate !== null) {
    const value = recordValue(candidate);
    if (!value || typeof value.baselineFingerprint !== "string" || !Array.isArray(value.baselinePaths) || !recordValue(value.baselineFileHashes) || !recordValue(value.baselineFileModes) || typeof value.totalTimeoutMs !== "number" || !Array.isArray(value.protectedPaths) || !Array.isArray(value.testRoots) || !Array.isArray(value.allowedNewTestRoots) || !Array.isArray(value.generatedOutputPaths)) return false;
  }
  return true;
}

function isValid(value: unknown): value is RunAggregate {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const aggregate = value as Partial<RunAggregate>;
  return (
    aggregate.schemaVersion === 2 &&
    typeof aggregate.runId === "string" &&
    Number.isSafeInteger(aggregate.revision) &&
    Number(aggregate.revision) >= 0 &&
    Number.isSafeInteger(aggregate.fencingEpoch) &&
    Number(aggregate.fencingEpoch) >= 0 &&
    typeof aggregate.checksum === "string" &&
    aggregate.checksum.length === 64 &&
    runChecksum(aggregate as RunAggregate) === aggregate.checksum &&
    hasStrictCurrentAggregateShape(aggregate as RunAggregate)
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

  async init(aggregate: RunAggregate): Promise<RunAggregate> {
    const paths = this.paths(aggregate.runId);
    await this.requireInitializedStorage(paths);
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
      if (!loaded) throw new Error(`No valid v2 run aggregate exists for ${runId}.`);
      return loaded;
    });
  }

  async acquireFencingEpoch(runId: string): Promise<RunAggregate> {
    const paths = this.paths(runId);
    return withShortFileLock(paths.lock, async () => {
      const latest = await this.requireHighestUnlocked(paths, runId);
      const fenceRaw = await this.readUnknown(paths.fence);
      if (fenceRaw === null) throw new Error(`Fencing record is missing: ${paths.fence}`);
      const fence = validateFenceRecord(fenceRaw, paths.fence);
      const nextEpoch = Math.max(latest.fencingEpoch, fence.epoch) + 1;
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
      const fenceRaw = await this.readUnknown(paths.fence);
      if (fenceRaw === null) throw new Error(`Fencing record is missing: ${paths.fence}`);
      const fence = validateFenceRecord(fenceRaw, paths.fence);
      const currentEpoch = Math.max(latest.fencingEpoch, fence.epoch);
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
    const snapshotFileName = safePathSegment(this.snapshotFileName, "snapshotFileName");
    const lockFileName = safePathSegment(this.lockFileName, "lockFileName");
    const walDirectoryName = safePathSegment(this.walDirectoryName, "walDirectoryName");
    const fenceFileName = safePathSegment(this.fenceFileName, "fenceFileName");
    return {
      runDir,
      snapshot: path.join(runDir, snapshotFileName),
      lock: path.join(runDir, lockFileName),
      wal: path.join(runDir, walDirectoryName),
      fence: path.join(runDir, fenceFileName),
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
    if (!latest) throw new Error(`No valid v2 run aggregate exists for ${runId}.`);
    return latest;
  }

  private async requireInitializedStorage(
    paths: ReturnType<FileRunRepository["paths"]>
  ): Promise<void> {
    for (const directory of [paths.runDir, paths.wal]) {
      let stat: Awaited<ReturnType<typeof fsp.stat>>;
      try { stat = await fsp.stat(directory); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error(`Run storage is not initialized: ${directory}`);
        }
        throw error;
      }
      if (!stat.isDirectory()) throw new Error(`Run storage path is not a directory: ${directory}`);
    }
  }

  private async loadHighestUnlocked(
    paths: ReturnType<FileRunRepository["paths"]>
  ): Promise<RunAggregate | null> {
    const candidates: RunAggregate[] = [];
    const snapshot = await this.readUnknown(paths.snapshot);
    if (snapshot !== null) {
      if (!isValid(snapshot)) throw new Error(`Run snapshot failed integrity validation: ${paths.snapshot}`);
      candidates.push(snapshot);
    }
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(paths.wal, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Run WAL directory is not initialized: ${paths.wal}`);
      }
      throw error;
    }
    const names: string[] = [];
    for (const entry of entries) {
      if (/^revision_\d+\.json$/u.test(entry.name)) {
        if (!entry.isFile()) throw new Error(`Run WAL record is not a regular file: ${path.join(paths.wal, entry.name)}`);
        names.push(entry.name);
        continue;
      }
      // A process can leave an atomic-write temporary behind after a crash;
      // it is non-authoritative and may be discarded on the next successful
      // commit. Every other WAL entry is an unexplained state and fails fast.
      if (/^revision_\d+\.json\.tmp\.\d+\.\d+(?:\.[a-f0-9]+)?$/u.test(entry.name)) continue;
      throw new Error(`Unexpected run WAL entry: ${path.join(paths.wal, entry.name)}`);
    }
    for (const name of names) {
      const candidate = await this.readUnknown(path.join(paths.wal, name));
      if (candidate === null) continue;
      if (!isValid(candidate)) throw new Error(`Run WAL record failed integrity validation: ${path.join(paths.wal, name)}`);
      const revisionText = name.slice("revision_".length, -".json".length);
      const encodedRevision = Number(revisionText);
      if (!Number.isSafeInteger(encodedRevision) || encodedRevision !== candidate.revision) {
        throw new Error(`Run WAL filename does not match its revision: ${path.join(paths.wal, name)}`);
      }
      candidates.push(candidate);
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
    const entries = await fsp.readdir(paths.wal, { withFileTypes: true });
    const names: string[] = [];
    for (const entry of entries) {
      if (/^revision_\d+\.json$/u.test(entry.name)) {
        if (!entry.isFile()) throw new Error(`Run WAL record is not a regular file: ${path.join(paths.wal, entry.name)}`);
        names.push(entry.name);
      } else if (!/^revision_\d+\.json\.tmp\.\d+\.\d+(?:\.[a-f0-9]+)?$/u.test(entry.name)) {
        throw new Error(`Unexpected run WAL entry: ${path.join(paths.wal, entry.name)}`);
      }
    }
    names.sort();
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
      if (error instanceof SyntaxError) throw new Error(`Malformed JSON: ${filePath}`);
      throw error;
    }
  }
}
