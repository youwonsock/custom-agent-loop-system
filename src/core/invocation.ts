import { AgentNode, ExecutionBinding, LocalConnection } from "../shared/domain";
import { resolveExecutable } from "./catalog";
import * as path from "node:path";
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
    env[key] = JSON.stringify({
      ...native,
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
            ? "Use only permitted read-only tools and inspect prior actual test evidence. Never request write or shell execution permissions."
            : "The write tool requires both filePath (absolute path) and content (string). Preserve existing tests and use bash to run them before deciding whether additional coverage is necessary. " +
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
