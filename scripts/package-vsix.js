#!/usr/bin/env node

const path = require("node:path");
const { spawnSync } = require("node:child_process");

const targets = {
  "win32-x64": "win32-x64",
  "win32-arm64": "win32-arm64",
  "darwin-x64": "darwin-x64",
  "darwin-arm64": "darwin-arm64",
  "linux-x64": "linux-x64",
  "linux-arm64": "linux-arm64",
};
const nativePlatform = `${process.platform}-${process.arch}`;
const target = targets[nativePlatform];
if (!target) throw new Error(`Unsupported VSIX target platform: ${nativePlatform}`);

const extensionRoot = path.resolve(__dirname, "..", "vscode-extension");
const packageJson = require(path.join(extensionRoot, "package.json"));
const vsceBinary = path.join(extensionRoot, "node_modules", "@vscode", "vsce", "vsce");
const forwarded = process.argv.slice(2);
if (!forwarded.includes("--out")) {
  forwarded.push("--out", `agent-loop-vscode-${target}-${packageJson.version}.vsix`);
}
const result = spawnSync(process.execPath, [vsceBinary, "package", "--target", target, ...forwarded], {
  cwd: extensionRoot,
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
