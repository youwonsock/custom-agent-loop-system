#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const mappings = [
  ["runtime_defaults.json", "generated_runtime_defaults.json"],
  ["agent_roles.json", "generated_agent_roles.json"],
  ["agent_loop.json", "generated_agent_loop.json"],
];
const stale = [];
for (const [sourceName, destinationName] of mappings) {
  const source = path.join(root, sourceName);
  const destination = path.join(root, "vscode-extension", "src", destinationName);
  const expected = `${JSON.stringify(JSON.parse(fs.readFileSync(source, "utf8")), null, 2)}\n`;
  if (!fs.existsSync(destination)) {
    stale.push(`${destinationName} is missing`);
    continue;
  }
  const actual = fs.readFileSync(destination, "utf8").replace(/\r\n/g, "\n");
  if (actual !== expected) stale.push(`${destinationName} differs from ${sourceName}`);
}
if (stale.length > 0) {
  throw new Error(
    `Generated runtime files are stale:\n${stale.map((entry) => `- ${entry}`).join("\n")}\n` +
    "Run node scripts/sync-runtime-defaults.js and commit the results."
  );
}
process.stdout.write(`Generated runtime files verified: ${mappings.length}\n`);
