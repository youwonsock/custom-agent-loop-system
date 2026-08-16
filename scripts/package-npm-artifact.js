#!/usr/bin/env node

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const packageJson = require(path.join(root, "package.json"));
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("npm_execpath is unavailable; run this script through npm.");

const artifactDirectory = path.join(root, "artifacts", "npm");
fs.mkdirSync(artifactDirectory, { recursive: true });
const artifactPrefix = `${packageJson.name.replace(/^@/, "").replaceAll("/", "-")}-`;
for (const entry of fs.readdirSync(artifactDirectory, { withFileTypes: true })) {
  if (
    entry.isFile() &&
    entry.name.startsWith(artifactPrefix) &&
    /\.tgz(?:\.(?:sha256|manifest\.json|cdx\.json))?$/.test(entry.name)
  ) {
    fs.rmSync(path.join(artifactDirectory, entry.name), { force: true });
  }
}
const result = spawnSync(
  process.execPath,
  [
    npmCli,
    "pack",
    "--json",
    "--ignore-scripts",
    "--pack-destination",
    artifactDirectory,
  ],
  {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  }
);
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(result.stderr || `npm pack exited with ${result.status}`);
const reports = JSON.parse(result.stdout);
if (!Array.isArray(reports) || reports.length !== 1) {
  throw new Error(`Expected one npm pack report, received ${reports.length}.`);
}
const report = reports[0];
const artifactPath = path.join(artifactDirectory, report.filename);
if (!fs.existsSync(artifactPath)) throw new Error(`npm pack did not create ${artifactPath}.`);

const files = new Set(report.files.map((entry) => entry.path));
for (const required of [
  "dist/loop_orchestrator.js",
  "dist/process_supervisor.js",
  "dist/protocol_contract.json",
  "agents.json",
  "agents.schema.json",
  "tasks.json",
  "tasks.schema.json",
  "workflow.json",
  "workflow.schema.json",
  "loop_config.schema.json",
  "scripts/fix-pty-permissions.js",
]) {
  if (!files.has(required)) throw new Error(`npm package is missing required file: ${required}`);
}
const forbidden = [...files].filter((file) =>
  file.endsWith(".ts") ||
  file.endsWith(".js.map") ||
  file.endsWith(".test.js") ||
  file.startsWith("test/") ||
  file.startsWith("experiments/") ||
  file.startsWith("vscode-extension/") ||
  file.startsWith(".github/") ||
  file.startsWith(".goal/") ||
  file.startsWith(".kilo/") ||
  file.startsWith("sessions_registry.json")
);
if (forbidden.length > 0) {
  throw new Error(`npm package leaks development/runtime files:\n${forbidden.join("\n")}`);
}

const artifact = fs.readFileSync(artifactPath);
const sha256 = crypto.createHash("sha256").update(artifact).digest("hex");
const gitResult = spawnSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
  windowsHide: true,
});
const sourceCommit = process.env.GITHUB_SHA ||
  (gitResult.status === 0 ? gitResult.stdout.trim() : "unknown");
const manifest = {
  schemaVersion: 1,
  packageName: packageJson.name,
  packageVersion: packageJson.version,
  artifactFile: path.basename(artifactPath),
  sha256,
  bytes: artifact.length,
  nodeEngine: packageJson.engines.node,
  sourceCommit,
  fileCount: files.size,
};
fs.writeFileSync(`${artifactPath}.sha256`, `${sha256}  ${path.basename(artifactPath)}\n`, "utf8");
fs.writeFileSync(
  `${artifactPath}.manifest.json`,
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8"
);
process.stdout.write(
  `npm artifact built once: ${artifactPath} (${files.size} files, ${artifact.length} bytes)\n`
);
