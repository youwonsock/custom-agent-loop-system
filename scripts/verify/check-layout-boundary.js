#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const violations = [];
const rootFiles = fs.readdirSync(root, { withFileTypes: true });
for (const entry of rootFiles) {
  if (entry.isFile() && entry.name.endsWith(".ts") && entry.name !== "playwright.config.ts") violations.push(`root production TypeScript remains: ${entry.name}`);
  if (entry.isFile() && entry.name.endsWith(".json") && !["package.json", "package-lock.json", "tsconfig.json", "tsconfig.tests.json"].includes(entry.name)) {
    violations.push(`root definition JSON remains: ${entry.name}`);
  }
}
const requiredDirs = ["src", "config", "tests", "scripts/build", "scripts/package", "scripts/runtime", "scripts/verify", "scripts/test-support"];
for (const relative of requiredDirs) if (!fs.existsSync(path.join(root, relative))) violations.push(`missing layout directory: ${relative}`);
const forbiddenPaths = [
  "dist/loop_orchestrator.js", "dist/process_supervisor.js", "desktop-app/core/dist/src",
  "desktop-app/core/dist/loop_orchestrator.js", "desktop-app/core/dist/process_supervisor.js",
  "desktop-app/core/dist/src/interfaces/cli/main.js", "desktop-app/core/agents.json",
  "scripts/bundle-core-for-vsix.js", "scripts/package-vsix.js",
  "scripts/verify-vsix-package.js", "vscode-extension",
];
for (const relative of forbiddenPaths) if (fs.existsSync(path.join(root, relative))) violations.push(`forbidden legacy layout path exists: ${relative}`);
const capability = JSON.parse(fs.readFileSync(path.join(root, "config", "protocol_contract.json"), "utf8"));
if (!capability.capabilities?.includes("packaged-core-layout-v2")) violations.push("protocol contract is missing packaged-core-layout-v2");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
if (packageJson.main !== "dist/core/entrypoints/loop-orchestrator.js" || packageJson.bin?.["agent-loop"] !== packageJson.main) {
  violations.push("package entrypoint does not use dist/core/entrypoints/loop-orchestrator.js");
}
const definitionFiles = [
  "agents.json", "agents.schema.json", "tasks.json", "tasks.schema.json",
  "workflow.json", "workflow.schema.json", "loop_config.json", "loop_config.schema.json",
  "protocol_contract.json", "runtime_defaults.json",
];
const stagedConfig = path.join(root, "desktop-app", "core", "config");
if (fs.existsSync(stagedConfig)) {
  for (const file of definitionFiles) {
    const source = path.join(root, "config", file);
    const staged = path.join(stagedConfig, file);
    if (!fs.existsSync(staged)) {
      violations.push(`desktop core config is missing ${file}`);
      continue;
    }
    const sourceHash = require("node:crypto").createHash("sha256").update(fs.readFileSync(source)).digest("hex");
    const stagedHash = require("node:crypto").createHash("sha256").update(fs.readFileSync(staged)).digest("hex");
    if (sourceHash !== stagedHash) violations.push(`desktop core config differs from config/${file}`);
  }
}
const forbiddenText = ["scripts/fix-pty-permissions.js", "scripts/bundle-core-for-vsix.js", "core/dist/src/interfaces/cli/main.js"];
function scan(relative) {
  const target = path.join(root, relative);
  if (!fs.existsSync(target)) return;
  const stat = fs.statSync(target);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
      if (new Set(["node_modules", ".git", "dist", "coverage", "artifacts", ".build"]).has(entry.name)) continue;
      scan(path.join(relative, entry.name));
    }
  } else if (/\.(?:js|cjs|mjs|ts|json|yml|yaml)$/u.test(relative)) {
    if (path.resolve(target) === path.resolve(__filename) || path.basename(target) === "check-legacy-boundary.js") return;
    const text = fs.readFileSync(target, "utf8");
    for (const token of forbiddenText) if (text.includes(token)) violations.push(`${relative} references legacy layout '${token}'`);
  }
}
for (const relative of ["src", "desktop-app/src", "scripts", ".github", "package.json", "desktop-app/package.json"]) scan(relative);
if (violations.length) {
  process.stderr.write(`Layout boundary check failed:\n${violations.join("\n")}\n`);
  process.exitCode = 1;
} else process.stdout.write("Layout boundary check passed.\n");
