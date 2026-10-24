/** Streaming framing, bounded buffers and credential redaction, independent of providers. */
const REDACTION_MARKER = "[REDACTED]";

function fixedLengthRedaction(length: number): string {
  if (length <= REDACTION_MARKER.length)
    return REDACTION_MARKER.slice(0, length);
  return REDACTION_MARKER + "*".repeat(length - REDACTION_MARKER.length);
}

export class StreamingRedactor {
  private carry = "";
  private readonly patterns: string[];
  private readonly maximumPatternLength: number;

  constructor(sensitiveValues: readonly string[]) {
    const patterns = new Set<string>();
    for (const secret of sensitiveValues.filter(Boolean)) {
      patterns.add(secret);
      const jsonEscaped = JSON.stringify(secret).slice(1, -1);
      if (jsonEscaped !== secret) patterns.add(jsonEscaped);
    }
    this.patterns = [...patterns].sort(
      (left, right) => right.length - left.length,
    );
    this.maximumPatternLength = this.patterns[0]?.length ?? 0;
  }

  push(chunk: string): string {
    if (this.patterns.length === 0) return chunk;
    const combined = this.carry + chunk;
    return this.consume(combined, false);
  }

  flush(): string {
    if (this.patterns.length === 0) return "";
    const combined = this.carry;
    return this.consume(combined, true);
  }

  private consume(combined: string, final: boolean): string {
    let index = 0;
    let output = "";
    while (index < combined.length) {
      const match = this.patterns.find((pattern) =>
        combined.startsWith(pattern, index),
      );
      if (match) {
        output += fixedLengthRedaction(match.length);
        index += match.length;
      } else {
        // Retain only a suffix that could become a secret in the next chunk.
        // Holding an unrelated maximum-length suffix delays complete JSON
        // policy events until another chunk (or a watchdog timeout) arrives.
        if (!final && combined.length - index < this.maximumPatternLength) {
          const suffix = combined.slice(index);
          if (this.patterns.some(pattern => pattern.startsWith(suffix))) break;
        }
        output += combined[index];
        index += 1;
      }
    }
    this.carry = combined.slice(index);
    return output;
  }
}

export function utf8Prefix(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maximumBytes) return value;
  return bytes
    .subarray(0, Math.max(0, maximumBytes))
    .toString("utf8")
    .replace(/\uFFFD$/, "");
}

export class LineBuffer {
  private buffer = "";

  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines: string[] = [];
    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf("\n")) >= 0) {
      lines.push(this.buffer.slice(0, newlineIndex).replace(/\r$/, ""));
      this.buffer = this.buffer.slice(newlineIndex + 1);
    }
    if (this.buffer.length > 1024 * 1024) {
      lines.push(this.buffer);
      this.buffer = "";
    }
    return lines;
  }

  flush(): string | null {
    if (this.buffer.length === 0) return null;
    const value = this.buffer;
    this.buffer = "";
    return value;
  }
}

export function stripTerminalControlSequences(value: string): string {
  return value
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, "")
    .replace(/\x1b[()][AB012]/g, "")
    .replace(/\x1b[=>]/g, "")
    .replace(/[\x00-\x08\x0e-\x1f\x7f]/g, "");
}

export function isInteractiveAccessPrompt(value: string): boolean {
  const normalized = stripTerminalControlSequences(value)
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return false;
  return (
    /(?:allow|grant)\b.{0,120}(?:\[y\/n\]|\(y\/n\)|yes\/no)/i.test(
      normalized,
    ) ||
    /(?:permission|access)\s+(?:is\s+)?(?:required|requested|needed)/i.test(
      normalized,
    ) ||
    /do you want to allow\b/i.test(normalized)
  );
}

export function appendRing(current: string, chunk: string, maxBytes: number): string {
  const combined = current + chunk;
  if (Buffer.byteLength(combined, "utf8") <= maxBytes) return combined;
  const buffer = Buffer.from(combined, "utf8");
  return buffer
    .subarray(Math.max(0, buffer.length - maxBytes))
    .toString("utf8");
}

export function isStructurallyCompleteJson(value: string): boolean {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const char of value) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{" || char === "[") {
      depth++;
    } else if (char === "}" || char === "]") {
      depth--;
      if (depth < 0) return true;
    }
  }
  return !inString && depth === 0;
}

