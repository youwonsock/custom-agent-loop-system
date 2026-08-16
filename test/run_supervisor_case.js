#!/usr/bin/env node

const os = require("node:os");
const path = require("node:path");
const nodeFs = require("node:fs");
const fs = require("node:fs/promises");

const mode = process.argv[2];
let backpressurePauseCount = 0;
let backpressureResumeCount = 0;
if (mode === "raw-log-backpressure") {
  const nodePty = require("node-pty");
  const originalSpawn = nodePty.spawn;
  nodePty.spawn = function trackedSpawn(...args) {
    const child = originalSpawn.apply(this, args);
    const originalPause = child.pause.bind(child);
    const originalResume = child.resume.bind(child);
    child.pause = function trackedPause() {
      backpressurePauseCount++;
      return originalPause();
    };
    child.resume = function trackedResume() {
      backpressureResumeCount++;
      return originalResume();
    };
    return child;
  };
}
if (["raw-log-runtime-error", "raw-log-final-error", "raw-log-backpressure"].includes(mode)) {
  const originalCreateWriteStream = nodeFs.createWriteStream;
  nodeFs.createWriteStream = function createFailingWriteStream(...args) {
    const stream = originalCreateWriteStream.apply(this, args);
    if (mode === "raw-log-runtime-error") {
      const originalWrite = stream.write.bind(stream);
      let failureScheduled = false;
      stream.write = function failingWrite(...writeArgs) {
        const result = originalWrite(...writeArgs);
        if (!failureScheduled) {
          failureScheduled = true;
          process.nextTick(() => {
            const error = new Error("simulated ENOSPC raw log write failure");
            error.code = "ENOSPC";
            stream.destroy(error);
          });
        }
        return result;
      };
    } else if (mode === "raw-log-final-error") {
      stream.end = function failingEnd() {
        const error = new Error("simulated EIO raw log finalization failure");
        error.code = "EIO";
        stream.destroy(error);
        return stream;
      };
    } else {
      const originalWrite = stream.write.bind(stream);
      let backpressured = false;
      stream.write = function slowWrite(...writeArgs) {
        const result = originalWrite(...writeArgs);
        if (!backpressured) {
          backpressured = true;
          setTimeout(() => stream.emit("drain"), 100);
          return false;
        }
        return result;
      };
    }
    return stream;
  };
}
const { ProcessSupervisor, terminateProcessTreeBounded } = require("../dist/process_supervisor");
const { checkProcessLiveness } = require("../dist/resilience");
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
    const rawLogPath = path.join(dir, "attempt.log");
    if (mode === "raw-log-directory") {
      await fs.mkdir(rawLogPath);
    }
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
      rawLogPath,
      interactionWhitelist: mode === "confirmation-prompt" ? ["Continue? [y/n]"] : [],
      destructivePrompts: [],
      sensitiveValues: ["secret-echo", "split-secret-echo", "wrapped-secret-echo"].includes(mode)
        ? ["top-secret"]
        : [],
      pollControl: mode === "control-poll-error"
        ? async () => { throw new Error("simulated EIO"); }
        : undefined,
    });
    const rawLog = await fs.readFile(rawLogPath, "utf8").catch(() => "");
    const providerSpawned = await fs.access(path.join(dir, "provider-spawned.txt"))
      .then(() => true)
      .catch(() => false);
    const descendantPid = Number(
      await fs.readFile(path.join(dir, "descendant-pid.txt"), "utf8").catch(() => "0")
    );
    await new Promise((resolve) => setTimeout(resolve, descendantPid > 0 ? 100 : 0));
    const descendantLiveness = descendantPid > 0 ? checkProcessLiveness(descendantPid) : "dead";
    if (descendantLiveness !== "dead") {
      await terminateProcessTreeBounded(descendantPid, 1_000);
    }
    process.stdout.write(JSON.stringify({
      pid: result.pid,
      outcome: result.outcome,
      failureKind: result.failureKind,
      failureMessage: result.failureMessage,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      cancelled: result.cancelled,
      assistantText: result.assistantText,
      cliSessionId: result.cliSessionId,
      eventsCount: result.events.length,
      eventBytes: result.events.reduce(
        (total, event) => total + Buffer.byteLength(JSON.stringify(event), "utf8"),
        0
      ),
      rawLogIncludesSecret: rawLog.includes("top-secret"),
      rawLogContainsCompletion: rawLog.includes("[PHASE_DONE]"),
      backpressurePauseCount,
      backpressureResumeCount,
      autoInjectedCount: result.autoInjected.length,
      providerSpawned,
      childLiveness: result.pid > 0 ? checkProcessLiveness(result.pid) : "dead",
      descendantLiveness,
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
