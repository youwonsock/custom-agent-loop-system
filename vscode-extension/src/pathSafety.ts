import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { LoopPathsConfig } from "./types";

function isOutside(basePath: string, candidatePath: string): boolean {
  const relative = path.relative(basePath, candidatePath);
  return (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  );
}

export async function canonicalizePathThroughExistingParents(inputPath: string): Promise<string> {
  let current = path.resolve(inputPath);
  const missingSegments: string[] = [];

  while (true) {
    try {
      const real = await fs.realpath(current);
      return path.resolve(real, ...missingSegments);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
      const parent = path.dirname(current);
      if (parent === current) throw err;
      missingSegments.unshift(path.basename(current));
      current = parent;
    }
  }
}

export function assertSafeRelativePath(
  value: unknown,
  label: string,
  singleSegment = false
): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty relative path.`);
  }
  const candidate = value;
  if (
    path.isAbsolute(candidate) ||
    path.win32.isAbsolute(candidate) ||
    path.posix.isAbsolute(candidate) ||
    /^[A-Za-z]:/.test(candidate) ||
    candidate.includes("\0")
  ) {
    throw new Error(`${label} must stay relative to the Agent Loop data root.`);
  }
  const portableParts = candidate.replace(/\\/g, "/").split("/");
  if (
    portableParts.some(
      (part) => {
        if (!part || part === "." || part === "..") return true;
        if (part.trim() !== part || part.endsWith(".") || part.endsWith(" ")) return true;
        if (/[<>:"|?*\x00-\x1F\x7F]/.test(part)) return true;
        return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part);
      }
    )
  ) {
    throw new Error(`${label} contains an unsafe path segment.`);
  }
  if (singleSegment && portableParts.length !== 1) {
    throw new Error(`${label} must be a single path segment.`);
  }
  return candidate;
}

export function validateLoopPathsConfig(paths: LoopPathsConfig): LoopPathsConfig {
  assertSafeRelativePath(paths.sessionsRoot, "paths.sessionsRoot");
  for (const [key, value] of Object.entries({
    registryFileName: paths.registryFileName,
    sessionsIndexFileName: paths.sessionsIndexFileName,
    variantsConfigFileName: paths.variantsConfigFileName,
    loopHistoryDirName: paths.loopHistoryDirName,
    controlDirName: paths.controlDirName,
    ownerLockFileName: paths.ownerLockFileName,
    stateLockFileName: paths.stateLockFileName,
    leaseFileName: paths.leaseFileName,
    registryLockFileName: paths.registryLockFileName,
    attemptLogsDirName: paths.attemptLogsDirName,
  })) {
    assertSafeRelativePath(value, `paths.${key}`, true);
  }
  for (const [key, value] of Object.entries(paths.sessionFileNames)) {
    assertSafeRelativePath(value, `paths.sessionFileNames.${key}`, true);
  }
  for (const [key, value] of Object.entries(paths.roomFileNames)) {
    assertSafeRelativePath(value, `paths.roomFileNames.${key}`, true);
  }
  for (const [key, value] of Object.entries(paths.roomDirNames)) {
    assertSafeRelativePath(value, `paths.roomDirNames.${key}`, true);
  }
  return paths;
}

export function resolveConfiguredDataRoot(configuredRoot: string): string {
  if (!configuredRoot || !path.isAbsolute(configuredRoot)) {
    throw new Error(
      `agentLoop.rootDir must be empty or an absolute path outside the workspace; received ${JSON.stringify(configuredRoot)}.`
    );
  }
  return path.resolve(configuredRoot);
}

export async function resolveContainedPath(
  basePath: string,
  configuredPath: string,
  label: string,
  allowBase = false
): Promise<string> {
  const resolvedBase = path.resolve(basePath);
  const resolvedCandidate = path.isAbsolute(configuredPath)
    ? path.resolve(configuredPath)
    : path.resolve(resolvedBase, configuredPath);
  const lexicalRelative = path.relative(resolvedBase, resolvedCandidate);
  if (
    (!allowBase && !lexicalRelative) ||
    isOutside(resolvedBase, resolvedCandidate)
  ) {
    throw new Error(`${label} escapes its allowed directory: ${configuredPath}`);
  }

  const [canonicalBase, canonicalCandidate] = await Promise.all([
    canonicalizePathThroughExistingParents(resolvedBase),
    canonicalizePathThroughExistingParents(resolvedCandidate),
  ]);
  if (
    (!allowBase && canonicalBase === canonicalCandidate) ||
    isOutside(canonicalBase, canonicalCandidate)
  ) {
    throw new Error(`${label} escapes its allowed directory through a symbolic link or junction.`);
  }
  return resolvedCandidate;
}

export async function assertPathOutsideBases(
  candidatePath: string,
  protectedBasePaths: readonly string[],
  label: string
): Promise<string> {
  const canonicalCandidate = await canonicalizePathThroughExistingParents(candidatePath);
  for (const protectedBasePath of protectedBasePaths) {
    const canonicalBase = await canonicalizePathThroughExistingParents(protectedBasePath);
    if (!isOutside(canonicalBase, canonicalCandidate)) {
      throw new Error(
        `${label} '${canonicalCandidate}' must be outside '${canonicalBase}'.`
      );
    }
  }
  return canonicalCandidate;
}

export async function runWithIsolatedDataRoot<T>(
  candidatePath: string,
  protectedBasePaths: readonly string[],
  operation: (canonicalRoot: string) => Promise<T>
): Promise<T> {
  const canonicalRoot = await assertPathOutsideBases(
    candidatePath,
    protectedBasePaths,
    "Agent Loop data root"
  );
  return operation(canonicalRoot);
}
