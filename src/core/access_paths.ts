import * as path from "node:path";

// A plan quoting code: `/[^a-z0-9]+/g`, `/slugify\(/`. A character class may hold `/`.
const REGEX_LITERAL =
  /^\/((?:\\.|\[(?:\\.|[^\]\\\r\n])*\]|[^/\\[\r\n])+)\/([dgimsuvy]*)(?=\s|[),;.:"'`]|$)/;
const REGEX_SYNTAX = /\\.|[[\]()^$+*?|{}]/;
const REGEX_ARGUMENT = /\.(?:match(?:All)?|replace(?:All)?|split|search)\(\s*$/;

/** True when file is root itself or anywhere below it. */
export function isWithin(
  root: string,
  file: string,
  api: typeof path.posix = path,
): boolean {
  const relative = api.relative(root, file);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(".." + api.sep) &&
      !api.isAbsolute(relative))
  );
}

/** Advisory prompt scan. Native CLI permissions remain the enforcement boundary. */
export function outsidePaths(text: string, roots: string[]): string[] {
  const found: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (
      /\bFILE_ACCESS:\s*\/(?=\s|$)/.test(line) &&
      !roots.some((root) => root === "/")
    )
      found.push("/");
    // Keep quoted paths intact, including spaces. Consume URLs as a whole so
    // their pathname cannot be mistaken for a filesystem request.
    const tokens =
      /https?:\/\/[^\s]+|(["'`])([^\n]*?)\1|(?:^|[\s(])((?:[A-Za-z]:[\\/]|\/)[^\s"'`),;]+)/g;
    for (const match of line.matchAll(tokens)) {
      let value = (match[2] ?? match[3] ?? "").replace(/[.:]+$/, "");
      if (match[3]) {
        const start = match.index! + match[0].indexOf(match[3]);
        const suffix = line.slice(start);
        const root = [...roots]
          .sort((a, b) => b.length - a.length)
          .find(
            (r) =>
              suffix.startsWith(r) &&
              /^(?:[\s\/\\"'`),;]|[.:](?:\s|$)|$)/.test(suffix.slice(r.length)),
          );
        if (root) {
          const rest = suffix.slice(root.length);
          value =
            root +
            (/^[\/\\]/.test(rest)
              ? (rest.match(/^[^\s"'`),;]*/)?.[0] ?? "")
              : "");
        }
      }
      if (!/^(?:[A-Za-z]:[\\/]|\/)/.test(value)) continue;
      const explicit = /\bFILE_ACCESS:\s*/.test(line.slice(0, match.index));
      const knownFileRoot =
        /^\/(?:Users|home|tmp|private|var|etc|opt|usr|Volumes|mnt|srv|root|workspace|data)(?:\/|$)/.test(
          value,
        );
      const start = match.index! + match[0].indexOf(match[2] ?? match[3] ?? "");
      const before = line.slice(0, start);
      const regexContext =
        /\b(?:text|hasText|match(?:es)?|regex(?:p)?|RegExp|pattern)\b/i.test(
          line.slice(0, match.index),
        );
      const literal = line.slice(start).match(REGEX_LITERAL);
      // A bare /foo/g stays a path unless the line says it is a pattern, and a
      // real path has a second separator, so it never reaches this literal shape.
      if (
        !explicit &&
        !knownFileRoot &&
        literal &&
        (REGEX_SYNTAX.test(literal[1]!) ||
          REGEX_ARGUMENT.test(before) ||
          (regexContext && literal[2]))
      )
        continue;
      // A plan quoting code: `f(x); // result`, `/** docs */`. A bare comment
      // marker names nothing, and a path after it is its own token.
      const commentMarker =
        /^\/{2,3}$/.test(value) ||
        (/^\/\*{1,2}$/.test(value) && line.slice(start).includes("*/"));
      if (!explicit && commentMarker) continue;
      const httpContext =
        /\b(?:HTTP|GET|HEAD|POST|URL|endpoint|request|route|traversal)\b/i.test(
          line,
        );
      const urlOnly = /^\/(?:\?|%[\da-f]{2})/i.test(value);
      // A web root-to-index mapping is a route description even when the line
      // omits "HTTP". Match this token only; a second '/' or real file path on
      // the same line must still be reviewed. Explicit FILE_ACCESS always wins.
      const rootDocumentRoute =
        value === "/" &&
        /\b(?:handle|serve|map)\s*$/i.test(before.replace(/["'`]$/, "")) &&
        /^\s*(?:->|=>|→)\s*index\.html\b/i.test(
          line.slice(start + 1).replace(/^["'`]/, ""),
        );
      if (
        !explicit &&
        !knownFileRoot &&
        !/^[A-Za-z]:/.test(value) &&
        (httpContext || urlOnly || rootDocumentRoute)
      )
        continue;
      const api = /^[A-Za-z]:[\\/]/.test(value) ? path.win32 : path.posix;
      if (
        !roots.some(
          (root) =>
            /^[A-Za-z]:[\\/]/.test(root) === (api === path.win32) &&
            isWithin(root, value, api),
        )
      )
        found.push(value);
    }
  }
  return [...new Set(found)];
}
