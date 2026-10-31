import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AgentNode } from "../shared/domain";
import { isWithin } from "./access_paths";
import { InvocationOptions } from "./invocation_types";
import { ProgramIoPolicy, prepareProgramIo } from "./program_io";
import { IoUnavailable } from "./program_io_errors";

/** Set up the isolated program I/O policy and the provider environment around it. */
export function prepareKiloIsolation(
  node: AgentNode,
  opts: InvocationOptions,
  guard: NonNullable<InvocationOptions["programIoGuard"]>,
  env: Record<string, string>,
  readonly: boolean,
): ProgramIoPolicy {
  if (!opts.scopeRoots?.length)
    throw new IoUnavailable(
      `Program isolation requires the native target boundary guard.`,
    );
  if (opts.allowedPaths.length)
    throw new IoUnavailable(
      `Strict program isolation requires a single target project.`,
    );
  for (const name of [
    "kilo.json",
    "kilo.jsonc",
    "opencode.json",
    "opencode.jsonc",
  ])
    if (fs.existsSync(path.join("/Library/Application Support/kilo", name)))
      throw new IoUnavailable(
        `Managed native tool configuration requires a supported isolated integration.`,
      );
  const programIo = prepareProgramIo({
    cwd: opts.cwd,
    directory: guard.directory,
    testRole: node.type === "test",
    readOnly: readonly,
    protectedFiles: guard.protectedFiles,
    expiresAt: guard.expiresAt,
  });
  // Provider credentials stay in the trusted control plane; project configs,
  // external plugins/MCP/LSP/formatters cannot create an unconfined tool host.
  env.XDG_DATA_HOME =
    env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local/share");
  // SDK/config dependencies are trusted host control-plane code. Reuse one
  // private home per session; commands in the VM never mount or inherit it.
  env.HOME =
    guard.providerHome ?? path.join(programIo.directory, "provider-home");
  fs.mkdirSync(env.HOME, { recursive: true, mode: 0o700 });
  env.HOME = fs.realpathSync(env.HOME);
  if (isWithin(programIo.cwd, env.HOME))
    throw new IoUnavailable(
      `Provider control home must be outside the untrusted project.`,
    );
  env.XDG_CONFIG_HOME = path.join(env.HOME, ".config");
  env.XDG_CACHE_HOME = path.join(env.HOME, ".cache");
  env.XDG_STATE_HOME = path.join(env.HOME, ".local/state");
  env.KILO_CONFIG_DIR = path.join(env.XDG_CONFIG_HOME, "kilo");
  env.KILO_DISABLE_PROJECT_CONFIG = "true";
  env.KILO_DISABLE_EXTERNAL_SKILLS = "true";
  env.KILO_DISABLE_SKILL_SHELL = "true";
  env.KILO_DISABLE_AUTOUPDATE = "true";
  env.KILO_DISABLE_LSP_DOWNLOAD = "true";
  env.KILO_DISABLE_DEFAULT_PLUGINS = "true";
  env.KILO_DISABLE_CODEBASE_INDEXING = "true";
  env.KILO_DISABLE_FFF = "true";
  env.KILO_DISABLE_CLAUDE_CODE = "true";
  env.KILO_DISABLE_CLAUDE_CODE_PROMPT = "true";
  env.KILO_DISABLE_CLAUDE_CODE_SKILLS = "true";
  env.SHELL = "/bin/sh";
  env.ENV = "/dev/null";
  env.BASH_ENV = "/dev/null";
  for (const key of Object.keys(env))
    if (
      /^(?:NODE_OPTIONS|NODE_PATH|KILO_CONFIG|OPENCODE_CONFIG|KILO_PURE|DYLD_.*|LD_.*)$/.test(
        key,
      )
    )
      delete env[key];
  for (const name of [
    "NODE_OPTIONS",
    "NODE_PATH",
    "DYLD_INSERT_LIBRARIES",
    "DYLD_LIBRARY_PATH",
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
  ])
    env[name] = "";
  env.GIT_DIR = "/dev/null";
  env.GIT_WORK_TREE = opts.cwd;
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_OPTIONAL_LOCKS = "0";
  fs.mkdirSync(env.KILO_CONFIG_DIR, { recursive: true, mode: 0o700 });
  env.AGENT_GRAPH_PROGRAM_IO = JSON.stringify(programIo);
  return programIo;
}
