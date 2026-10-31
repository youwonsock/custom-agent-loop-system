import { AgentNode } from "../shared/domain";
import { FailureKind } from "./resilience";
export function buildRecoveryMessage(
  kind: FailureKind,
  message: string,
  assistantText: string,
  events: Record<string, unknown>[],
  role?: AgentNode["type"],
  frozenTest = false,
): string {
  const lines = [
    `[${kind}] ${message}`,
    `Previous observed output:\n${assistantText.slice(-5000)}`,
  ];
  if (message.includes("[AGENT_GRAPH_UNSCOPED_TERMINATION]"))
    return "A broad process termination was blocked BEFORE execution. Preserve existing work; close only the server objects/child handles this task created. Never use pkill/killall, process-name searches for killing, taskkill /IM or Stop-Process -Name. Fix lifecycle cleanup in implementation and execute registered checks as standalone foreground commands. No permission expansion or operator approval is needed for this correction.";
  if (kind === "tool_arguments") {
    const errors = events
      .flatMap((event) => {
        const part = event.part as Record<string, unknown> | undefined;
        const state = part?.state as Record<string, unknown> | undefined;
        return event.type === "tool_use" &&
          state?.status === "error" &&
          typeof state.error === "string"
          ? [`${String(part?.tool)}: ${state.error.slice(0, 1500)}`]
          : [];
      })
      .slice(-3);
    if (role === "test" && frozenTest)
      return [
        ...lines,
        "This is the frozen TEST role. Never repair product, documentation, tests, package or config, including README. Use only this invocation's available inspection tools and exact registered foreground checks. Missing files/coverage or failing checks require a FAIL report with file, requirement and observed cause for implementation. Do not call write/edit, use heredocs, create a replacement report file, request broader permissions or switch models. All repairs belong to implementation and require a fresh full test cycle.",
        ...errors,
      ].join("\n");
    lines.push(
      "The preceding CLI aborted repeated unavailable tools or malformed tool input. This is a fresh bounded attempt. Follow this invocation's actual tool protocol, supply all required fields, never submit {} and never repeat the same invalid call. Kernel-isolated Kilo roles use bash only: read-only roles inspect with standalone cat/ls and never execute tests or writes; implementation uses small quoted heredocs. Other Kilo invocations use native read/glob/grep in read-only roles and bash(command, description) plus write(filePath, content) where available. Never request disabled tools or broader permissions. Do not weaken checks or switch models.",
      ...errors,
    );
    if (/for the "write" tool/.test(message))
      lines.push(
        "A repeated write schema failure selects a bounded Kilo fallback: write is unavailable in the next writable invocation, including Kilo's shared native edit group. Use the permitted bash tool with both command and description and small safely quoted heredocs to create or update files. Never invent the missing content of an empty call, request broader permissions, modify protected checks, or call the disabled write/edit tools again.",
      );
  }
  return lines.join("\n");
}
