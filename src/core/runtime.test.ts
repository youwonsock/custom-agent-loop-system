import test from "node:test";
import assert from "node:assert/strict";
import { classifyFailure } from "./runtime";
import { SupervisorResult } from "./process_supervisor";
import { emptyEvidence } from "./event_evidence";
import { cliDiagnostic, emptyCliDiagnostics } from "./cli_diagnostics";
import { buildRecoveryMessage } from "./prompt";

const result = (): SupervisorResult => ({
  evidence: emptyEvidence(),
  diagnostics: emptyCliDiagnostics(),
  pid: 1,
  outcome: "succeeded",
  failureKind: null,
  failureMessage: null,
  exitCode: 0,
  output: "",
  assistantText: "",
  events: [],
  cliSessionId: null,
  startedAt: "",
  endedAt: "",
  timedOut: false,
  cancelled: false,
  rawLogPath: "",
  controlRequest: null,
  autoInjected: [],
});
test("malformed tool input gets bounded schema feedback and a fresh-session retry", () => {
  const r = result();
  r.exitCode = 1;
  r.diagnostics.terminalError = cliDiagnostic('Stopped after 3 consecutive invalid-argument failures for the "write" tool.');
  const failure = classifyFailure(r, { reason: "CLI failed", failureKind: null });
  assert.equal(failure.kind, "tool_arguments");
  assert.equal(failure.retryable, true);
  const recovery = buildRecoveryMessage(failure.kind, failure.message, "Existing tests pass", [{ type: "tool_use", part: { tool: "write", state: { status: "error", error: 'filePath and content are required' } } }]);
  assert.match(recovery, /filePath and content are required/);
  assert.match(recovery, /never submit \{\}/);
});
test("a provider capacity retry timeout keeps its timeout cause and provider explanation", () => {
  const r = result();
  r.failureKind = "idle_timeout";
  r.failureMessage = "No meaningful progress";
  r.timedOut = true;
  r.diagnostics.plainError = cliDiagnostic({ statusCode: 503, message: "Providers are at capacity" });
  const failure = classifyFailure(r, { reason: "No meaningful progress", failureKind: null });
  assert.equal(failure.kind, "idle_timeout");
  assert.match(failure.message, /Providers are at capacity/);
});
test("a timed-out native authentication error remains non-retryable even for a free model", () => {
  const r = result();
  r.timedOut = true;
  r.failureKind = "idle_timeout";
  r.diagnostics.plainError = cliDiagnostic("Invalid credential");
  const failure = classifyFailure(r, { reason: "Idle", failureKind: null });
  assert.equal(failure.kind, "idle_timeout");
  assert.equal(failure.retryable, false);
});
test("completion failures retain their typed cause despite auth/status strings in ordinary output", () => {
  const r = result();
  r.output =
    '{"timestamp":1791946608401,"callID":"call-440358e11c92","text":"authentication required, HTTP 429"}';
  for (const failureKind of [
    "incomplete_response",
    "role_violation",
  ] as const) {
    const failure = classifyFailure(r, {
      reason: "specific completion failure",
      failureKind,
    });
    assert.equal(failure.kind, failureKind);
    assert.equal(failure.message, "specific completion failure");
  }
});
test("explicit supervisor causes cannot be replaced by provider authentication diagnostics", () => {
  for (const failureKind of [
    "permission",
    "spawn_error",
    "idle_timeout",
    "cancelled",
    "orphaned_process",
  ] as const) {
    const r = result();
    r.failureKind = failureKind;
    r.failureMessage = "confirmed failure";
    r.exitCode = 1;
    r.diagnostics.terminalError = cliDiagnostic(
      "authentication required: sign in",
    );
    const failure = classifyFailure(r, {
      reason: "confirmed failure",
      failureKind,
    });
    assert.equal(failure.kind, failureKind);
  }
});
test("plaintext errors classify unsuccessful CLI exits, but cannot override successful execution", () => {
  const r = result();
  r.diagnostics.plainError = cliDiagnostic("authentication required: sign in");
  assert.equal(
    classifyFailure(r, {
      reason: "missing completion",
      failureKind: "incomplete_response",
    }).kind,
    "incomplete_response",
  );
  r.exitCode = 1;
  const failure = classifyFailure(r, {
    reason: "CLI exit 1",
    failureKind: "process_exit",
  });
  assert.equal(failure.kind, "auth");
  assert.equal(failure.retryable, false);
  assert.match(failure.message, /authentication required/);
});
