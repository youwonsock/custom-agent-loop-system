import * as path from "node:path";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { spawn } from "node:child_process";
import type { ProviderConfig } from "../runtime/providers/provider-runtime";
import { resolveBinaryForSpawn } from "../runtime/binary-resolution";
import { atomicWriteJson } from "../infrastructure/json-file-store";
import { withShortFileLock } from "../infrastructure/resilience";
import {
  type ProviderDiscoveryResultV2,
  type SessionIndexProjectionV4,
  validateProviderDiscoveryResultV2,
  validateSessionIndexProjectionV4,
} from "../interfaces/operator/contracts";

export interface ProviderDiscoveryOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
  environment?: NodeJS.ProcessEnv;
}

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_MODELS = 2_000;

function executableCandidates(binary: string, environment: NodeJS.ProcessEnv): string[] {
  if (path.isAbsolute(binary)) return [binary];
  const dirs = (environment.PATH ?? "").split(path.delimiter).filter(Boolean);
  if (process.platform !== "win32") return dirs.map((directory) => path.join(directory, binary));
  const extensions = (environment.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";").map((extension) => extension.trim()).filter(Boolean);
  // A configured name may already contain an extension (most commonly a
  // .cmd/.bat shim). In that case check the name as-is before considering
  // PATHEXT variants; otherwise a name such as `provider.exe` would be
  // incorrectly expanded to `provider.exe.EXE`.
  const hasExecutableExtension = extensions.some((extension) =>
    extension.toLowerCase() === path.extname(binary).toLowerCase()
  );
  return dirs.flatMap((directory) => hasExecutableExtension
    ? [path.join(directory, binary)]
    : extensions.map((extension) => path.join(directory, `${binary}${extension}`)));
}

