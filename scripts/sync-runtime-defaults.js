#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
for (const [sourceName, destinationName] of [
  ["runtime_defaults.json", "generated_runtime_defaults.json"],
  ["agents.json", "generated_agents.json"],
  ["tasks.json", "generated_tasks.json"],
  ["workflow.json", "generated_workflow.json"],
  ["protocol_contract.json", "generated_protocol_contract.json"],
]) {
  const source = path.join(root, sourceName);
  const destination = path.join(root, "vscode-extension", "src", destinationName);
  const canonical = `${JSON.stringify(JSON.parse(fs.readFileSync(source, "utf8")), null, 2)}\n`;
  const current = fs.existsSync(destination) ? fs.readFileSync(destination, "utf8") : "";
  if (current !== canonical) fs.writeFileSync(destination, canonical, "utf8");
}
