/**
 * Shared output safety primitives for provider and verification processes.
 *
 * The redactor deliberately keeps a short carry buffer so a credential split
 * across OS pipe/PTY chunks is still masked before it is persisted.  Callers
 * must call flush() after the stream closes to emit the final carry.
 */
const REDACTION_MARKER = "[REDACTED]";

function fixedLengthRedaction(length: number): string {
  if (length <= REDACTION_MARKER.length) return REDACTION_MARKER.slice(0, length);
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
    this.patterns = [...patterns].sort((left, right) => right.length - left.length);
    this.maximumPatternLength = this.patterns[0]?.length ?? 0;
  }

  push(chunk: string): string {
    if (this.patterns.length === 0) return chunk;
    const combined = this.carry + chunk;
    const safeBoundary = Math.max(0, combined.length - (this.maximumPatternLength - 1));
    return this.consume(combined, safeBoundary);
  }

  flush(): string {
    if (this.patterns.length === 0) return "";
    const combined = this.carry;
    return this.consume(combined, combined.length);
  }

  /**
   * PTYs may insert visual line wraps inside a secret. JSON reassembly removes
   * those wraps before parsing, so apply the same patterns once more to the
   * complete reconstructed record before it enters persisted event state.
   */
  redactComplete(value: string): string {
    let redacted = value;
    for (const pattern of this.patterns) {
      if (!redacted.includes(pattern)) continue;
      redacted = redacted.split(pattern).join(fixedLengthRedaction(pattern.length));
    }
    return redacted;
  }

  private consume(combined: string, safeBoundary: number): string {
    let index = 0;
    let output = "";
    while (index < safeBoundary) {
      const match = this.patterns.find((pattern) => combined.startsWith(pattern, index));
      if (match) {
        output += fixedLengthRedaction(match.length);
        index += match.length;
      } else {
        output += combined[index];
        index += 1;
      }
    }
    this.carry = combined.slice(index);
    return output;
  }
}

/** Append UTF-8 output without ever retaining more than the configured limit. */
export function appendBounded(
  current: string,
  chunk: Buffer | string,
  maximumBytes: number
): { value: string; truncated: boolean } {
  const limit = Math.max(0, Math.floor(maximumBytes));
  const remaining = limit - Buffer.byteLength(current, "utf8");
  if (remaining <= 0) return { value: current, truncated: true };
  const bytes = Buffer.from(chunk);
  if (bytes.byteLength > remaining) {
    return {
      value: current + bytes.subarray(0, remaining).toString("utf8").replace(/\uFFFD$/u, ""),
      truncated: true,
    };
  }
  return { value: current + bytes.toString("utf8"), truncated: false };
}
