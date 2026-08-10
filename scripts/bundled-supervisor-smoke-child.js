#!/usr/bin/env node

const fs = require("node:fs/promises");
const path = require("node:path");

const supervisorPath = process.argv[2];
const fakeCliPath = process.argv[3];
const workingDirectory = process.argv[4] || process.cwd();
if (!supervisorPath || !fakeCliPath) {
  throw new Error(
    "Usage: bundled-supervisor-smoke-child <process-supervisor-path> <fake-cli-path> [cwd]"
  );
}

const { ProcessSupervisor } = require(supervisorPath);
const rawLogPath = path.join(workingDirectory, "bundled-supervisor-smoke.log");

void (async () => {
  const result = await new ProcessSupervisor().run({
    binary: process.execPath,
    args: [fakeCliPath],
    cwd: workingDirectory,
    env: { ...process.env, NODE_PATH: "" },
    cols: 80,
    rows: 24,
    useConpty: false,
    transportTimeoutMs: 5_000,
    idleTimeoutMs: 5_000,
    toolTimeoutMs: 5_000,
    phaseTimeoutMs: 10_000,
    absoluteDeadlineAtMs: Date.now() + 15_000,
    terminationGraceMs: 100,
    killTimeoutMs: 2_000,
    maxInMemoryOutputBytes: 256 * 1024,
    rawLogPath,
    interactionWhitelist: [],
    destructivePrompts: [],
    sensitiveValues: [],
  });
  const rawLog = await fs.readFile(rawLogPath, "utf8");
  if (result.outcome !== "succeeded" || result.exitCode !== 0) {
    throw new Error(`Bundled ProcessSupervisor failed: ${JSON.stringify({
      outcome: result.outcome,
      exitCode: result.exitCode,
      failureKind: result.failureKind,
      failureMessage: result.failureMessage,
    })}`);
  }
  if (!result.assistantText.includes("AGENT_LOOP_SUPERVISOR_OK") ||
      !rawLog.includes("AGENT_LOOP_SUPERVISOR_OK")) {
    throw new Error("Bundled ProcessSupervisor did not preserve the expected fake-provider output.");
  }
  process.stdout.write("Bundled ProcessSupervisor PTY lifecycle completed.\n");
  process.exit(0);
})().catch((error) => {
  process.stderr.write(`${error.stack || error.message || error}\n`);
  process.exit(1);
});
