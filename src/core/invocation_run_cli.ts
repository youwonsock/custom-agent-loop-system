import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { InvocationContext } from "./invocation_types";
import { kiloRecoveryAgents } from "./kilo_recovery";

/** Only role/access restrictions belong to the orchestrator. Native tools,
 * MCP, web, plugins, skills and hooks retain their CLI configuration. */
function nativePermission(
  c: { type: string },
  { opts, readonly, programIo }: InvocationContext,
): Record<string, unknown> {
  const permission: Record<string, unknown> = {
    edit: readonly ? "deny" : "allow",
  };
  if (readonly) permission.bash = programIo ? "allow" : "deny";
  if (programIo) {
    permission["*"] = "deny";
    permission.bash = "allow";
    permission.todowrite = "allow";
    permission.edit = "deny";
  }
  if (opts.allowedPaths.length)
    permission.external_directory = Object.fromEntries(
      opts.allowedPaths.map((p) => [
        `${p.replace(/\\/g, "/").replace(/\/$/, "")}/**`,
        "allow",
      ]),
    );
  if (c.type === "kilo" && opts.scopeRoots)
    permission.external_directory = {
      "*": "deny",
      ...Object.fromEntries(
        opts.scopeRoots.flatMap((p) => {
          const root = p.replace(/\\/g, "/").replace(/\/$/, "");
          return [
            [root, "allow"],
            [`${root}/**`, "allow"],
          ];
        }),
      ),
    };
  return permission;
}
/** Hands the Kilo protocol plugin its rules; true when the plugin has to load. */
function publishKiloChecks(
  c: { type: string },
  { opts, env, readonly, programIo }: InvocationContext,
): boolean {
  delete env.AGENT_GRAPH_KILO_CHECKS;
  const guardedChecks = Boolean(
    c.type === "kilo" &&
    (programIo ||
      (!readonly &&
        (opts.verificationCommands?.length || opts.guardOwnedProcesses)) ||
      opts.scopeRoots?.length),
  );
  if (guardedChecks)
    env.AGENT_GRAPH_KILO_CHECKS = JSON.stringify({
      cwd: opts.cwd,
      commands: readonly ? [] : (opts.verificationCommands ?? []),
      ...(opts.testSourcesReadOnly ? { testSourcesReadOnly: true } : {}),
      ...(opts.guardOwnedProcesses ? { guardOwnedProcesses: true } : {}),
      ...(opts.verificationAliases
        ? { aliases: opts.verificationAliases }
        : {}),
      ...(opts.scopeRoots ? { scopeRoots: opts.scopeRoots } : {}),
      ...(programIo ? { programIo, readOnlyRole: readonly } : {}),
    });
  return guardedChecks;
}
type NativeAgents = Record<string, { tools?: Record<string, unknown> }>;
/** Kilo resolves effective agents before plugin config hooks; write=false
 * must be part of the invocation config, not a later hook mutation. */
async function recoveryAgentsWithoutWrite(
  c: { type: string },
  { opts, env, readonly, executable }: InvocationContext,
  native: Record<string, unknown>,
): Promise<NativeAgents> {
  const recoveryAgents: NativeAgents = Object.create(null);
  if (c.type !== "kilo" || readonly || !opts.disableWrite)
    return recoveryAgents;
  const names = await kiloRecoveryAgents(
    executable.file,
    executable.prefix,
    opts.cwd,
    env,
  );
  const nativeAgents = (native.agent as NativeAgents | undefined) ?? {};
  for (const name of names)
    recoveryAgents[name] = {
      ...nativeAgents[name],
      tools: { ...nativeAgents[name]?.tools, write: false },
    };
  return recoveryAgents;
}
function kiloToolProtocol({
  opts,
  readonly,
  programIo,
}: InvocationContext): string {
  return (
    "\n\nNative tool protocol: use the exact schema supplied by this CLI. Never send an empty tool input. After a schema error, correct the missing fields before trying again; do not repeat the same invalid call. " +
    (programIo
      ? `Kernel-isolated tool protocol: commands execute in a Linux VM with Node 24 and preinstalled Chromium/Playwright, regardless of the provider CLI host platform. Each bash command gets a fresh VM, destroyed before its result is accepted. Start, use and close any server in the same foreground check; no background server or PID survives to a later call. Use bash(command, description) for ALL project file operations. Native read/glob/grep/write/edit/task/skill/MCP tools are disabled. Use target-relative paths, shell cat/ls/grep for inspection and small quoted heredocs for implementation writes. ${readonly ? "This role is READ ONLY: only inspection commands (cat/ls/head/tail/sed/grep) are permitted; do not execute tests, Node programs, mkdir or writes." : opts.testSourcesReadOnly ? "Test role: exact registered foreground checks, inspection and verification output preparation only. Never edit product/tests/config; return FAIL on a failure." : "Implementation owns all product and authored-test repairs."} Review/approval must read each own test file and the canonical quality report using standalone cat commands. The VM confines every command and its children; HOME/cache/temp are private under verification/.agent-io. Host network, home, sockets and credentials are unavailable. Never use /tmp output paths, host credentials/configuration or unregistered execution tools. Emit AGENT_REPORT only in final assistant text.`
      : readonly
        ? "Use only permitted read-only tools: read(filePath), glob(pattern), grep(pattern) to inspect target files and prior actual test evidence. exec, exec_command, execute, bash, write and edit are unavailable in this read-only role; never call them or request shell/write permissions. For planning, use the supplied browser command/schema contract without reading the platform implementation."
        : "Use bash with command (string) and description (string) for shell commands, never exec or exec_command. " +
          (opts.disableWrite
            ? "The write tool is disabled in this attempt after observed schema failures; Kilo also excludes its shared native edit group. Do not call write/edit or invent content for a failed empty call. Use permitted bash commands with small, safely quoted heredocs to create or update files; preserve frozen acceptance files. "
            : "The write tool requires both filePath (absolute path) and content (string). Keep each write small; never send {}. ") +
          (opts.testSourcesReadOnly
            ? "This test role cannot edit ANY source, tests, package or configuration. Execute exact registered checks and inspect via read/glob/grep or read-only shell commands. On first failure report FAIL with concrete diagnostics; implementation owns every repair. "
            : "Preserve existing tests and use bash to run them before deciding whether additional coverage is necessary. ") +
          (process.platform === "win32"
            ? "The tool shell is Windows PowerShell: use npm.cmd and npx.cmd to avoid npm.ps1 execution policy errors, or invoke node.exe directly. Use PowerShell syntax, not Bash for/do/done loops or &&. Do not change the host execution policy."
            : ""))
  );
}

