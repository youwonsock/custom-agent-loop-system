#!/usr/bin/env node

const packagePath = process.argv[2];
const cwd = process.argv[3] || process.cwd();
if (!packagePath) throw new Error("Usage: pty-smoke-child <node-pty-package-path> [cwd]");

const nodePty = require(packagePath);
let output = "";
let settled = false;
const child = nodePty.spawn(
  process.execPath,
  [
    "-e",
    "process.stdout.write('AGENT_LOOP_PTY_OK\\n'); setTimeout(() => process.exit(0), 250)",
  ],
  {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd,
    env: { ...process.env, NODE_PATH: "" },
  }
);

const timer = setTimeout(() => {
  if (settled) return;
  settled = true;
  try { child.kill(); } catch { /* already exited */ }
  process.stderr.write("Bundled node-pty smoke timed out.\n");
  process.exit(1);
}, 15_000);

child.onData((chunk) => {
  output += chunk;
});
child.onExit(({ exitCode }) => {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  // node-pty may deliver the final onData callback immediately after onExit on
  // some platforms. The producer stays alive briefly after writing and the
  // verifier also gives the event queue one bounded drain window.
  setTimeout(() => {
    if (exitCode !== 0) {
      process.stderr.write(`Bundled node-pty child exited with ${exitCode}.\n`);
      process.exit(1);
    }
    if (!output.includes("AGENT_LOOP_PTY_OK")) {
      process.stderr.write(`Bundled node-pty output was unexpected: ${JSON.stringify(output)}\n`);
      process.exit(1);
    }
    process.stdout.write("Bundled node-pty lifecycle completed.\n");
    process.exit(0);
  }, 250);
});
