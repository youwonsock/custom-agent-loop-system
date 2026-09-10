#!/usr/bin/env node

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const supplied = process.argv.slice(2).map((entry) => path.resolve(entry));
const desktopRoot = path.join(root, "desktop-app");
const desktopVersion = require(path.join(desktopRoot, "package.json")).version;
const artifacts = supplied.length > 0
  ? supplied
  : [path.join(root, "artifacts", "desktop", `AgentLoopOrchestrator-${desktopVersion}-win32-x64-Setup.exe`)]
      .filter((artifact) => fs.existsSync(artifact));

if (artifacts.length === 0) throw new Error("No artifacts were provided or discovered.");
for (const artifact of artifacts) {
  const digest = crypto.createHash("sha256").update(fs.readFileSync(artifact)).digest("hex");
  const line = `${digest}  ${path.basename(artifact)}\n`;
  fs.writeFileSync(`${artifact}.sha256`, line, "utf8");
  process.stdout.write(line);
}
