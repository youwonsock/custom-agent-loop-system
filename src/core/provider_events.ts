import type { Activity } from "../shared/execution_types";

type AnyObj = Record<string, unknown>;

export function extractAssistantText(event: AnyObj): string | null {
  const eventType = typeof event.type === "string" ? event.type : "";
  if (eventType === "text") {
    const part = event.part as Record<string, unknown> | undefined;
    if (part && typeof part.text === "string") return part.text;
    for (const key of ["text", "content", "message"]) {
      if (typeof event[key] === "string") return event[key] as string;
    }
  }

  // Codex CLI JSONL: only completed agent_message items count as assistant text.
  if (eventType === "item.completed") {
    const item = event.item as Record<string, unknown> | undefined;
    if (item?.type === "agent_message" && typeof item.text === "string")
      return item.text;
  }

  // Claude Code stream-json: assistant.message.content contains typed blocks.
  if (eventType === "assistant") {
    const message = event.message as Record<string, unknown> | undefined;
    const content = Array.isArray(message?.content) ? message.content : [];
    const textBlocks = content
      .filter(
        (block): block is Record<string, unknown> =>
          Boolean(block) && typeof block === "object",
      )
      .filter(
        (block) => block.type === "text" && typeof block.text === "string",
      )
      .map((block) => String(block.text));
    return textBlocks.length > 0 ? textBlocks.join("\n") : null;
  }
  // Some Claude versions omit an assistant event in print mode. The result is a
  // legitimate final assistant field, unlike prompt/tool payloads.
  if (
    eventType === "result" &&
    event.is_error !== true &&
    !String(event.subtype ?? "").startsWith("error_") &&
    typeof event.result === "string"
  )
    return event.result;
  return null;
}

export function findSessionId(value: unknown, depth = 0): string | null {
  if (!value || typeof value !== "object" || depth > 4) return null;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (
      ["sessionID", "sessionId", "session_id", "thread_id"].includes(key) &&
      typeof child === "string" &&
      child.length > 0
    ) {
      return child;
    }
    const nested = findSessionId(child, depth + 1);
    if (nested) return nested;
  }
  return null;
}

function toolEventStatus(event: AnyObj): string | null {
  const part = event.part as Record<string, unknown> | undefined;
  const state = part?.state as Record<string, unknown> | undefined;
  return typeof state?.status === "string" ? state.status.toLowerCase() : null;
}

function activityForEvent(
  event: AnyObj,
): Activity | null {
  const type = typeof event.type === "string" ? event.type : "";
  if (type === "tool_use") {
    const status = toolEventStatus(event);
    return status &&
      ["completed", "failed", "error", "cancelled"].includes(status)
      ? "model_generation"
      : "tool_execution";
  }
  if (["text", "tool_result", "step_start", "step_finish"].includes(type)) {
    return "model_generation";
  }
  if (type === "item.started" || type === "item.completed") {
    const item = event.item as Record<string, unknown> | undefined;
    const itemType = typeof item?.type === "string" ? item.type : "";
    const isTool = [
      "command_execution",
      "file_change",
      "mcp_tool_call",
      "web_search",
    ].includes(itemType);
    return type === "item.started" && isTool
      ? "tool_execution"
      : "model_generation";
  }
  if (type === "assistant") {
    const message = event.message as Record<string, unknown> | undefined;
    const content = Array.isArray(message?.content) ? message.content : [];
    return content.some(
      (block) =>
        Boolean(block) &&
        typeof block === "object" &&
        (block as AnyObj).type === "tool_use",
    )
      ? "tool_execution"
      : "model_generation";
  }
  if (
    [
      "user",
      "result",
      "thread.started",
      "turn.started",
      "turn.completed",
    ].includes(type)
  ) {
    return "model_generation";
  }
  return null;
}

function progressIdentity(
  event: AnyObj,
  assistantText: string | null,
): string | null {
  const type = typeof event.type === "string" ? event.type : "";
  // A provider retry can emit fresh step IDs indefinitely without generating
  // any answer. Lifecycle notifications are transport, not useful progress.
  if (["step_start", "step_finish"].includes(type)) return null;
  if (type === "text" && !assistantText?.trim()) return null;
  if (type === "tool_use" && ["failed", "error", "cancelled"].includes(toolEventStatus(event) ?? ""))
    return null;
  const recognized = [
    "text",
    "tool_use",
    "tool_result",
    "step_start",
    "step_finish",
    "item.started",
    "item.completed",
    "assistant",
    "user",
    "result",
    "thread.started",
    "turn.started",
    "turn.completed",
  ];
  if (!recognized.includes(type)) return null;
  if (type === "tool_use") {
    const part = event.part as Record<string, unknown> | undefined;
    const id = [event.id, event.callID, part?.id, part?.callID].find(
      (value) => typeof value === "string",
    ) as string | undefined;
    const timestamp =
      typeof event.timestamp === "number" || typeof event.timestamp === "string"
        ? String(event.timestamp)
        : "";
    const status = toolEventStatus(event) ?? "unknown";
    return `tool_use:${id ?? "anonymous"}:${status}:${timestamp || JSON.stringify(event).slice(-200)}`;
  }
  for (const key of ["id", "messageID", "callID"]) {
    if (typeof event[key] === "string")
      return `${type}:${event[key] as string}`;
  }
  const part = event.part as Record<string, unknown> | undefined;
  if (part && typeof part.id === "string") return `${type}:${part.id}`;
  const item = event.item as Record<string, unknown> | undefined;
  if (item && typeof item.id === "string") {
    const status = typeof item.status === "string" ? item.status : "";
    return `${type}:${item.id}:${status}`;
  }
  const message = event.message as Record<string, unknown> | undefined;
  if (message && typeof message.id === "string") return `${type}:${message.id}`;
  if (assistantText) {
    const normalized = assistantText.replace(/\s+/g, " ").trim();
    if (normalized.length > 0) return `${type}:${normalized.slice(-500)}`;
  }
  if (
    [
      "tool_use",
      "step_start",
      "step_finish",
      "item.started",
      "item.completed",
      "result",
    ].includes(type)
  ) {
    return `${type}:${JSON.stringify(event).slice(0, 500)}`;
  }
  return null;
}

/** Normalize native events before the supervisor applies deadlines or publishes progress. */
export function normalizeProviderEvent(event: AnyObj) {
  const assistantText = extractAssistantText(event);
  return {
    assistantText,
    sessionId: findSessionId(event),
    activity: activityForEvent(event),
    progressId: progressIdentity(event, assistantText),
  };
}
