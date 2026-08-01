import test from "node:test";
import assert from "node:assert/strict";
import { AgentAttemptRunner } from "./agent_attempt_runner";
import { AttemptFailure } from "./resilience";

function failure(kind: AttemptFailure["kind"], retryable = true): AttemptFailure {
  return {
    kind,
    message: kind,
    retryable,
    occurredAt: new Date(0).toISOString(),
    attemptId: null,
    role: null,
    phase: null,
    exitCode: 1,
    cliSessionId: "cli-1",
  };
}

test("transport failure reconnects once, then uses a fresh CLI session", () => {
  const runner = new AgentAttemptRunner(
    { maxAttempts: 3, retryBackoffMs: [5000, 30000] },
    () => 0.5
  );
  const first = runner.decideRetry({
    failure: failure("transport_timeout"),
    attemptNumber: 1,
    budgetRemainingMs: 100_000,
    cliSessionId: "cli-1",
    reconnectUsed: false,
  });
  assert.equal(first.reconnect, true);
  assert.equal(first.delayMs, 5000);
  const second = runner.decideRetry({
    failure: failure("transport_timeout"),
    attemptNumber: 2,
    budgetRemainingMs: 100_000,
    cliSessionId: "cli-1",
    reconnectUsed: true,
  });
  assert.equal(second.reconnect, false);
  assert.equal(second.delayMs, 30000);
});

test("rate limits honor Retry-After but never exceed two minutes", () => {
  const runner = new AgentAttemptRunner(
    { maxAttempts: 3, retryBackoffMs: [5000, 30000] },
    () => 1
  );
  const decision = runner.decideRetry({
    failure: failure("rate_limited"),
    attemptNumber: 1,
    budgetRemainingMs: 500_000,
    cliSessionId: null,
    reconnectUsed: false,
    retryAfterMs: 120_000,
  });
  assert.equal(decision.delayMs, 120_000);
});

test("tool timeouts retry in a fresh CLI session", () => {
  const runner = new AgentAttemptRunner(
    { maxAttempts: 3, retryBackoffMs: [5000, 30000] },
    () => 0.5
  );
  const decision = runner.decideRetry({
    failure: failure("tool_timeout"),
    attemptNumber: 1,
    budgetRemainingMs: 100_000,
    cliSessionId: "cli-1",
    reconnectUsed: false,
  });
  assert.equal(decision.retry, true);
  assert.equal(decision.reconnect, false);
});

test("auth, orphan, attempt exhaustion, and budget exhaustion do not retry", () => {
  const runner = new AgentAttemptRunner({ maxAttempts: 3, retryBackoffMs: [5000, 30000] });
  for (const input of [
    { failure: failure("auth", false), attemptNumber: 1, budgetRemainingMs: 1000 },
    { failure: failure("orphaned_process", false), attemptNumber: 1, budgetRemainingMs: 1000 },
    { failure: failure("network"), attemptNumber: 3, budgetRemainingMs: 1000 },
    { failure: failure("network"), attemptNumber: 1, budgetRemainingMs: 0 },
  ]) {
    assert.equal(
      runner.decideRetry({
        ...input,
        cliSessionId: "cli-1",
        reconnectUsed: false,
      }).retry,
      false
    );
  }
});
