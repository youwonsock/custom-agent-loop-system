import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resolveBinaryForSpawn } from "./binary-resolution";
import {
  resolveProviderCapability,
  type ProviderAdapter,
  type ProviderCapabilityMode,
} from "./providers/provider-capabilities";
import type {
  ProviderCapabilityDecision,
  ProviderCapabilityRuntimePort,
} from "../application/ports/provider-capability-runtime-port";

const VERSION_PROBE_TIMEOUT_MS = 15_000;
const VERSION_PROBE_MAX_OUTPUT_BYTES = 64 * 1024;

function safeProbeEnvironment(): Record<string, string> {
  const names = process.platform === "win32"
    ? ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec", "COMSPEC", "TEMP", "TMP"]
    : ["PATH", "TMPDIR", "TMP", "TEMP"];
  const environment: Record<string, string> = {};
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

async function regularFile(candidate: string): Promise<string | null> {
  try {
    const stat = await fs.stat(candidate);
    return stat.isFile() ? path.resolve(candidate) : null;
  } catch {
    return null;
  }
}

async function resolveAbsoluteBinary(binary: string): Promise<string | null> {
  const resolved = resolveBinaryForSpawn(binary);
  if (path.isAbsolute(resolved)) return regularFile(resolved);
  if (resolved.includes("/") || resolved.includes("\\")) {
    return regularFile(path.resolve(resolved));
  }
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
        .split(";")
        .filter(Boolean)
    : [""];
  const directories = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const directory of directories) {
    for (const extension of extensions) {
      const found = await regularFile(path.join(directory, `${resolved}${extension}`));
      if (found) return found;
    }
  }
  return null;
}

async function commandShimLaunch(binary: string): Promise<{ file: string; args: string[] } | null> {
  if (path.extname(binary).toLowerCase() !== ".cmd") return null;
  try {
    const content = await fs.readFile(binary, "utf8");
    // npm-generated Windows shims invoke a JavaScript entry point relative to
    // the shim. Launch that entry point with this Node process rather than
    // routing an untrusted configured binary through cmd.exe.
    const match = content.match(/"%~dp0\\([^"\r\n]+\.js)"/iu);
    if (!match) return null;
    const script = path.resolve(path.dirname(binary), match[1].replace(/\\/gu, path.sep));
    const relative = path.relative(path.dirname(binary), script);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
    if (!await regularFile(script)) return null;
    return { file: process.execPath, args: [script, "--version"] };
  } catch {
    return null;
  }
}

async function probeVersion(binary: string): Promise<{ version: string | null; diagnostic: string | null }> {
  const shim = await commandShimLaunch(binary);
  const file = shim?.file ?? binary;
  const args = shim?.args ?? ["--version"];
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        cwd: path.dirname(binary),
        env: safeProbeEnvironment(),
        timeout: VERSION_PROBE_TIMEOUT_MS,
        maxBuffer: VERSION_PROBE_MAX_OUTPUT_BYTES,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = `${stderr || stdout || error.message}`.trim().replace(/\s+/gu, " ").slice(0, 1_000);
          resolve({ version: null, diagnostic: detail || "CLI version probe failed." });
          return;
        }
        const output = `${stdout}${stderr}`.trim().slice(0, VERSION_PROBE_MAX_OUTPUT_BYTES);
        resolve({ version: output || null, diagnostic: output ? null : "CLI version probe returned no version." });
      }
    );
  });
}

/**
 * Resolves and probes the executable at the recovery boundary.  No result is
 * cached: replacing a CLI binary between recovery attempts must force a fresh
 * capability decision rather than reuse stale evidence.
 */
export class ProviderCapabilityRuntime implements ProviderCapabilityRuntimePort {
  async inspect(
    adapter: ProviderAdapter,
    binary: string,
    mode: ProviderCapabilityMode
  ): Promise<ProviderCapabilityDecision> {
    const resolvedBinary = await resolveAbsoluteBinary(binary);
    if (!resolvedBinary) {
      const capability = resolveProviderCapability(adapter, mode);
      return {
        ...capability,
        resolvedBinary: null,
        diagnostic: `Could not resolve provider binary '${binary}'.`,
      };
    }
    const probe = await probeVersion(resolvedBinary);
    const capability = resolveProviderCapability(adapter, mode, { cliVersion: probe.version });
    return {
      ...capability,
      resolvedBinary,
      diagnostic: probe.diagnostic,
    };
  }
}
