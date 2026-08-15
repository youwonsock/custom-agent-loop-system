#!/usr/bin/env node

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : null;
}
const optionNames = new Set(["--expected-commit", "--expected-count", "--expected-vsix-targets"]);
const positional = process.argv.slice(2).filter((value, index, values) =>
  !optionNames.has(value) && !optionNames.has(values[index - 1])
);
const expectedCommit = option("expected-commit");
const expectedCountText = option("expected-count");
const expectedCount = expectedCountText === null ? null : Number(expectedCountText);
const expectedVsixTargets = new Set(
  (option("expected-vsix-targets") || "").split(",").map((value) => value.trim()).filter(Boolean)
);
if (process.argv.includes("--expected-commit") && !expectedCommit) {
  throw new Error("--expected-commit requires a full commit SHA.");
}
if (expectedCount !== null && (!Number.isSafeInteger(expectedCount) || expectedCount < 1)) {
  throw new Error("--expected-count must be a positive integer.");
}
const bundleInput = positional[0]
  ? path.resolve(positional[0])
  : path.join(root, "artifacts");

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function walk(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (
      entry.isDirectory() &&
      !["node_modules", ".git", ".vscode-test", "out", "core"].includes(entry.name)
    ) files.push(...walk(entryPath));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
}

if (!fs.existsSync(bundleInput)) {
  throw new Error(`Release bundle input does not exist: ${bundleInput}`);
}
const bundleRoot = fs.statSync(bundleInput).isDirectory() ? bundleInput : path.dirname(bundleInput);
const files = fs.statSync(bundleInput).isDirectory() ? walk(bundleInput) : [bundleInput];
const artifacts = files.filter((file) => file.endsWith(".tgz") || file.endsWith(".vsix"));
if (artifacts.length === 0) throw new Error(`No npm or VSIX artifacts found at ${bundleInput}.`);
if (expectedCount !== null && artifacts.length !== expectedCount) {
  throw new Error(`Expected ${expectedCount} release artifacts, found ${artifacts.length}.`);
}
const observedVsixTargets = new Set();

for (const artifact of artifacts) {
  const digest = sha256File(artifact);
  const checksumPath = `${artifact}.sha256`;
  const sbomPath = `${artifact}.cdx.json`;
  const manifestPath = `${artifact}.manifest.json`;
  for (const required of [checksumPath, sbomPath, manifestPath]) {
    if (!fs.existsSync(required)) {
      throw new Error(`Artifact ${path.basename(artifact)} is missing ${path.basename(required)}.`);
    }
  }
  const checksum = fs.readFileSync(checksumPath, "utf8").trim();
  if (checksum !== `${digest}  ${path.basename(artifact)}`) {
    throw new Error(`Checksum mismatch for ${artifact}.`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (
    manifest.schemaVersion !== 1 ||
    manifest.artifactFile !== path.basename(artifact) ||
    manifest.sha256 !== digest ||
    manifest.bytes !== fs.statSync(artifact).size
  ) {
    throw new Error(`Manifest mismatch for ${artifact}.`);
  }
  if (expectedCommit && manifest.sourceCommit !== expectedCommit) {
    throw new Error(
      `Artifact ${path.basename(artifact)} was built from ${manifest.sourceCommit}, not ${expectedCommit}.`
    );
  }
  if (artifact.endsWith(".vsix")) observedVsixTargets.add(manifest.targetPlatform);
  const sbom = JSON.parse(fs.readFileSync(sbomPath, "utf8"));
  if (sbom.bomFormat !== "CycloneDX") throw new Error(`Invalid CycloneDX SBOM for ${artifact}.`);
  const hashes = sbom.metadata?.component?.hashes || [];
  if (!hashes.some((hash) => hash.alg === "SHA-256" && hash.content === digest)) {
    throw new Error(`SBOM does not bind the SHA-256 of ${artifact}.`);
  }
}

const missingVsixTargets = [...expectedVsixTargets].filter(
  (target) => !observedVsixTargets.has(target)
);
const unexpectedVsixTargets = [...observedVsixTargets].filter(
  (target) => !expectedVsixTargets.has(target)
);
if (
  expectedVsixTargets.size > 0 &&
  (missingVsixTargets.length > 0 || unexpectedVsixTargets.length > 0)
) {
  throw new Error(
    `VSIX target mismatch. Missing: ${missingVsixTargets.join(", ") || "none"}; ` +
      `unexpected: ${unexpectedVsixTargets.join(", ") || "none"}.`
  );
}

process.stdout.write(
  `Release bundle verified: ${artifacts.length} exact artifact(s) under ${bundleRoot}` +
    `${expectedCommit ? ` from ${expectedCommit}` : ""}.\n`
);
