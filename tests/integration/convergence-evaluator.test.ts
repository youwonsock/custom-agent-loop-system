import assert from "node:assert/strict";
import test from "node:test";
import { evaluateConvergence, type ConvergenceState } from "../../src/application/convergence-evaluator";

const at = "2026-09-06T00:00:00.000Z";
function state(overrides: Partial<ConvergenceState> = {}): ConvergenceState {
  return {
    contractHash: "a".repeat(64),
    reachedStep: 10,
    highestReachedStep: 10,
    failedCommandIds: ["tests"],
    unsatisfiedRequirementIds: ["REQ-001"],
    unresolvedFindingIds: [],
    stagnantCycles: 0,
    history: [],
    ...overrides,
  };
}

test("convergence uses the first observation as a baseline and normalizes ids", () => {
  const decision = evaluateConvergence(null, {
    contractHash: "a".repeat(64),
    reachedStep: 10,
    failedCommandIds: ["tests", "tests"],
    unsatisfiedRequirementIds: ["REQ-001"],
    unresolvedFindingIds: [],
  }, at);
  assert.equal(decision.improved, true);
  assert.equal(decision.stagnantCycles, 0);
  assert.equal(decision.shouldInterrupt, false);
  assert.match(decision.signature, /^[a-f0-9]{64}$/u);
});

test("convergence resets stagnation on contract revision and detects two stagnant cycles", () => {
  const first = evaluateConvergence(state({ stagnantCycles: 1 }), {
    contractHash: "b".repeat(64),
    reachedStep: 10,
    failedCommandIds: ["tests"],
    unsatisfiedRequirementIds: ["REQ-001"],
    unresolvedFindingIds: [],
  }, at);
  assert.equal(first.improved, true);
  assert.equal(first.stagnantCycles, 0);
  const stagnant = evaluateConvergence(state(), {
    contractHash: "a".repeat(64),
    reachedStep: 10,
    failedCommandIds: ["tests"],
    unsatisfiedRequirementIds: ["REQ-001"],
    unresolvedFindingIds: [],
  }, at);
  assert.equal(stagnant.improved, false);
  assert.equal(stagnant.stagnantCycles, 1);
  const second = evaluateConvergence(state({ stagnantCycles: 1 }), {
    contractHash: "a".repeat(64),
    reachedStep: 10,
    failedCommandIds: ["tests"],
    unsatisfiedRequirementIds: ["REQ-001"],
    unresolvedFindingIds: [],
  }, at);
  assert.equal(second.stagnantCycles, 2);
  assert.equal(second.shouldInterrupt, true);
});

test("convergence rejects regressions and accepts a strictly smaller unresolved set", () => {
  const regressed = evaluateConvergence(state(), {
    contractHash: "a".repeat(64),
    reachedStep: 9,
    failedCommandIds: ["tests"],
    unsatisfiedRequirementIds: ["REQ-001"],
    unresolvedFindingIds: [],
  }, at);
  assert.equal(regressed.improved, false);
  const fixed = evaluateConvergence(state(), {
    contractHash: "a".repeat(64),
    reachedStep: 10,
    failedCommandIds: [],
    unsatisfiedRequirementIds: ["REQ-001"],
    unresolvedFindingIds: [],
  }, at);
  assert.equal(fixed.improved, true);
  assert.equal(fixed.stagnantCycles, 0);
});

test("a cycle that never reaches a comparable stage is recorded as null and cannot count as progress", () => {
  const decision = evaluateConvergence(state(), {
    contractHash: "a".repeat(64),
    reachedStep: null,
    failedCommandIds: [],
    unsatisfiedRequirementIds: [],
    unresolvedFindingIds: [],
  }, at);
  assert.equal(decision.improved, false);
  assert.equal(decision.stagnantCycles, 1);
});
