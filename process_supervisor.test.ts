import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as path from "node:path";
import { isInteractiveAccessPrompt, matchesConfiguredPrompt } from "./process_supervisor";

interface CaseResult {
  pid: number;
  outcome: string;
  failureKind: string | null;
  failureMessage: string | null;
  exitCode: number;
  timedOut: boolean;
  cancelled: boolean;
  assistantText: string;
  cliSessionId: string | null;
  eventsCount: number;
  eventBytes: number;
  rawLogIncludesSecret: boolean;
  rawLogContainsCompletion: boolean;
  backpressurePauseCount: number;
  backpressureResumeCount: number;
  autoInjectedCount: number;
  providerSpawned: boolean;
  childLiveness: string;
  descendantLiveness: string;
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

test("malformed machine-readable provider events fail closed", async () => {
  const result = await runFake("malformed-structured-event");
  assert.equal(result.outcome, "process_exit");
  assert.equal(result.failureKind, "process_exit");
  assert.match(result.failureMessage ?? "", /malformed structured event/i);
  assert.match(result.assistantText, /\[PHASE_DONE\]/);
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

test("configured secrets remain redacted when PTY wrapping splits a reconstructed JSON value", async () => {
  const result = await runFake("wrapped-secret-echo", { cols: 15 });
  assert.equal(result.outcome, "succeeded");
  assert.equal(result.rawLogIncludesSecret, false);
  assert.equal(result.assistantText.includes("top-secret"), false);
  assert.match(result.assistantText, /\[REDACTED\]/);
  assert.match(result.assistantText, /\[PHASE_DONE\]/);
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

test("generic text confirmations are denied without injecting an affirmative response", async () => {
  const result = await runFake("confirmation-prompt", {
    transport: 500,
    idle: 2_000,
    phase: 3_000,
  });
  assert.equal(result.outcome, "process_exit");
  assert.equal(result.failureKind, "permission");
  assert.match(result.failureMessage ?? "", /automatic approval is disabled/i);
  assert.equal(result.autoInjectedCount, 0);
  assert.equal(result.assistantText.includes("Unsafe confirmation was accepted"), false);
});

test("configured destructive prompts use identifier boundaries", () => {
  assert.equal(matchesConfiguredPrompt("Destroy generated files? [y/n]", "Destroy"), true);
  assert.equal(matchesConfiguredPrompt("Delete target?", "Delete"), true);
  assert.equal(
    matchesConfiguredPrompt(
      "opencode uninstall           uninstall opencode and remove all related files",
      "uninstall"
    ),
    false
  );
  assert.equal(
    matchesConfiguredPrompt("opencode uninstall? Continue? [y/n]", "uninstall"),
    true
  );
  assert.equal(matchesConfiguredPrompt("npm error at _destroy (node:_http_client:898:9)", "Destroy"), false);
  assert.equal(matchesConfiguredPrompt("Previously destroyed cache entry", "Destroy"), false);
  assert.equal(matchesConfiguredPrompt("pending.delete(data.id);", "Delete"), false);
  assert.equal(matchesConfiguredPrompt("pending?.delete (data.id);", "Delete"), false);
  assert.equal(
    matchesConfiguredPrompt(
      "const send=(method,params={})=>new Promise((res,rej)=>{const req=id++; const t=setTimeout(()=>{delete pending[req]; rej(new Error('timeout '+method));},8000);",
      "Delete"
    ),
    false
  );
  assert.equal(matchesConfiguredPrompt("delete cache.entries[key];", "Delete"), false);
  assert.equal(
    matchesConfiguredPrompt(
      "connection: { abort: null, destroyed: true, destroy: [Function: destroy] },",
      "Destroy"
    ),
    false
  );
});

test("completed automatic access denials are not treated as interactive prompts", () => {
  assert.equal(isInteractiveAccessPrompt("Permission access is required. Continue? [y/n]"), true);
  assert.equal(
    isInteractiveAccessPrompt(
      "! permission requested: external_directory (C:\\Users\\a\\AppData\\Local\\Temp\\*); auto-rejecting"
    ),
    false
  );
  assert.equal(isInteractiveAccessPrompt("External directory access was denied"), false);
});

test("control queue polling errors stop the provider instead of being ignored", async () => {
  const result = await runFake("control-poll-error", {
    transport: 500,
    idle: 2_000,
    phase: 3_000,
  });
  assert.equal(result.outcome, "process_exit");
  assert.equal(result.failureKind, "permission");
  assert.match(result.failureMessage ?? "", /control queue polling failed/i);
  assert.match(result.failureMessage ?? "", /simulated EIO/);
});

test("raw log open failures fail before the provider is spawned", async () => {
  const result = await runFake("raw-log-directory");
  assert.equal(result.pid, -1);
  assert.equal(result.outcome, "spawn_error");
  assert.equal(result.failureKind, "permission");
  assert.match(result.failureMessage ?? "", /Raw log could not be opened/i);
  assert.equal(result.timedOut, false);
  assert.equal(result.cancelled, false);
  assert.equal(result.providerSpawned, false);
});

test("raw log write failures terminate the provider without an unhandled stream error", async () => {
  const result = await runFake("raw-log-runtime-error", {
    transport: 1_000,
    idle: 2_000,
    phase: 3_000,
  });
  assert.equal(result.outcome, "spawn_error");
  assert.equal(result.failureKind, "permission");
  assert.match(result.failureMessage ?? "", /Raw log I\/O failure.*ENOSPC/i);
  assert.equal(result.timedOut, false);
  assert.equal(result.cancelled, false);
  assert.equal(result.providerSpawned, true);
  assert.equal(result.childLiveness, "dead");
});

test("raw log finalization failures cannot preserve a nominal provider success", async () => {
  const result = await runFake("raw-log-final-error");
  assert.equal(result.outcome, "spawn_error");
  assert.equal(result.failureKind, "permission");
  assert.equal(result.exitCode, -1);
  assert.match(result.failureMessage ?? "", /Raw log I\/O failure.*EIO/i);
  assert.equal(result.timedOut, false);
  assert.equal(result.cancelled, false);
  assert.equal(result.providerSpawned, true);
  assert.equal(result.childLiveness, "dead");
});

test("raw log backpressure pauses and resumes the PTY without losing completion evidence", async () => {
  const result = await runFake("raw-log-backpressure", {
    transport: 1_000,
    idle: 2_000,
    phase: 3_000,
  });
  assert.equal(result.outcome, "succeeded");
  assert.ok(result.backpressurePauseCount >= 1);
  assert.ok(result.backpressureResumeCount >= 1);
  assert.equal(result.rawLogContainsCompletion, true);
  assert.match(result.assistantText, /\[PHASE_DONE\]/);
});

test("initial transport timeout stops after connection and model generation gets its own budget", async () => {
  const result = await runFake("delayed-model", {
    transport: 750,
    idle: 500,
    tool: 700,
    phase: 1_000,
  });
  assert.equal(result.outcome, "succeeded");
  assert.match(result.assistantText, /\[PHASE_DONE\]/);
});

test("meaningful progress renews the phase window up to the absolute recovery deadline", async () => {
  const result = await runFake("continuous-progress", {
    transport: 750,
    idle: 250,
    tool: 250,
    phase: 200,
    // Keep the absolute budget comfortably above Windows PTY/process startup jitter.
    // The 200ms renewable window is still exercised by the 400ms fake workload.
    absolute: 2_000,
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

test("forced termination contains grandchildren before the PTY root can orphan them", async () => {
  const result = await runFake("spawn-child", {
    transport: 400,
    idle: 1_000,
    phase: 2_000,
  });
  assert.equal(result.outcome, "transport_timeout");
  assert.equal(result.childLiveness, "dead");
  assert.equal(result.descendantLiveness, "dead");
});

test("parsed JSON events are retained in a byte-bounded recent ring", async () => {
  const result = await runFake("event-flood", { maxBytes: 2_048, cols: 2_000 });
  assert.equal(result.outcome, "succeeded");
  assert.ok(result.eventsCount < 21);
  assert.ok(result.eventBytes <= 2_048);
  assert.match(result.assistantText, /\[PHASE_DONE\]/);
});
