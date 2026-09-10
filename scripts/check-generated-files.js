#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const canonicalFiles = [
  "runtime_defaults.json", "agents.json", "agents.schema.json", "tasks.json", "tasks.schema.json",
  "workflow.json", "workflow.schema.json", "loop_config.json", "loop_config.schema.json",
  "protocol_contract.json",
];
for (const fileName of canonicalFiles) JSON.parse(fs.readFileSync(path.join(root, fileName), "utf8"));
process.stdout.write(`Canonical runtime definitions verified: ${canonicalFiles.length}\n`);
