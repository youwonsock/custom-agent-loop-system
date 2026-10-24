import * as path from "node:path";
/** Exact platform-owned helper path; no project-authored executable qualifies. */
export function browserVerificationCommand(): string {
  const file = path.resolve(__dirname, "../server/cli.js");
  const quoted =
    process.platform === "win32"
      ? "'" + file.replace(/'/g, "''") + "'"
      : "'" + file.split("'").join(`'"'"'`) + "'";
  return `node ${quoted} verify-browser --spec .agent-graph/browser.json`;
}
