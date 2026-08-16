#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const extensionRoot = fs.realpathSync(path.resolve(__dirname, ".."));
const buildTarget = path.resolve(extensionRoot, "out");
if (
  path.dirname(buildTarget) !== extensionRoot ||
  path.basename(buildTarget) !== "out"
) {
  throw new Error(`Refusing to clean unexpected extension build target: ${buildTarget}`);
}
fs.rmSync(buildTarget, { recursive: true, force: true });
