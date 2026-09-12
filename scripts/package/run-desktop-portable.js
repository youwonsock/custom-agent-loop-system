#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const root = path.resolve(__dirname, "../..");
const version = require(path.join(root, "desktop-app", "package.json")).version;
const artifact = path.join(root, "artifacts", "desktop", `AgentLoopOrchestrator-${version}-win32-x64`);
const executable = path.join(artifact, "agent-loop-orchestrator.exe");
if (process.platform !== "win32") throw new Error("The portable desktop build currently targets win32-x64.");
if (!fs.existsSync(executable)) {
  throw new Error(`Portable desktop executable is missing. Run npm run package:desktop first: ${executable}`);
}

const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
delete environment.NODE_OPTIONS;
const child = spawn(executable, process.argv.slice(2), {
  cwd: artifact,
  env: environment,
  stdio: "inherit",
  windowsHide: false,
});
child.once("error", (error) => {
  console.error(`Could not start portable desktop executable: ${error.message}`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
