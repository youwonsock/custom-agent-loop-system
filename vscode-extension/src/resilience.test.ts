import test from "node:test";
import assert from "node:assert/strict";
import {
  assessSessionDeletionSafety,
  decideRecoveryAction,
  elapsedSince,
  evaluateLease,
  evaluateOwnership,
  shouldAutoRecover,
  shouldGracefullyStop,
} from "./resilience";

test("session deletion requires terminal state, safe ownership, and dead children", () => {
  assert.equal(assessSessionDeletionSafety("RUNNING", "active", []).safe, false);
  assert.equal(assessSessionDeletionSafety("STOPPED", "unverifiable", []).safe, false);
  assert.equal(assessSessionDeletionSafety("PAUSED", "recoverable", ["alive"]).safe, false);
  assert.equal(assessSessionDeletionSafety("PAUSED", "recoverable", ["unknown"]).safe, false);
  assert.equal(assessSessionDeletionSafety("STOPPED", "missing", ["dead"]).safe, true);
});

const lease = {
  ownerId: "owner",
  ownerPid: 42,
  childPid: null,
  acquiredAt: "2026-01-01T00:00:00.000Z",
  heartbeatAt: "2026-01-01T00:00:00.000Z",
  expiresAt: "2026-01-01T00:00:20.000Z",
};

test("lease decisions distinguish active, recoverable, and unverifiable owners", () => {
  assert.equal(evaluateLease(lease, Date.parse("2026-01-01T00:00:10.000Z"), "alive"), "active");
  assert.equal(evaluateLease(lease, Date.parse("2026-01-01T00:00:21.000Z"), "dead"), "recoverable");
  assert.equal(evaluateLease(lease, Date.parse("2026-01-01T00:00:21.000Z"), "unknown"), "unverifiable");
});

test("an ownerless RUNNING v4 session is recoverable", () => {
  assert.equal(shouldAutoRecover("RUNNING", "recoverable"), true);
  assert.equal(shouldAutoRecover("PAUSED", "recoverable"), false);
  assert.equal(shouldAutoRecover("RUNNING", "active"), false);
  assert.equal(shouldGracefullyStop("RUNNING"), true);
  assert.equal(shouldGracefullyStop("SUCCESS"), false);
});

test("elapsed progress age is a pure bounded calculation", () => {
  assert.equal(elapsedSince("2026-01-01T00:00:00.000Z", Date.parse("2026-01-01T00:00:03.000Z")), 3000);
  assert.equal(elapsedSince(null), null);
});

test("a dead owner without a first lease becomes recoverable after the TTL", () => {
  const ownerLock = {
    ownerId: "owner",
    ownerPid: 42,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  assert.equal(
    evaluateOwnership(
      null,
      ownerLock,
      Date.parse("2026-01-01T00:00:10.000Z"),
      20_000,
      "dead"
    ),
    "unverifiable"
  );
  assert.equal(
    evaluateOwnership(
      null,
      ownerLock,
      Date.parse("2026-01-01T00:00:21.000Z"),
      20_000,
      "dead"
    ),
    "recoverable"
  );
});

test("recovery action treats every v4 ownerless session consistently", () => {
  assert.equal(decideRecoveryAction("RUNNING", 4, "recoverable", true), "ignore");
  assert.equal(decideRecoveryAction("RUNNING", 4, "missing", false), "recover");
  assert.equal(decideRecoveryAction("RUNNING", 4, "unverifiable", false), "follow");
  assert.equal(decideRecoveryAction("PAUSED", 4, "missing", false), "ignore");
});
