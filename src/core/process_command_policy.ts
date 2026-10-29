import { testCommandAllowed } from "./test_source_guard";
export const UNSCOPED_TERMINATION = "[AGENT_GRAPH_UNSCOPED_TERMINATION]";
/** Conservative native-command policy, not a sandbox for arbitrary program code. */
export function broadProcessTermination(command: string, cwd: string): boolean {
  if (testCommandAllowed(command, cwd, [])) return false;
  return /\b(?:pkill|killall)\b|\bfuser\b[^\n]*(?:-k|--kill)|\btaskkill\b[^\n]*\/IM\b|\bStop-Process\b[^\n]*-Name\b|\bkill\b[^\n]*\$\([^)]*\b(?:pgrep|ps|lsof)\b|\bkill\s+(?:-[A-Za-z0-9]+\s+)*(?:--\s+)?-[1-9]\d*\s*(?:$|[;&|])/i.test(
    command,
  );
}
export function unscopedTerminationEvent(
  event: Record<string, unknown>,
): string | null {
  const part = event.part as
      { state?: { status?: string; error?: unknown } } | undefined,
    state = part?.state;
  return event.type === "tool_use" &&
    state?.status === "error" &&
    typeof state.error === "string" &&
    state.error.includes(UNSCOPED_TERMINATION)
    ? state.error.slice(0, 6000)
    : null;
}
