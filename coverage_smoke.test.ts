import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { resolveBinaryForSpawn } from "./binary_resolution";
import {
  atomicAppendLine,
  atomicReadJson,
  atomicWriteJson,
  atomicWriteText,
  renameWithRetry,
} from "./json_file_store";
import { getDefaultConfig } from "./runtime_config";
import { main } from "./src/interfaces/cli/main";
import { composeApplication } from "./src/composition/application";
import { createDefaultDefinitionRegistries } from "./src/definitions/default-registries";
import { loadDefinitionSource } from "./src/definitions/definition-loader";
import { compileWorkflow } from "./src/definitions/workflow-compiler";
import { createRunAggregate, deriveWorkflowRequirements } from "./src/application/run-factory";
import { VerificationContractService } from "./src/application/verification-contract-service";
import { RunReducer, WorkflowBudgetError } from "./src/application/run-reducer";
import { FileRunControlRepository } from "./src/infrastructure/file-run-control-repository";
import { FileRunRepository } from "./src/infrastructure/file-run-repository";
import { initRunStorage } from "./src/infrastructure/run-storage";
import { FileArtifactStore } from "./src/infrastructure/file-artifact-store";
import { FileRunProjection, initPlanOutput } from "./src/interfaces/operator/run-projection";
import { createEmptySessionIndexProjection } from "./src/interfaces/operator/contracts";
import { ProviderCapabilityRuntime } from "./src/runtime/provider-capability-runtime";
import { SupervisedAgentRuntime } from "./src/runtime/supervised-agent-runtime";
import { runAuthenticatedProviderConformance } from "./provider_conformance";
// These modules are intentionally type-heavy and normally disappear from the
// runtime import graph.  Load them once in the smoke suite so the coverage
// inventory verifies their compiled module boundary as well; there is no
// executable branch hidden behind these declarations.
import "./loop_orchestrator";
import "./src/application/node-execution-context";
import "./src/application/ports/agent-runtime-port";
import "./src/application/ports/artifact-store";
import "./src/application/ports/control-command";
import "./src/application/ports/project-lease-port";
import "./src/application/ports/provider-capability-runtime-port";
import "./src/application/ports/run-repository";
import "./src/application/ports/verification-runtime-port";
import "./src/application/ports/workspace-integrity-port";
import "./src/domain/agent";
import "./src/domain/control-command";
import "./src/domain/domain-effect";
import "./src/domain/run-aggregate";
import "./src/domain/task-result";
import "./src/domain/task";
import "./src/domain/workflow";
import type { ArtifactReference } from "./src/domain/task-result";
import type { AgentRuntimeRequest } from "./src/application/ports/agent-runtime-port";

function artifact(id: string, mediaType = "application/json"): ArtifactReference {
  return {
    artifactId: id,
    sha256: id.padEnd(64, "0").slice(0, 64),
    mediaType,
    bytes: 1,
    createdAt: "2026-09-09T00:00:00.000Z",
  };
}