function isExecutableFile(candidate: string): boolean {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    // Windows does not expose a meaningful executable permission bit; the
    // existence check is the appropriate test there. POSIX providers must be
    // executable, otherwise spawn would fail even though the file exists.
    fs.accessSync(candidate, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolve a configured provider only when an actual executable exists. */
export function findProviderExecutable(binary: string, environment: NodeJS.ProcessEnv = process.env): string | null {
  const trimmed = binary.trim();
  if (!trimmed) return null;
  // Discovery accepts a PATH command name or an explicit absolute path only.
  // A relative path would resolve differently for the desktop and core
  // processes and could accidentally escape the operator's intended PATH.
  if (!path.isAbsolute(trimmed) && (trimmed.includes("/") || trimmed.includes("\\"))) return null;
  for (const candidate of executableCandidates(trimmed, environment)) {
    if (isExecutableFile(candidate)) return resolveBinaryForSpawn(candidate);
  }
  // Do not fall back to the parent process' PATH here. Discovery receives an
  // explicit environment (used by tests and by the desktop runner), so only a
  // command found in that PATH or an explicitly configured absolute path may
  // be reported as available.
  return null;
}

function boundedAppend(current: string, chunk: Buffer, maxBytes: number): string {
  const remaining = Math.max(0, maxBytes - Buffer.byteLength(current, "utf8"));
  if (remaining === 0) return current;
  return current + chunk.subarray(0, remaining).toString("utf8");
}

function redactDiagnostic(value: string, environment: NodeJS.ProcessEnv): string {
  let redacted = value;
  for (const [name, secret] of Object.entries(environment)) {
    if (!secret || !/(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/iu.test(name)) continue;
    redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted;
}

function parseModels(stdout: string): string[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  const candidates: string[] = [];
  const add = (value: unknown): void => {
    if (typeof value !== "string") return;
    const model = value.trim();
    if (model && model.length <= 512 && !candidates.includes(model)) candidates.push(model);
  };
  let parsedStructured = false;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    parsedStructured = true;
    const values = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object"
        ? ((parsed as { models?: unknown }).models ?? [])
        : [];
    if (Array.isArray(values)) {
      for (const value of values) {
        if (typeof value === "string") add(value);
        else if (value && typeof value === "object") {
          add((value as { id?: unknown; name?: unknown }).id);
          add((value as { id?: unknown; name?: unknown }).name);
        }
      }
    }
  } catch {
    // Most provider CLIs print one model per line or a small table.
  }
  if (parsedStructured) return candidates.slice(0, MAX_MODELS);
  for (const line of stdout.split(/\r?\n/u)) {
    const value = line.trim().replace(/^[-*•]\s*/u, "");
    if (!value || /^(model|models|name|id)\s*$/iu.test(value)) continue;
    // Avoid turning human-readable status/error lines into model ids.
    if (/^(error|warning|info|fetching|loading|installed)\b/iu.test(value)) continue;
    const columns = value.split(/\s{2,}|\t/u);
    add(columns[0]);
  }
  return candidates.slice(0, MAX_MODELS);
}

function errorResult(
  provider: ProviderConfig,
  providerId: string,
  discoveredAt: string,
  code: string,
  message: string,
  command: string | null = null
): ProviderDiscoveryResultV2 {
  return {
    schemaVersion: 2,
    providerId,
    label: provider.label,
    adapter: provider.adapter,
    binary: provider.binary,
    enabled: provider.enabled,
    available: false,
    models: [],
    discoveredAt,
    command,
    catalogSource: provider.modelCatalog.source,
    error: { code, message: message.slice(0, 2_000) },
  };
}

async function runModelCommand(
  executable: string,
  args: string[],
  options: ProviderDiscoveryOptions
): Promise<{ models: string[]; stderr: string; exitCode: number | null; timedOut: boolean; outputLimitExceeded: boolean }> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable, args, {
        cwd: process.cwd(),
        env: options.environment ?? process.env,
        windowsHide: true,
        shell: process.platform === "win32" && /\.(?:cmd|bat)$/iu.test(executable),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ models: [], stderr: error instanceof Error ? error.message : String(error), exitCode: -1, timedOut: false, outputLimitExceeded: false });
      return;
    }
    let stdout = "";
    let stderr = "";
    let totalOutputBytes = 0;
    let outputLimitExceeded = false;
    let timedOut = false;
    let settled = false;
    const stopForOutputLimit = (): void => {
      if (settled || outputLimitExceeded) return;
      outputLimitExceeded = true;
      try { child.kill(); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ESRCH") stderr = boundedAppend(stderr, Buffer.from(error instanceof Error ? error.message : String(error)), maxOutputBytes);
      }
      clearTimeout(timer);
      finish(null);
    };
    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      const environment = options.environment ?? process.env;
      resolve({
        models: parseModels(redactDiagnostic(stdout, environment)),
        stderr: redactDiagnostic(stderr, environment),
        exitCode,
        timedOut,
        outputLimitExceeded,
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ESRCH") stderr = boundedAppend(stderr, Buffer.from(error instanceof Error ? error.message : String(error)), maxOutputBytes);
      }
      finish(null);
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (totalOutputBytes + chunk.byteLength > maxOutputBytes) {
        stopForOutputLimit();
        return;
      }
      totalOutputBytes += chunk.byteLength;
      stdout = boundedAppend(stdout, chunk, maxOutputBytes);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (totalOutputBytes + chunk.byteLength > maxOutputBytes) {
        stopForOutputLimit();
        return;
      }
      totalOutputBytes += chunk.byteLength;
      stderr = boundedAppend(stderr, chunk, maxOutputBytes);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      stderr = boundedAppend(stderr, Buffer.from(error.message), maxOutputBytes);
      finish(-1);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      finish(typeof code === "number" ? code : null);
    });
  });
}

