#!/usr/bin/env node

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const packageJson = require(path.join(root, "package.json"));
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("npm_execpath is unavailable; run this check through npm.");
const expectedFileName = `${packageJson.name.replace(/^@/, "").replace(/\//g, "-")}-${packageJson.version}.tgz`;
const artifactPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(root, "artifacts", "npm", expectedFileName);

function fail(message) {
  throw new Error(`[verify-npm] ${message}`);
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function run(label, file, args, options = {}) {
  const result = spawnSync(file, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: options.timeout || 180_000,
    windowsHide: true,
  });
  if (result.error) fail(`${label} failed: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`${label} exited with ${result.status}: ${result.stderr || result.stdout}`);
  }
  return result;
}

function listFiles(directory, prefix = "") {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(entryPath, relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files.sort();
}

if (!fs.existsSync(artifactPath)) fail(`Missing npm artifact: ${artifactPath}`);
for (const sidecar of [`${artifactPath}.sha256`, `${artifactPath}.manifest.json`]) {
  if (!fs.existsSync(sidecar)) fail(`Missing artifact sidecar: ${sidecar}`);
}
const digest = sha256File(artifactPath);
const checksumLine = fs.readFileSync(`${artifactPath}.sha256`, "utf8").trim();
if (checksumLine !== `${digest}  ${path.basename(artifactPath)}`) {
  fail("SHA-256 sidecar does not match the exact npm artifact.");
}
const manifest = JSON.parse(fs.readFileSync(`${artifactPath}.manifest.json`, "utf8"));
if (
  manifest.schemaVersion !== 1 ||
  manifest.packageName !== packageJson.name ||
  manifest.packageVersion !== packageJson.version ||
  manifest.artifactFile !== path.basename(artifactPath) ||
  manifest.sha256 !== digest ||
  manifest.bytes !== fs.statSync(artifactPath).size
) {
  fail("Artifact manifest identity, size, or digest does not match the exact npm artifact.");
}

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-loop-npm-artifact-"));
try {
  fs.writeFileSync(
    path.join(temporaryRoot, "package.json"),
    `${JSON.stringify({ name: "agent-loop-artifact-verifier", private: true }, null, 2)}\n`,
    "utf8"
  );
  run(
    "installing exact npm artifact",
    process.execPath,
    [
      npmCli,
      "install",
      "--no-package-lock",
      "--no-audit",
      "--no-fund",
      "--save-exact",
      artifactPath,
    ],
    { cwd: temporaryRoot }
  );

  const installedRoot = path.join(temporaryRoot, "node_modules", packageJson.name);
  const installedPackagePath = path.join(installedRoot, "package.json");
  if (!fs.existsSync(installedPackagePath)) fail("Installed artifact package.json is missing.");
  const installedPackage = JSON.parse(fs.readFileSync(installedPackagePath, "utf8"));
  if (installedPackage.name !== packageJson.name || installedPackage.version !== packageJson.version) {
    fail("Installed artifact package identity does not match the candidate.");
  }
  if (installedPackage.dependencies?.["@langchain/langgraph"] !== undefined) {
    fail("The production package unexpectedly depends on LangGraph.");
  }

  const files = listFiles(installedRoot);
  for (const required of [
    "dist/loop_orchestrator.js",
    "dist/process_supervisor.js",
    "dist/protocol_contract.json",
    "scripts/fix-pty-permissions.js",
  ]) {
    if (!files.includes(required)) fail(`Installed artifact is missing ${required}.`);
  }
  const forbidden = files.filter((file) =>
    file.endsWith(".ts") ||
    file.endsWith(".js.map") ||
    file.endsWith(".test.js") ||
    file.startsWith("experiments/") ||
    file.startsWith("vscode-extension/")
  );
  if (forbidden.length > 0) {
    fail(`Installed artifact leaks development files:\n${forbidden.join("\n")}`);
  }

  run(
    "installed CLI smoke",
    process.execPath,
    [path.join(installedRoot, "dist", "loop_orchestrator.js"), "--help"],
    { cwd: temporaryRoot, timeout: 30_000 }
  );

  const fakeCliPath = path.join(temporaryRoot, "artifact-supervisor-fake-cli.js");
  fs.writeFileSync(
    fakeCliPath,
    [
      "const event = {",
      "  type: 'text',",
      "  id: 'npm-supervisor-smoke',",
      "  part: { id: 'npm-supervisor-smoke', text: 'AGENT_LOOP_SUPERVISOR_OK\\n[PHASE_DONE]' },",
      "};",
      "process.stdout.write(JSON.stringify(event) + '\\n');",
    ].join("\n"),
    "utf8"
  );
  run(
    "installed ProcessSupervisor lifecycle",
    process.execPath,
    [
      path.join(root, "scripts", "bundled-supervisor-smoke-child.js"),
      path.join(installedRoot, "dist", "process_supervisor.js"),
      fakeCliPath,
      temporaryRoot,
    ],
    { cwd: temporaryRoot, timeout: 30_000 }
  );
  run(
    "installed native PTY lifecycle",
    process.execPath,
    [
      path.join(root, "scripts", "pty-smoke-child.js"),
      path.join(temporaryRoot, "node_modules", "node-pty"),
      temporaryRoot,
    ],
    { cwd: temporaryRoot, timeout: 30_000 }
  );
  process.stdout.write(
    `npm artifact verified after install: ${path.basename(artifactPath)} ` +
      `(${process.platform}-${process.arch}, ${process.version})\n`
  );
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
