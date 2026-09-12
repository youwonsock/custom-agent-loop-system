import * as os from "node:os";
import * as path from "node:path";
import * as fsp from "node:fs/promises";
import * as fs from "node:fs";
import { CliOptions } from "./application";

export type PathDialect = "win32" | "posix";

export interface RootSet {
  codeRoot: string;
  configRoot: string;
  projectRoot: string;
  dataRoot: string;
}

export interface RootResolutionEnvironment {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  homeDir: string;
  currentWorkingDirectory: string;
  scriptPath: string;
}

const WINDOWS_RESERVED_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;
const WINDOWS_DEVICE_PREFIX = /^(?:\\\\[.?]\\|\\\?\?\\)/;

export function hostPathDialect(platform: NodeJS.Platform = process.platform): PathDialect {
  return platform === "win32" ? "win32" : "posix";
}

export function validateLocalRootPath(input: string, dialect: PathDialect): void {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new Error("Root path must be a non-empty string.");
  }
  if (input.includes("\0")) throw new Error("Root path contains a NUL byte.");
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(input)) {
    throw new Error(`Root path must be a local filesystem path, not a URI: ${input}`);
  }

  if (dialect === "win32") {
    const normalized = input.replace(/\//g, "\\");
    if (WINDOWS_DEVICE_PREFIX.test(normalized)) {
      throw new Error(`Windows device paths are not supported for roots: ${input}`);
    }
    if (normalized.startsWith("\\\\")) {
      throw new Error(`Network/UNC roots are not supported: ${input}`);
    }
    if (!path.win32.isAbsolute(normalized)) {
      throw new Error(`Windows root must be absolute: ${input}`);
    }
    const withoutDrive = normalized.replace(/^[A-Za-z]:/, "");
    if (withoutDrive.includes(":")) {
      throw new Error(`NTFS alternate data streams are not supported in roots: ${input}`);
    }
    for (const segment of withoutDrive.split("\\").filter(Boolean)) {
      const trimmed = segment.replace(/[ .]+$/g, "");
      if (trimmed.length === 0 || WINDOWS_RESERVED_NAME.test(trimmed)) {
        throw new Error(`Reserved Windows path segment is not supported: ${segment}`);
      }
    }
    return;
  }

  if (!path.posix.isAbsolute(input)) throw new Error(`POSIX root must be absolute: ${input}`);
  if (input.startsWith("//")) throw new Error(`Network-style POSIX roots are not supported: ${input}`);
}

