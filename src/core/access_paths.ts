import * as path from "node:path";

/** Advisory prompt scan. Native CLI permissions remain the enforcement boundary. */
export function outsidePaths(text: string, roots: string[]): string[] {
  const found: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (/\bFILE_ACCESS:\s*\/(?=\s|$)/.test(line) && !roots.some(root => root === "/")) found.push("/");
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
      const tail = line.slice(match.index! + match[0].indexOf(match[2] ?? match[3] ?? ""));
      const regexContext = /\b(?:text|hasText|match(?:es)?|regex(?:p)?|RegExp|pattern)\b/i.test(line.slice(0,match.index));
      if (!explicit && !knownFileRoot && regexContext && /^\/(?:\\.|[^/\\\r\n])+\/[dgimsuvy]+(?=\s|[),;.]|$)/.test(tail)) continue;
      const httpContext = /\b(?:HTTP|GET|HEAD|POST|URL|endpoint|request|route|traversal)\b/i.test(line);
      const urlOnly = /^\/(?:\?|%[\da-f]{2})/i.test(value);
      const start = match.index! + match[0].indexOf(match[2] ?? match[3] ?? "");
      // A web root-to-index mapping is a route description even when the line
      // omits "HTTP". Match this token only; a second '/' or real file path on
      // the same line must still be reviewed. Explicit FILE_ACCESS always wins.
      const rootDocumentRoute = value === "/" &&
        /\b(?:handle|serve|map)\s*$/i.test(line.slice(0,start).replace(/["'`]$/, "")) &&
        /^\s*(?:->|=>|→)\s*index\.html\b/i.test(line.slice(start+1).replace(/^["'`]/, ""));
      if (!explicit && !knownFileRoot && !/^[A-Za-z]:/.test(value) && (httpContext || urlOnly || rootDocumentRoute)) continue;
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
