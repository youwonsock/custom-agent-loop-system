import * as crypto from "node:crypto";
import * as path from "node:path";
import * as fsp from "node:fs/promises";
import { atomicReadJson, atomicWriteJson } from "./json_file_store";
import { LockRecord, SessionLease, checkProcessLiveness } from "./resilience";
import { RootSet, canonicalizeLocalRoot } from "./root_set";

export interface RootMigrationPaths {
  registryFileName: string;
  sessionsRoot: string;
  ownerLockFileName: string;
  leaseFileName: string;
}

export interface RootMigrationFile {
  group: "data" | "config";
  relativePath: string;
  sha256: string;
  bytes: number;
}

export interface RootMigrationManifest {
  version: 1;
  sourceRoot: string;
  dataRoot: string;
  configRoot: string;
  completedAt: string;
  files: RootMigrationFile[];
}

const MANIFEST_FILE_NAME = "migration_manifest.json";
const CONFIG_FILE_NAMES = ["loop_config.json", "agent_roles.json", "agent_loop.json"];

function isContained(basePath: string, candidatePath: string): boolean {
  const relative = path.relative(path.resolve(basePath), path.resolve(candidatePath));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

async function fileHash(filePath: string): Promise<{ sha256: string; bytes: number }> {
  const content = await fsp.readFile(filePath);
  return {
    sha256: crypto.createHash("sha256").update(content).digest("hex"),
    bytes: content.length,
  };
}

async function collectFiles(root: string, relativePath = ""): Promise<string[]> {
  const directory = path.join(root, relativePath);
  const entries = await fsp.readdir(directory, { withFileTypes: true }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  const files: string[] = [];
  for (const entry of entries) {
    const childRelative = path.join(relativePath, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Migration refuses symbolic links: ${childRelative}`);
    }
    if (entry.isDirectory()) files.push(...(await collectFiles(root, childRelative)));
    else if (entry.isFile()) files.push(childRelative);
    else throw new Error(`Migration refuses unsupported filesystem entries: ${childRelative}`);
  }
  return files;
}

async function assertNoLiveSessions(
  sourceRoot: string,
  paths: RootMigrationPaths
): Promise<void> {
  const sessionsRoot = path.join(sourceRoot, paths.sessionsRoot);
  const entries = await fsp.readdir(sessionsRoot, { withFileTypes: true }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const sessionDir = path.join(sessionsRoot, entry.name);
    const lease = await atomicReadJson<SessionLease>(path.join(sessionDir, paths.leaseFileName));
    if (lease && Date.parse(lease.expiresAt) > Date.now()) {
      throw new Error(`Cannot migrate live leased session '${entry.name}'.`);
    }
    const owner = await atomicReadJson<LockRecord>(path.join(sessionDir, paths.ownerLockFileName));
    if (owner && checkProcessLiveness(owner.ownerPid) !== "dead") {
      throw new Error(`Cannot migrate session '${entry.name}' while owner pid ${owner.ownerPid} may be alive.`);
    }
  }
}

async function validateJsonFiles(root: string, relativePaths: readonly string[]): Promise<void> {
  for (const relativePath of relativePaths) {
    if (!relativePath.toLowerCase().endsWith(".json")) continue;
    const content = await fsp.readFile(path.join(root, relativePath), "utf8");
    const parsed = JSON.parse(content) as unknown;
    if (!parsed || typeof parsed !== "object") {
      throw new Error(`Migrated JSON must contain an object or array: ${relativePath}`);
    }
  }
}

async function stageFiles(
  sourceRoot: string,
  targetRoot: string,
  stagingRoot: string,
  relativePaths: readonly string[],
  group: RootMigrationFile["group"]
): Promise<RootMigrationFile[]> {
  const records: RootMigrationFile[] = [];
  for (const relativePath of relativePaths) {
    const sourcePath = path.join(sourceRoot, relativePath);
    const stagedPath = path.join(stagingRoot, relativePath);
    if (!isContained(stagingRoot, stagedPath)) {
      throw new Error(`Migration staging path escaped its root: ${relativePath}`);
    }
    await fsp.mkdir(path.dirname(stagedPath), { recursive: true });
    await fsp.copyFile(sourcePath, stagedPath);
    const sourceDigest = await fileHash(sourcePath);
    const stagedDigest = await fileHash(stagedPath);
    if (sourceDigest.sha256 !== stagedDigest.sha256 || sourceDigest.bytes !== stagedDigest.bytes) {
      throw new Error(`Migration checksum mismatch while staging: ${relativePath}`);
    }
    records.push({ group, relativePath, ...sourceDigest });
  }
  await validateJsonFiles(stagingRoot, relativePaths);

  for (const record of records) {
    const stagedPath = path.join(stagingRoot, record.relativePath);
    const targetPath = path.join(targetRoot, record.relativePath);
    if (!isContained(targetRoot, targetPath)) {
      throw new Error(`Migration destination escaped its root: ${record.relativePath}`);
    }
    await fsp.mkdir(path.dirname(targetPath), { recursive: true });
    try {
      await fsp.rename(stagedPath, targetPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await fileHash(targetPath);
      if (existing.sha256 !== record.sha256 || existing.bytes !== record.bytes) {
        throw new Error(`Migration destination conflict: ${targetPath}`);
      }
      await fsp.rm(stagedPath, { force: true });
    }
    const promoted = await fileHash(targetPath);
    if (promoted.sha256 !== record.sha256 || promoted.bytes !== record.bytes) {
      throw new Error(`Migration checksum mismatch after promotion: ${targetPath}`);
    }
  }
  return records;
}

async function verifyCompletedManifest(manifest: RootMigrationManifest): Promise<void> {
  for (const record of manifest.files) {
    const root = record.group === "data" ? manifest.dataRoot : manifest.configRoot;
    const digest = await fileHash(path.join(root, record.relativePath));
    if (digest.sha256 !== record.sha256 || digest.bytes !== record.bytes) {
      throw new Error(`Completed migration verification failed: ${record.relativePath}`);
    }
  }
}

export async function migrateLegacyRoot(
  sourceRootInput: string,
  roots: RootSet,
  paths: RootMigrationPaths
): Promise<RootMigrationManifest> {
  const sourceRoot = await canonicalizeLocalRoot(sourceRootInput);
  const dataRoot = await canonicalizeLocalRoot(roots.dataRoot);
  const configRoot = await canonicalizeLocalRoot(roots.configRoot);
  if (sourceRoot === dataRoot || sourceRoot === configRoot) {
    throw new Error("Migration source and destination roots must be different.");
  }
  if (isContained(sourceRoot, dataRoot) || isContained(dataRoot, sourceRoot)) {
    throw new Error("Migration source and data roots must not contain one another.");
  }
  await assertNoLiveSessions(sourceRoot, paths);
  await Promise.all([
    fsp.mkdir(dataRoot, { recursive: true }),
    fsp.mkdir(configRoot, { recursive: true }),
  ]);

  const manifestPath = path.join(dataRoot, MANIFEST_FILE_NAME);
  const existing = await atomicReadJson<RootMigrationManifest>(manifestPath);
  if (existing) {
    if (
      existing.version !== 1 ||
      existing.sourceRoot !== sourceRoot ||
      existing.dataRoot !== dataRoot ||
      existing.configRoot !== configRoot
    ) {
      throw new Error(`Destination already contains a migration manifest for another source.`);
    }
    await verifyCompletedManifest(existing);
    return existing;
  }

  const sourceKey = crypto.createHash("sha256").update(sourceRoot).digest("hex").slice(0, 12);
  const dataStaging = path.join(dataRoot, `.migration-staging-${sourceKey}-data`);
  const configStaging = path.join(configRoot, `.migration-staging-${sourceKey}-config`);
  if (!isContained(dataRoot, dataStaging) || !isContained(configRoot, configStaging)) {
    throw new Error("Migration staging roots are not contained by their destinations.");
  }
  await Promise.all([
    fsp.mkdir(dataStaging, { recursive: true }),
    fsp.mkdir(configStaging, { recursive: true }),
  ]);

  const dataRelativePaths: string[] = [];
  const registryPath = path.join(sourceRoot, paths.registryFileName);
  if (await fsp.stat(registryPath).then((stat) => stat.isFile()).catch(() => false)) {
    dataRelativePaths.push(paths.registryFileName);
  }
  for (const relative of await collectFiles(sourceRoot, paths.sessionsRoot)) {
    dataRelativePaths.push(relative);
  }
  const configRelativePaths: string[] = [];
  for (const fileName of CONFIG_FILE_NAMES) {
    if (await fsp.stat(path.join(sourceRoot, fileName)).then((stat) => stat.isFile()).catch(() => false)) {
      configRelativePaths.push(fileName);
    }
  }

  const files = [
    ...(await stageFiles(sourceRoot, dataRoot, dataStaging, dataRelativePaths, "data")),
    ...(await stageFiles(sourceRoot, configRoot, configStaging, configRelativePaths, "config")),
  ].sort((left, right) =>
    `${left.group}:${left.relativePath}`.localeCompare(`${right.group}:${right.relativePath}`)
  );
  const manifest: RootMigrationManifest = {
    version: 1,
    sourceRoot,
    dataRoot,
    configRoot,
    completedAt: new Date().toISOString(),
    files,
  };
  await atomicWriteJson(manifestPath, manifest);
  await Promise.all([
    fsp.rm(dataStaging, { recursive: true, force: true }),
    configStaging === dataStaging
      ? Promise.resolve()
      : fsp.rm(configStaging, { recursive: true, force: true }),
  ]);
  return manifest;
}
