import test from "node:test";
import assert from "node:assert/strict";
import { evaluateProviderConformance, runAuthenticatedProviderConformance } from "../../src/tools/provider-conformance";

const baseEvidence = {
  invocationArgs: ["run", "safe prompt"],
  resultText: "redacted output",
  beforeSnapshot: { "protected.txt": "hash-a" },
  afterSnapshot: { "protected.txt": "hash-a" },
  scannedTemporaryText: "safe log",
  secretSentinel: "exact-secret-sentinel",
  readOnly: true,
  structuredEventCount: 1,
  writeProofPresent: false,
};

test("provider conformance accepts an unchanged, redacted read-only attempt", () => {
  assert.deepEqual(evaluateProviderConformance(baseEvidence), []);
});

test("provider conformance rejects mutation and every secret-sentinel surface", () => {
  const failures = evaluateProviderConformance({
    ...baseEvidence,
    invocationArgs: ["--token", baseEvidence.secretSentinel],
    resultText: `diagnostic=${baseEvidence.secretSentinel}`,
    scannedTemporaryText: `log=${baseEvidence.secretSentinel}`,
    afterSnapshot: { "protected.txt": "hash-b" },
  });
  assert.deepEqual(failures, [
    "secret sentinel appeared in provider arguments",
    "secret sentinel appeared in provider output or diagnostics",
    "secret sentinel remained in a temporary file",
    "read-only provider mutated the conformance workspace",
  ]);
});

test("read-only conformance requires an authenticated structured response", () => {
  assert.deepEqual(evaluateProviderConformance({
    ...baseEvidence,
    structuredEventCount: 0,
  }), ["read-only provider did not emit an authenticated structured response"]);
});

test("write conformance requires both a proof artifact and structured events", () => {
  assert.deepEqual(evaluateProviderConformance({
    ...baseEvidence,
    readOnly: false,
    structuredEventCount: 0,
    writeProofPresent: false,
  }), [
    "write-capable provider did not create the proof artifact",
    "provider emitted no structured events",
  ]);
});

test("tool-free and read-only conformance distinguish blocked capability decisions", async () => {
  for (const provider of ["opencode", "kilo", "codex", "claude"] as const) {
    const report = await runAuthenticatedProviderConformance({ provider, model: "coverage", binary: "missing-agent-loop-provider", mode: "tools-none" });
    assert.equal(report.spawned, false);
    assert.equal(report.expectedFailClosed, true);
    assert.match(report.outcome, /^blocked_/u);
  }
  const missing = await runAuthenticatedProviderConformance({ provider: "codex", model: "coverage", binary: "missing-agent-loop-provider", mode: "write" });
  assert.equal(missing.spawned, false);
  assert.equal(missing.expectedFailClosed, true);
  assert.match(missing.outcome, /^blocked_/u);
});

test("conformance reports tool-free authentication failures separately from read-only failures", () => {
  assert.deepEqual(evaluateProviderConformance({
    ...baseEvidence,
    toolsNone: true,
    structuredEventCount: 0,
  }), ["tool-free provider did not emit an authenticated structured response"]);
  assert.deepEqual(evaluateProviderConformance({
    ...baseEvidence,
    readOnly: false,
    structuredEventCount: 1,
    writeProofPresent: false,
  }), ["write-capable provider did not create the proof artifact"]);
});
