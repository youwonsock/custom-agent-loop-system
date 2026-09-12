import * as path from "node:path";
import * as fsp from "node:fs/promises";
import type { LoopConfig } from "../config/runtime-config";
import { assertSafeSessionId, getControlQueuePaths, initControlQueue } from "./resilience";

/**
 * Initialize the non-authoritative directory layout owned by one run.
 * Snapshot, WAL records, projections, and summaries are deliberately not
 * synthesized here; their owning component creates them as part of a commit.
 */
export async function initRunStorage(
  dataRoot: string,
  runId: string,
  config: { paths: Pick<LoopConfig["paths"], "sessionsRoot" | "attemptLogsDirName" | "controlDirName"> & {
    /** Optional for focused test fixtures that do not persist verification logs. */
    verificationLogsDirName?: string;
  } }
): Promise<{ runsRoot: string; sessionDirectory: string }> {
  assertSafeSessionId(runId);
  const canonicalDataRoot = path.resolve(dataRoot);
  const dataStat = await fsp.stat(canonicalDataRoot);
  if (!dataStat.isDirectory()) throw new Error(`Data root is not a directory: ${canonicalDataRoot}`);
  const canonicalData = await fsp.realpath(canonicalDataRoot);
  const runsRoot = path.resolve(canonicalDataRoot, config.paths.sessionsRoot);
  const runsRelative = path.relative(canonicalDataRoot, runsRoot);
  if (runsRelative.startsWith("..") || path.isAbsolute(runsRelative)) {
    throw new Error(`Sessions root escapes the configured data root: ${config.paths.sessionsRoot}.`);
  }
  const sessionDirectory = path.resolve(runsRoot, runId);
  const relative = path.relative(runsRoot, sessionDirectory);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Run path escapes configured data root: ${runId}.`);
  }
  const containedDirectory = (name: string, label: string): string => {
    if (!name || name.includes("\0") || path.isAbsolute(name) || path.win32.isAbsolute(name)) {
      throw new Error(`${label} must be a relative path.`);
    }
    const portableParts = name.replace(/\\/gu, "/").split("/");
    if (portableParts.some((part) => !part || part === "." || part === "..")) {
      throw new Error(`${label} contains an unsafe path segment.`);
    }
    const resolved = path.resolve(sessionDirectory, portableParts.join(path.sep));
    const childRelative = path.relative(sessionDirectory, resolved);
    if (!childRelative || childRelative.startsWith("..") || path.isAbsolute(childRelative)) {
      throw new Error(`${label} escapes the session storage directory.`);
    }
    return resolved;
  };
  const attemptLogsDirectory = containedDirectory(config.paths.attemptLogsDirName, "attemptLogsDirName");
  const verificationLogsDirectory = containedDirectory(
    config.paths.verificationLogsDirName ?? "verification_logs",
    "verificationLogsDirName"
  );
  const controlDirectory = containedDirectory(config.paths.controlDirName, "controlDirName");
  await fsp.mkdir(runsRoot, { recursive: true });
  const canonicalRunsRoot = await fsp.realpath(runsRoot);
  const runsCanonicalRelative = path.relative(canonicalData, canonicalRunsRoot);
  if (!runsCanonicalRelative || runsCanonicalRelative.startsWith("..") || path.isAbsolute(runsCanonicalRelative)) {
    throw new Error(`Sessions root resolves outside the configured data root: ${runsRoot}.`);
  }
  await fsp.mkdir(sessionDirectory, { recursive: true });
  const canonicalSessionDirectory = await fsp.realpath(sessionDirectory);
  const sessionCanonicalRelative = path.relative(canonicalRunsRoot, canonicalSessionDirectory);
  if (!sessionCanonicalRelative || sessionCanonicalRelative.startsWith("..") || path.isAbsolute(sessionCanonicalRelative)) {
    throw new Error(`Run path resolves outside the configured sessions root: ${sessionDirectory}.`);
  }
  await Promise.all([
    fsp.mkdir(path.join(sessionDirectory, "run_wal"), { recursive: true }),
    fsp.mkdir(path.join(sessionDirectory, "artifacts"), { recursive: true }),
    fsp.mkdir(attemptLogsDirectory, { recursive: true }),
    fsp.mkdir(verificationLogsDirectory, { recursive: true }),
    fsp.mkdir(path.join(sessionDirectory, "runtime_inputs"), { recursive: true }),
    fsp.mkdir(controlDirectory, { recursive: true }),
  ]);
  for (const directory of [
    path.join(sessionDirectory, "run_wal"),
    path.join(sessionDirectory, "artifacts"),
    attemptLogsDirectory,
    verificationLogsDirectory,
    path.join(sessionDirectory, "runtime_inputs"),
    controlDirectory,
  ]) {
    const canonicalDirectory = await fsp.realpath(directory);
    const directoryRelative = path.relative(canonicalSessionDirectory, canonicalDirectory);
    if (!directoryRelative || directoryRelative.startsWith("..") || path.isAbsolute(directoryRelative)) {
      throw new Error(`Run storage path resolves outside the session directory: ${directory}.`);
    }
  }
  await initControlQueue(getControlQueuePaths(sessionDirectory, path.relative(sessionDirectory, controlDirectory)));
  return { runsRoot, sessionDirectory };
}
