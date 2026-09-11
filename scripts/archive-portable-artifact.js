#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { sha256File, isPortableArtifactPath } = require("./portable-artifact.js");

const portable = process.argv[2] ? path.resolve(process.argv[2]) : null;
if (!portable || !isPortableArtifactPath(portable)) {
  throw new Error("Usage: node scripts/archive-portable-artifact.js <portable-directory>");
}
const directory = path.dirname(portable);
const name = path.basename(portable);
const archive = path.join(directory, `${name}.zip`);
if (fs.existsSync(archive)) fs.rmSync(archive, { force: true });
const result = spawnSync("zip", ["-q", "-r", archive, name], {
  cwd: directory,
  encoding: "utf8",
  windowsHide: true,
});
if (result.error || result.status !== 0) {
  throw new Error(`Could not create portable desktop archive: ${result.error?.message || result.stderr || result.status}`);
}

const portableManifest = JSON.parse(fs.readFileSync(`${portable}.manifest.json`, "utf8"));
const sha256 = sha256File(archive);
const manifest = {
  schemaVersion: 1,
  artifactType: "desktop-portable-archive",
  artifactFile: path.basename(archive),
  packageName: portableManifest.packageName,
  packageVersion: portableManifest.packageVersion,
  targetPlatform: portableManifest.targetPlatform,
  sha256,
  bytes: fs.statSync(archive).size,
  sourceCommit: portableManifest.sourceCommit,
  verificationHelper: portableManifest.verificationHelper,
  sourceDirectoryDigest: portableManifest.sha256,
};
fs.writeFileSync(`${archive}.sha256`, `${sha256}  ${path.basename(archive)}\n`, "utf8");
fs.writeFileSync(`${archive}.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
const sbom = {
  bomFormat: "CycloneDX", specVersion: "1.5", version: 1,
  metadata: { component: { type: "application", name: portableManifest.packageName, version: portableManifest.packageVersion, hashes: [{ alg: "SHA-256", content: sha256 }], properties: [
    { name: "agent-loop:artifactType", value: "desktop-portable-archive" },
    { name: "agent-loop:sourceDirectoryDigest", value: portableManifest.sha256 },
    { name: "agent-loop:verificationHelperTarget", value: portableManifest.verificationHelper.target },
    { name: "agent-loop:verificationHelperSha256", value: portableManifest.verificationHelper.sha256 },
    { name: "agent-loop:verificationHelperSourceCommit", value: portableManifest.verificationHelper.sourceCommit },
  ] } },
};
fs.writeFileSync(`${archive}.cdx.json`, `${JSON.stringify(sbom, null, 2)}\n`, "utf8");
process.stdout.write(`Portable desktop archive staged: ${archive} (${manifest.bytes} bytes)\n`);
