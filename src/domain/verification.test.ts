import assert from "node:assert/strict";
import test from "node:test";
import {
  candidateNeedsVerificationApproval,
  hashVerificationCandidate,
  validateVerificationContractDraft,
  verificationCommandJson,
  verificationStatusJson,
  type VerificationApprovalCandidate,
  type VerificationContract,
  type VerificationContractDraft,
} from "./verification";

const command = {
  id: "tests",
  label: "unit tests",
  executable: "npm",
  args: ["test"],
  cwd: ".",
  timeoutMs: 1_000,
  requirementIds: ["REQ-001"],
};

function draft(overrides: Partial<VerificationContractDraft> = {}): VerificationContractDraft {
  return {
    commands: [command],
    totalTimeoutMs: 2_000,
    protectedPaths: ["scripts"],
    testRoots: ["test"],
    allowedNewTestRoots: ["test/fixtures"],
    generatedOutputPaths: ["dist"],
    ...overrides,
  };
}

function contract(overrides: Partial<VerificationContract> = {}): VerificationContract {
  return {
    ...draft(),
    revision: 1,
    contractHash: "a".repeat(64),
    approvedRequestId: "request-1",
    approvedAt: "2026-09-06T00:00:00.000Z",
    baselineArtifactId: "artifact_baseline",
    baselineFingerprint: "b".repeat(64),
    baselinePaths: ["package.json", "test/old.test.ts", "src/entry.ts"],
    baselineFileHashes: {
      "package.json": "c".repeat(64),
      "test/old.test.ts": "d".repeat(64),
      "src/entry.ts": "e".repeat(64),
    },
    ...overrides,
  };
}

test("verification contract validation rejects unsafe commands and policy roots", () => {
  const invalid: Array<[string, Partial<VerificationContractDraft>, RegExp]> = [
    ["no commands", { commands: [] }, /between 1 and 10/u],
    ["invalid total timeout", { totalTimeoutMs: 0 }, /total timeout/u],
    ["duplicate command ids", { commands: [command, { ...command, label: "second" }] }, /duplicated/u],
    ["unsafe command id", { commands: [{ ...command, id: "../tests" }] }, /duplicated or unsafe/u],
    ["empty label", { commands: [{ ...command, label: " " }] }, /label and executable/u],
    ["invalid command timeout", { commands: [{ ...command, timeoutMs: 0 }] }, /timeout/u],
    ["absolute cwd", { commands: [{ ...command, cwd: "C:\\repo" }] }, /project-relative/u],
    ["parent cwd", { commands: [{ ...command, cwd: "../repo" }] }, /project-relative/u],
    ["empty requirements", { commands: [{ ...command, requirementIds: [] }] }, /at least one/u],
    ["duplicate requirements", { commands: [{ ...command, requirementIds: ["REQ-001", "REQ-001"] }] }, /unique requirement/u],
    ["unknown requirement", { commands: [{ ...command, requirementIds: ["REQ-404"] }] }, /unknown requirement/u],
    ["non-array policy", { testRoots: "test" as unknown as string[] }, /unique array/u],
    ["duplicate policy path", { protectedPaths: ["scripts", "./scripts"] }, /unique array/u],
    ["outside allowed new root", { allowedNewTestRoots: ["src"] }, /contained/u],
    ["root generated output", { generatedOutputPaths: ["."] }, /project root/u],
    ["protected generated output", { protectedPaths: ["dist"], generatedOutputPaths: ["dist"] }, /Protected paths/u],
  ];
  for (const [label, overrides, expected] of invalid) {
    assert.throws(
      () => validateVerificationContractDraft(draft(overrides), new Set(["REQ-001"])),
      expected,
      label,
    );
  }
  assert.doesNotThrow(() => validateVerificationContractDraft(draft(), new Set(["REQ-001"])));
});

test("candidate approval detects policy, execution-surface, test, and allowed-new-test changes", () => {
  const approved = contract();
  const base: VerificationApprovalCandidate = {
    candidateHash: "",
    baseRevision: approved.revision,
    commands: structuredClone(approved.commands),
    changedPaths: ["test/fixtures/new.test.ts"],
    addedPaths: ["test/fixtures/new.test.ts"],
    modifiedPaths: [],
    deletedPaths: [],
    baselineFingerprint: "f".repeat(64),
    baselinePaths: [...approved.baselinePaths!, "test/fixtures/new.test.ts"],
    baselineFileHashes: { ...approved.baselineFileHashes!, "test/fixtures/new.test.ts": "1".repeat(64) },
    diffArtifactId: null,
    baselineArtifactId: null,
  };
  base.candidateHash = hashVerificationCandidate(base);
  assert.equal(candidateNeedsVerificationApproval(approved, base, "C:\\repo"), false);

  const cases: Array<[string, Partial<VerificationApprovalCandidate>]> = [
    ["policy", { totalTimeoutMs: 3_000 }],
    ["changed test", { changedPaths: ["test/old.test.ts"], modifiedPaths: ["test/old.test.ts"], addedPaths: [] }],
    ["deleted protected file", { changedPaths: ["scripts/check.js"], deletedPaths: ["scripts/check.js"], addedPaths: [] }],
    ["changed package manifest", { changedPaths: ["package.json"], modifiedPaths: ["package.json"], addedPaths: [] }],
    ["changed command entrypoint", { changedPaths: ["scripts/check.js"], modifiedPaths: ["scripts/check.js"], addedPaths: [] }],
    ["new source under test root", { changedPaths: ["test/helper.ts"], addedPaths: ["test/helper.ts"] }],
    ["unclassified digest change", { changedPaths: [], addedPaths: [], modifiedPaths: [], deletedPaths: [] }],
  ];
  for (const [label, changes] of cases) {
    const candidate = { ...base, ...changes };
    candidate.candidateHash = hashVerificationCandidate(candidate);
    assert.equal(candidateNeedsVerificationApproval(approved, candidate, "C:\\repo"), true, label);
  }

  const missingBaseline = contract({ baselinePaths: undefined, baselineFileHashes: undefined });
  assert.equal(candidateNeedsVerificationApproval(missingBaseline, base, "C:\\repo"), true);
});

test("verification JSON projections copy mutable values and candidate hashes are canonical", () => {
  const commandJson = verificationCommandJson(command);
  assert.deepEqual(commandJson, command);
  (commandJson.args as string[]).push("--changed");
  assert.deepEqual(command.args, ["test"]);

  const status = {
    contractRevision: 1,
    contractHash: "a".repeat(64),
    currentVerificationId: "verify-1",
    currentCommandId: "tests",
    completedCommands: 1,
    commandCount: 1,
    proofId: null,
    proofValid: false,
    pendingApproval: null,
    invalidationReason: null,
  };
  const projected = verificationStatusJson(status) as typeof status;
  assert.deepEqual(projected, status);
  assert.notEqual(projected, status);

  const left: VerificationApprovalCandidate = {
    candidateHash: "",
    baseRevision: 1,
    commands: [command],
    changedPaths: ["b", "a"],
    addedPaths: [],
    modifiedPaths: [],
    deletedPaths: [],
    baselinePaths: ["z", "a"],
    baselineFileHashes: { z: "1", a: "2" },
    diffArtifactId: null,
    baselineArtifactId: null,
  };
  const right = { ...left, changedPaths: ["a", "b"], baselinePaths: ["a", "z"] };
  assert.equal(hashVerificationCandidate(left), hashVerificationCandidate(right));
  assert.notEqual(hashVerificationCandidate(left), hashVerificationCandidate({ ...left, baseRevision: 2 }));
});
