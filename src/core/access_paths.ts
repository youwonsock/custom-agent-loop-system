import * as path from "node:path";

/** Advisory prompt scan. Native CLI permissions remain the enforcement boundary. */
export function outsidePaths(text: string, roots: string[]): string[] {
  const found: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    // Keep quoted paths intact, including spaces. Consume URLs as a whole so
    // their pathname cannot be mistaken for a filesystem request.
    const tokens = /https?:\/\/[^\s]+|(["'`])([^\n]*?)\1|(?:^|[\s(])((?:[A-Za-z]:[\\/]|\/)[^\s"'`),;]+)/g;
    for (const match of line.matchAll(tokens)) {
      let value = (match[2] ?? match[3] ?? "").replace(/[.:]+$/, "");
      if (match[3]) {
        const start = match.index! + match[0].indexOf(match[3]);
        const suffix = line.slice(start);
        const root = [...roots].sort((a, b) => b.length - a.length).find(r => suffix.startsWith(r) && /^(?:[\s\/\\"'`),;]|[.:](?:\s|$)|$)/.test(suffix.slice(r.length)));
        if (root) {
          const rest = suffix.slice(root.length);
          value = root + (/^[\/\\]/.test(rest) ? rest.match(/^[^\s"'`),;]*/)?.[0] ?? "" : "");
        }
      }
      if (!/^(?:[A-Za-z]:[\\/]|\/)/.test(value)) continue;
      const explicit = /\bFILE_ACCESS:\s*/.test(line.slice(0, match.index));
      const knownFileRoot = /^\/(?:Users|home|tmp|private|var|etc|opt|usr|Volumes|mnt|srv|root|workspace|data)(?:\/|$)/.test(value);
      const httpContext = /\b(?:HTTP|GET|HEAD|POST|URL|endpoint|request|route|traversal)\b/i.test(line);
      const urlOnly = /^\/(?:\?|%[\da-f]{2})/i.test(value);
      if (!explicit && !knownFileRoot && !/^[A-Za-z]:/.test(value) && (httpContext || urlOnly)) continue;
      const api = /^[A-Za-z]:[\\/]/.test(value) ? path.win32 : path.posix;
      if (!roots.some(root => {
        if (/^[A-Za-z]:[\\/]/.test(root) !== (api === path.win32)) return false;
        const relative = api.relative(api.resolve(root), api.resolve(value));
        return relative === "" || (relative !== ".." && !relative.startsWith(`..${api.sep}`) && !api.isAbsolute(relative));
      })) found.push(value);
    }
  }
  return [...new Set(found)];
}
