#!/usr/bin/env node

const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { readVerificationHelperIdentity } = require("./verification-helper-identity.js");

const root = path.resolve(__dirname, "..");
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("npm_execpath is unavailable; run this script through npm.");
const result = spawnSync(
  process.execPath,
  [npmCli, "sbom", "--omit=dev", "--sbom-format", "cyclonedx"],
  { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }
);
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(result.stderr || `npm sbom exited with ${result.status}`);
const sbom = JSON.parse(result.stdout);
const outputDirectory = path.join(root, "artifacts");
fs.mkdirSync(outputDirectory, { recursive: true });
const artifactDirectoryIndex = process.argv.indexOf("--artifact-directory");
let artifactPath = null;
if (artifactDirectoryIndex >= 0) {
  const suppliedDirectory = process.argv[artifactDirectoryIndex + 1];
  if (!suppliedDirectory) throw new Error("--artifact-directory requires a directory path.");
  const artifactDirectory = path.resolve(suppliedDirectory);
  const artifacts = fs.readdirSync(artifactDirectory)
    .filter((name) => name.endsWith(".tgz"))
    .map((name) => path.join(artifactDirectory, name));
  if (artifacts.length !== 1) {
    throw new Error(`Expected exactly one npm artifact in ${artifactDirectory}, found ${artifacts.length}.`);
  }
  artifactPath = artifacts[0];
}
if (artifactPath) {
  const artifactDigest = crypto.createHash("sha256")
    .update(fs.readFileSync(artifactPath))
    .digest("hex");
  sbom.metadata = sbom.metadata || {};
  sbom.metadata.component = sbom.metadata.component || {
    type: "application",
    name: require(path.join(root, "package.json")).name,
    version: require(path.join(root, "package.json")).version,
  };
  sbom.metadata.component.hashes = [
    ...(sbom.metadata.component.hashes || []).filter((hash) => hash.alg !== "SHA-256"),
    { alg: "SHA-256", content: artifactDigest },
  ];
  sbom.metadata.component.properties = [
    ...(sbom.metadata.component.properties || []).filter(
      (property) => ![
        "agent-loop:artifactFile",
        "agent-loop:verificationHelperTarget",
        "agent-loop:verificationHelperSha256",
        "agent-loop:verificationHelperSourceCommit",
      ].includes(property.name)
    ),
    { name: "agent-loop:artifactFile", value: path.basename(artifactPath) },
  ];
  const helper = readVerificationHelperIdentity(root);
  sbom.metadata.component.properties.push(
    { name: "agent-loop:verificationHelperTarget", value: helper.target },
    { name: "agent-loop:verificationHelperSha256", value: helper.sha256 },
    { name: "agent-loop:verificationHelperSourceCommit", value: helper.sourceCommit },
  );
} else {
  const helper = readVerificationHelperIdentity(root, { required: false });
  if (helper) {
    sbom.metadata = sbom.metadata || {};
    sbom.metadata.component = sbom.metadata.component || {};
    sbom.metadata.component.properties = [
      ...(sbom.metadata.component.properties || []),
      { name: "agent-loop:verificationHelperTarget", value: helper.target },
      { name: "agent-loop:verificationHelperSha256", value: helper.sha256 },
      { name: "agent-loop:verificationHelperSourceCommit", value: helper.sourceCommit },
    ];
  }
}
const outputPath = artifactPath
  ? `${artifactPath}.cdx.json`
  : path.join(outputDirectory, "agent-loop-npm-runtime-sbom.cdx.json");
fs.writeFileSync(outputPath, `${JSON.stringify(sbom, null, 2)}\n`, "utf8");
process.stdout.write(`SBOM written to ${outputPath}\n`);
