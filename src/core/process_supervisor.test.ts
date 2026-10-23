import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as path from "node:path";
import {
  CliDiagnostics,
  MAX_DIAGNOSTIC_MESSAGE_BYTES,
} from "./cli_diagnostics";

interface CaseResult {
  diagnostics: CliDiagnostics;
  evidence: {
    fileMutation: boolean;
    completedSearches: number;
    maxTokens: number;
    actualModelId: string | null;
    commands: { command: string; exitCode: number | null }[];
  };
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
test("file mutation, search and spend survive eviction from the recent event ring", async () => {
  const result = await runFake("evidence-flood", { maxBytes: 1024 });
  assert.equal(result.evidence.fileMutation, true);
  assert.equal(result.evidence.completedSearches, 1);
  assert.equal(result.evidence.maxTokens, 123);
  assert.deepEqual(result.evidence.commands.map(c => [c.command, c.exitCode]), [["npm test", 0]]);
  assert.ok(result.eventBytes <= 1024);
});
test("pipe JSON preserves long Unicode records while stderr arrives inside a stdout record", async () => {
  const result = await runFake("pipe-json-interleaved", { transportMode: "pipe" });
  assert.equal(result.outcome, "succeeded");
  assert.equal(result.assistantText, '한글🙂'.repeat(1200) + '\n[PHASE_DONE]');
  assert.equal(result.cliSessionId, "pipe-session");
  assert.equal(result.evidence.maxTokens, 42);
  assert.equal(result.evidence.actualModelId, "kilo/pipe-fixture");
  assert.equal(result.diagnostics.plainError?.kind, "rate_limited");
});
test("pipe transport retains streaming credential redaction and bounded termination", async () => {
  const secret = await runFake("split-secret-echo", { transportMode: "pipe" });
  assert.equal(secret.rawLogIncludesSecret, false);
  assert.doesNotMatch(secret.assistantText, /top-secret/);
  const stopped = await runFake("ignore-termination", { transportMode: "pipe", transport: 100 });
  assert.equal(stopped.outcome, "transport_timeout");
});

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
    conpty?: boolean;
    transportMode?: "pty" | "pipe";
  },
): Promise<CaseResult> {
  const helper = path.join(
    __dirname,
    "..",
    "..",
    "..",
    "test",
    "run_supervisor_case.js",
  );
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
        String(timeouts?.conpty ?? false),
        timeouts?.transportMode ?? "pty",
      ],
      { timeout: 10_000, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          reject(
            new Error(`Supervisor helper failed: ${err.message}\n${stderr}`),
          );
          return;
        }
        try {
          resolve(JSON.parse(stdout.trim()) as CaseResult);
        } catch (parseError) {
          reject(
            new Error(
              `Invalid helper output: ${stdout}\n${String(parseError)}`,
            ),
          );
        }
      },
    );
  });
}

test("supervisor captures assistant events and CLI session id", async () => {
  const result = await runFake("success");
  assert.equal(result.outcome, "succeeded");
  assert.match(result.assistantText, /\[PHASE_DONE\]/);
  assert.equal(result.cliSessionId, "fake-session-1");
});

test(
  "ConPTY output draining preserves the exit result after the process dies",
  { skip: process.platform !== "win32" },
  async () => {
    for (const mode of ["success", "claude-terminal-error"]) {
      const result = await runFake(mode, {
        conpty: true,
        transport: 750,
        idle: 200,
        phase: 2_000,
      });
      assert.equal(result.exitCode, 0);
      assert.equal(result.outcome, mode === "success" ? "succeeded" : "process_exit");
      assert.equal(result.failureKind, mode === "success" ? null : "auth");
    }
  },
);

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
  const noOutput = await runFake("no-output", {
    transport: 100,
    idle: 500,
    phase: 1_000,
  });
  assert.equal(noOutput.outcome, "transport_timeout");
  const spinner = await runFake("spinner", {
    transport: 500,
    idle: 120,
    phase: 1_000,
  });
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
  assert.match(
    result.failureMessage ?? "",
    /interactive filesystem\/tool access/i,
  );
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
test("Kilo bootstrap logs establish transport but repeated capacity logs cannot extend model idle time", async () => {
  const result = await runFake("native-provider-retries", { transport: 750, idle: 250, phase: 2000 });
  assert.equal(result.outcome, "idle_timeout");
  assert.equal(result.cliSessionId, "ses_nativeRetry");
  assert.equal(result.diagnostics.plainError?.kind, "rate_limited");
});

