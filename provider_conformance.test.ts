import test from "node:test";
import assert from "node:assert/strict";
import { evaluateProviderConformance } from "./provider_conformance";

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
