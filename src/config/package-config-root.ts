import * as fs from "node:fs";
import * as path from "node:path";

const REQUIRED_MARKERS = ["agents.json", "protocol_contract.json"] as const;

function isPackagedConfigRoot(candidate: string): boolean {
  return REQUIRED_MARKERS.every((marker) => {
    try {
      return fs.statSync(path.join(candidate, marker)).isFile();
    } catch {
      return false;
    }
  });
}

/** Resolve a definition directory explicitly associated with a code root. */
export function resolvePackagedConfigRoot(codeRoot: string): string {
  if (typeof codeRoot !== "string" || !codeRoot.trim()) {
    throw new Error("Packaged code root must be a non-empty path.");
  }
  const root = path.resolve(codeRoot);
  const configRoot = path.join(root, "config");
  if (!isPackagedConfigRoot(configRoot)) {
    throw new Error(`Packaged config root is missing required definition markers: ${configRoot}`);
  }
  return configRoot;
}

/** Find the nearest packaged config directory without using process.cwd(). */
export function findPackagedConfigRoot(startDirectory: string): string {
  if (typeof startDirectory !== "string" || !startDirectory.trim()) {
    throw new Error("Packaged config search directory must be a non-empty path.");
  }
  let cursor = path.resolve(startDirectory);
  try {
    if (!fs.statSync(cursor).isDirectory()) cursor = path.dirname(cursor);
  } catch {
    cursor = path.dirname(cursor);
  }
  while (true) {
    const candidate = path.join(cursor, "config");
    if (isPackagedConfigRoot(candidate)) return candidate;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  throw new Error(`Unable to locate packaged config from ${path.resolve(startDirectory)}.`);
}

export function readPackagedConfigJson<T>(fileName: string, startDirectory = __dirname): T {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\.json$/u.test(fileName)) {
    throw new Error(`Invalid packaged config filename: ${fileName}`);
  }
  const root = findPackagedConfigRoot(startDirectory);
  try {
    return JSON.parse(fs.readFileSync(path.join(root, fileName), "utf8")) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot load packaged config ${path.join(root, fileName)}: ${message}`);
  }
}
