type Obj = Record<string, unknown>;
/** Only native tool schema/availability failures; product assertions and access
 * denials keep their normal verdict/gate instead of becoming argument retries. */
export class ToolFailureTracker {
  private seen = new Set<string>();
  private previous = "";
  private count = 0;
  observe(event: Obj): string | null {
    if (event.type !== "tool_use") return null;
    const part = event.part as Obj | undefined;
    const state = part?.state as Obj | undefined;
    if (!part || !state) return null;
    if (state.status === "completed") {
      this.previous = "";
      this.count = 0;
      return null;
    }
    const error = typeof state.error === "string" ? state.error : "";
    if (state.status !== "error") return null;
    if (!/unavailable tool|invalid (?:tool )?(?:arguments?|input)|required (?:field|parameter)|missing.*(?:filePath|content|command)/i.test(error)) {
      this.previous = "";
      this.count = 0;
      return null;
    }
    const identity = String(part.callID ?? part.id ?? event.id ?? "");
    // Duplicate streamed snapshots of the same failed call cannot consume retries.
    if (!identity || this.seen.has(identity)) return null;
    this.seen.add(identity);
    if (this.seen.size > 128) this.seen.delete(this.seen.values().next().value!);
    const key = `${String(part.tool)}:${error}`;
    this.count = this.previous === key ? this.count + 1 : 1;
    this.previous = key;
    return this.count >= 3
      ? `Stopped after ${this.count} consecutive invalid-argument failures for the "${String(part.tool)}" tool. ${error.slice(0, 1500)}`
      : null;
  }
}