export async function discoverProvider(
  providerId: string,
  provider: ProviderConfig,
  options: ProviderDiscoveryOptions = {}
): Promise<ProviderDiscoveryResultV2> {
  const discoveredAt = new Date().toISOString();
  if (!provider.enabled) {
    return errorResult(provider, providerId, discoveredAt, "disabled", "Provider is disabled.");
  }
  const executable = findProviderExecutable(provider.binary, options.environment ?? process.env);
  if (!executable) {
    return errorResult(provider, providerId, discoveredAt, "not-installed", `Provider executable '${provider.binary}' was not found on PATH.`);
  }
  if (provider.modelCatalog.source === "configured") {
    return {
      schemaVersion: 2,
      providerId,
      label: provider.label,
      adapter: provider.adapter,
      binary: provider.binary,
      enabled: provider.enabled,
      available: true,
      models: [...provider.modelCatalog.models],
      discoveredAt,
      command: null,
      catalogSource: "configured",
      error: null,
    };
  }
  const command = `${executable} ${provider.modelCatalog.args.join(" ")}`;
  const result = await runModelCommand(executable, provider.modelCatalog.args, options);
  if (result.timedOut) return errorResult(provider, providerId, discoveredAt, "timeout", "Model discovery timed out.", command);
  if (result.outputLimitExceeded) return errorResult(provider, providerId, discoveredAt, "output-limit", "Model discovery output exceeded the configured limit.", command);
  if (result.exitCode !== 0) {
    return errorResult(provider, providerId, discoveredAt, "exit-nonzero", result.stderr || `Model discovery exited with ${String(result.exitCode)}.`, command);
  }
  if (result.models.length === 0) return errorResult(provider, providerId, discoveredAt, "empty-catalog", "Model discovery returned no models.", command);
  return {
    schemaVersion: 2,
    providerId,
    label: provider.label,
    adapter: provider.adapter,
    binary: provider.binary,
    enabled: provider.enabled,
    available: true,
    models: result.models,
    discoveredAt,
    command,
    catalogSource: "command",
    error: null,
  };
}

export async function discoverProviders(
  providers: Record<string, ProviderConfig>,
  options: ProviderDiscoveryOptions = {}
): Promise<ProviderDiscoveryResultV2[]> {
  const results = await Promise.all(
    Object.entries(providers).map(([id, provider]) => discoverProvider(id, provider, options))
  );
  return results.sort((left, right) => left.providerId.localeCompare(right.providerId));
}

/** Merge only discovery fields while preserving concurrent session metadata. */
export async function discoverAndMergeSessionIndex(
  indexPath: string,
  lockPath: string,
  discoveries: readonly ProviderDiscoveryResultV2[],
  _variantDefaults: Record<string, string[]> = {}
): Promise<SessionIndexProjectionV4> {
  const providerIds = new Set<string>();
  for (const discovery of discoveries) {
    validateProviderDiscoveryResultV2(discovery);
    if (providerIds.has(discovery.providerId)) throw new Error(`Provider discovery contains duplicate provider id: ${discovery.providerId}`);
    providerIds.add(discovery.providerId);
  }
  return withShortFileLock(lockPath, async () => {
    let parsed: unknown;
    try { parsed = JSON.parse(await fsp.readFile(indexPath, "utf8")) as unknown; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Session index is not initialized: ${indexPath}`);
      if (error instanceof SyntaxError) throw new Error(`Session index is not valid JSON: ${indexPath}`);
      throw error;
    }
    const current: SessionIndexProjectionV4 = validateSessionIndexProjectionV4(
      parsed,
    );
    const availableModels = [...new Set(
      discoveries.filter((entry) => entry.available).flatMap((entry) => entry.models)
    )].sort();
    const timestamps = discoveries.map((entry) => entry.discoveredAt).sort();
    const discoveredAt = timestamps.length > 0 ? timestamps[timestamps.length - 1] : null;
    const next: SessionIndexProjectionV4 = {
      ...current,
      version: 4,
      availableModels,
      modelsDiscoveredAt: discoveredAt,
      modelsDiscoveredCli: "provider-discovery-v2",
      // Discovery owns only the catalog/timestamp fields. Preserve operator
      // overrides and concurrent session metadata from the locked index.
      manualModelsOverride: current.manualModelsOverride,
      modelVariants: current.modelVariants,
      providerCatalog: Object.fromEntries(discoveries.map((entry) => [entry.providerId, entry])),
    };
    await atomicWriteJson(indexPath, next);
    return next;
  });
}
