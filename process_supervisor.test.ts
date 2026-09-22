import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as path from "node:path";

interface CaseResult {
  outcome: string;
  failureKind: string | null;
  failureMessage: string | null;
  exitCode: number;
  assistantText: string;
  cliSessionId: string | null;
  eventsCount: number;
  eventBytes: number;
  rawLogIncludesSecret: boolean;
}

function runFake(
  mode: string,
  timeouts?: {
    transport?: number;
    idle?: number;
    tool?: number;
    phase?: number;
    cols?: number;
    maxBytes?: number;
    absolute?: number;
  }
): Promise<CaseResult> {
  const helper = path.join(__dirname, "..", "test", "run_supervisor_case.js");
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [
        helper,
        mode,
        String(timeouts?.transport ?? 1_000),
        String(timeouts?.idle ?? 1_000),
        String(timeouts?.tool ?? 1_500),
        String(timeouts?.phase ?? 2_000),
        String(timeouts?.cols ?? 1_000),
        String(timeouts?.maxBytes ?? 1024 * 1024),
        String(timeouts?.absolute ?? timeouts?.phase ?? 2_000),
      ],
      { timeout: 10_000, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`Supervisor helper failed: ${err.message}\n${stderr}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout.trim()) as CaseResult);
        } catch (parseError) {
          reject(new Error(`Invalid helper output: ${stdout}\n${String(parseError)}`));
        }
      }
    );
  });
}

test("supervisor captures assistant events and CLI session id", async () => {
  const result = await runFake("success");
  assert.equal(result.outcome, "succeeded");
  assert.match(result.assistantText, /\[PHASE_DONE\]/);
  assert.equal(result.cliSessionId, "fake-session-1");
});

test("raw prompt echo cannot become assistant completion", async () => {
  const result = await runFake("prompt-echo");
  assert.equal(result.outcome, "succeeded");
  assert.equal(result.assistantText, "");
});

test("configured secrets are redacted from raw logs and assistant text", async () => {
  const result = await runFake("secret-echo");
  assert.equal(result.outcome, "succeeded");
  assert.equal(result.rawLogIncludesSecret, false);
  assert.equal(result.assistantText.includes("top-secret"), false);
  assert.match(result.assistantText, /\[REDACTED\]/);
});

test("configured secrets remain redacted when split across PTY chunks", async () => {
  const result = await runFake("split-secret-echo");
  assert.equal(result.outcome, "succeeded");
  assert.equal(result.rawLogIncludesSecret, false);
  assert.equal(result.assistantText.includes("top-secret"), false);
  assert.match(result.assistantText, /\[REDACTED\]/);
});

test("PTY-wrapped JSON events are reassembled before assistant parsing", async () => {
  const result = await runFake("planner", { cols: 60 });
  assert.equal(result.outcome, "succeeded");
  assert.match(result.assistantText, /## OPTION 3: C/);
  assert.match(result.assistantText, /\n\[PHASE_DONE\]$/);
});

test("no-output and spinner hangs terminate through separate watchdogs", async () => {
  const noOutput = await runFake("no-output", { transport: 100, idle: 500, phase: 1_000 });
  assert.equal(noOutput.outcome, "transport_timeout");
  const spinner = await runFake("spinner", { transport: 500, idle: 120, phase: 1_000 });
  assert.equal(spinner.outcome, "idle_timeout");
});

test("interactive access prompts fail fast instead of being auto-approved or timing out", async () => {
  const result = await runFake("permission-prompt", {
    transport: 500,
    idle: 2_000,
    phase: 3_000,
  });
  assert.equal(result.outcome, "process_exit");
  assert.equal(result.failureKind, "permission");
  assert.match(result.failureMessage ?? "", /interactive filesystem\/tool access/i);
});

test("initial transport timeout stops after connection and model generation gets its own budget", async () => {
  const result = await runFake("delayed-model", {
    transport: 750,
    idle: 1800,
    tool: 1800,
    phase: 3_000,
  });
  assert.equal(result.outcome, "succeeded");
  assert.match(result.assistantText, /\[PHASE_DONE\]/);
});

test("meaningful progress renews the phase window up to the absolute recovery deadline", async () => {
  const result = await runFake("continuous-progress", {
    transport: 750,
    idle: 250,
    tool: 250,
    phase: 750,
    // Allow process startup while exercising renewal across a 1200ms workload.
    absolute: 3_000,
  });
  assert.equal(result.outcome, "succeeded");
  assert.match(result.assistantText, /\[PHASE_DONE\]/);
});

test("an active tool uses the longer tool timeout and reports tool_timeout when stalled", async () => {
  const completed = await runFake("delayed-tool", {
    // Process startup can exceed 100ms while the full test suite runs in parallel.
    // Keep this test focused on the idle-vs-tool timeout distinction.
    transport: 750,
    idle: 120,
    tool: 500,
    phase: 1_000,
  });
  assert.equal(completed.outcome, "succeeded");

  const stalled = await runFake("tool-hang", {
    transport: 750,
    idle: 500,
    tool: 120,
    phase: 1_000,
  });
  assert.equal(stalled.outcome, "tool_timeout");
});

test("forced termination handles a process that ignores graceful signals", async () => {
  const result = await runFake("ignore-termination", { transport: 100, idle: 500, phase: 1_000 });
  assert.equal(result.outcome, "transport_timeout");
});

test("parsed JSON events are retained in a byte-bounded recent ring", async () => {
  const result = await runFake("event-flood", { maxBytes: 2_048, cols: 2_000 });
  assert.equal(result.outcome, "succeeded");
  assert.ok(result.eventsCount < 21);
  assert.ok(result.eventBytes <= 2_048);
  assert.match(result.assistantText, /\[PHASE_DONE\]/);
});
