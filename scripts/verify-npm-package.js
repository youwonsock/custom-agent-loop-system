#!/usr/bin/env node

const { spawnSync } = require("node:child_process");

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("npm_execpath is unavailable; run this check through npm run pack:check.");
const result = spawnSync(process.execPath, [
  npmCli,
  "pack",
  "--dry-run",
  "--json",
  "--ignore-scripts",
], {
  cwd: process.cwd(),
  encoding: "utf8",
});
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(result.stderr || `npm pack exited with ${result.status}`);
const report = JSON.parse(result.stdout);
const files = new Set(report[0].files.map((entry) => entry.path));
for (const required of [
  "dist/loop_orchestrator.js",
  "dist/process_supervisor.js",
  "agent_roles.json",
  "agent_loop.json",
  "loop_config.schema.json",
  "scripts/fix-pty-permissions.js",
]) {
  if (!files.has(required)) throw new Error(`npm package is missing required file: ${required}`);
}
const forbidden = [...files].filter((file) =>
  file.endsWith(".ts") ||
  file.endsWith(".test.js") ||
  file.startsWith("test/") ||
  file.startsWith("vscode-extension/") ||
  file.startsWith(".goal/") ||
  file.startsWith(".kilo/") ||
  file.startsWith("sessions_registry.json")
);
if (forbidden.length > 0) {
  throw new Error(`npm package leaks development/runtime files:\n${forbidden.join("\n")}`);
}
process.stdout.write(
  `npm package contents verified: ${files.size} files, ${report[0].unpackedSize} unpacked bytes.\n`
);
