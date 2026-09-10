#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const destination = path.join(root, "desktop-app", "core");
const distSource = path.join(root, "dist");
if (!fs.existsSync(distSource)) throw new Error("dist/ does not exist; run npm run build first.");

fs.mkdirSync(destination, { recursive: true });
const oldDist = path.join(destination, "dist");
const oldNative = path.join(destination, "native");
fs.rmSync(oldDist, { recursive: true, force: true });
// Native files are part of the same candidate as dist/. Remove the complete
// staged tree before copying so a previous helper cannot survive into a new
// desktop package when the current build artifact is missing or differs.
fs.rmSync(oldNative, { recursive: true, force: true });
fs.cpSync(distSource, oldDist, {
  recursive: true,
  // The packaged core needs compiled runtime modules only. Test bundles and
  // source maps are deliberately left out of the desktop payload.
  filter: (source) => !/\.test\.js(?:\.map)?$/u.test(source) && !source.endsWith(".map"),
});

for (const file of [
  "agents.json", "agents.schema.json", "tasks.json", "tasks.schema.json",
  "workflow.json", "workflow.schema.json", "loop_config.json", "loop_config.schema.json",
  "protocol_contract.json", "runtime_defaults.json",
]) {
  fs.copyFileSync(path.join(root, file), path.join(destination, file));
}
const helperDirectory = path.join(root, "native", "bin", "win32-x64");
const helperFiles = ["verification-host.exe", "verification-host.manifest.json"];
if (!helperFiles.every((file) => fs.existsSync(path.join(helperDirectory, file)))) {
  throw new Error("The current Windows verification helper artifact is required before staging desktop core.");
}
fs.mkdirSync(path.join(destination, "native", "bin", "win32-x64"), { recursive: true });
for (const file of helperFiles) {
  fs.copyFileSync(path.join(helperDirectory, file), path.join(destination, "native", "bin", "win32-x64", file));
}
process.stdout.write(`Desktop core staged at ${destination} (compiled JS and definitions only).\n`);