/** OpenCode and Kilo share one command shape and a JSON config in the environment. */
export async function runCliArguments(
  c: { type: string },
  context: InvocationContext,
): Promise<string[]> {
  const { binding: b, opts, env, readonly, programIo } = context;
  const args = [
    "run",
    "--format",
    "json",
    "--model",
    b.modelId,
    "--dir",
    opts.cwd,
  ];
  // Kilo emits no JSON until the model starts a step. Bootstrap/provider
  // logs must be enabled before the subcommand to distinguish a live CLI
  // waiting on capacity from a broken initial transport.
  if (c.type === "kilo") args.unshift("--print-logs", "--log-level", "INFO");
  if (b.variant) args.push("--variant", b.variant);
  if (opts.resumeId) args.push("--session", opts.resumeId);
  if (opts.fullAccess && !readonly) args.push("--auto");
  const permission = nativePermission(c, context);
  const key =
    c.type === "kilo" ? "KILO_CONFIG_CONTENT" : "OPENCODE_CONFIG_CONTENT";
  let native = env[key]
    ? (JSON.parse(env[key]) as Record<string, unknown>)
    : {};
  if (programIo)
    native = Object.fromEntries(
      Object.entries(native).filter(([name]) =>
        [
          "provider",
          "model",
          "small_model",
          "enabled_providers",
          "disabled_providers",
        ].includes(name),
      ),
    );
  const guardedChecks = publishKiloChecks(c, context);
  const recoveryAgents = await recoveryAgentsWithoutWrite(c, context, native);
  env[key] = JSON.stringify({
    ...native,
    ...(programIo
      ? {
          snapshot: false,
          lsp: false,
          formatter: false,
          mcp: {},
          tools: {
            "*": false,
            bash: true,
            todowrite: true,
            read: false,
            glob: false,
            grep: false,
            write: false,
            edit: false,
            apply_patch: false,
            task: false,
            skill: false,
          },
        }
      : {}),
    ...(Object.keys(recoveryAgents).length
      ? {
          agent: {
            ...((native.agent as Record<string, unknown>) ?? {}),
            ...recoveryAgents,
          },
        }
      : {}),
    ...(guardedChecks
      ? {
          plugin: [
            ...(Array.isArray(native.plugin) ? native.plugin : []),
            pathToFileURL(path.join(__dirname, "kilo_protocol_plugin.js")).href,
          ],
        }
      : {}),
    ...(c.type === "kilo" && !readonly && opts.disableWrite
      ? {
          tools: {
            ...((native.tools as Record<string, unknown>) ?? {}),
            write: false,
          },
        }
      : {}),
    permission: {
      ...((native.permission as Record<string, unknown>) ?? {}),
      ...permission,
    },
  });
  const protocol = c.type === "kilo" ? kiloToolProtocol(context) : "";
  args.push(opts.prompt + protocol);
  if (c.type === "kilo" && opts.scopeRoots)
    args[args.length - 1] +=
      `\nTarget scope: native filesystem tools may inspect only these approved roots: ${JSON.stringify(opts.scopeRoots)}. Default glob/grep path is the target project. Never inspect parent directories, global configuration, credentials or orchestrator sessions. A scope denial happened before execution; correct the path and continue using target-relative files. Registered platform verifiers may be executed as supplied; do not read/search their installation. Emit AGENT_REPORT directly in the final assistant response, never write AGENT_REPORT.json in read-only/test roles.`;
  return args;
}
