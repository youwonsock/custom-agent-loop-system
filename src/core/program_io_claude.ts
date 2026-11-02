import * as fs from "node:fs";
import * as path from "node:path";
import { nativeScopeProblem } from "./native_scope";
import { ProgramIoPolicy, wrapProgramCommand } from "./program_io";
import { literalShellWords } from "./verification_evidence";
import { testCommandAllowed } from "./test_source_guard";

export const CLAUDE_CALLS_FILE = "claude-calls.jsonl";
/** Claude's own file tools run on the host, so each is held to the target. */
const FILE_TOOLS = new Set(["Read", "Glob", "Grep", "Edit", "Write"]);

export interface ClaudeVmProtocol {
  cwd: string;
  roots: string[];
  readOnly: boolean;
  testRole: boolean;
  commands: string[];
}
interface HookInput {
  tool_name?: unknown;
  tool_input?: unknown;
  tool_use_id?: unknown;
}

const deny = (reason: string) => ({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: reason,
  },
});
const allow = (updatedInput?: Record<string, unknown>) => ({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "allow",
    ...(updatedInput ? { updatedInput } : {}),
  },
});

/**
 * Runs before every Claude tool call. Bash leaves for the VM, signed. Anything that
 * cannot be held to the target is refused, because a hook that lets a call through
 * unchanged would run it on the host.
 */
export function claudeVmDecision(
  input: HookInput,
  policy: ProgramIoPolicy,
  protocol: ClaudeVmProtocol,
): object {
  const tool = String(input.tool_name ?? ""),
    args = (input.tool_input ?? {}) as Record<string, unknown>;
  if (tool === "TodoWrite") return allow();
  if (FILE_TOOLS.has(tool)) {
    const writes = tool === "Edit" || tool === "Write";
    if (writes && (protocol.readOnly || protocol.testRole))
      return deny(`${tool} is not available to this role.`);
    const problem = nativeScopeProblem(
      tool.toLowerCase(),
      args,
      protocol.cwd,
      protocol.roots,
    );
    return problem
      ? deny(`Blocked before execution: ${problem}. Stay inside the project.`)
      : allow();
  }
  if (tool !== "Bash" || typeof args.command !== "string")
    return deny(`${tool} is not available when commands run in a VM.`);
  if (literalShellWords(args.command)?.[1] === policy.runner)
    return deny("Internal authorization wrappers cannot be called directly.");
  if (protocol.readOnly && !testCommandAllowed(args.command, protocol.cwd, []))
    return deny("This role can only inspect files.");
  if (
    protocol.testRole &&
    !testCommandAllowed(args.command, protocol.cwd, protocol.commands)
  )
    return deny(
      "The test role runs registered checks and read-only inspection only.",
    );
  const wrapped = wrapProgramCommand(args.command, policy, args.command);
  const payload = JSON.parse(
    Buffer.from(literalShellWords(wrapped)![2]!, "base64url").toString(),
  ) as { id: string; command: string };
  fs.appendFileSync(
    path.join(policy.directory, CLAUDE_CALLS_FILE),
    `${JSON.stringify({ toolUseId: input.tool_use_id, id: payload.id, command: payload.command })}\n`,
    { mode: 0o600 },
  );
  return allow({ ...args, command: wrapped });
}

if (require.main === module) {
  let text = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (text += chunk));
  process.stdin.on("end", () => {
    try {
      process.stdout.write(
        JSON.stringify(
          claudeVmDecision(
            JSON.parse(text),
            JSON.parse(process.env.AGENT_GRAPH_PROGRAM_IO!),
            JSON.parse(process.env.AGENT_GRAPH_CLAUDE_VM!),
          ),
        ),
      );
    } catch (error) {
      // Exit code 2 refuses the call; any other failure would let it run on the host.
      process.stderr.write(String(error));
      process.exit(2);
    }
  });
}
