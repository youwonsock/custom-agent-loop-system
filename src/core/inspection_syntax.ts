import * as path from "node:path";
import { canonicalCommand, literalShellWords } from "./verification_evidence";

export interface InspectionSegment {
  text: string;
  next: string;
}
function stderrAt(text: string, index: number): string | undefined {
  if (index > 0 && !/\s/.test(text[index - 1]!)) return undefined;
  return text.slice(index).match(/^2>(?:&1|\s*\/dev\/null)(?=\s|[;&|]|$)/)?.[0];
}
/** Split literal inspection chains without interpreting quoted operators. */
export function inspectionSegments(text: string): InspectionSegment[] | null {
  if (/[\r\n]/.test(text)) return null;
  const parts: InspectionSegment[] = [];
  let quote = "",
    current = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "\\" && quote !== "'") {
      if (i + 1 >= text.length) return null;
      current += c + text[++i];
      continue;
    }
    if (quote) {
      current += c;
      if (c === quote) quote = "";
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      current += c;
      continue;
    }
    const stderr = stderrAt(text, i);
    if (stderr) {
      current += stderr;
      i += stderr.length - 1;
      continue;
    }
    if (c === "&" || c === "|" || c === ";") {
      const next = c !== ";" && text[i + 1] === c ? c + c : c;
      if (c === "&" && next !== "&&") return null;
      if (!current.trim() || parts.length >= 32) return null;
      parts.push({ text: current.trim(), next });
      current = "";
      i += next.length - 1;
      continue;
    }
    current += c;
  }
  if (quote || !current.trim()) return null;
  parts.push({ text: current.trim(), next: "" });
  return parts;
}
export function stripInspectionStderr(
  text: string,
  removed?: string[],
): string {
  let output = "",
    quote = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "\\" && quote !== "'") {
      output += c;
      if (i + 1 < text.length) output += text[++i];
      continue;
    }
    if (quote) {
      output += c;
      if (c === quote) quote = "";
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      output += c;
      continue;
    }
    const stderr = stderrAt(text, i);
    if (stderr) {
      removed?.push(stderr);
      i += stderr.length - 1;
      continue;
    }
    output += c;
  }
  return output;
}
const shellQuote = (word: string) =>
  /^[a-zA-Z0-9_./:@%+=,-]+$/.test(word)
    ? word
    : `'${word.replace(/'/g, "'\\''")}'`;
/** Only simple, already scope-checked literal inspection paths are rewritten.
 * No glob expansion, substitutions, arbitrary programs or native grants. */
export function normalizeInspectionCommand(
  command: string,
  cwd: string,
): string {
  if (process.platform === "win32") return command;
  const parts = inspectionSegments(canonicalCommand(command));
  if (!parts) return command;
  for (const part of parts) {
    const w = literalShellWords(stripInspectionStderr(part.text));
    if (
      w?.[0] === "cd" &&
      (w.length !== 2 || path.resolve(cwd, w[1]!) !== path.resolve(cwd))
    )
      return command;
  }
  let changed = false;
  const normalized = parts.map((part) => {
    const removed: string[] = [],
      words = literalShellWords(stripInspectionStderr(part.text, removed));
    if (
      !words?.length ||
      !["ls", "dir", "cat", "head", "tail", "mkdir", "cd"].includes(words[0]!)
    )
      return part;
    if (
      words.some((w) => /[$`*?\[\]{}!]/.test(w)) ||
      words.some((w) => w.startsWith("--") && w !== "--") ||
      (words[0] === "ls" && words.some((w) => /^-[A-Za-z]*I/.test(w)))
    )
      return part;
    let local = false;
    const args = words.map((word, i) => {
      if (!i || !path.isAbsolute(word)) return word;
      const relative = path.relative(cwd, word);
      if (
        relative === ".." ||
        relative.startsWith("../") ||
        path.isAbsolute(relative)
      )
        return word;
      local = true;
      return relative || ".";
    });
    if (!local) return part;
    changed = true;
    return {
      ...part,
      text:
        args.map(shellQuote).join(" ") +
        (removed.length ? " " + removed.join(" ") : ""),
    };
  });
  return changed
    ? normalized
        .map((p) => p.text + (p.next ? " " + p.next + " " : ""))
        .join("")
    : command;
}
