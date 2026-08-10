#!/usr/bin/env node

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const supplied = process.argv.slice(2).map((entry) => path.resolve(entry));
const extensionRoot = path.join(root, "vscode-extension");
const extensionVersion = require(path.join(extensionRoot, "package.json")).version;
const nativeTarget = `${process.platform}-${process.arch}`;
const artifacts = supplied.length > 0
  ? supplied
  : [path.join(extensionRoot, `agent-loop-vscode-${nativeTarget}-${extensionVersion}.vsix`)]
      .filter((artifact) => fs.existsSync(artifact));

if (artifacts.length === 0) throw new Error("No artifacts were provided or discovered.");
for (const artifact of artifacts) {
  const digest = crypto.createHash("sha256").update(fs.readFileSync(artifact)).digest("hex");
  const line = `${digest}  ${path.basename(artifact)}\n`;
  fs.writeFileSync(`${artifact}.sha256`, line, "utf8");
  process.stdout.write(line);
}
