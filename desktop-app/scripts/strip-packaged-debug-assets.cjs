#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const outputRoot = path.resolve(__dirname, "..", "out");
if (!fs.existsSync(outputRoot)) throw new Error(`Packaged output directory is missing: ${outputRoot}`);
for (const entry of fs.readdirSync(outputRoot, { withFileTypes: true })) {
  if (!entry.isDirectory() || !entry.name.includes("win32-x64")) continue;
  const rendererRoot = path.join(outputRoot, entry.name, "resources", "renderer");
  if (!fs.existsSync(rendererRoot)) continue;
  const stack = [rendererRoot];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const child of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, child.name);
      if (child.isDirectory()) stack.push(target);
      else if (child.name.endsWith(".map")) fs.rmSync(target, { force: true });
    }
  }
}
