import { AgentNode, ExecutionBinding, LocalConnection } from "../shared/domain";
import { resolveExecutable } from "./catalog";
import * as path from "node:path";
import { isReadOnly } from "../shared/node_roles";
import { claudeArguments } from "./invocation_claude";
import { codexArguments } from "./invocation_codex";
import { prepareKiloIsolation } from "./invocation_kilo";
import { runCliArguments } from "./invocation_run_cli";
import {
  Invocation,
  InvocationContext,
  InvocationOptions,
} from "./invocation_types";

function inheritedEnvironment(): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (v): v is [string, string] => typeof v[1] === "string",
    ),
  );
  // Windows names are case-insensitive but this copy is a plain object: a parent
  // "Path" would otherwise leave env.PATH unset and hand the child two spellings.
  const pathKeys = Object.keys(env).filter((key) =>
    process.platform === "win32"
      ? key.toUpperCase() === "PATH"
      : key === "PATH",
  );
  const inheritedPath = pathKeys.map((key) => env[key]).find(Boolean) ?? "";
  for (const key of pathKeys) delete env[key];
  env.PATH = [path.dirname(process.execPath), inheritedPath]
    .filter(Boolean)
    .join(path.delimiter);
  return env;
}
export async function buildInvocation(
  c: LocalConnection,
  b: ExecutionBinding,
  node: AgentNode,
  opts: InvocationOptions,
): Promise<Invocation> {
  const executable = await resolveExecutable(c.binary),
    readonly = isReadOnly(node.type),
    env = inheritedEnvironment();
  const programIo =
    c.type === "kilo" && opts.programIoGuard
      ? prepareKiloIsolation(node, opts, opts.programIoGuard, env, readonly)
      : undefined;
  const context: InvocationContext = {
    binding: b,
    opts,
    env,
    readonly,
    executable,
    ...(programIo ? { programIo } : {}),
  };
  const args =
    c.type === "codex"
      ? await codexArguments(context)
      : c.type === "claude"
        ? claudeArguments(context)
        : await runCliArguments(c, context);
  return {
    binary: executable.file,
    args: [...executable.prefix, ...args],
    env,
    ...(programIo ? { programIoPolicy: programIo } : {}),
    ...(c.type === "kilo" && process.platform === "win32"
      ? { transport: "pipe" as const }
      : {}),
  };
}
