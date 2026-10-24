import { shellMutation } from "./shell_mutation";
import { CommandReceipt } from "../shared/domain";
type Event = Record<string, unknown>;
export interface EventEvidence {
  commands: CommandReceipt[];
  fileMutation: boolean;
  changedFiles?: string[];
  completedSearches: number;
  maxTokens: number;
  assistantTextBytes: number;
  actualModelId: string | null;
}
export const emptyEvidence = (): EventEvidence => ({
  commands: [],
  fileMutation: false,
  completedSearches: 0,
  maxTokens: 0,
  assistantTextBytes: 0,
  actualModelId: null,
});
const obj = (value: unknown): Event =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Event)
    : {};
function preExecutionDenied(error: unknown, metadata: unknown): boolean {
  const approval = obj(obj(metadata).approval),
    rule = obj(approval.rule);
  if (rule.action === "deny" || approval.action === "deny") return true;
  const message = typeof error === "string" ? error : "";
  return /^(?:Model tried to call unavailable tool\b|The user has specified a rule which prevents you from using this specific tool call\b|(?:The )?[Uu]ser (?:denied|rejected) (?:this )?tool (?:use|call)\b|Tool (?:use|call) (?:was )?(?:denied|rejected) (?:by|before)\b|PreToolUse hook .*?(?:denied|blocked))/i.test(
    message,
  );
}
function mutatingTool(name: string, input: unknown): boolean {
  name = name.toLowerCase().replace(/[^a-z]/g, "");
  if (
    /^(write|writefile|edit|multiedit|notebookedit|applypatch|createfile|deletefile|movefile|renamefile)$/.test(
      name,
    )
  )
    return true;
  if (
    ["bash", "shell", "commandexecution", "backgroundprocess"].includes(name)
  ) {
    const command = typeof input === "string" ? input : obj(input).command;
    return typeof command === "string" && shellMutation(command);
  }
  return false;
}

export class MutationTracker {
  private confirmed = false;
  private readonly files = new Set<string>();
  private readonly pendingFiles = new Map<string, string[]>();
  get changedFiles(): string[] {
    const files = [
      ...new Set([...this.files, ...this.pendingFiles.values()].flat()),
    ];
    return files.length > 256 ? ["__too_many_changed_files__"] : files;
  }

