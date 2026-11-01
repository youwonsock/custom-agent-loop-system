import { shellMutation } from "./shell_mutation";
import {
  CommandReceipt,
  NativeScopeAudit,
  ProgramIoAudit,
} from "../shared/domain";
import { obj as toObj } from "./values";
type Event = Record<string, unknown>;
export interface EventEvidence {
  programIoAudit?: ProgramIoAudit;
  scopeAudit?: NativeScopeAudit;
  readFiles?: string[];
  commands: CommandReceipt[];
  fileMutation: boolean;
  changedFiles?: string[];
  /** Files the CLI's own permission check refused to let a write tool change. */
  deniedWrites?: string[];
  /** Background processes the CLI left running, ended after it exited. */
  reapedProcesses?: number[];
  completedSearches: number;
  maxTokens: number;
  assistantTextBytes: number;
  actualModelId: string | null;
}
export const emptyEvidence = (): EventEvidence => ({
  readFiles: [],
  commands: [],
  fileMutation: false,
  completedSearches: 0,
  maxTokens: 0,
  assistantTextBytes: 0,
  actualModelId: null,
});
const obj = (value: unknown): Event => toObj(value) as Event;
export function preExecutionDenied(error: unknown, metadata: unknown): boolean {
  const approval = obj(obj(metadata).approval),
    rule = obj(approval.rule);
  if (rule.action === "deny" || approval.action === "deny") return true;
  const message = typeof error === "string" ? error : "";
  if (
    /^(?:Error:\s*)?\[AGENT_GRAPH_(?:TEST_POLICY|SCOPE_DENIED|IO_DENIED|CHECK_DENIED|UNSCOPED_TERMINATION)\]/.test(
      message,
    )
  )
    return true;
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

/** One tool lifecycle report, in the form every CLI's events reduce to. */
interface ToolCall {
  id: unknown;
  name: string;
  input: unknown;
  status: string;
  denied: boolean;
  nativeChange?: boolean;
}
const denial = (id: unknown): ToolCall => ({
  id,
  name: "",
  input: null,
  status: "denied",
  denied: true,
});
const nativeFileChange = (e: Event): ToolCall[] => [
  {
    id: e.id,
    name: "",
    input: e,
    status: "completed",
    denied: false,
    nativeChange: true,
  },
];
function codexItem(e: Event): ToolCall[] {
  const item = obj(e.item),
    isFileChange = item.type === "file_change";
  if (!isFileChange && item.type !== "command_execution") return [];
  return [
    {
      id: item.id,
      name: String(item.type),
      input: isFileChange
        ? {
            paths: Array.isArray(item.changes)
              ? item.changes.map((c) => obj(c).path)
              : [],
          }
        : item.command,
      status:
        e.type === "item.started"
          ? "requested"
          : String(item.status ?? "completed"),
      denied: preExecutionDenied(
        obj(item.error).message ?? item.error,
        item.metadata,
      ),
      nativeChange: isFileChange,
    },
  ];
}
const commandExecution = (e: Event): ToolCall[] => [
  {
    id: e.id,
    name: "commandexecution",
    input: e.command,
    status: String(e.status ?? "completed"),
    denied: preExecutionDenied(e.error, e.metadata),
  },
];
function runCliToolUse(e: Event): ToolCall[] {
  const part = Object.keys(obj(e.part)).length ? obj(e.part) : e,
    state = obj(part.state);
  return [
    {
      id: part.callID ?? part.id ?? e.callID ?? e.id,
      name: String(part.tool ?? part.name ?? part.tool_name ?? ""),
      input: state.input ?? part.input ?? e.input,
      status: String(state.status ?? part.status ?? "requested"),
      denied: preExecutionDenied(
        state.error ?? part.error,
        state.metadata ?? part.metadata,
      ),
    },
  ];
}
function claudeRequests(e: Event): ToolCall[] {
  const content = obj(e.message).content;
  if (!Array.isArray(content)) return [];
  return content
    .map(obj)
    .filter((block) => block.type === "tool_use")
    .map((block) => ({
      id: block.id,
      name: String(block.name ?? ""),
      input: block.input,
      status: "requested",
      denied: false,
    }));
}
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((v) => obj(v).text)
    .filter((v) => typeof v === "string")
    .join("\n");
}
function toolResults(content: unknown): ToolCall[] {
  if (!Array.isArray(content)) return [];
  return content
    .map(obj)
    .filter((block) => block.type === "tool_result")
    .map((block) => ({
      id: block.tool_use_id ?? block.callID,
      name: "",
      input: null,
      status: block.is_error === true ? "failed" : "completed",
      denied: preExecutionDenied(resultText(block.content), block.metadata),
    }));
}
const EVENT_CALLS = new Map<unknown, (e: Event) => ToolCall[]>([
  ["file_change", nativeFileChange],
  ["filechange", nativeFileChange],
  ["item.started", codexItem],
  ["item.completed", codexItem],
  ["command_execution", commandExecution],
  ["tool_use", runCliToolUse],
  ["assistant", claudeRequests],
  ["user", (e) => toolResults(obj(e.message).content)],
  ["tool_result", (e) => toolResults([e])],
  [
    "system",
    (e) => (e.subtype === "permission_denied" ? [denial(e.tool_use_id)] : []),
  ],
  [
    "result",
    (e) =>
      Array.isArray(e.permission_denials)
        ? e.permission_denials.map((d) => denial(obj(d).tool_use_id))
        : [],
  ],
]);

export class MutationTracker {
  private confirmed = false;
  private readonly files = new Set<string>();
  private readonly pendingFiles = new Map<string, string[]>();
  readonly deniedWrites: string[] = [];
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
  private tool({
    id,
    name,
    input,
    status,
    denied,
    nativeChange = false,
  }: ToolCall): void {
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
    const e = obj(value);
    for (const call of EVENT_CALLS.get(e.type)?.(e) ?? []) this.tool(call);
    if (e.type === "result" && Array.isArray(e.permission_denials))
      for (const denied of e.permission_denials) {
        const file = obj(obj(denied).tool_input).file_path;
        if (typeof file === "string") this.deniedWrites.push(file);
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
