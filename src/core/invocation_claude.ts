import { InvocationContext } from "./invocation_types";

export function claudeArguments({
  binding: b,
  opts,
  readonly,
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
  for (const dir of opts.allowedPaths) args.push("--add-dir", dir);
  if (b.variant) args.push("--effort", b.variant);
  if (opts.resumeId) args.push("--resume", opts.resumeId);
  return args;
}