function defaultCodeRoot(scriptPath: string, dialect: PathDialect): string {
  const pathApi = dialect === "win32" ? path.win32 : path.posix;
  const absoluteScript = pathApi.resolve(scriptPath);
  let cursor = pathApi.dirname(absoluteScript);
  while (true) {
    const configRoot = pathApi.join(cursor, "config");
    if (fs.existsSync(pathApi.join(configRoot, "agents.json")) && fs.existsSync(pathApi.join(configRoot, "protocol_contract.json"))) {
      return cursor;
    }
    const parent = pathApi.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  // Keep deterministic test/dev fallback for an unpacked dist entrypoint.
  const scriptDirectory = pathApi.dirname(absoluteScript);
  return pathApi.basename(scriptDirectory).toLowerCase() === "dist"
    ? pathApi.dirname(scriptDirectory)
    : pathApi.basename(pathApi.dirname(scriptDirectory)).toLowerCase() === "dist"
      ? pathApi.dirname(pathApi.dirname(scriptDirectory))
      : pathApi.basename(pathApi.dirname(scriptDirectory)).toLowerCase() === "core" &&
          pathApi.basename(pathApi.dirname(pathApi.dirname(scriptDirectory))).toLowerCase() === "dist"
        ? pathApi.dirname(pathApi.dirname(pathApi.dirname(scriptDirectory)))
      : scriptDirectory;
}

function defaultConfigRoot(environment: RootResolutionEnvironment): string {
  if (environment.platform === "win32") {
    const base =
      environment.env.APPDATA ??
      path.win32.join(environment.homeDir, "AppData", "Roaming");
    return path.win32.join(base, "AgentLoopOrchestrator");
  }
  if (environment.platform === "darwin") {
    return path.posix.join(
      environment.homeDir,
      "Library",
      "Application Support",
      "CustomAgentLoopSystem"
    );
  }
  const base =
    environment.env.XDG_CONFIG_HOME ?? path.posix.join(environment.homeDir, ".config");
  return path.posix.join(base, "custom-agent-loop-system");
}

function defaultDataRoot(environment: RootResolutionEnvironment): string {
  if (environment.platform === "win32") {
    const base =
      environment.env.LOCALAPPDATA ??
      environment.env.APPDATA ??
      path.win32.join(environment.homeDir, "AppData", "Local");
    return path.win32.join(base, "AgentLoopOrchestrator");
  }
  if (environment.platform === "darwin") {
    return path.posix.join(
      environment.homeDir,
      "Library",
      "Application Support",
      "CustomAgentLoopSystem"
    );
  }
  const base =
    environment.env.XDG_DATA_HOME ??
    path.posix.join(environment.homeDir, ".local", "share");
  return path.posix.join(base, "custom-agent-loop-system");
}

function resolveForDialect(value: string, dialect: PathDialect): string {
  return dialect === "win32" ? path.win32.resolve(value) : path.posix.resolve(value);
}

export function resolveRootSet(
  options: CliOptions,
  environment: RootResolutionEnvironment = {
    platform: process.platform,
    env: process.env,
    homeDir: os.homedir(),
    currentWorkingDirectory: process.cwd(),
    scriptPath: process.argv[1],
  }
): RootSet {
  const dialect = hostPathDialect(environment.platform);
  if (options.root !== undefined) {
    throw new Error("--root was removed in v8; use --data-root and --config-root.");
  }

  const codeRootInput =
    options["code-root"] && options["code-root"] !== "true"
      ? options["code-root"]
      : defaultCodeRoot(environment.scriptPath, dialect);
  const configRootInput =
    options["config-root"] && options["config-root"] !== "true"
      ? options["config-root"]
      : defaultConfigRoot(environment);
  const dataRootInput =
    options["data-root"] && options["data-root"] !== "true"
      ? options["data-root"]
      : defaultDataRoot(environment);
  const projectRootInput =
    options["project-root"] && options["project-root"] !== "true"
      ? options["project-root"]
      : options.target && options.target !== "true"
        ? options.target
        : environment.currentWorkingDirectory;

  const codeRoot = resolveForDialect(codeRootInput, dialect);
  const configRoot = resolveForDialect(configRootInput, dialect);
  const dataRoot = resolveForDialect(dataRootInput, dialect);
  const projectRoot = resolveForDialect(projectRootInput, dialect);
  validateLocalRootPath(configRoot, dialect);
  validateLocalRootPath(dataRoot, dialect);

  return {
    codeRoot,
    configRoot,
    projectRoot,
    dataRoot,
  };
}

export async function canonicalizeLocalRoot(
  rootPath: string,
  dialect: PathDialect = hostPathDialect()
): Promise<string> {
  validateLocalRootPath(rootPath, dialect);
  if (dialect !== hostPathDialect()) return rootPath;

  const missingSegments: string[] = [];
  let cursor = path.resolve(rootPath);
  while (true) {
    try {
      const stat = await fsp.stat(cursor);
      if (!stat.isDirectory()) throw new Error(`Root ancestor is not a directory: ${cursor}`);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw new Error(`No existing ancestor for root: ${rootPath}`);
      missingSegments.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
  const canonicalAncestor = await fsp.realpath(cursor);
  const canonical = path.join(canonicalAncestor, ...missingSegments);
  validateLocalRootPath(canonical, dialect);
  return canonical;
}

export async function canonicalizeRootSet(roots: RootSet): Promise<RootSet> {
  const [configRoot, dataRoot] = await Promise.all([
    canonicalizeLocalRoot(roots.configRoot),
    canonicalizeLocalRoot(roots.dataRoot),
  ]);
  return { ...roots, configRoot, dataRoot };
}