test("file helpers, verification contract service, and control queue preserve their boundaries", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-loop-coverage-"));
  try {
    const jsonPath = path.join(root, "value.json");
    const textPath = path.join(root, "lines.txt");
    await atomicWriteJson(jsonPath, { value: 1 });
    assert.deepEqual(await atomicReadJson<{ value: number }>(jsonPath), { value: 1 });
    await atomicWriteText(textPath, "first\n");
    await atomicAppendLine(textPath, "second");
    assert.equal(await fs.readFile(textPath, "utf8"), "first\nsecond\n");
    const renamed = path.join(root, "renamed.txt");
    await renameWithRetry(textPath, renamed);
    assert.equal(await fs.readFile(renamed, "utf8"), "first\nsecond\n");
    assert.equal(resolveBinaryForSpawn("definitely-missing-agent-loop-binary"), "definitely-missing-agent-loop-binary");

    let artifactNumber = 0;
    const artifacts = {
      put: async (_content: string | Buffer, mediaType: string): Promise<ArtifactReference> =>
        artifact(`artifact-${++artifactNumber}`, mediaType),
      read: async (): Promise<Buffer> => Buffer.from("{}", "utf8"),
    };
    let fingerprintNumber = 0;
    const integrity = {
      fingerprint: async (): Promise<{
        digest: string;
        files: number;
        paths: string[];
        fileHashes: Record<string, string>;
        fileModes: Record<string, number>;
      }> => {
        fingerprintNumber += 1;
        const digest = `digest-${fingerprintNumber}`;
        return {
          digest,
          files: 2,
          paths: ["src/app.ts", "test/app.test.ts"],
          fileHashes: { "src/app.ts": `hash-${fingerprintNumber}`, "test/app.test.ts": "test-hash" },
          fileModes: { "src/app.ts": 0o644, "test/app.test.ts": 0o644 },
        };
      },
      watch: () => ({ reliable: true, dirty: () => false, close: () => undefined }),
    };
    const service = new VerificationContractService(integrity, artifacts);
    const command = {
      id: "unit",
      label: "unit tests",
      executable: "node",
      args: ["--version"],
      cwd: ".",
      timeoutMs: 1_000,
      requirementIds: ["REQ-001"],
    };
    const prepared = await service.createInitial(
      [command],
      root,
      [],
      "initial-request",
      {
        commands: [command],
        totalTimeoutMs: 2_000,
        protectedPaths: ["package.json"],
        testRoots: ["test"],
        allowedNewTestRoots: ["test"],
        generatedOutputPaths: ["dist"],
      }
    );
    const candidate = await service.candidate(
      prepared.contract,
      root,
      [],
      prepared.contract.baselinePaths,
      prepared.contract.baselineFileHashes,
      prepared.contract.baselineFileModes,
      { totalTimeoutMs: 3_000 }
    );
    const applied = service.apply(
      prepared.contract,
      candidate.candidate,
      "approval-request",
      "2026-09-09T00:00:01.000Z"
    );
    assert.equal(applied.revision, prepared.contract.revision + 1);
    assert.equal(applied.totalTimeoutMs, 3_000);

    await initRunStorage(root, "run_coverage", {
      paths: { sessionsRoot: "runs", attemptLogsDirName: "attempt_logs", controlDirName: "control" },
    });
    const controls = new FileRunControlRepository(path.join(root, "runs"));
    const queued = await controls.enqueue("run_coverage", "interrupt", "pause for test");
    assert.equal(queued.type, "interrupt");
    const claimed = await controls.claim("run_coverage");
    assert.equal(claimed?.requestId, queued.requestId);
    await controls.complete(claimed!, "completed", "acknowledged");
    await controls.recover("run_coverage");
    await assert.rejects(() => controls.enqueue("../escape", "stop", null), /Unsafe run id/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("composition and file projection initialize a complete operator snapshot", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-loop-projection-"));
  try {
    const config = getDefaultConfig();
    await fs.mkdir(root, { recursive: true });
    const app = composeApplication({ dataRoot: root, runId: "projection_run", config });
    assert.ok(app.runner);
    assert.ok(app.verificationContracts);

    const source = await loadDefinitionSource(process.cwd());
    const bundle = compileWorkflow(source, createDefaultDefinitionRegistries());
    const aggregate = createRunAggregate({
      runId: "projection_run",
      definition: bundle,
      goal: "Projection smoke",
      requirements: deriveWorkflowRequirements("Projection smoke"),
      targetProjectPath: root,
      now: "2026-09-09T00:00:00.000Z",
    });
    const reducer = new RunReducer();
    const reserved = reducer.reserveNode(aggregate, "activation_smoke", "2026-09-09T00:00:01.000Z");
    const started = reducer.startAttempt(reserved, "activation_smoke", "attempt_smoke", "2026-09-09T00:00:02.000Z");
    const interrupted = reducer.applyBoundaryControl(
      started,
      "interrupt_smoke",
      "interrupt",
      "inspect this run",
      "2026-09-09T00:00:03.000Z",
      true
    );
    assert.equal(interrupted.execution.currentNodeId, bundle.applicationPolicy.interruptNodeId);
    const stopped = reducer.applyBoundaryControl(
      aggregate,
      "stop_smoke",
      "stop",
      "stop this run",
      "2026-09-09T00:00:04.000Z"
    );
    assert.equal(stopped.execution.status, "STOPPED");
    const resumed = reducer.resumeRun(stopped, "resume smoke", "2026-09-09T00:00:05.000Z");
    assert.equal(resumed.execution.status, "RUNNING");
    const accessChanged = reducer.setAccessMode(resumed, "full_access", "2026-09-09T00:00:06.000Z");
    const findings = reducer.recordFindings(accessChanged, [{ text: "A smoke finding", source: "qa" }], "qa_smoke", "2026-09-09T00:00:07.000Z");
    const feedback = reducer.recordReviewFeedback(findings, "qa", "qa_smoke", "Needs another review", ["diagnostic"], "2026-09-09T00:00:08.000Z");
    const converged = reducer.recordConvergence(feedback, {
      contractHash: null,
      reachedStep: 1,
      failedCommandIds: [],
      unsatisfiedRequirementIds: [],
      unresolvedFindingIds: feedback.context.findings.map((finding) => finding.id),
    }, "2026-09-09T00:00:09.000Z");
    assert.equal(converged.context.convergence.history.length, 1);
    const fingerprinted = reducer.confirmWorkspaceFingerprint(converged, "a".repeat(64), "2026-09-09T00:00:10.000Z");
    assert.equal(fingerprinted.context.latestWorkspaceFingerprint, "a".repeat(64));
    const blocked = reducer.blockForBudget(fingerprinted, new WorkflowBudgetError("cycles"), "2026-09-09T00:00:11.000Z");
    assert.equal(blocked.execution.status, "BLOCKED");
    const storage = await initRunStorage(root, aggregate.runId, config);
    const indexPath = path.join(root, config.paths.sessionsIndexFileName);
    await atomicWriteJson(indexPath, createEmptySessionIndexProjection());
    const artifacts = new FileArtifactStore(path.join(storage.sessionDirectory, "artifacts"));
    const projection = new FileRunProjection(
      {
        runsRoot: storage.runsRoot,
        indexPath,
        projectionFileName: config.paths.sessionFileNames.state,
        progressFileName: config.paths.sessionFileNames.progressNotes,
        finalSummaryFileName: config.paths.sessionFileNames.finalSummary,
        indexLockFileName: config.paths.registryLockFileName,
      },
      artifacts
    );
    await initPlanOutput(storage.sessionDirectory);
    await projection.update(aggregate);
    const snapshot = JSON.parse(await fs.readFile(path.join(storage.sessionDirectory, config.paths.sessionFileNames.state), "utf8")) as { projectionSchemaVersion: number; verification: unknown };
    assert.equal(snapshot.projectionSchemaVersion, 2);
    assert.ok(snapshot.verification);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("CLI capability and initialization paths, capability runtime, and supervised failure boundaries are fail-closed", async () => {
  assert.equal(await main([]), 1);
  assert.equal(await main(["--help"]), 0);
  assert.equal(await main(["capabilities", "--config-root", path.join(os.tmpdir(), "agent-loop-uninitialized-config"), "--data-root", path.join(os.tmpdir(), "agent-loop-uninitialized-data")]), 0);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-loop-cli-"));
  try {
    const configRoot = path.join(root, "config");
    const dataRoot = path.join(root, "data");
    await fs.mkdir(dataRoot, { recursive: true });
    assert.equal(await main(["init", "--config-root", configRoot, "--data-root", dataRoot]), 0);
    assert.equal(await main(["unknown-command", "--config-root", configRoot, "--data-root", dataRoot]), 1);
    await main(["upgrade", "--reset-sessions", "--dry-run", "--config-root", configRoot, "--data-root", dataRoot]);
    await assert.rejects(
      () => main(["status", "--session", "missing", "--config-root", configRoot, "--data-root", dataRoot]),
      /Run not found|ENOENT|missing/u
    );
    await assert.rejects(
      () => main(["run", "--target", root, "--config-root", configRoot, "--data-root", dataRoot]),
      /--goal is required/u
    );
    await assert.rejects(
      () => main(["upgrade", "--config-root", configRoot, "--data-root", dataRoot]),
      /upgrade requires --reset-sessions/u
    );
    await assert.rejects(
      () => main(["set-access", "--session", "missing", "--mode", "invalid", "--config-root", configRoot, "--data-root", dataRoot]),
      /--mode must be ask or full_access|Run not found|ENOENT/u
    );
    await assert.rejects(
      () => main(["stop", "--session", "missing", "--config-root", configRoot, "--data-root", dataRoot]),
      /Run not found|ENOENT|missing/u
    );
    await assert.rejects(
      () => main(["interrupt", "--session", "missing", "--message", "pause", "--config-root", configRoot, "--data-root", dataRoot]),
      /Run not found|ENOENT|missing/u
    );
    await assert.rejects(
      () => main(["approve-plan", "--session", "missing", "--config-root", configRoot, "--data-root", dataRoot]),
      /Run not found|ENOENT|missing/u
    );
    await assert.rejects(
      () => main(["approve-verification", "--session", "missing", "--request-id", "request", "--candidate-hash", "hash", "--config-root", configRoot, "--data-root", dataRoot]),
      /Run not found|ENOENT|missing/u
    );
    await assert.rejects(
      () => main(["reject-verification", "--session", "missing", "--request-id", "request", "--candidate-hash", "hash", "--message", "reject", "--config-root", configRoot, "--data-root", dataRoot]),
      /Run not found|ENOENT|missing/u
    );
    await assert.rejects(
      () => main(["resume", "--session", "missing", "--config-root", configRoot, "--data-root", dataRoot]),
      /Run not found|ENOENT|missing/u
    );
    await assert.rejects(
      () => main(["revise-plan", "--session", "missing", "--message", "revise", "--config-root", configRoot, "--data-root", dataRoot]),
      /Run not found|ENOENT|missing/u
    );
    await assert.rejects(
      () => main(["cancel-plan", "--session", "missing", "--config-root", configRoot, "--data-root", dataRoot]),
      /Run not found|ENOENT|missing/u
    );
    await assert.rejects(
      () => main(["init", "--config-root", configRoot, "--data-root", dataRoot]),
      /ALREADY_INITIALIZED/u
    );

    const capabilityRuntime = new ProviderCapabilityRuntime();
    const missing = await capabilityRuntime.inspect("codex", "definitely-missing-agent-loop-binary", "tools-none");
    assert.equal(missing.resolvedBinary, null);
    const nodeCapability = await capabilityRuntime.inspect("codex", process.execPath, "tools-none");
    assert.equal(nodeCapability.resolvedBinary, path.resolve(process.execPath));

    const runtime = new SupervisedAgentRuntime({
      providers: {},
      toolAccess: { webSearch: { enabled: false, mode: "live" }, mcpServers: [] },
      defaults: getDefaultConfig().defaults,
      destructivePrompts: [],
      runDataRoot: dataRoot,
    });
    const invalid = await runtime.execute({ runId: "../escape", attemptId: "attempt", mode: "task" } as unknown as AgentRuntimeRequest);
    assert.equal(invalid.status, "failed");
    assert.equal(invalid.failure?.kind, "security");

    const blockedConformance = await runAuthenticatedProviderConformance({
      provider: "codex",
      model: "coverage-smoke",
      binary: "definitely-missing-agent-loop-binary",
      mode: "tools-none",
    });
    assert.equal(blockedConformance.spawned, false);
    assert.equal(blockedConformance.expectedFailClosed, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("CLI operator commands read and mutate a persisted paused session", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-loop-cli-operator-"));
  try {
    const configRoot = path.join(root, "config");
    const dataRoot = path.join(root, "data");
    const targetRoot = path.join(root, "project");
    await fs.mkdir(targetRoot, { recursive: true });
    await main(["init", "--config-root", configRoot, "--data-root", dataRoot]);
    const config = getDefaultConfig();
    const source = await loadDefinitionSource(process.cwd());
    const bundle = compileWorkflow(source, createDefaultDefinitionRegistries());
    const initial = createRunAggregate({
      runId: "cli-operator",
      definition: bundle,
      goal: "Exercise operator commands.",
      requirements: deriveWorkflowRequirements("Exercise operator commands."),
      targetProjectPath: targetRoot,
      now: "2026-09-10T00:00:00.000Z",
    });
    await initRunStorage(dataRoot, initial.runId, config);
    const repository = new FileRunRepository({ runsRoot: path.join(dataRoot, config.paths.sessionsRoot) });
    await repository.init(initial);
    const owned = await repository.acquireFencingEpoch(initial.runId);
    const paused = new RunReducer().setStatus(owned, "PAUSED", "operator pause", "2026-09-10T00:00:01.000Z");
    await repository.commit(paused, owned.revision, owned.fencingEpoch);
    await main(["status", "--session", initial.runId, "--json", "--config-root", configRoot, "--data-root", dataRoot]);
    await main(["set-access", "--session", initial.runId, "--mode", "full_access", "--config-root", configRoot, "--data-root", dataRoot]);
    await main(["stop", "--session", initial.runId, "--message", "operator stop", "--config-root", configRoot, "--data-root", dataRoot]);
    await main(["status", "--session", initial.runId, "--config-root", configRoot, "--data-root", dataRoot]);
    await assert.rejects(
      () => main(["interrupt", "--session", initial.runId, "--message", "already stopped", "--config-root", configRoot, "--data-root", dataRoot]),
      /Cannot interrupt/u
    );
    await main(["upgrade", "--reset-sessions", "--config-root", configRoot, "--data-root", dataRoot]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
