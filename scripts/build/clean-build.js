#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const workspaceRoot = fs.realpathSync(path.resolve(__dirname, "../.."));
const targets = [
  path.resolve(workspaceRoot, "dist", "core"),
  path.resolve(workspaceRoot, ".build", "tsc"),
  path.resolve(workspaceRoot, ".build", "test-dist"),
];
for (const buildTarget of targets) {
  const relative = path.relative(workspaceRoot, buildTarget).replace(/\\/gu, "/");
  if (!(relative === "dist/core" || relative === ".build/tsc" || relative === ".build/test-dist")) {
    throw new Error(`Refusing to clean unexpected build target: ${buildTarget}`);
  }
  fs.rmSync(buildTarget, { recursive: true, force: true });
}
