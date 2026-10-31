export type ShellQuote = "" | "'" | '"';
export interface ShellScanner {
  /** A backslash and what follows it. Single quotes have no escapes, so never there. */
  escape(next: string | undefined, quote: ShellQuote): void;
  /** A quote character that opens or closes a quoted part. */
  quoteMark(c: string): void;
  /** Any other character. Returns how many following characters it consumed. */
  char(c: string, at: number, quote: ShellQuote): number;
}
/** Return from `char` to stop reading the rest of the text. */
export const STOP_SCAN = Infinity;
/** Tracks quotes and escapes for the shell readers; each keeps its own rules.
 * Returns the quote left open at the end of the text, if any. */
export function scanShell(text: string, scanner: ShellScanner): ShellQuote {
  let quote: ShellQuote = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "\\" && quote !== "'") {
      scanner.escape(text[++i], quote);
      continue;
    }
    if (c === quote || (!quote && (c === "'" || c === '"'))) {
      quote = c === quote ? "" : (c as ShellQuote);
      scanner.quoteMark(c);
      continue;
    }
    i += scanner.char(c, i, quote);
  }
  return quote;
}