test("meaningful progress renews the phase window up to the absolute recovery deadline", async () => {
  const windows = process.platform === "win32";
  const result = await runFake("continuous-progress", {
    transport: windows ? 2_000 : 750,
    // WinPTY may batch progress while starting the helper or draining output.
    idle: windows ? 1_000 : 250,
    tool: windows ? 1_000 : 250,
    phase: windows ? 1_000 : 750,
    // Both phase windows remain shorter than the 1200ms workload.
    absolute: windows ? 5_000 : 3_000,
  });
  assert.equal(result.outcome, "succeeded", JSON.stringify(result));
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
  const result = await runFake("ignore-termination", {
    transport: 100,
    idle: 500,
    phase: 1_000,
  });
  assert.equal(result.outcome, "transport_timeout");
});

test("parsed JSON events are retained in a byte-bounded recent ring", async () => {
  const result = await runFake("event-flood", { maxBytes: 2_048, cols: 2_000 });
  assert.equal(result.outcome, "succeeded");
  assert.ok(result.eventsCount < 21);
  assert.ok(result.eventBytes <= 2_048);
  assert.match(result.assistantText, /\[PHASE_DONE\]/);
});

test("reported Kilo QA events complete without auth or mutation false positives", async () => {
  const result = await runFake("qa-auth-regression");
  assert.equal(result.outcome, "succeeded");
  assert.equal(result.evidence.fileMutation, false);
  assert.deepEqual(result.diagnostics, {
    terminalError: null,
    plainError: null,
  });
  assert.match(result.assistantText, /APPROVED\s+\[PHASE_DONE\]$/);
});
test("a native error after completed output rejects exit-zero success and survives ring eviction redacted", async () => {
  const result = await runFake("terminal-secret-after-completion", {
    maxBytes: 1024,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.outcome, "process_exit");
  assert.equal(result.failureKind, "auth");
  assert.equal(result.diagnostics.terminalError?.kind, "auth");
  assert.ok(result.eventBytes <= 1024);
  assert.ok(!JSON.stringify(result.diagnostics).includes("top-secret"));
  assert.equal(result.rawLogIncludesSecret, false);
  assert.ok(
    Buffer.byteLength(result.diagnostics.terminalError!.message) <=
      MAX_DIAGNOSTIC_MESSAGE_BYTES,
  );
});
test("Claude final error results cannot satisfy assistant completion", async () => {
  const result = await runFake("claude-terminal-error");
  assert.equal(result.outcome, "process_exit");
  assert.equal(result.failureKind, "auth");
  assert.ok(!result.assistantText.includes("This error must not"));
});
test("web tool authentication errors do not become CLI authentication failures", async () => {
  const result = await runFake("tool-auth-error");
  assert.equal(result.outcome, "succeeded");
  assert.deepEqual(result.diagnostics, {
    terminalError: null,
    plainError: null,
  });
});
test("permission denial correlation excludes unexecuted writes but retains potentially partial failures", async () => {
  const denied = await runFake("denied-claude-write");
  assert.equal(denied.evidence.fileMutation, false);
  assert.equal(denied.outcome, "succeeded");
  const partial = await runFake("partial-claude-write");
  assert.equal(partial.evidence.fileMutation, true);
  assert.equal(partial.outcome, "succeeded");
});
