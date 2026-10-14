import { AgentNode, ExecutionBinding, LocalConnection } from "../shared/domain";
import { resolveExecutable } from "./catalog";
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
  },
): Promise<{ binary: string; args: string[]; env: Record<string, string> }> {
  const executable = await resolveExecutable(c.binary),
    readonly = isReadOnly(node.type);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (v): v is [string, string] => typeof v[1] === "string",
    ),
  );
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
    ];
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
    args.push(opts.prompt);
  }
  return {
    binary: executable.file,
    args: [...executable.prefix, ...args],
    env,
  };
}
