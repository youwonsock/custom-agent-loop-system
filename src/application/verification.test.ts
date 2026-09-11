import assert from "node:assert/strict";
import test from "node:test";
import { VerificationRunner, createVerificationContract } from "./verification-runner";
import { validateVerificationContractDraft } from "../domain/verification";
import type { ArtifactReference } from "../domain/task-result";
import type { VerificationCommandSpec } from "../domain/verification";
import type { VerificationRuntimePort } from "./ports/verification-runtime-port";
import type { WorkspaceIntegrityPort, WorkspaceWatch, WorkspaceFingerprint } from "./ports/workspace-integrity-port";
import type { ArtifactStorePort } from "./ports/artifact-store";

const digest = "a".repeat(64);
const command: VerificationCommandSpec = {
  id: "tests",
  label: "tests",
  executable: "node",
  args: ["test.js"],
  cwd: ".",
  timeoutMs: 1000,
  requirementIds: ["REQ-001"],
};

class MemoryArtifacts implements ArtifactStorePort {
  readonly values: ArtifactReference[] = [];
  async put(content: string | Buffer, mediaType: string): Promise<ArtifactReference> {
    const bytes = Buffer.isBuffer(content) ? content.length : Buffer.byteLength(content);
    const reference = { artifactId: `artifact_${digest}`, sha256: digest, mediaType, bytes, createdAt: "2026-09-06T00:00:00.000Z" };
    this.values.push(reference);
    return reference;
  }
  async read(): Promise<Buffer> { return Buffer.from(""); }
}

class StableIntegrity implements WorkspaceIntegrityPort {
  readonly value: WorkspaceFingerprint = { digest, files: 1, paths: ["test.js"], fileHashes: { "test.js": digest }, fileModes: { "test.js": 0o644 } };
  fingerprint(): Promise<WorkspaceFingerprint> { return Promise.resolve(this.value); }
  watch(): WorkspaceWatch { return { reliable: true, dirty: () => false, close: () => undefined }; }
}

class ScriptedRuntime implements VerificationRuntimePort {
  calls = 0;
  constructor(private readonly exitCode: number | null, private readonly signal: string | null = null) {}
  execute(request: Parameters<VerificationRuntimePort["execute"]>[0]) {
    this.calls += 1;
    return Promise.resolve({
      resolvedExecutable: request.command.executable,
      exitCode: this.exitCode,
      signal: this.signal,
      stdout: "ok",
      stderr: "",
      timedOut: false,
      processTreeClean: true,
      startedAt: "2026-09-06T00:00:00.000Z",
      completedAt: "2026-09-06T00:00:00.100Z",
    });
  }
}

class FailingIntegrity implements WorkspaceIntegrityPort {
  fingerprint(): Promise<WorkspaceFingerprint> {
    return Promise.reject(new Error("preflight unavailable"));
  }
  watch(): WorkspaceWatch {
    return { reliable: false, dirty: () => true, close: () => undefined };
  }
}

class ChangedBeforeIntegrity extends StableIntegrity {
  private calls = 0;
  override fingerprint(): Promise<WorkspaceFingerprint> {
    this.calls += 1;
    return Promise.resolve({
      ...this.value,
      digest: this.calls === 1 ? "b".repeat(64) : "b".repeat(64),
    });
  }
}

function contract(): ReturnType<typeof createVerificationContract> {
  return createVerificationContract([command], digest, "test", { paths: ["test.js"], fileHashes: { "test.js": digest } });
}

test("verification records a normal failing exit as a completed observation", async () => {
  const artifacts = new MemoryArtifacts();
  const runner = new VerificationRunner(new ScriptedRuntime(2), new StableIntegrity(), artifacts);
  const result = await runner.run(contract(), { runId: "run", verificationId: "verification", projectRoot: process.cwd(), additionalRoots: [], implementationActivationId: null, testActivationId: null });
  assert.equal(result.proof.passed, false);
  assert.equal(result.proof.executionError, false);
  assert.equal(result.records[0].status, "completed");
  assert.equal(result.records[0].exitCode, 2);
});

test("verification distinguishes a signal from a normal non-zero exit and stops later commands", async () => {
  const artifacts = new MemoryArtifacts();
  const twoCommands = createVerificationContract([command, { ...command, id: "typecheck" }], digest, "test", { paths: ["test.js"], fileHashes: { "test.js": digest } });
  const runner = new VerificationRunner(new ScriptedRuntime(null, "SIGTERM"), new StableIntegrity(), artifacts);
  const result = await runner.run(twoCommands, { runId: "run", verificationId: "verification", projectRoot: process.cwd(), additionalRoots: [], implementationActivationId: null, testActivationId: null });
  assert.equal(result.proof.executionError, false);
  assert.equal(result.records[0].signal, "SIGTERM");
  assert.equal(result.records[1].status, "not_run");
});

