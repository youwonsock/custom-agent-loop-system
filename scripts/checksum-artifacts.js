#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { artifactDigest, isPortableArtifactPath } = require("./portable-artifact.js");

const root = path.resolve(__dirname, "..");
const supplied = process.argv.slice(2).map((entry) => path.resolve(entry));
const desktopRoot = path.join(root, "desktop-app");
const desktopVersion = require(path.join(desktopRoot, "package.json")).version;
const artifacts = supplied.length > 0
  ? supplied
  : [path.join(root, "artifacts", "desktop", `AgentLoopOrchestrator-${desktopVersion}-win32-x64`)]
      .filter((artifact) => fs.existsSync(artifact));

if (artifacts.length === 0) throw new Error("No artifacts were provided or discovered.");
for (const artifact of artifacts) {
  if (fs.statSync(artifact).isDirectory() && !isPortableArtifactPath(artifact)) {
    throw new Error(`Unsupported directory artifact: ${artifact}`);
  }
  const digest = artifactDigest(artifact);
  const line = `${digest}  ${path.basename(artifact)}${fs.statSync(artifact).isDirectory() ? "/" : ""}\n`;
  fs.writeFileSync(`${artifact}.sha256`, line, "utf8");
  process.stdout.write(line);
}
