#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { summarizePortableDirectory } = require("./portable-artifact.js");
const { readVerificationHelperIdentity } = require("./verification-helper-identity.js");

const root = path.resolve(__dirname, "..");
const desktopPackage = require(path.join(root, "desktop-app", "package.json"));
const supplied = process.argv[2] ? path.resolve(process.argv[2]) : null;
const candidates = supplied ? [supplied] : [
  path.join(root, "desktop-app", "out", "Agent Loop Orchestrator-win32-x64"),
];
const source = candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isDirectory());
if (!source) throw new Error(`Portable desktop directory was not found. Checked:\n${candidates.join("\n")}`);

const entryExecutable = path.join(source, "agent-loop-orchestrator.exe");
if (!fs.existsSync(entryExecutable)) {
  throw new Error(`Portable desktop entry executable was not found: ${entryExecutable}`);
}

const verificationHelper = readVerificationHelperIdentity(path.join(root, "desktop-app", "core"));
const gitResult = spawnSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
  windowsHide: true,
});
const sourceCommit = process.env.GITHUB_SHA ||
  (gitResult.status === 0 ? gitResult.stdout.trim() : "unknown");
if (verificationHelper.sourceCommit !== sourceCommit) {
  throw new Error(
    `Verification helper was built from ${verificationHelper.sourceCommit}, not candidate commit ${sourceCommit}.`
  );
}

const outputDirectory = path.join(root, "artifacts", "desktop");
fs.mkdirSync(outputDirectory, { recursive: true });
const artifactName = `AgentLoopOrchestrator-${desktopPackage.version}-win32-x64`;
const output = path.join(outputDirectory, artifactName);
for (const entry of fs.readdirSync(outputDirectory, { withFileTypes: true })) {
  if (entry.isDirectory() && /^AgentLoopOrchestrator-.*-win32-x64$/u.test(entry.name) && entry.name !== artifactName) {
    fs.rmSync(path.join(outputDirectory, entry.name), { recursive: true, force: true });
  }
  if (/^AgentLoopOrchestrator-.*-win32-x64-Setup\.exe(?:\.(?:sha256|manifest\.json|cdx\.json))?$/u.test(entry.name)) {
    fs.rmSync(path.join(outputDirectory, entry.name), { recursive: true, force: true });
  }
}
for (const candidate of [output, `${output}.sha256`, `${output}.manifest.json`, `${output}.cdx.json`]) {
  if (fs.existsSync(candidate)) fs.rmSync(candidate, { recursive: true, force: true });
}
fs.cpSync(source, output, { recursive: true });

const summary = summarizePortableDirectory(output);
const manifest = {
  schemaVersion: 1,
  artifactType: "desktop-portable",
  artifactFile: artifactName,
  entryExecutable: "agent-loop-orchestrator.exe",
  packageName: desktopPackage.name,
  packageVersion: desktopPackage.version,
  targetPlatform: "win32-x64",
  sha256: summary.sha256,
  bytes: summary.bytes,
  fileCount: summary.fileCount,
  sourceCommit,
  verificationHelper,
};
fs.writeFileSync(`${output}.sha256`, `${summary.sha256}  ${artifactName}/\n`, "utf8");
fs.writeFileSync(`${output}.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
const sbom = {
  bomFormat: "CycloneDX", specVersion: "1.5", version: 1,
  metadata: { component: { type: "application", name: desktopPackage.productName, version: desktopPackage.version, hashes: [{ alg: "SHA-256", content: summary.sha256 }], properties: [
    { name: "agent-loop:artifactType", value: "desktop-portable" },
    { name: "agent-loop:entryExecutable", value: "agent-loop-orchestrator.exe" },
    { name: "agent-loop:verificationHelperTarget", value: verificationHelper.target },
    { name: "agent-loop:verificationHelperSha256", value: verificationHelper.sha256 },
    { name: "agent-loop:verificationHelperSourceCommit", value: verificationHelper.sourceCommit },
  ] } },
};
fs.writeFileSync(`${output}.cdx.json`, `${JSON.stringify(sbom, null, 2)}\n`, "utf8");
process.stdout.write(`Desktop portable artifact staged: ${output} (${summary.fileCount} files, ${summary.bytes} bytes)\n`);
