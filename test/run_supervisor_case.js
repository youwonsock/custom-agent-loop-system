#!/usr/bin/env node

const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const { ProcessSupervisor } = require("../dist/process_supervisor");

const mode = process.argv[2];
const transportTimeoutMs = Number(process.argv[3]);
const idleTimeoutMs = Number(process.argv[4]);
const toolTimeoutMs = Number(process.argv[5]);
const phaseTimeoutMs = Number(process.argv[6]);
const cols = Number(process.argv[7] || 1000);
const maxInMemoryOutputBytes = Number(process.argv[8] || 1024 * 1024);
const absoluteDeadlineMs = Number(process.argv[9] || phaseTimeoutMs);

void (async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-loop-supervisor-"));
  try {
    const result = await new ProcessSupervisor().run({
      binary: process.execPath,
      args: [path.join(__dirname, "fake_cli.js"), mode],
      cwd: dir,
      env: process.env,
      cols,
      rows: 30,
      useConpty: false,
      transportTimeoutMs,
      idleTimeoutMs,
      toolTimeoutMs,
      phaseTimeoutMs,
      absoluteDeadlineAtMs: Date.now() + absoluteDeadlineMs,
      terminationGraceMs: 50,
      killTimeoutMs: 1_000,
      maxInMemoryOutputBytes,
      rawLogPath: path.join(dir, "attempt.log"),
      interactionWhitelist: [],
      destructivePrompts: [],
      sensitiveValues: mode === "secret-echo" || mode === "split-secret-echo" ? ["top-secret"] : [],
    });
    const rawLog = await fs.readFile(path.join(dir, "attempt.log"), "utf8");
    process.stdout.write(JSON.stringify({
      outcome: result.outcome,
      failureKind: result.failureKind,
      failureMessage: result.failureMessage,
      exitCode: result.exitCode,
      assistantText: result.assistantText,
      cliSessionId: result.cliSessionId,
      eventsCount: result.events.length,
      eventBytes: result.events.reduce(
        (total, event) => total + Buffer.byteLength(JSON.stringify(event), "utf8"),
        0
      ),
      rawLogIncludesSecret: rawLog.includes("top-secret"),
    }));
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 25));
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  process.exit(0);
})().catch((err) => {
  process.stderr.write(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
