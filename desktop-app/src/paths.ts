import * as path from "node:path";
import * as fsp from "node:fs/promises";

export const PRODUCT_FOLDER = "AgentLoopOrchestrator";

export interface DesktopRoots {
  codeRoot: string;
  configRoot: string;
  dataRoot: string;
}

export function resolveDesktopRoots(appPath: string, appData: string, localAppData: string): DesktopRoots {
  return {
    codeRoot: path.resolve(appPath, "core"),
    configRoot: path.resolve(appData, PRODUCT_FOLDER),
    dataRoot: path.resolve(localAppData, PRODUCT_FOLDER),
  };
}

function isUncOrDevicePath(value: string): boolean {
  const normalized = value.replace(/\//gu, "\\");
  return normalized.startsWith("\\\\");
}

function containsPath(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function overlapsPath(left: string, right: string): boolean {
  return containsPath(left, right) || containsPath(right, left);
}

export async function canonicalPath(value: string): Promise<string> {
  const absolute = path.resolve(value);
  try { return await fsp.realpath(absolute); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return absolute;
    throw error;
  }
}

/** Project roots must be local and separate from application-owned data. */
export async function validateProjectPath(projectPath: string, roots: DesktopRoots): Promise<string> {
  if (typeof projectPath !== "string" || !projectPath.trim()) throw new Error("A project directory is required.");
  const candidate = await canonicalPath(projectPath);
  if (isUncOrDevicePath(candidate)) throw new Error("UNC and device paths are not supported.");
  const [configRoot, dataRoot] = await Promise.all([canonicalPath(roots.configRoot), canonicalPath(roots.dataRoot)]);
  if (overlapsPath(configRoot, candidate) || overlapsPath(dataRoot, candidate)) {
    throw new Error("The project directory cannot be inside Agent Loop configuration or data roots.");
  }
  let stat: Awaited<ReturnType<typeof fsp.stat>>;
  try { stat = await fsp.stat(candidate); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("The selected project directory does not exist.");
    throw error;
  }
  if (!stat.isDirectory()) throw new Error("The selected project path is not a directory.");
  return candidate;
}

export async function initDesktopRoots(roots: DesktopRoots): Promise<void> {
  for (const [label, root] of [["configRoot", roots.configRoot], ["dataRoot", roots.dataRoot]] as const) {
    if (typeof root !== "string" || !root.trim() || isUncOrDevicePath(root)) {
      throw new Error(`${label} must be a local filesystem path.`);
    }
  }
  const configRoot = path.resolve(roots.configRoot);
  const dataRoot = path.resolve(roots.dataRoot);
  if (overlapsPath(configRoot, dataRoot)) {
    throw new Error("Configuration and data roots must be separate and non-overlapping.");
  }
  const codeRoot = path.resolve(roots.codeRoot);
  if (overlapsPath(codeRoot, configRoot) || overlapsPath(codeRoot, dataRoot)) {
    throw new Error("Packaged code root must be separate from configuration and data roots.");
  }
  await Promise.all([
    fsp.mkdir(configRoot, { recursive: true }),
    fsp.mkdir(dataRoot, { recursive: true }),
  ]);
  for (const [label, root] of [["configRoot", configRoot], ["dataRoot", dataRoot]] as const) {
    const stat = await fsp.stat(root);
    if (!stat.isDirectory()) throw new Error(`${label} is not a directory: ${root}`);
  }
  // Resolve all three roots after creation.  The packaged code tree is
  // normally inside an immutable ASAR, but development launchers and test
  // harnesses can provide it through a junction/symlink; lexical path checks
  // alone would allow that tree to alias the user-owned config/data roots.
  const [canonicalCode, canonicalConfig, canonicalData] = await Promise.all([
    canonicalPath(codeRoot),
    fsp.realpath(configRoot),
    fsp.realpath(dataRoot),
  ]);
  if (overlapsPath(canonicalCode, canonicalConfig) || overlapsPath(canonicalCode, canonicalData)) {
    throw new Error("Packaged code root resolves to a configuration or data root.");
  }
  if (overlapsPath(canonicalConfig, canonicalData)) {
    throw new Error("Configuration and data roots resolve to overlapping locations.");
  }
}
