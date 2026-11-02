import * as path from "node:path";
import type { AgentNode } from "../../shared/domain";
import { ProgramIoPolicy, prepareProgramIo } from "../program_io/program_io";
import { IoUnavailable } from "../program_io/program_io_errors";
import { browserVerificationCommand } from "../verification/browser_command";
import { InvocationContext, InvocationOptions } from "./invocation_types";

// Headless Claude cannot ask for permission, and it ignores a project's allow list
// until the folder is trusted. These lists keep an automated run going without
// changing that trust. They are not a security boundary: `node` runs any code.
const INSPECT = [
  "Bash(ls:*)",
  "Bash(cat:*)",
  "Bash(head:*)",
  "Bash(tail:*)",
  "Bash(wc:*)",
  "Bash(grep:*)",
  "Bash(sed -n:*)",
  "Bash(echo:*)",
  "Bash(date:*)",
  "Bash(pwd)",
  "Bash(git status:*)",
  "Bash(git diff:*)",
  "Bash(git log:*)",
];
const RUN_CHECKS = ["Bash(node:*)", "Bash(npm test)", "Bash(npm test:*)"];
const BUILD = [
  "Edit",
  "Write",
  "NotebookEdit",
  "Bash(npm:*)",
  "Bash(npx:*)",
  "Bash(mkdir:*)",
];

function unattendedTools(role: string, checks: string[] = []): string[] {
  return [
    ...(role === "implementation" ? BUILD : []),
    ...INSPECT,
    ...RUN_CHECKS,
    ...checks.map((command) => `Bash(${command})`),
  ];
}

/** Claude's Bash sandbox refuses local ports and stops Chromium from starting. */
function unattendedSettings(
  unattended: NonNullable<InvocationOptions["claudeUnattended"]>,
): string {
  return JSON.stringify({
    sandbox: {
      network: { allowLocalBinding: true },
      ...(unattended.browserVerification
        ? { excludedCommands: [browserVerificationCommand()] }
        : {}),
    },
  });
}

/** Tools are limited too: the hook only knows what to do with these. */
function vmTools(role: string, readonly: boolean): string {
  const inspect = ["Read", "Glob", "Grep", "TodoWrite"];
  if (readonly) return inspect.join(",");
  return [
    ...inspect,
    "Bash",
    ...(role === "implementation" ? ["Edit", "Write"] : []),
  ].join(",");
}
function vmSettings(): string {
  const hook = path.join(__dirname, "../program_io/program_io_claude.js");
  return JSON.stringify({
    // The VM is the boundary, and Claude's own sandbox would refuse to start it.
    sandbox: { enabled: false },
    hooks: {
      PreToolUse: [
        {
          matcher: "*",
          hooks: [
            {
              type: "command",
              command: `${JSON.stringify(process.execPath)} ${JSON.stringify(hook)}`,
            },
          ],
        },
      ],
    },
  });
}
export function prepareClaudeIsolation(
  node: AgentNode,
  opts: InvocationOptions,
  guard: NonNullable<InvocationOptions["programIoGuard"]>,
  env: Record<string, string>,
  readonly: boolean,
): ProgramIoPolicy {
  if (opts.allowedPaths.length)
    throw new IoUnavailable(
      "Strict program isolation requires a single target project.",
    );
  const programIo = prepareProgramIo({
    cwd: opts.cwd,
    directory: guard.directory,
    testRole: node.type === "test",
    readOnly: readonly,
    protectedFiles: guard.protectedFiles,
    expiresAt: guard.expiresAt,
  });
  env.AGENT_GRAPH_PROGRAM_IO = JSON.stringify(programIo);
  env.AGENT_GRAPH_CLAUDE_VM = JSON.stringify({
    cwd: programIo.cwd,
    roots: [programIo.cwd],
    readOnly: readonly,
    testRole: node.type === "test",
    commands: opts.verificationCommands ?? [],
  });
  return programIo;
}

export function claudeArguments({
  binding: b,
  opts,
  readonly,
  role,
  programIo,
}: InvocationContext): string[] {
  const args = [
    "-p",
    opts.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    b.modelId,
  ];
  if (programIo) {
    const tools = vmTools(role, readonly);
    args.push(
      "--tools",
      tools,
      "--allowedTools",
      tools,
      "--settings",
      vmSettings(),
    );
  } else if (readonly)
    args.push("--disallowedTools", "Edit,Write,NotebookEdit,Bash");
  else if (opts.fullAccess) args.push("--dangerously-skip-permissions");
  else if (opts.claudeUnattended)
    args.push(
      "--allowedTools",
      unattendedTools(role, opts.verificationCommands).join(","),
      "--settings",
      unattendedSettings(opts.claudeUnattended),
    );
  for (const dir of opts.allowedPaths) args.push("--add-dir", dir);
  if (b.variant) args.push("--effort", b.variant);
  if (opts.resumeId) args.push("--resume", opts.resumeId);
  return args;
}
