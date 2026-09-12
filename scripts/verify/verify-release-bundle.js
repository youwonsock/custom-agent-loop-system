#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { artifactDigest, isPortableArtifactPath, summarizePortableDirectory } = require("../package/portable-artifact.js");

const root = path.resolve(__dirname, "../..");
function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : null;
}
const optionNames = new Set(["--expected-commit", "--expected-count", "--expected-desktop-targets"]);
const positional = process.argv.slice(2).filter((value, index, values) =>
  !optionNames.has(value) && !optionNames.has(values[index - 1])
);
const expectedCommit = option("expected-commit");
const expectedCountText = option("expected-count");
const expectedCount = expectedCountText === null ? null : Number(expectedCountText);
const expectedDesktopTargets = new Set(
  (option("expected-desktop-targets") || "").split(",").map((value) => value.trim()).filter(Boolean)
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

function sha256Artifact(filePath) {
  return artifactDigest(filePath);
}

function collectArtifacts(directory) {
  const artifacts = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (isPortableArtifactPath(entryPath)) artifacts.push(entryPath);
      else if (!["node_modules", ".git", "out", "core"].includes(entry.name)) {
        artifacts.push(...collectArtifacts(entryPath));
      }
    } else if (entry.isFile() && (entry.name.endsWith(".tgz") || entry.name.endsWith(".exe") || entry.name.endsWith(".zip"))) {
      artifacts.push(entryPath);
    }
  }
  return artifacts;
}

function propertyValue(sbom, name) {
  const properties = sbom.metadata?.component?.properties;
  if (!Array.isArray(properties)) return null;
  const property = properties.find((item) => item && item.name === name);
  return typeof property?.value === "string" ? property.value : null;
}

function assertVerificationHelperBinding(artifact, manifest, sbom, expectedCommit) {
  const majorVersion = Number.parseInt(String(manifest.packageVersion || "0").split(".")[0], 10);
  if (majorVersion < 6) return;
  const helper = manifest.verificationHelper;
  if (
    !helper ||
    helper.target !== "win32-x64" ||
    !/^[a-f0-9]{64}$/u.test(helper.sha256 || "") ||
    typeof helper.sourceCommit !== "string" ||
    !helper.sourceCommit
  ) {
    throw new Error(`Artifact ${path.basename(artifact)} is missing a valid verification helper identity.`);
  }
  if (expectedCommit && helper.sourceCommit !== expectedCommit) {
    throw new Error(`Artifact ${path.basename(artifact)} embeds a helper from ${helper.sourceCommit}, not ${expectedCommit}.`);
  }
  if (
    propertyValue(sbom, "agent-loop:verificationHelperTarget") !== helper.target ||
    propertyValue(sbom, "agent-loop:verificationHelperSha256") !== helper.sha256 ||
    propertyValue(sbom, "agent-loop:verificationHelperSourceCommit") !== helper.sourceCommit
  ) {
    throw new Error(`SBOM verification helper identity does not match ${path.basename(artifact)}.`);
  }
}

if (!fs.existsSync(bundleInput)) {
  throw new Error(`Release bundle input does not exist: ${bundleInput}`);
}
const bundleRoot = fs.statSync(bundleInput).isDirectory() ? bundleInput : path.dirname(bundleInput);
const artifacts = fs.statSync(bundleInput).isDirectory() ? collectArtifacts(bundleInput) : [bundleInput];
if (artifacts.length === 0) throw new Error(`No npm or desktop artifacts found at ${bundleInput}.`);
if (expectedCount !== null && artifacts.length !== expectedCount) {
  throw new Error(`Expected ${expectedCount} release artifacts, found ${artifacts.length}.`);
}
const observedDesktopTargets = new Set();

for (const artifact of artifacts) {
  const digest = sha256Artifact(artifact);
  const checksumPath = `${artifact}.sha256`;
  const sbomPath = `${artifact}.cdx.json`;
  const manifestPath = `${artifact}.manifest.json`;
  for (const required of [checksumPath, sbomPath, manifestPath]) {
    if (!fs.existsSync(required)) {
      throw new Error(`Artifact ${path.basename(artifact)} is missing ${path.basename(required)}.`);
    }
  }
  const checksum = fs.readFileSync(checksumPath, "utf8").trim();
  const isDirectoryArtifact = fs.statSync(artifact).isDirectory();
  const expectedChecksum = `${digest}  ${path.basename(artifact)}${isDirectoryArtifact ? "/" : ""}`;
  if (checksum !== expectedChecksum) {
    throw new Error(`Checksum mismatch for ${artifact}.`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const artifactBytes = isDirectoryArtifact ? summarizePortableDirectory(artifact).bytes : fs.statSync(artifact).size;
  if (
    manifest.schemaVersion !== 1 ||
    manifest.artifactFile !== path.basename(artifact) ||
    manifest.sha256 !== digest ||
    manifest.bytes !== artifactBytes
  ) {
    throw new Error(`Manifest mismatch for ${artifact}.`);
  }
  if (expectedCommit && manifest.sourceCommit !== expectedCommit) {
    throw new Error(
      `Artifact ${path.basename(artifact)} was built from ${manifest.sourceCommit}, not ${expectedCommit}.`
    );
  }
  if (manifest.targetPlatform) observedDesktopTargets.add(manifest.targetPlatform);
  const sbom = JSON.parse(fs.readFileSync(sbomPath, "utf8"));
  if (sbom.bomFormat !== "CycloneDX") throw new Error(`Invalid CycloneDX SBOM for ${artifact}.`);
  const hashes = sbom.metadata?.component?.hashes || [];
  if (!hashes.some((hash) => hash.alg === "SHA-256" && hash.content === digest)) {
    throw new Error(`SBOM does not bind the SHA-256 of ${artifact}.`);
  }
  assertVerificationHelperBinding(artifact, manifest, sbom, expectedCommit);
}

const missingDesktopTargets = [...expectedDesktopTargets].filter(
  (target) => !observedDesktopTargets.has(target)
);
const unexpectedDesktopTargets = [...observedDesktopTargets].filter(
  (target) => !expectedDesktopTargets.has(target)
);
if (
  expectedDesktopTargets.size > 0 &&
  (missingDesktopTargets.length > 0 || unexpectedDesktopTargets.length > 0)
) {
  throw new Error(
    `Desktop target mismatch. Missing: ${missingDesktopTargets.join(", ") || "none"}; ` +
      `unexpected: ${unexpectedDesktopTargets.join(", ") || "none"}.`
  );
}

process.stdout.write(
  `Release bundle verified: ${artifacts.length} exact artifact(s) under ${bundleRoot}` +
    `${expectedCommit ? ` from ${expectedCommit}` : ""}.\n`
);
