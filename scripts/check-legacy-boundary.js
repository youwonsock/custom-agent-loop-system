#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const forbiddenPaths = [
  "vscode-extension",
  "src/interfaces/vscode/run-projection.ts",
  "scripts/bundle-core-for-vsix.js",
  "scripts/package-vsix.js",
  "scripts/verify-vsix-package.js",
  "src/application/maintenance-service.ts",
  "src/application/maintenance-service.test.ts",
  "docs/MIGRATION.md",
];
const forbiddenTokens = [
  "RunProjectionV1",
  "OperatorSnapshotV2",
  "validateRunProjectionV1",
  "validateOperatorSnapshotV2",
  "normalizeSessionIndexProjectionV4",
  "legacyVerificationBinding",
  "@electron-forge/maker-squirrel",
  "desktop-installer",
  "Setup.exe",
  "--squirrel-",
  "MaintenanceService",
  "cmdUpgrade",
  "readLoopConfigForUpgrade",
  "loadLoopPathsForMaintenance",
  "runMaintenance",
  "importLegacyControlFiles",
  "upgrade --reset-sessions",
  "ignore: () => false",
  ".webpack/main/main.js",
  "desktop:runMaintenance",
  "runMaintenance:",
  "baselineFingerprint?:",
  "baselinePaths?:",
  "baselineFileHashes?:",
  "baselineFileModes?:",
  "approvedExecutable?:",
  "approvedArgs?:",
  "approvedCwd?:",
];
const forbiddenPatterns = [/\bcompletionNodeId\b/u];
const scanRoots = [
  "src", "desktop-app/src", "scripts", ".github",
  "package.json", "desktop-app/package.json",
  "agents.json", "agents.schema.json", "tasks.json", "tasks.schema.json",
  "workflow.json", "workflow.schema.json",
];
const ignored = new Set(["node_modules", "dist", "coverage", "artifacts", ".git"]);

function filesUnder(candidate) {
  if (!fs.existsSync(candidate)) return [];
  const stat = fs.statSync(candidate);
  if (stat.isFile()) return [candidate];
  const result = [];
  for (const entry of fs.readdirSync(candidate, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const child = path.join(candidate, entry.name);
    if (entry.isDirectory()) result.push(...filesUnder(child));
    else if (entry.isFile() && /\.(?:ts|tsx|js|jsx|cjs|mjs|json|yml|yaml)$/u.test(entry.name)) result.push(child);
  }
  return result;
}

const violations = [];
for (const relative of forbiddenPaths) {
  if (fs.existsSync(path.join(root, relative))) violations.push(`forbidden legacy path exists: ${relative}`);
}
for (const relative of scanRoots) {
  for (const file of filesUnder(path.join(root, relative))) {
    if (path.resolve(file) === path.resolve(__filename)) continue;
    const text = fs.readFileSync(file, "utf8");
    for (const token of forbiddenTokens) {
      if (text.includes(token)) violations.push(`${path.relative(root, file).replace(/\\/gu, "/")}: forbidden legacy token '${token}'`);
    }
    for (const pattern of forbiddenPatterns) {
      if (pattern.test(text)) violations.push(`${path.relative(root, file).replace(/\\/gu, "/")}: forbidden legacy token '${pattern.source}'`);
    }
  }
}
const workflowSchema = JSON.parse(fs.readFileSync(path.join(root, "workflow.schema.json"), "utf8"));
if (workflowSchema.properties?.schemaVersion?.const !== 2) violations.push("workflow.schema.json must require schemaVersion 2");
if (workflowSchema.properties?.cyclePolicy?.properties?.completionNodeId) violations.push("workflow.schema.json contains singular completionNodeId");
if (workflowSchema.properties?.cyclePolicy?.required?.includes("completionNodeIds") !== true) violations.push("workflow.schema.json must require completionNodeIds");

if (violations.length > 0) {
  process.stderr.write(`Legacy boundary check failed:\n${violations.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Legacy boundary check passed.\n");
}
