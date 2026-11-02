import { browserVerificationCommand } from "./browser_command";
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

export function claudeArguments({
  binding: b,
  opts,
  readonly,
  role,
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
  if (readonly) args.push("--disallowedTools", "Edit,Write,NotebookEdit,Bash");
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