  private readonly pending = new Map<string, boolean>();
  get hasMutation(): boolean {
    return this.confirmed;
  }
  finish(): boolean {
    return this.confirmed || this.pending.size > 0;
  }
  private tool(
    id: unknown,
    name: string,
    input: unknown,
    status: string,
    denied: boolean,
    nativeChange = false,
  ): void {
    const key = typeof id === "string" && id ? id : null;
    const data = obj(input);
    const paths = [
      data.filePath,
      data.file_path,
      data.path,
      ...(Array.isArray(data.paths) ? data.paths : []),
    ].filter((v): v is string => typeof v === "string");
    if (denied || ["denied", "rejected"].includes(status)) {
      if (key) this.pendingFiles.delete(key);
    } else if (
      paths.length &&
      key &&
      (nativeChange || mutatingTool(name, input))
    ) {
      if (this.pendingFiles.size >= 256) {
        this.files.add("__too_many_changed_files__");
        this.pendingFiles.clear();
      }
      this.pendingFiles.set(key, paths);
    }
    const commitPaths = () => {
      for (const file of paths.length
        ? paths
        : key
          ? (this.pendingFiles.get(key) ?? [])
          : []) {
        if (this.files.size < 255) this.files.add(file);
        else this.files.add("__too_many_changed_files__");
      }
      if (key) this.pendingFiles.delete(key);
    };
    if (nativeChange && ["completed", "success"].includes(status)) {
      commitPaths();
      this.confirmed = true;
      if (key) this.pending.delete(key);
      return;
    }
    if (denied || ["denied", "rejected"].includes(status)) {
      if (key) this.pending.delete(key);
      return;
    }
    const mutation =
      nativeChange ||
      mutatingTool(name, input) ||
      (key ? this.pending.has(key) : false);
    if (!mutation) return;
    if (["completed", "success"].includes(status)) {
      commitPaths();
      this.confirmed = true;
      if (key) this.pending.delete(key);
    } else if (key) {
      // Requests and failed writes are unresolved until their result/denial.
      // Unknown or partial execution remains conservative at attempt end.
      this.pending.set(key, true);
      if (this.pending.size > 512) {
        this.confirmed = true;
        this.pending.delete(this.pending.keys().next().value!);
      }
    } else this.confirmed = true;
  }
  observe(value: unknown): void {
    const e = obj(value),
      type = e.type;
    if (type === "file_change" || type === "filechange") {
      this.tool(e.id, "", e, "completed", false, true);
    } else if (type === "item.started" || type === "item.completed") {
      const item = obj(e.item);
      if (!["command_execution", "file_change"].includes(String(item.type)))
        return;
      const status =
        type === "item.started"
          ? "requested"
          : String(item.status ?? "completed");
      this.tool(
        item.id,
        String(item.type),
        item.type === "file_change"
          ? {
              paths: Array.isArray(item.changes)
                ? item.changes.map((c) => obj(c).path)
                : [],
            }
          : item.command,
        status,
        preExecutionDenied(
          obj(item.error).message ?? item.error,
          item.metadata,
        ),
        item.type === "file_change",
      );
    } else if (type === "command_execution") {
      this.tool(
        e.id,
        "commandexecution",
        e.command,
        String(e.status ?? "completed"),
        preExecutionDenied(e.error, e.metadata),
      );
    } else if (type === "tool_use") {
      const part = Object.keys(obj(e.part)).length ? obj(e.part) : e,
        state = obj(part.state);
      this.tool(
        part.callID ?? part.id ?? e.callID ?? e.id,
        String(part.tool ?? part.name ?? part.tool_name ?? ""),
        state.input ?? part.input ?? e.input,
        String(state.status ?? part.status ?? "requested"),
        preExecutionDenied(
          state.error ?? part.error,
          state.metadata ?? part.metadata,
        ),
      );
    } else if (type === "assistant") {
      const content = obj(e.message).content;
      if (Array.isArray(content))
        for (const value of content) {
          const block = obj(value);
          if (block.type === "tool_use")
            this.tool(
              block.id,
              String(block.name ?? ""),
              block.input,
              "requested",
              false,
            );
        }
    } else if (type === "user" || type === "tool_result") {
      const content = type === "user" ? obj(e.message).content : [e];
      if (Array.isArray(content))
        for (const value of content) {
          const block = obj(value);
          if (block.type !== "tool_result") continue;
          const text =
            typeof block.content === "string"
              ? block.content
              : Array.isArray(block.content)
                ? block.content
                    .map((v) => obj(v).text)
                    .filter((v) => typeof v === "string")
                    .join("\n")
                : "";
          this.tool(
            block.tool_use_id ?? block.callID,
            "",
            null,
            block.is_error === true ? "failed" : "completed",
            preExecutionDenied(text, block.metadata),
          );
        }
    } else if (type === "system" && e.subtype === "permission_denied") {
      this.tool(e.tool_use_id, "", null, "denied", true);
    } else if (type === "result" && Array.isArray(e.permission_denials)) {
      for (const denied of e.permission_denials)
        this.tool(obj(denied).tool_use_id, "", null, "denied", true);
    }
  }
}
export function fileMutation(value: unknown): boolean {
  const tracker = new MutationTracker();
  tracker.observe(value);
  return tracker.finish();
}
export function completedSearch(event: Event): string | null {
  const type = String(event.type ?? ""),
    item = event.item as Event | undefined,
    part = event.part as Event | undefined,
    state = part?.state as Event | undefined;
  if (type === "item.completed" && item?.type === "web_search")
    return String(item.id ?? JSON.stringify(item));
  const name = String(
    event.name ?? event.tool ?? part?.tool ?? part?.name ?? "",
  )
    .toLowerCase()
    .replace(/[^a-z]/g, "");
  if (
    ["websearch", "webfetch"].includes(name) &&
    (type === "tool_result" ||
      ["completed", "success"].includes(String(state?.status)))
  )
    return String(event.id ?? part?.id ?? JSON.stringify(event));
  return null;
}
export function claudeCompletedSearch(
  event: Event,
  pending: Set<string>,
): string | null {
  const message = event.message as Event | undefined,
    content = Array.isArray(message?.content)
      ? (message.content as Event[])
      : [];
  if (event.type === "assistant")
    for (const b of content)
      if (
        b.type === "tool_use" &&
        /^(WebSearch|WebFetch)$/i.test(String(b.name)) &&
        typeof b.id === "string"
      )
        pending.add(b.id);
  if (event.type === "user")
    for (const b of content)
      if (
        b.type === "tool_result" &&
        typeof b.tool_use_id === "string" &&
        pending.delete(b.tool_use_id) &&
        b.is_error !== true
      )
        return `claude:${b.tool_use_id}`;
  return null;
}
export function observeTokens(event: Event, depth = 0): number {
  if (depth > 5) return 0;
  let count = 0;
  const part = obj(event.part),
    tokens = obj(part.tokens);
  // Kilo/OpenCode report usage under step_finish.part.tokens, not *_tokens.
  if (event.type === "step_finish")
    for (const key of ["total", "output", "reasoning"])
      if (typeof tokens[key] === "number" && Number.isFinite(tokens[key]))
        count = Math.max(count, tokens[key] as number);
  for (const [key, value] of Object.entries(event)) {
    if (
      typeof value === "number" &&
      /(?:total_tokens|totalTokens|output_tokens|outputTokens)/.test(key)
    )
      count = Math.max(count, value);
    else if (value && typeof value === "object" && !Array.isArray(value))
      count = Math.max(count, observeTokens(value as Event, depth + 1));
  }
  return count;
}
export function observeModel(event: Event): string | null {
  const direct = event.model ?? obj(event.message).model;
  if (typeof direct === "string") return direct;
  if (event.type === "step_finish" || event.type === "step_start") {
    const model = obj(obj(event.part).model);
    if (typeof model.modelID === "string")
      return typeof model.providerID === "string"
        ? `${model.providerID}/${model.modelID}`
        : model.modelID;
  }
  return null;
}
