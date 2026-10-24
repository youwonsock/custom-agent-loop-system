import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

/** Resolve names only. Never copy or log provider credentials/config contents. */
export async function kiloRecoveryAgents(
  binary: string, prefix: string[], cwd: string, env: Record<string, string>,
): Promise<string[]> {
  try {
    const {stdout} = await execute(binary, [...prefix, "debug", "config"], {
      cwd, env, timeout: 12_000, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
    const config: unknown = JSON.parse(stdout);
    if (!config || typeof config !== "object" || Array.isArray(config)) throw Error();
    const value = config as Record<string, unknown>;
    const agents = value.agent && typeof value.agent === "object" && !Array.isArray(value.agent)
      ? Object.keys(value.agent) : [];
    const names = new Set(["build", "code", ...agents]);
    if (typeof value.default_agent === "string") names.add(value.default_agent);
    if (names.size > 200 || [...names].some(n => !n || n.length > 200 || /[\r\n\0]/.test(n))) throw Error();
    return [...names];
  } catch {
    // execFile errors may contain the entire stdout/stderr (including secrets).
    throw new Error("Kilo write recovery could not resolve effective agent names; no model invocation was started by this preflight.");
  }
}
