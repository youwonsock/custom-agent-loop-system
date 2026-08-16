#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const workspaceRoot = fs.realpathSync(path.resolve(__dirname, ".."));
const buildTarget = path.resolve(workspaceRoot, "dist");
if (
  path.dirname(buildTarget) !== workspaceRoot ||
  path.basename(buildTarget) !== "dist"
) {
  throw new Error(`Refusing to clean unexpected build target: ${buildTarget}`);
}
fs.rmSync(buildTarget, { recursive: true, force: true });