test("verification commits a bounded failure proof when preflight cannot fingerprint the workspace", async () => {
  const artifacts = new MemoryArtifacts();
  const runner = new VerificationRunner(new ScriptedRuntime(0), new FailingIntegrity(), artifacts);
  const result = await runner.run(contract(), {
    runId: "run",
    verificationId: "verification",
    projectRoot: process.cwd(),
    additionalRoots: [],
    implementationActivationId: null,
    testActivationId: null,
  });
  assert.equal(result.proof.passed, false);
  assert.equal(result.proof.executionError, true);
  assert.match(result.proof.failureReason ?? "", /preflight unavailable/u);
  assert.equal(result.proof.beforeFingerprint.length, 64);
  assert.equal(result.proof.afterFingerprint.length, 64);
});

test("verification does not execute commands when the approved baseline is already stale", async () => {
  const artifacts = new MemoryArtifacts();
  const runtime = new ScriptedRuntime(0);
  const runner = new VerificationRunner(runtime, new ChangedBeforeIntegrity(), artifacts);
  const result = await runner.run(contract(), {
    runId: "run",
    verificationId: "verification",
    projectRoot: process.cwd(),
    additionalRoots: [],
    implementationActivationId: null,
    testActivationId: null,
  });
  assert.equal(runtime.calls, 0);
  assert.equal(result.records[0].status, "not_run");
  assert.equal(result.proof.executionError, true);
  assert.match(result.proof.failureReason ?? "", /approved verification baseline/u);
});

test("the project root cannot be hidden as generated output", () => {
  assert.throws(() => validateVerificationContractDraft({
    commands: [command],
    totalTimeoutMs: 1000,
    protectedPaths: [],
    testRoots: ["."],
    allowedNewTestRoots: ["."],
    generatedOutputPaths: ["."],
  }), /project root/u);
});

test("verification contract preparation and candidate diffing preserve the approved baseline", async () => {
  const artifacts = new MemoryArtifacts();
  const integrity = new StableIntegrity();
  const runner = new VerificationRunner(new ScriptedRuntime(0), integrity, artifacts);
  const prepared = await runner.prepareContract([command], process.cwd(), [], "approval", { generatedOutputPaths: ["coverage"] });
  assert.equal(prepared.baselineArtifactId, `artifact_${digest}`);
  assert.equal((await runner.currentFingerprint(prepared, process.cwd(), [])).digest, digest);
  const candidate = runner.buildApprovalCandidate(prepared, {
    digest: "b".repeat(64),
    paths: ["test.js", "new.test.js"],
    fileHashes: { "test.js": "b".repeat(64), "new.test.js": digest },
    fileModes: { "test.js": 1, "new.test.js": 1 },
  }, { commands: [{ ...command, args: ["--help"] }] });
  assert.deepEqual(candidate.addedPaths, ["new.test.js"]);
  assert.deepEqual(candidate.modifiedPaths, ["test.js"]);
  assert.ok(candidate.candidateHash.length === 64);
});

test("verification recovery preserves prior checkpoints and distinguishes controls from runtime errors", async () => {
  const baseRecord = {
    verificationId: "verification", commandId: "tests", status: "running" as const, executable: "node", args: ["test.js"], cwd: process.cwd(),
    approvedExecutable: "node", approvedArgs: ["test.js"], approvedCwd: ".", startedAt: "2026-09-06T00:00:00.000Z", completedAt: null,
    exitCode: null, signal: null, timedOut: false, processTreeClean: null, logArtifactId: null, summary: "", elapsedMs: 1,
  };
  const runtime = new ScriptedRuntime(0);
  const prior = await new VerificationRunner(runtime, new StableIntegrity(), new MemoryArtifacts()).run(contract(), {
    runId: "run", verificationId: "verification", projectRoot: process.cwd(), additionalRoots: [], implementationActivationId: null, testActivationId: null,
    existingRecords: [baseRecord],
  });
  assert.equal(runtime.calls, 0);
  assert.equal(prior.proof.executionError, true);
  const notRun = await new VerificationRunner(new ScriptedRuntime(0), new StableIntegrity(), new MemoryArtifacts()).run(contract(), {
    runId: "run", verificationId: "verification", projectRoot: process.cwd(), additionalRoots: [], implementationActivationId: null, testActivationId: null,
    existingRecords: [{ ...baseRecord, status: "not_run", startedAt: null, summary: "stopped" }],
  });
  assert.equal(notRun.records[0].status, "not_run");
  const control = await new VerificationRunner(new ScriptedRuntime(0), new StableIntegrity(), new MemoryArtifacts()).run(contract(), {
    runId: "run", verificationId: "verification", projectRoot: process.cwd(), additionalRoots: [], implementationActivationId: null, testActivationId: null,
    pollControl: async () => ({ schemaVersion: 1, requestId: "stop-1", runId: "run", type: "stop", message: "stop", createdAt: "2026-09-06T00:00:00.000Z" }),
  });
  assert.equal(control.control?.type, "stop");
  assert.equal(control.records[0].status, "not_run");
  const throwing = await new VerificationRunner({ execute: async () => { throw new Error("runtime exploded"); } }, new StableIntegrity(), new MemoryArtifacts()).run(contract(), {
    runId: "run", verificationId: "verification", projectRoot: process.cwd(), additionalRoots: [], implementationActivationId: null, testActivationId: null,
  });
  assert.equal(throwing.proof.executionError, true);
  assert.match(throwing.proof.failureReason ?? "", /runtime exploded/u);
});
