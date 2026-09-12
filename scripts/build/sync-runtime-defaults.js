#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const configRoot = path.join(root, "config");
for (const fileName of [
  "runtime_defaults.json", "agents.json", "agents.schema.json", "tasks.json", "tasks.schema.json",
  "workflow.json", "workflow.schema.json", "loop_config.json", "loop_config.schema.json",
  "protocol_contract.json",
]) JSON.parse(fs.readFileSync(path.join(configRoot, fileName), "utf8"));
