import { AgentNode, ExecutionBinding, LocalConnection } from "../shared/domain";
import { resolveExecutable } from "./catalog";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { kiloRecoveryAgents } from "./kilo_recovery";
export function isReadOnly(type: AgentNode["type"]): boolean {
  return ["planning", "review", "approval", "interrupt"].includes(type);
}
export async function buildInvocation(
  c: LocalConnection,
  b: ExecutionBinding,
  node: AgentNode,
  opts: {
    prompt: string;
    cwd: string;
    fullAccess: boolean;
    allowedPaths: string[];
    resumeId?: string;
    nativeApprovalReview?: boolean;
    verificationCommands?: string[];
    disableWrite?: boolean;
    testSourcesReadOnly?: boolean;
    guardOwnedProcesses?: boolean;
    verificationAliases?: Record<string,string>;
  },
): Promise<{
  binary: string;
  args: string[];
  env: Record<string, string>;
  transport?: "pipe";
}> {
  const executable = await resolveExecutable(c.binary),
    readonly = isReadOnly(node.type);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (v): v is [string, string] => typeof v[1] === "string",
    ),
  );
  env.PATH = [path.dirname(process.execPath), env.PATH ?? ""]
    .filter(Boolean)
    .join(path.delimiter);
  let args: string[];
  if (c.type === "codex") {
    args = [
      "exec",
      "--json",
      "--model",
      b.modelId,
      "--skip-git-repo-check",
      "--sandbox",
      readonly
        ? "read-only"
        : opts.fullAccess
          ? "danger-full-access"
          : "workspace-write",
      "-c",
      "allow_login_shell=false",
      "-c",
      `shell_environment_policy.set.PATH=${JSON.stringify(env.PATH)}`,
    ];
    if (opts.nativeApprovalReview && !readonly && !opts.fullAccess) {
      // Native reviewer authorizes individual commands; --approve-for-me already selects workspace-write.
      args.splice(args.indexOf("--sandbox"), 2);
      args.splice(1, 0, "--approve-for-me");
    }
    for (const dir of opts.allowedPaths) args.push("--add-dir", dir);
    if (b.variant)
      args.push("-c", `model_reasoning_effort=${JSON.stringify(b.variant)}`);
    if (opts.resumeId) args.push("resume", opts.resumeId);
    args.push(opts.prompt);
  } else if (c.type === "claude") {
    args = [
      "-p",
      opts.prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      b.modelId,
    ];
    if (readonly)
      args.push("--disallowedTools", "Edit,Write,NotebookEdit,Bash");
    else if (opts.fullAccess) args.push("--dangerously-skip-permissions");
    for (const dir of opts.allowedPaths) args.push("--add-dir", dir);
    if (b.variant) args.push("--effort", b.variant);
    if (opts.resumeId) args.push("--resume", opts.resumeId);
  } else {
    args = ["run", "--format", "json", "--model", b.modelId, "--dir", opts.cwd];
    // Kilo emits no JSON until the model starts a step. Bootstrap/provider
    // logs must be enabled before the subcommand to distinguish a live CLI
    // waiting on capacity from a broken initial transport.
    if (c.type === "kilo") args.unshift("--print-logs", "--log-level", "INFO");
    if (b.variant) args.push("--variant", b.variant);
    if (opts.resumeId) args.push("--session", opts.resumeId);
    if (opts.fullAccess && !readonly) args.push("--auto");
    // Only role/access restrictions belong to the orchestrator. Native tools,
    // MCP, web, plugins, skills and hooks retain their CLI configuration.
    const permission: Record<string, unknown> = {
      edit: readonly ? "deny" : "allow",
    };
    if (readonly) permission.bash = "deny";
    if (opts.allowedPaths.length)
      permission.external_directory = Object.fromEntries(
        opts.allowedPaths.map((p) => [
          `${p.replace(/\\/g, "/").replace(/\/$/, "")}/**`,
          "allow",
        ]),
      );
    const key =
      c.type === "kilo" ? "KILO_CONFIG_CONTENT" : "OPENCODE_CONFIG_CONTENT";
    const native = env[key]
      ? (JSON.parse(env[key]) as Record<string, unknown>)
      : {};
    delete env.AGENT_GRAPH_KILO_CHECKS;
    const guardedChecks = c.type === "kilo" && !readonly && (opts.verificationCommands?.length||opts.guardOwnedProcesses);
    if (guardedChecks) env.AGENT_GRAPH_KILO_CHECKS = JSON.stringify({cwd: opts.cwd, commands: opts.verificationCommands??[],...(opts.testSourcesReadOnly?{testSourcesReadOnly:true}:{}),...(opts.guardOwnedProcesses?{guardOwnedProcesses:true}:{}),...(opts.verificationAliases?{aliases:opts.verificationAliases}:{})});
    const recoveryAgents: Record<string, {tools?: Record<string, unknown>}> = Object.create(null);
    if (c.type === "kilo" && !readonly && opts.disableWrite) {
      // Kilo resolves effective agents before plugin config hooks; write=false
      // must be part of the invocation config, not a later hook mutation.
      const names = await kiloRecoveryAgents(executable.file, executable.prefix, opts.cwd, env);
      const nativeAgents = (native.agent as typeof recoveryAgents | undefined) ?? {};
      for (const name of names) recoveryAgents[name] = {
        ...nativeAgents[name], tools: {...nativeAgents[name]?.tools, write: false},
      };
    }
    env[key] = JSON.stringify({
      ...native,
      ...(Object.keys(recoveryAgents).length ? {agent: {
        ...((native.agent as Record<string, unknown>) ?? {}), ...recoveryAgents,
      }} : {}),
      ...(guardedChecks ? {plugin: [
        ...(Array.isArray(native.plugin) ? native.plugin : []),
        pathToFileURL(path.join(__dirname, "kilo_protocol_plugin.js")).href,
      ]} : {}),
      ...(c.type === "kilo" && !readonly && opts.disableWrite ? {tools: {
        ...((native.tools as Record<string, unknown>) ?? {}), write: false,
      }} : {}),
      permission: {
        ...((native.permission as Record<string, unknown>) ?? {}),
        ...permission,
      },
    });
    const protocol =
      c.type !== "kilo"
        ? ""
        : "\n\nNative tool protocol: use the exact schema supplied by this CLI. Never send an empty tool input. After a schema error, correct the missing fields before trying again; do not repeat the same invalid call. " +
          (readonly
            ? "Use only permitted read-only tools: read(filePath), glob(pattern), grep(pattern) to inspect target files and prior actual test evidence. exec, exec_command, execute, bash, write and edit are unavailable in this read-only role; never call them or request shell/write permissions. For planning, use the supplied browser command/schema contract without reading the platform implementation."
            : "Use bash with command (string) and description (string) for shell commands, never exec or exec_command. " +
              (opts.disableWrite
                ? "The write tool is disabled in this attempt after observed schema failures; Kilo also excludes its shared native edit group. Do not call write/edit or invent content for a failed empty call. Use permitted bash commands with small, safely quoted heredocs to create or update files; preserve frozen acceptance files. "
                : "The write tool requires both filePath (absolute path) and content (string). Keep each write small; never send {}. ") +
              (opts.testSourcesReadOnly ? "This test role cannot edit ANY source, tests, package or configuration. Execute exact registered checks and inspect via read/glob/grep or read-only shell commands. On first failure report FAIL with concrete diagnostics; implementation owns every repair. " : "Preserve existing tests and use bash to run them before deciding whether additional coverage is necessary. ") +
              (process.platform === "win32"
                ? "The tool shell is Windows PowerShell: use npm.cmd and npx.cmd to avoid npm.ps1 execution policy errors, or invoke node.exe directly. Use PowerShell syntax, not Bash for/do/done loops or &&. Do not change the host execution policy."
                : ""));
    args.push(opts.prompt + protocol);
  }
  return {
    binary: executable.file,
    args: [...executable.prefix, ...args],
    env,
    ...(c.type === "kilo" && process.platform === "win32"
      ? { transport: "pipe" as const }
      : {}),
  };
}
