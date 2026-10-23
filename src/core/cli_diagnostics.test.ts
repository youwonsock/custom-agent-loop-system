import test from "node:test";
import assert from "node:assert/strict";
import {
  cliDiagnostic,
  CliDiagnosticCollector,
  MAX_DIAGNOSTIC_MESSAGE_BYTES,
} from "./cli_diagnostics";

test("auth requires a real code/status or explicit failure rather than identifiers or a topic", () => {
  for (const message of [
    "call-440358e11c92",
    "timestamp=1791946608401",
    "Review the authentication flow and API key settings",
    "429 observations",
    "credential-helper exited",
  ]) {
    assert.equal(cliDiagnostic(message).kind, "process_exit", message);
  }
  for (const error of [
    "authentication required: sign in",
    "Not logged in. Please run /login",
    "Invalid API key",
    { name: "ProviderAuthError", data: { message: "Login required" } },
    { statusCode: 401, message: "HTTP request rejected" },
    { code: "authentication_failed" },
  ]) {
    assert.equal(cliDiagnostic(error).kind, "auth");
  }
  assert.equal(
    cliDiagnostic({ statusCode: 403, message: "Forbidden" }).kind,
    "permission",
  );
  assert.equal(cliDiagnostic("HTTP 403").kind, "permission");
  assert.equal(
    cliDiagnostic({ statusCode: 429, message: "Request rejected" }).kind,
    "rate_limited",
  );
  assert.equal(
    cliDiagnostic("temporary network connection lost").kind,
    "network",
  );
});
test("Kilo tool argument aborts, capacity errors and cancelled requests retain actionable types", () => {
  assert.equal(cliDiagnostic('Stopped after 3 consecutive invalid-argument failures for the "write" tool.').kind, "tool_arguments");
  assert.equal(cliDiagnostic({ statusCode: 499, message: "status code 499" }).kind, "network");
  assert.equal(cliDiagnostic({ statusCode: 503, message: "overloaded" }).kind, "rate_limited");
  const collector = new CliDiagnosticCollector();
  collector.observeLine('timestamp=2026-10-22T16:51:13Z level=INFO message="providers are currently at capacity"');
  assert.equal(JSON.stringify(collector.diagnostics.plainError), "null");
  collector.observeLine('timestamp=2026-10-22T16:51:13Z level=ERROR run=fixture message="stream error" error.error="AI_APICallError: The request limited providers for this model and they are currently at capacity. Providers considered: reflection."');
  assert.equal(collector.diagnostics.plainError?.kind, "rate_limited");
});
test("billing and exhausted quotas are distinct from temporary capacity and rate limits", () => {
  for (const error of [
    { statusCode: 402, message: "Payment required" },
    { statusCode: 429, code: "insufficient_quota", message: "Request rejected" },
    { code: "billing_error" },
    "Provider quota exhausted", "Insufficient credits", "Credit balance is too low",
    "You exceeded your current quota", "You've hit your usage limit", "You have reached your usage limit",
  ]) assert.equal(cliDiagnostic(error).kind, "quota_exhausted", JSON.stringify(error));
  assert.equal(cliDiagnostic({ statusCode: 429, message: "Too many requests" }).kind, "rate_limited");
  assert.equal(cliDiagnostic({ statusCode: 503, message: "Providers are at capacity" }).kind, "rate_limited");
  assert.equal(cliDiagnostic("Review the usage limit and credits UI").kind, "process_exit");
  const collector = new CliDiagnosticCollector();
  collector.observeLine("Insufficient credits");
  assert.equal(collector.diagnostics.plainError?.kind, "quota_exhausted");
});

test("only execution-level failures are collected; assistant/tool/embedded errors are ignored", () => {
  const collector = new CliDiagnosticCollector();
  for (const event of [
    { type: "text", part: { text: "authentication required: sign in" } },
    {
      type: "assistant",
      message: { content: [{ type: "text", text: "HTTP 401" }] },
    },
    {
      type: "tool_use",
      part: {
        tool: "webfetch",
        state: { status: "error", error: "HTTP 401: authentication failed" },
      },
    },
    {
      type: "tool_result",
      payload: { type: "error", error: { statusCode: 403 } },
    },
    { type: "step_finish", timestamp: 1791946608401 },
  ])
    collector.observeEvent(event);
  collector.observeLine("Prompt says authentication required: sign in");
  assert.equal(
    JSON.stringify(collector.diagnostics),
    JSON.stringify({ terminalError: null, plainError: null }),
  );
  collector.observeLine("authentication required: sign in");
  assert.equal(collector.diagnostics.plainError?.kind, "auth");
});

test("native final failures are normalized across supported protocols and survive normal output", () => {
  for (const event of [
    { type: "turn.failed", error: { message: "Invalid API key" } },
    {
      type: "error",
      error: {
        name: "APIError",
        data: { statusCode: 401, message: "Unauthorized" },
      },
    },
    {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: ["Not logged in"],
    },
    { type: "assistant", error: "authentication_failed" },
  ]) {
    const collector = new CliDiagnosticCollector();
    collector.observeEvent(event);
    for (let n = 0; n < 100; n++)
      collector.observeEvent({
        type: "step_finish",
        timestamp: 1791946608401,
        part: { id: `id-${n}`, output: "noise" },
      });
    assert.equal(collector.diagnostics.terminalError?.kind, "auth");
  }
  const collector = new CliDiagnosticCollector();
  collector.observeEvent({
    type: "error",
    message: "temporary network connection lost",
    willRetry: true,
  });
  assert.equal(JSON.stringify(collector.diagnostics.terminalError), "null");
  collector.observeEvent({
    type: "error",
    message: "temporary network connection lost",
  });
  collector.observeEvent({ type: "turn.completed" });
  assert.equal(JSON.stringify(collector.diagnostics.terminalError), "null");
  collector.observeEvent({ type: "assistant", error: "authentication_failed" });
  collector.observeEvent({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    errors: [],
  });
  assert.equal(collector.diagnostics.terminalError?.kind, "auth");
});

test("diagnostics are redacted and bounded without losing the classified kind", () => {
  const key = "QA_DIAGNOSTIC_TEST_SECRET",
    previous = process.env[key];
  process.env[key] = "fixture-private-key-987";
  try {
    const diagnostic = cliDiagnostic({
      statusCode: 401,
      message: `Invalid API key: ${process.env[key]} ` + "가".repeat(10000),
    });
    assert.equal(diagnostic.kind, "auth");
    assert.ok(
      Buffer.byteLength(diagnostic.message) <= MAX_DIAGNOSTIC_MESSAGE_BYTES,
    );
    assert.ok(!diagnostic.message.includes(process.env[key]!));
    assert.match(diagnostic.message, /REDACTED/);
    assert.ok(!diagnostic.message.includes("\uFFFD"));
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});


test("explicit upstream credential failures retry without treating operator authentication failures as transient", () => {
  const upstream = "AI_APICallError: Upstream request failed: Invalid credential";
  assert.equal(cliDiagnostic(upstream).kind, "network");
  assert.equal(cliDiagnostic({ statusCode: 502, message: upstream }).kind, "network");
  assert.equal(cliDiagnostic({ statusCode: 401, message: upstream }).kind, "auth");
  assert.equal(cliDiagnostic({ statusCode: 403, message: upstream }).kind, "auth");
  for (const message of ["Invalid credential", "Invalid API key", "Upstream authentication failed", "Please fix credentials"])
    assert.notEqual(cliDiagnostic(message).kind, "network", message);
});
