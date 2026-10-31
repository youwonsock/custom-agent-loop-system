import * as fs from "node:fs";
import * as path from "node:path";
import { inspectionSegments } from "./inspection_syntax";
import { canonicalCommand, literalShellWords } from "./verification_evidence";
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {};
/** Keep completed native reads outside the bounded recent-event ring. */
export class InspectionTracker {
  private readonly seen = new Set<string>();
  private readonly pending = new Map<string, unknown>();
  constructor(private readonly cwd: string) {}
  get files(): string[] {
    return [...this.seen];
  }
  private add(file: unknown): void {
    if (
      typeof file !== "string" ||
      !file ||
      file.length > 2000 ||
      this.seen.size >= 1000
    )
      return;
    const relative = path.relative(this.cwd, path.resolve(this.cwd, file));
    if (
      relative &&
      !path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(".." + path.sep)
    )
      this.seen.add(relative.split(path.sep).join("/"));
  }
  private command(text: unknown): void {
    if (typeof text !== "string") return;
    const parts = inspectionSegments(canonicalCommand(text));
    if (!parts || parts.some((p) => !["", "&&", ";"].includes(p.next))) return;
    const reads: Array<{ files: string[]; lastExit: boolean }> = [];
    for (const [at, part] of parts.entries()) {
      const words = literalShellWords(part.text);
      if (!words?.length) return;
      const name = words.shift()!.split(/[\\/]/).at(-1)!.toLowerCase();
      if (name === "cd") {
        if (
          at ||
          words.length !== 1 ||
          path.resolve(this.cwd, words[0]!) !== path.resolve(this.cwd)
        )
          return;
        continue;
      }
      if (name === "echo" || name === "printf") continue;
      if (!["cat", "type", "get-content"].includes(name)) return;
      const files = words.filter(
        (w) =>
          !["--", "-path", "-literalpath", "-raw"].includes(w.toLowerCase()),
      );
      if (files.some((w) => w.startsWith("-"))) return;
      reads.push({
        files,
        lastExit: !parts.slice(at).some((p) => p.next === ";"),
      });
    }
    // The exit code covers only what follows the last `;`. An earlier read could
    // have failed unseen, so it counts only for a file that is actually readable.
    for (const read of reads)
      for (const file of read.files)
        if (read.lastExit || this.regularFile(file)) this.add(file);
  }
  private regularFile(file: string): boolean {
    try {
      fs.accessSync(path.resolve(this.cwd, file), fs.constants.R_OK);
      return fs.statSync(path.resolve(this.cwd, file)).isFile();
    } catch {
      return false;
    }
  }
  observe(event: Obj): void {
    const part = obj(event.part),
      state = obj(part.state),
      item = obj(event.item);
    if (
      event.type === "tool_use" &&
      String(part.tool).toLowerCase() === "read" &&
      state.status === "completed"
    )
      this.add(obj(state.input).filePath ?? obj(state.input).file_path);
    if (
      event.type === "tool_use" &&
      part.tool === "bash" &&
      state.status === "completed" &&
      obj(state.metadata).exit === 0
    )
      this.command(obj(state.input).command);
    if (
      event.type === "item.completed" &&
      item.type === "command_execution" &&
      item.exit_code === 0 &&
      item.status !== "failed"
    )
      this.command(item.command);
    const content = obj(event.message).content;
    if (Array.isArray(content))
      for (const value of content) {
        const b = obj(value);
        if (
          event.type === "assistant" &&
          b.type === "tool_use" &&
          b.name === "Read" &&
          typeof b.id === "string"
        ) {
          this.pending.set(b.id, obj(b.input).file_path);
          if (this.pending.size > 128)
            this.pending.delete(this.pending.keys().next().value!);
        }
        if (
          event.type === "user" &&
          b.type === "tool_result" &&
          typeof b.tool_use_id === "string"
        ) {
          if (b.is_error !== true) this.add(this.pending.get(b.tool_use_id));
          this.pending.delete(b.tool_use_id);
        }
      }
  }
}
