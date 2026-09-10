import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { createDefaultDefinitionRegistries } from "../definitions/default-registries";
import { loadDefinitionSource } from "../definitions/definition-loader";
import { compileWorkflow } from "../definitions/workflow-compiler";
import { createRunAggregate } from "./run-factory";
import { RunReducer } from "./run-reducer";
import { TaskInputAssembler } from "./task-input-assembler";
import { TransitionRouter } from "./transition-router";
import { WorkflowRunner } from "./workflow-runner";
import { createVerificationContract } from "./verification-runner";
import type { VerificationRunnerResult } from "./verification-runner";
import type { AgentTaskRunner } from "./agent-task-runner";
import type { NodeExecutionContext } from "./node-execution-context";
import type { VerificationRunner } from "./verification-runner";
import type { VerificationContractService } from "./verification-contract-service";
import { NoopProjection } from "./ports/projection";
import type { RunControlCommandPort } from "./ports/control-command";
import { FileArtifactStore } from "../infrastructure/file-artifact-store";
import { FileRunRepository } from "../infrastructure/file-run-repository";
import { initRunStorage } from "../infrastructure/run-storage";
import type { ArtifactReference } from "../domain/task-result";
import { hashVerificationCandidate } from "../domain/verification";
import type { VerificationApprovalCandidate, VerificationCommandRecord, VerificationProof } from "../domain/verification";

const timestamp = "2026-09-10T00:00:00.000Z";
const digest = "a".repeat(64);

function artifact(sha256: string, mediaType: string): ArtifactReference {
  return {
    artifactId: `artifact_${sha256}`,
    sha256,
    mediaType,
    bytes: 1,
    createdAt: timestamp,
  };
}

test("workflow runner executes a core verification node and commits its proof", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-loop-runner-verify-"));
  try {
    const source = await loadDefinitionSource(process.cwd());
    const registries = createDefaultDefinitionRegistries();
    const bundle = compileWorkflow(source, registries);
    const reducer = new RunReducer();
    const initial = createRunAggregate({
      runId: "runner-verification",
      definition: bundle,
      goal: "Run a core verification boundary.",
      requirements: [{ id: "REQ-001", text: "Run a core verification boundary." }],
      targetProjectPath: root,
      now: timestamp,
    });
    let prepared = initial;
    prepared.execution.currentNodeId = "IMPLEMENTATION";
    prepared.execution.cyclesStarted = 1;
    prepared.execution.activeCycleNumber = 1;
    prepared = reducer.reserveNode(prepared, "impl", timestamp);
    prepared = reducer.startAttempt(prepared, "impl", "impl-attempt", timestamp);
    prepared = reducer.completeNode(prepared, {
      nodeId: "IMPLEMENTATION",
      activationId: "impl",
      result: { status: "succeeded", signal: "success", output: null, effects: [], artifacts: [], failure: null, pendingInput: null },
      targetId: "TEST",
      terminalStatus: null,
      effects: [],
      completedAt: timestamp,
    });
    prepared = reducer.reserveNode(prepared, "test", timestamp);
    prepared = reducer.startAttempt(prepared, "test", "test-attempt", timestamp);
    prepared = reducer.completeNode(prepared, {
      nodeId: "TEST",
      activationId: "test",
      result: { status: "succeeded", signal: "prepared", output: null, effects: [], artifacts: [], failure: null, pendingInput: null },
      targetId: "VERIFY",
      terminalStatus: null,
      effects: [],
      completedAt: timestamp,
    });
    const baseline = artifact(digest, "application/vnd.custom-agent-loop.workspace-fingerprint+json;version=1");
    const contract = createVerificationContract(
      [{ id: "unit", label: "unit", executable: "node", args: ["--version"], cwd: ".", timeoutMs: 1_000, requirementIds: ["REQ-001"] }],
      digest,
      "plan-approval",
      { paths: [], fileHashes: {} }
    );
    contract.baselineArtifactId = baseline.artifactId;
    prepared.context.verificationContract = contract;
    prepared.context.selectedVerificationDraft = {
      commands: [...contract.commands],
      totalTimeoutMs: contract.totalTimeoutMs,
      protectedPaths: [...contract.protectedPaths],
      testRoots: [...contract.testRoots],
      allowedNewTestRoots: [...contract.allowedNewTestRoots],
      generatedOutputPaths: [...contract.generatedOutputPaths],
    };
    prepared.artifacts[baseline.artifactId] = baseline;

    const runsRoot = path.join(root, "runs");
    await initRunStorage(root, prepared.runId, { paths: { sessionsRoot: "runs", attemptLogsDirName: "attempt_logs", controlDirName: "control" } });
    const repository = new FileRunRepository({ runsRoot });
    await repository.init(prepared);
    await repository.acquireFencingEpoch(prepared.runId);
    const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
    const log = artifact("b".repeat(64), "application/vnd.custom-agent-loop.verification-log+json;version=1");
    const resultArtifact = artifact("c".repeat(64), "application/vnd.custom-agent-loop.verification-result+json;version=1");
    const command: VerificationCommandRecord = {
      verificationId: "verify_activation_verification",
      commandId: "unit",
      status: "completed",
      executable: "node",
      args: ["--version"],
      cwd: root,
      approvedExecutable: "node",
      approvedArgs: ["--version"],
      approvedCwd: ".",
      startedAt: timestamp,
      completedAt: timestamp,
      exitCode: 0,
      signal: null,
      timedOut: false,
      processTreeClean: true,
      logArtifactId: log.artifactId,
      summary: "unit passed",
      elapsedMs: 1,
    };
    const proof: VerificationProof = {
      proofId: "runner-proof",
      verificationId: command.verificationId,
      contractRevision: contract.revision,
      contractHash: contract.contractHash,
      baselineFingerprint: digest,
      beforeFingerprint: digest,
      afterFingerprint: digest,
      implementationActivationId: "impl",
      testActivationId: "test",
      commands: [command],
      passed: true,
      verifiedAt: timestamp,
      watcherReliable: true,
      executionError: false,
      resultArtifactId: resultArtifact.artifactId,
    };
    const fakeVerificationRunner = {
      currentFingerprint: async () => ({ digest, files: 0, paths: [], fileHashes: {} }),
      buildApprovalCandidate: () => { throw new Error("not used"); },
      run: async (_contract: unknown, context: { verificationId: string; onRecord?: (record: VerificationCommandRecord, log?: ArtifactReference) => Promise<void> }): Promise<VerificationRunnerResult> => {
        const runCommand = { ...command, verificationId: context.verificationId };
        const runProof = { ...proof, verificationId: context.verificationId, commands: [runCommand] };
        await context.onRecord?.({ ...runCommand, status: "reserved", startedAt: null, completedAt: null, exitCode: null, processTreeClean: null, logArtifactId: null, summary: "" }, undefined);
        await context.onRecord?.({ ...runCommand, status: "running", completedAt: null, exitCode: null, processTreeClean: null, logArtifactId: null, summary: "" }, undefined);
        await context.onRecord?.(runCommand, log);
        return { proof: runProof, records: [runCommand], control: null, resultArtifact };
      },
    } as unknown as VerificationRunner;
    const taskRunner = { run: async () => { throw new Error("task runner should not be used"); } } as unknown as AgentTaskRunner;
    const runner = new WorkflowRunner(
      repository,
      reducer,
      new TransitionRouter(),
      taskRunner,
      new TaskInputAssembler(artifacts, registries.schemas),
      new NoopProjection(),
      { now: () => timestamp, delay: async () => undefined },
      undefined,
      undefined,
      fakeVerificationRunner,
      undefined,
    );
    const completed = await runner.runUntilBoundary(prepared.runId, { maxStepsPerInvocation: 1 });
    assert.equal(completed.execution.currentNodeId, "QA_REVIEW");
    assert.equal(completed.context.verificationProof?.proofId, proof.proofId);
    assert.equal(completed.context.verificationRecords.length, 1);
    assert.equal(completed.context.verificationRecords[0].status, "completed");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function runnerFixture(nodeId: string): Promise<{
  root: string;
  repository: FileRunRepository;
  artifacts: FileArtifactStore;
  reducer: RunReducer;
  aggregate: import("../domain/run-aggregate").RunAggregate;
  bundle: import("../domain/workflow").CompiledWorkflowBundle;
  registries: ReturnType<typeof createDefaultDefinitionRegistries>;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-loop-runner-boundary-"));
  const source = await loadDefinitionSource(process.cwd());
  const registries = createDefaultDefinitionRegistries();
  const bundle = compileWorkflow(source, registries);
  const reducer = new RunReducer();
  const aggregate = createRunAggregate({
    runId: `runner-${nodeId.toLowerCase()}`,
    definition: bundle,
    goal: "Exercise workflow runner boundary.",
    requirements: [{ id: "REQ-001", text: "Exercise workflow runner boundary." }],
    targetProjectPath: root,
    now: timestamp,
  });
  aggregate.execution.currentNodeId = nodeId;
  aggregate.execution.cyclesStarted = 1;
  aggregate.execution.activeCycleNumber = 1;
  const runsRoot = path.join(root, "runs");
  await initRunStorage(root, aggregate.runId, { paths: { sessionsRoot: "runs", attemptLogsDirName: "attempt_logs", controlDirName: "control" } });
  const repository = new FileRunRepository({ runsRoot });
  await repository.init(aggregate);
  await repository.acquireFencingEpoch(aggregate.runId);
  return { root, repository, artifacts: new FileArtifactStore(path.join(root, "artifacts")), reducer, aggregate, bundle, registries };
}

function baseRunner(
  fixture: Awaited<ReturnType<typeof runnerFixture>>,
  taskRunner: AgentTaskRunner,
  verificationRunner?: VerificationRunner,
  verificationContracts?: VerificationContractService,
  controls?: RunControlCommandPort
): WorkflowRunner {
  return new WorkflowRunner(
    fixture.repository,
    fixture.reducer,
    new TransitionRouter(),
    taskRunner,
    new TaskInputAssembler(fixture.artifacts, fixture.registries.schemas),
    new NoopProjection(),
    { now: () => timestamp, delay: async () => undefined },
    undefined,
    controls,
    verificationRunner,
    verificationContracts,
  );
}

test("workflow runner records a verification preflight failure when the core runtime is absent", async () => {
  const fixture = await runnerFixture("VERIFY");
  try {
    const runner = baseRunner(fixture, { run: async () => { throw new Error("task runner must not run"); } } as unknown as AgentTaskRunner);
    const result = await runner.runUntilBoundary(fixture.aggregate.runId, { maxStepsPerInvocation: 1 });
    assert.equal(result.execution.status, "BLOCKED");
    assert.match(result.execution.reason ?? "", /Verification runtime is not configured/u);
    assert.equal(result.context.verificationProof, null);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("workflow runner waits for reapproval when the workspace fingerprint or policy changed", async () => {
  const fixture = await runnerFixture("VERIFY");
  try {
    const contract = createVerificationContract(
      [{ id: "unit", label: "unit", executable: "node", args: ["--version"], cwd: ".", timeoutMs: 1000, requirementIds: ["REQ-001"] }],
      digest,
      "plan",
      { paths: [], fileHashes: {} }
    );
    const baseline = artifact(digest, "application/vnd.custom-agent-loop.workspace-fingerprint+json;version=1");
    contract.baselineArtifactId = baseline.artifactId;
    fixture.aggregate.context.verificationContract = contract;
    fixture.aggregate.context.verificationCriteriaChanges = ["TEST proposed a changed command policy"];
    fixture.aggregate.context.selectedVerificationDraft = {
      commands: [...contract.commands], totalTimeoutMs: contract.totalTimeoutMs, protectedPaths: [], testRoots: [], allowedNewTestRoots: [], generatedOutputPaths: [],
    };
    const candidate: VerificationApprovalCandidate = {
      candidateHash: "",
      baseRevision: contract.revision,
      baselineFingerprint: "b".repeat(64),
      baselineArtifactId: artifact("b".repeat(64), "application/vnd.custom-agent-loop.workspace-fingerprint+json;version=1").artifactId,
      diffArtifactId: artifact("c".repeat(64), "application/vnd.custom-agent-loop.verification-diff+json;version=1").artifactId,
      baselinePaths: [], baselineFileHashes: {}, baselineFileModes: {},
      commands: [...contract.commands], totalTimeoutMs: contract.totalTimeoutMs, protectedPaths: [], testRoots: [], allowedNewTestRoots: [], generatedOutputPaths: [],
      changedPaths: ["src/example.ts"], addedPaths: [], modifiedPaths: ["src/example.ts"], deletedPaths: [],
    };
    candidate.candidateHash = hashVerificationCandidate(candidate);
    fixture.aggregate.artifacts[baseline.artifactId] = baseline;
    const diff = artifact("c".repeat(64), "application/vnd.custom-agent-loop.verification-diff+json;version=1");
    const nextBaseline = artifact("b".repeat(64), "application/vnd.custom-agent-loop.workspace-fingerprint+json;version=1");
    fixture.aggregate.artifacts[diff.artifactId] = diff;
    fixture.aggregate.artifacts[nextBaseline.artifactId] = nextBaseline;
    const stored = await fixture.repository.load(fixture.aggregate.runId);
    await fixture.repository.commit(
      { ...stored, context: structuredClone(fixture.aggregate.context), artifacts: structuredClone(fixture.aggregate.artifacts) },
      stored.revision,
      stored.fencingEpoch,
    );
    const service = {
      candidate: async () => ({ candidate, diff, baseline: nextBaseline }),
    } as unknown as VerificationContractService;
    const verificationRunner = {
      currentFingerprint: async () => ({ digest: "b".repeat(64), files: 1, paths: ["src/example.ts"], fileHashes: {} }),
    } as unknown as VerificationRunner;
    const runner = baseRunner(fixture, { run: async () => { throw new Error("task runner must not run"); } } as unknown as AgentTaskRunner, verificationRunner, service);
    const result = await runner.runUntilBoundary(fixture.aggregate.runId, { maxStepsPerInvocation: 1 });
    assert.equal(result.execution.status, "WAITING_USER");
    assert.equal(result.pendingInput?.kind, "verification_approval");
    assert.equal(result.context.verificationCandidate?.candidateHash, candidate.candidateHash);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("workflow runner routes a verification execution error to BLOCKED and honours boundary controls", async () => {
  const fixture = await runnerFixture("VERIFY");
  try {
    const contract = createVerificationContract(
      [{ id: "unit", label: "unit", executable: "node", args: ["--version"], cwd: ".", timeoutMs: 1000, requirementIds: ["REQ-001"] }],
      digest,
      "plan",
      { paths: [], fileHashes: {} }
    );
    const baseline = artifact(digest, "application/vnd.custom-agent-loop.workspace-fingerprint+json;version=1");
    contract.baselineArtifactId = baseline.artifactId;
    fixture.aggregate.context.verificationContract = contract;
    fixture.aggregate.context.selectedVerificationDraft = {
      commands: [...contract.commands], totalTimeoutMs: contract.totalTimeoutMs, protectedPaths: [], testRoots: [], allowedNewTestRoots: [], generatedOutputPaths: [],
    };
    fixture.aggregate.artifacts[baseline.artifactId] = baseline;
    const stored = await fixture.repository.load(fixture.aggregate.runId);
    await fixture.repository.commit(
      { ...stored, context: structuredClone(fixture.aggregate.context), artifacts: structuredClone(fixture.aggregate.artifacts) },
      stored.revision,
      stored.fencingEpoch,
    );
    const proofCommand: VerificationCommandRecord = {
      verificationId: "placeholder", commandId: "unit", status: "completed", executable: "node", args: ["--version"], cwd: fixture.root,
      approvedExecutable: "node", approvedArgs: ["--version"], approvedCwd: ".", startedAt: timestamp, completedAt: timestamp,
      exitCode: null, signal: "SIGTERM", timedOut: false, processTreeClean: true, logArtifactId: null, summary: "unknown", elapsedMs: 1,
    };
    const resultArtifact = artifact("f".repeat(64), "application/vnd.custom-agent-loop.verification-result+json;version=1");
    fixture.aggregate.artifacts[resultArtifact.artifactId] = resultArtifact;
    const verificationRunner = {
      currentFingerprint: async () => ({ digest, files: 0, paths: [], fileHashes: {} }),
      run: async (_contract: unknown, context: { verificationId: string; implementationActivationId: string | null; testActivationId: string | null; onRecord?: (record: VerificationCommandRecord) => Promise<void> }): Promise<VerificationRunnerResult> => {
        const command = { ...proofCommand, verificationId: context.verificationId };
        await context.onRecord?.({ ...command, status: "reserved", startedAt: null, completedAt: null, exitCode: null, signal: null, processTreeClean: null, summary: "", logArtifactId: null });
        await context.onRecord?.({ ...command, status: "running", startedAt: timestamp, completedAt: null, exitCode: null, signal: null, processTreeClean: null, summary: "", logArtifactId: null });
        await context.onRecord?.(command);
        const proof: VerificationProof = {
          proofId: "execution-error-proof", verificationId: context.verificationId, contractRevision: contractObj(fixture).revision,
          contractHash: contractObj(fixture).contractHash, baselineFingerprint: digest, beforeFingerprint: digest, afterFingerprint: digest,
          implementationActivationId: context.implementationActivationId, testActivationId: context.testActivationId, commands: [command], passed: false,
          verifiedAt: timestamp, watcherReliable: true, executionError: true, failureReason: "process cleanup unknown", resultArtifactId: resultArtifact.artifactId,
        };
        return { proof, records: [command], control: null, resultArtifact };
      },
    } as unknown as VerificationRunner;
    const result = await baseRunner(fixture, { run: async () => { throw new Error("task runner must not run"); } } as unknown as AgentTaskRunner, verificationRunner).runUntilBoundary(fixture.aggregate.runId, { maxStepsPerInvocation: 1 });
    assert.equal(result.execution.status, "BLOCKED");
    assert.match(result.context.verificationInvalidationReason ?? "", /unknown/u);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("workflow runner persists task human input without completing the activation", async () => {
  const fixture = await runnerFixture("PLANNING");
  try {
    const runner = baseRunner(fixture, {
      run: async (context: NodeExecutionContext) => ({
        status: "waiting_user",
        signal: null,
        output: null,
        effects: [],
        artifacts: [],
        failure: null,
        pendingInput: {
          requestId: `${context.activationId}-question`,
          kind: "custom",
          nodeId: context.node.id,
          activationId: context.activationId,
          prompt: "Provide a missing planning detail.",
          allowedSignals: ["approved", "rejected"],
          context: { question: "detail" },
          createdAt: timestamp,
        },
      }),
    } as unknown as AgentTaskRunner);
    const result = await runner.runUntilBoundary(fixture.aggregate.runId, { maxStepsPerInvocation: 1 });
    assert.equal(result.execution.status, "WAITING_USER");
    assert.equal(result.pendingInput?.kind, "custom");
    assert.equal(result.nodeExecutions[result.execution.activeActivationId!].status, "waiting_user");
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("workflow runner records retryable task failures and retries the same activation", async () => {
  const fixture = await runnerFixture("PLANNING");
  try {
    let calls = 0;
    const runner = baseRunner(fixture, {
      run: async () => {
        calls += 1;
        return {
          status: "failed", signal: "error", output: null, effects: [], artifacts: [], pendingInput: null,
          failure: { kind: "provider", message: "temporary provider outage", retryable: true, ambiguousMutation: false, attemptId: null },
        };
      },
    } as unknown as AgentTaskRunner);
    const result = await runner.runUntilBoundary(fixture.aggregate.runId, { maxStepsPerInvocation: 1 });
    assert.equal(calls, 3);
    const execution = Object.values(result.nodeExecutions).find((item) => item.nodeId === "PLANNING");
    assert.ok(execution);
    assert.equal(execution.attemptIds.length, 3);
    assert.equal(result.execution.currentNodeId, "INTERRUPT");
    assert.equal(result.execution.status, "RUNNING");
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("workflow runner converts task runner exceptions and ambiguous failures into safe boundaries", async () => {
  const fixture = await runnerFixture("PLANNING");
  try {
    const runner = baseRunner(fixture, { run: async () => { throw new Error("provider crashed"); } } as unknown as AgentTaskRunner);
    const result = await runner.runUntilBoundary(fixture.aggregate.runId, { maxStepsPerInvocation: 1 });
    assert.equal(result.execution.currentNodeId, "INTERRUPT");
    assert.equal(result.execution.status, "RUNNING");
    const failure = Object.values(result.nodeExecutions).find((item) => item.nodeId === "PLANNING")?.failure;
    assert.match(failure?.message ?? "", /provider crashed/u);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
  const ambiguous = await runnerFixture("IMPLEMENTATION");
  try {
    const runner = baseRunner(ambiguous, { run: async () => ({
      status: "failed", signal: "error", output: null, effects: [], artifacts: [], pendingInput: null,
      failure: { kind: "unknown_mutation", message: "write state unknown", retryable: false, ambiguousMutation: true, attemptId: null },
    }) } as unknown as AgentTaskRunner);
    const result = await runner.runUntilBoundary(ambiguous.aggregate.runId, { maxStepsPerInvocation: 1 });
    assert.equal(result.execution.status, "BLOCKED");
    assert.equal(result.execution.currentNodeId, "IMPLEMENTATION");
  } finally {
    await fs.rm(ambiguous.root, { recursive: true, force: true });
  }
});

function contractObj(fixture: Awaited<ReturnType<typeof runnerFixture>>) {
  return fixture.aggregate.context.verificationContract!;
}
