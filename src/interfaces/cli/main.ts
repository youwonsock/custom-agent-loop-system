#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import * as path from "node:path";
import * as fsp from "node:fs/promises";
import { parseCliArgs, type CliOptions } from "./application";
import { canonicalizeRootSet, resolveRootSet, type RootSet } from "./root-set";
import { loadLoopConfig, type LoopConfig } from "../../config/runtime-config";
import { SessionOwnership } from "../../infrastructure/resilience";
import { initRunStorage } from "../../infrastructure/run-storage";
import { FileProjectLease } from "../../infrastructure/file-project-lease";
import { FileRunRepository } from "../../infrastructure/file-run-repository";
import { atomicWriteJson, renameWithRetry } from "../../infrastructure/json-file-store";
import {
  INIT_DEFINITION_FILES,
  createInitManifest,
  hashDefinitionFiles,
  initManifestPath,
  readInitManifest,
  readSessionIndexStrict,
  validatePackagedSchemaDocument,
  validateInitializedRoots,
} from "../../application/init-manifest";
import { assertJsonSchema, type JsonSchema } from "../../definitions/json-schema";
import type { JsonValue } from "../../domain/json";
import { createEmptySessionIndexProjection, validateSessionIndexProjectionV4 } from "../../interfaces/operator/contracts";
import { composeApplication } from "../../composition/application";
import { createRunAggregate, deriveWorkflowRequirements } from "../../application/run-factory";
import { createDefaultDefinitionRegistries } from "../../definitions/default-registries";
import { loadDefinitionSource } from "../../definitions/definition-loader";
import { compileWorkflow } from "../../definitions/workflow-compiler";
import type { AgentRuntimeOverride } from "../../domain/agent";
import type { DefinitionSourceBundle, HumanGateResponse } from "../../domain/workflow";
import { discoverAndMergeSessionIndex, discoverProviders } from "../../application/provider-discovery";
import { resolvePackagedConfigRoot } from "../../config/package-config-root";
import {
  CORE_CAPABILITIES,
  CORE_PROTOCOL_VERSION,
  CORE_STATE_SCHEMA_VERSION,
} from "../../protocol/protocol-contract";

const IMPLEMENTATION_VERSION = "8.0.0";
const SECRET_VALUES_ENV = "AGENT_LOOP_SECRET_VALUES";
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const UTILITY_PROCESS_ENV = "AGENT_LOOP_UTILITY_PROCESS";
const RUNNING_IN_UTILITY_PROCESS = process.env[UTILITY_PROCESS_ENV] === "1";

function usage(): void {
  console.log(`Agent Loop Orchestrator ${IMPLEMENTATION_VERSION}

Usage:
  agent-loop init [--config-root <path>]
  agent-loop run --goal <text> --target <path> [--session <id>]
  agent-loop resume --session <id>
  agent-loop approve-plan --session <id> --choice-id <id>
  agent-loop revise-plan --session <id> --message <text>
  agent-loop approve-verification --session <id> --request-id <id> --candidate-hash <hash>
  agent-loop reject-verification --session <id> --request-id <id> --candidate-hash <hash> --message <text>
  agent-loop cancel-plan --session <id>
  agent-loop set-access --session <id> --mode <ask|full_access>
  agent-loop stop --session <id>
  agent-loop interrupt --session <id> --message <text>
  agent-loop status --session <id> [--json]
  agent-loop models [--json]
  agent-loop capabilities

Common roots:
  --data-root <path>    Authoritative run data root
  --config-root <path>  Trusted agents/tasks/workflow configuration root
`);
}

function requiredOption(options: CliOptions, name: string): string {
  const value = options[name];
  if (!value || value === "true") throw new Error(`--${name} is required.`);
  return value;
}

function numberOption(options: CliOptions, name: string, defaultValue: number): number {
  const raw = options[name];
  if (!raw || raw === "true") return defaultValue;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`--${name} must be a positive integer.`);
  }
  return value;
}

function listOption(options: CliOptions, name: string, defaultValues: number[]): number[] {
  const raw = options[name];
  if (!raw || raw === "true") return defaultValues;
  const values = raw.split(",").map((part) => Number(part.trim()));
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error(`--${name} must contain non-negative integer delays.`);
  }
  return values;
}

function jsonStringRecord(value: string | undefined, name: string): Record<string, string> {
  if (!value || value === "true") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`--${name} must be a JSON object.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`--${name} must be a JSON object.`);
  }
  const result: Record<string, string> = {};
  for (const [key, child] of Object.entries(parsed)) {
    if (typeof child === "string" && child.trim()) result[key] = child;
  }
  return result;
}

function consumeSecretValues(): Record<string, string> {
  const raw = process.env[SECRET_VALUES_ENV];
  delete process.env[SECRET_VALUES_ENV];
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${SECRET_VALUES_ENV} must contain a JSON object.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${SECRET_VALUES_ENV} must contain a JSON object.`);
  }
  return Object.fromEntries(
    Object.entries(parsed).filter((entry): entry is [string, string] =>
      typeof entry[1] === "string"
    )
  );
}

async function prepareRoots(options: CliOptions): Promise<RootSet> {
  return canonicalizeRootSet(resolveRootSet(options));
}

async function assertDataRootOutsideTarget(dataRoot: string, target: string): Promise<void> {
  await fsp.mkdir(dataRoot, { recursive: true });
  const [canonicalData, canonicalTarget] = await Promise.all([
    fsp.realpath(dataRoot),
    fsp.realpath(target),
  ]);
  const relative = path.relative(canonicalTarget, canonicalData);
  if (!relative || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    throw new Error(
      `Agent Loop data root must be outside the provider target: ${canonicalData}.`
    );
  }
}

async function withOwnedApplication<T>(
  roots: RootSet,
  runId: string,
  config: LoopConfig,
  options: {
    secretValues?: Readonly<Record<string, string>>;
    projectRoots?: ReadonlyArray<string>;
  },
  operation: (app: ReturnType<typeof composeApplication>) => Promise<T>
): Promise<T> {
  if (!SAFE_ID.test(runId)) throw new Error(`Unsafe run id: ${runId}.`);
  const runsRoot = path.resolve(roots.dataRoot, config.paths.sessionsRoot);
  const sessionDirectory = path.resolve(runsRoot, runId);
  const relative = path.relative(runsRoot, sessionDirectory);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Run path escapes the configured data root: ${runId}.`);
  }
  await initRunStorage(roots.dataRoot, runId, config);
  const ownership = new SessionOwnership({
    sessionDir: sessionDirectory,
    ownerLockFileName: config.paths.ownerLockFileName,
    leaseFileName: config.paths.leaseFileName,
    heartbeatIntervalMs: config.defaults.heartbeatIntervalMs,
    leaseTtlMs: config.defaults.leaseTtlMs,
  });
  await ownership.acquire();
  const projectLease = new FileProjectLease();
  let lease: Awaited<ReturnType<FileProjectLease["acquire"]>> | null = null;
  let leaseMonitor: NodeJS.Timeout | null = null;
  let leaseLoss: Error | null = null;
  let leaseStopRequested = false;
  let value!: T;
  let operationError: unknown;
  const releaseErrors: unknown[] = [];
  try {
    if (options.projectRoots && options.projectRoots.length > 0) {
      lease = await projectLease.acquire(
        options.projectRoots,
        `${process.pid}:${runId}`,
        config.defaults.leaseTtlMs
      );
    }
    const app = composeApplication({
      dataRoot: roots.dataRoot,
      runId,
      config,
      secretValues: options.secretValues,
      onChildPid: (pid) => ownership.setChildPid(pid),
    });
    if (lease?.assertOwned) {
      const checkLease = (): void => {
        if (!lease || leaseLoss) return;
        void lease.assertOwned!().catch(async (error) => {
          leaseLoss ??= error instanceof Error ? error : new Error(String(error));
          if (leaseStopRequested) return;
          leaseStopRequested = true;
          try {
            // A lost project lease is a safety boundary.  Queue STOP through
            // the durable control channel so an active provider/verification
            // process is cleaned up by the owning runner before this process
            // releases its session ownership.
            await app.commands.requestControl(
              runId,
              `lease_loss_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`,
              "stop",
              "Project lease ownership was lost; stopping the run."
            );
          } catch (stopError) {
            leaseLoss = new AggregateError(
              [leaseLoss, stopError],
              "Project lease was lost and the safety stop could not be queued."
            );
          }
        });
      };
      leaseMonitor = setInterval(checkLease, Math.max(100, Math.min(5_000, Math.floor(config.defaults.leaseTtlMs / 3))));
      leaseMonitor.unref();
    }
    value = await operation(app);
    if (lease?.assertOwned) {
      try { await lease.assertOwned(); }
      catch (error) { leaseLoss ??= error instanceof Error ? error : new Error(String(error)); }
    }
    if (leaseLoss) throw leaseLoss;
  } catch (error) {
    operationError = error;
  } finally {
    if (leaseMonitor) {
      clearInterval(leaseMonitor);
      leaseMonitor = null;
    }
  }
  try {
    await lease?.release();
  } catch (error) {
    releaseErrors.push(error);
  }
  try {
    await ownership.release();
  } catch (error) {
    releaseErrors.push(error);
  }
  if (operationError !== undefined && releaseErrors.length > 0) {
    throw new AggregateError([operationError, ...releaseErrors], `Run operation and resource release failed for ${runId}.`);
  }
  if (operationError !== undefined) throw operationError;
  if (releaseErrors.length === 1) throw releaseErrors[0];
  if (releaseErrors.length > 1) throw new AggregateError(releaseErrors, `Resource release failed for ${runId}.`);
  return value;
}

async function savedProjectRoots(
  roots: RootSet,
  config: LoopConfig,
  runId: string
): Promise<string[]> {
  const runsRoot = path.resolve(roots.dataRoot, config.paths.sessionsRoot);
  const repository = new FileRunRepository({ runsRoot });
  const aggregate = await repository.load(runId);
  const pendingContext = aggregate.pendingInput?.context &&
    typeof aggregate.pendingInput.context === "object" &&
    !Array.isArray(aggregate.pendingInput.context)
    ? aggregate.pendingInput.context as Record<string, unknown>
    : null;
  // An access approval can add a write root in the same response that resumes
  // the run. Include the requested roots in the lease before applying that
  // response, otherwise the provider could start while only the original
  // project root is protected.
  const requestedPaths = Array.isArray(pendingContext?.requestedPaths)
    ? pendingContext.requestedPaths.filter((value): value is string =>
        typeof value === "string" &&
        (path.isAbsolute(value) || path.win32.isAbsolute(value) || path.posix.isAbsolute(value))
      )
    : [];
  return [
    aggregate.context.targetProjectPath,
    ...aggregate.context.additionalAllowedPaths,
    ...requestedPaths,
  ];
}

async function definitionSource(roots: RootSet): Promise<DefinitionSourceBundle> {
  return loadDefinitionSource(roots.configRoot);
}

function runtimeOverrides(options: CliOptions): Record<string, AgentRuntimeOverride> {
  const models = jsonStringRecord(options["model-mapping"], "model-mapping");
  const providers = jsonStringRecord(options["provider-mapping"], "provider-mapping");
  const modelFlags: Record<string, string> = {
    planner: "planner-model",
    implementer: "implementer-model",
    tester: "tester-model",
    qa_lead: "qa-model",
    master: "master-model",
    interrupter: "interrupter-model",
  };
  const variantFlags: Record<string, string> = {
    planner: "planner-variant",
    implementer: "implementer-variant",
    tester: "tester-variant",
    qa_lead: "qa-variant",
    master: "master-variant",
    interrupter: "interrupter-variant",
  };
  const agentIds = new Set([
    ...Object.keys(models),
    ...Object.keys(providers),
    ...Object.keys(modelFlags),
  ]);
  const overrides: Record<string, AgentRuntimeOverride> = {};
  for (const agentId of agentIds) {
    const modelFlag = modelFlags[agentId];
    const variantFlag = variantFlags[agentId];
    const model = modelFlag && options[modelFlag] !== "true"
      ? options[modelFlag]
      : models[agentId];
    const variant = variantFlag && options[variantFlag] !== "true"
      ? options[variantFlag]
      : undefined;
    const provider = providers[agentId];
    if (model || provider || variant) overrides[agentId] = { model, provider, variant };
  }
  return overrides;
}

function applyRunOverrides(
  source: DefinitionSourceBundle,
  config: LoopConfig,
  options: CliOptions
): void {
  source.workflow.budgets.maxCycles = numberOption(
    options,
    "max-cycles",
    source.workflow.budgets.maxCycles
  );
  source.workflow.budgets.maxWorkflowSteps = numberOption(
    options,
    "max-workflow-steps",
    source.workflow.budgets.maxWorkflowSteps
  );
  const maxAttempts = numberOption(
    options,
    "max-agent-attempts",
    config.defaults.maxAgentAttempts
  );
  const backoff = listOption(
    options,
    "retry-backoff",
    config.defaults.retryBackoffMs
  );
  for (const task of source.tasks.tasks) {
    task.retryPolicy.maxAttempts = Math.min(task.retryPolicy.maxAttempts, maxAttempts);
    task.retryPolicy.backoffMs = backoff.slice(0, Math.max(0, task.retryPolicy.maxAttempts - 1));
  }
  config.defaults.phaseTimeoutMs = numberOption(
    options,
    "phase-timeout",
    config.defaults.phaseTimeoutMs
  );
  config.defaults.idleTimeoutMs = numberOption(
    options,
    "idle-timeout",
    config.defaults.idleTimeoutMs
  );
  config.defaults.toolTimeoutMs = numberOption(
    options,
    "tool-timeout",
    config.defaults.toolTimeoutMs
  );
  config.defaults.transportTimeoutMs = numberOption(
    options,
    "transport-timeout",
    config.defaults.transportTimeoutMs
  );
  config.defaults.terminationGraceMs = numberOption(
    options,
    "termination-grace",
    config.defaults.terminationGraceMs
  );
  config.defaults.killTimeoutMs = numberOption(
    options,
    "kill-timeout",
    config.defaults.killTimeoutMs
  );
  config.defaults.maxInMemoryOutputBytes = numberOption(
    options,
    "max-output-bytes",
    config.defaults.maxInMemoryOutputBytes
  );
  config.defaults.heartbeatIntervalMs = numberOption(
    options,
    "heartbeat-interval",
    config.defaults.heartbeatIntervalMs
  );
  config.defaults.leaseTtlMs = numberOption(
    options,
    "lease-ttl",
    config.defaults.leaseTtlMs
  );
  if (config.defaults.heartbeatIntervalMs >= config.defaults.leaseTtlMs) {
    throw new Error("--heartbeat-interval must be lower than --lease-ttl.");
  }
  const profile = options.profile && options.profile !== "true" ? options.profile : null;
  const binary = options.binary && options.binary !== "true" ? options.binary : null;
  if (profile && binary && config.providers[profile]) config.providers[profile].binary = binary;
}

function printRunStatus(aggregate: Awaited<ReturnType<ReturnType<typeof composeApplication>["repository"]["load"]>>): void {
  const active = aggregate.execution.activeActivationId
    ? aggregate.nodeExecutions[aggregate.execution.activeActivationId]
    : null;
  const verificationId = active && aggregate.definition.nodes[active.nodeId]?.kind === "verification"
    ? `${active.activationId}_verification`
    : aggregate.context.verificationProof?.verificationId ??
      aggregate.context.verificationRecords[aggregate.context.verificationRecords.length - 1]?.verificationId ??
      null;
  const verificationRecords = verificationId
    ? aggregate.context.verificationRecords.filter((record) => record.verificationId === verificationId)
    : [];
  console.log(
    [
      `Run: ${aggregate.runId}`,
      `Status: ${aggregate.execution.status}`,
      `Node: ${aggregate.execution.currentNodeId}`,
      `Activation: ${active?.activationId ?? "none"}`,
      `Workflow steps: ${aggregate.execution.workflowStepsConsumed}/${aggregate.definition.budgets.maxWorkflowSteps}`,
      `Cycles: ${aggregate.execution.cyclesStarted}/${aggregate.definition.budgets.maxCycles}`,
      ...(aggregate.context.verificationContract
        ? [`Verification: revision ${aggregate.context.verificationContract.revision}, ` +
            `${verificationRecords.filter((record) => record.status === "completed").length}/` +
            `${aggregate.context.verificationContract.commands.length} commands`]
        : []),
      ...(aggregate.context.verificationInvalidationReason
        ? [`Verification reason: ${aggregate.context.verificationInvalidationReason}`]
        : []),
      ...(aggregate.execution.reason ? [`Reason: ${aggregate.execution.reason}`] : []),
    ].join("\n")
  );
}

async function cmdRun(options: CliOptions, roots: RootSet, secrets: Record<string, string>): Promise<void> {
  const goal = requiredOption(options, "goal");
  const target = path.resolve(requiredOption(options, "target"));
  await assertDataRootOutsideTarget(roots.dataRoot, target);
  const runId = options.session && options.session !== "true"
    ? options.session
    : `run_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
  if (!SAFE_ID.test(runId)) throw new Error(`Unsafe run id: ${runId}.`);
  const config = JSON.parse(JSON.stringify(await loadLoopConfig(roots.configRoot))) as LoopConfig;
  const source = structuredClone(await definitionSource(roots));
  applyRunOverrides(source, config, options);
  const definition = compileWorkflow(
    source,
    createDefaultDefinitionRegistries(),
    { runtimeOverrides: runtimeOverrides(options) }
  );
  const initial = createRunAggregate({
    runId,
    definition,
    goal,
    requirements: deriveWorkflowRequirements(goal),
    targetProjectPath: target,
    accessMode: options["full-access"] === "true" ? "full_access" : "ask",
  });
  const result = await withOwnedApplication(
    roots,
    runId,
    config,
    {
      secretValues: secrets,
      projectRoots: [target],
    },
    async (app) => {
      const committed = await app.repository.init(initial);
      await app.projection.update(committed);
      await app.repository.acquireFencingEpoch(runId);
      return app.runner.runUntilBoundary(runId);
    }
  );
  printRunStatus(result);
}

async function cmdResume(options: CliOptions, roots: RootSet, secrets: Record<string, string>): Promise<void> {
  const runId = requiredOption(options, "session");
  const config = JSON.parse(JSON.stringify(await loadLoopConfig(roots.configRoot))) as LoopConfig;
  applyRunOverrides(
    structuredClone(await definitionSource(roots)),
    config,
    options
  );
  const projectRoots = await savedProjectRoots(roots, config, runId);
  const aggregate = await withOwnedApplication(
    roots,
    runId,
    config,
    {
      secretValues: secrets,
      projectRoots,
    },
    async (app) => {
      let current = await app.repository.load(runId);
      if (current.execution.status === "SUCCESS") return current;
      if (current.execution.status === "WAITING_USER") {
        const pending = current.pendingInput;
        const approveAccess =
          options["approve-access"] === "true" || options["full-access"] === "true";
        if (!pending || pending.kind !== "access_approval" || !approveAccess) {
          return current;
        }
        current = await app.commands.respondToHumanGate(runId, {
          requestId: pending.requestId,
          nodeId: pending.nodeId,
          signal: options["full-access"] === "true" ? "full_access" : "retry",
          respondedAt: new Date().toISOString(),
        });
      }
      if (
        options["full-access"] === "true" &&
        current.context.accessMode !== "full_access"
      ) {
        current = await app.commands.setAccessMode(
          runId,
          `access_mode_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`,
          "full_access"
        );
      }
      if (current.execution.status === "BLOCKED") {
        throw new Error(
          current.execution.reason ?? "Blocked runs require operator reconciliation and are not replayed."
        );
      }
      if (["PAUSED", "STOPPED", "FAILED"].includes(current.execution.status)) {
        current = await app.commands.resumeRun(
          runId,
          `resume_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`,
          "Operator resumed the run."
        );
      }
      current = await app.recovery.recoverAfterOwnershipChange(runId);
      return current.execution.status === "RUNNING"
        ? app.runner.runUntilBoundary(runId)
        : current;
    }
  );
  printRunStatus(aggregate);
}

async function cmdVerificationDecision(
  options: CliOptions,
  roots: RootSet,
  secrets: Record<string, string>,
  approved: boolean
): Promise<void> {
  const runId = requiredOption(options, "session");
  const requestId = requiredOption(options, "request-id");
  const candidateHash = requiredOption(options, "candidate-hash");
  const config = await loadLoopConfig(roots.configRoot);
  const projectRoots = await savedProjectRoots(roots, config, runId);
  const current = await withOwnedApplication(
    roots,
    runId,
    config,
    { secretValues: secrets, projectRoots },
    async (app) => {
      // Re-acquire the run fencing epoch before applying an approval.  This
      // makes a CLI process that was started while another owner was active
      // observe/reconcile stale activations before it can commit a decision.
      await app.recovery.recoverAfterOwnershipChange(runId);
      const aggregate = approved
        ? await app.commands.approveVerification(runId, requestId, candidateHash)
        : await app.commands.rejectVerification(
            runId,
            requestId,
            candidateHash,
            requiredOption(options, "message")
          );
      return aggregate.execution.status === "RUNNING"
        ? app.runner.runUntilBoundary(runId)
        : aggregate;
    }
  );
  printRunStatus(current);
}

async function respondToPlanGate(
  options: CliOptions,
  roots: RootSet,
  signal: "approved" | "revision_requested" | "cancelled"
): Promise<void> {
  const runId = requiredOption(options, "session");
  const config = await loadLoopConfig(roots.configRoot);
  const projectRoots = await savedProjectRoots(roots, config, runId);
  const aggregate = await withOwnedApplication(
    roots,
    runId,
    config,
    { projectRoots },
    async (app) => {
      // Plan approval captures the initial verification baseline in the same
      // CAS operation as the human response. Refresh the fencing epoch first
      // so that capture is performed by the current session/project owner.
      await app.recovery.recoverAfterOwnershipChange(runId);
      const current = await app.repository.load(runId);
      const pending = current.pendingInput;
      if (!pending || pending.kind !== "plan_approval") {
        throw new Error(`Run ${runId} has no pending plan approval gate.`);
      }
      const response: HumanGateResponse = {
        requestId: pending.requestId,
        nodeId: pending.nodeId,
        signal,
        ...(signal === "approved" ? { choiceId: requiredOption(options, "choice-id") } : {}),
        ...(options.message && options.message !== "true" ? { value: options.message } : {}),
        respondedAt: new Date().toISOString(),
      };
      return app.commands.respondToHumanGate(runId, response);
    }
  );
  printRunStatus(aggregate);
}

async function cmdRevisePlan(
  options: CliOptions,
  roots: RootSet,
  secrets: Record<string, string>
): Promise<void> {
  requiredOption(options, "message");
  await respondToPlanGate(options, roots, "revision_requested");
  await cmdResume(options, roots, secrets);
}

async function cmdStop(options: CliOptions, roots: RootSet): Promise<void> {
  const runId = requiredOption(options, "session");
  const config = await loadLoopConfig(roots.configRoot);
  const app = composeApplication({ dataRoot: roots.dataRoot, runId, config });
  const result = await app.commands.requestControl(
    runId,
    `stop_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`,
    "stop",
    options.message && options.message !== "true" ? options.message : "Operator stopped the run."
  );
  if (result.queuedRequestId) {
    console.log(`Stop command queued: ${result.queuedRequestId}`);
  }
  printRunStatus(result.aggregate);
}

async function cmdSetAccess(options: CliOptions, roots: RootSet): Promise<void> {
  const runId = requiredOption(options, "session");
  const mode = requiredOption(options, "mode");
  if (mode !== "ask" && mode !== "full_access") {
    throw new Error("--mode must be ask or full_access.");
  }
  const config = await loadLoopConfig(roots.configRoot);
  const app = composeApplication({ dataRoot: roots.dataRoot, runId, config });
  const aggregate = await app.repository.load(runId);
  if (aggregate.execution.status === "RUNNING") {
    throw new Error("Access mode cannot change while a provider may be running.");
  }
  const committed = await app.commands.setAccessMode(
    runId,
    `access_mode_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`,
    mode
  );
  printRunStatus(committed);
}

async function cmdInterrupt(
  options: CliOptions,
  roots: RootSet,
  secrets: Record<string, string>
): Promise<void> {
  const runId = requiredOption(options, "session");
  const config = await loadLoopConfig(roots.configRoot);
  const app = composeApplication({ dataRoot: roots.dataRoot, runId, config });
  const result = await app.commands.requestControl(
    runId,
    `interrupt_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`,
    "interrupt",
    requiredOption(options, "message")
  );
  if (result.queuedRequestId) {
    console.log(`Interrupt command queued: ${result.queuedRequestId}`);
    printRunStatus(result.aggregate);
    return;
  }
  const completed = result.aggregate.execution.status === "RUNNING"
    ? await withOwnedApplication(
        roots,
        runId,
        config,
        { secretValues: secrets, projectRoots: await savedProjectRoots(roots, config, runId) },
        async (owned) => {
          await owned.repository.acquireFencingEpoch(runId);
          return owned.runner.runUntilBoundary(runId);
        }
      )
    : result.aggregate;
  printRunStatus(completed);
}

async function cmdStatus(options: CliOptions, roots: RootSet): Promise<void> {
  const runId = requiredOption(options, "session");
  const config = await loadLoopConfig(roots.configRoot);
  const app = composeApplication({ dataRoot: roots.dataRoot, runId, config });
  const aggregate = await app.repository.load(runId);
  if (options.json === "true") {
    const active = aggregate.execution.activeActivationId
      ? aggregate.nodeExecutions[aggregate.execution.activeActivationId]
      : null;
    const verificationId = active && aggregate.definition.nodes[active.nodeId]?.kind === "verification"
      ? `${active.activationId}_verification`
      : aggregate.context.verificationProof?.verificationId ??
        aggregate.context.verificationRecords[aggregate.context.verificationRecords.length - 1]?.verificationId ??
        null;
    const verificationRecords = verificationId
      ? aggregate.context.verificationRecords.filter((record) => record.verificationId === verificationId)
      : [];
    const contract = aggregate.context.verificationContract;
    console.log(JSON.stringify({
      schemaVersion: 1,
      runId: aggregate.runId,
      status: aggregate.execution.status,
      currentNodeId: aggregate.execution.currentNodeId,
      activeActivationId: aggregate.execution.activeActivationId,
      pendingInput: aggregate.pendingInput,
      reason: aggregate.execution.reason,
      verification: {
        contract: contract ? {
          revision: contract.revision,
          contractHash: contract.contractHash,
          commands: contract.commands,
          totalTimeoutMs: contract.totalTimeoutMs,
          protectedPaths: contract.protectedPaths,
          testRoots: contract.testRoots,
          allowedNewTestRoots: contract.allowedNewTestRoots,
          generatedOutputPaths: contract.generatedOutputPaths,
          baselineArtifactId: contract.baselineArtifactId,
          baselineFingerprint: contract.baselineFingerprint,
        } : null,
        elapsedMs: aggregate.context.verificationElapsedMs,
        contractRevision: contract?.revision ?? null,
        contractHash: contract?.contractHash ?? null,
        currentVerificationId: verificationId,
        proofId: aggregate.context.verificationProof?.proofId ?? null,
        proofValid: Boolean(aggregate.context.verificationProof?.passed && !aggregate.context.verificationInvalidationReason),
        pendingApproval: aggregate.context.verificationCandidate,
        criteriaChanges: aggregate.context.verificationCriteriaChanges ?? [],
        invalidationReason: aggregate.context.verificationInvalidationReason,
        commands: verificationRecords.map((record) => ({
          verificationId: record.verificationId,
          commandId: record.commandId,
          status: record.status,
          exitCode: record.exitCode,
          signal: record.signal,
          timedOut: record.timedOut,
          processTreeClean: record.processTreeClean,
          summary: record.summary.slice(0, 8_000),
        })),
      },
      revision: aggregate.revision,
      fencingEpoch: aggregate.fencingEpoch,
      budgets: {
        workflowSteps: {
          consumed: aggregate.execution.workflowStepsConsumed,
          limit: aggregate.definition.budgets.maxWorkflowSteps,
        },
        cycles: {
          consumed: aggregate.execution.cyclesStarted,
          limit: aggregate.definition.budgets.maxCycles,
        },
      },
    }, null, 2));
  } else {
    printRunStatus(aggregate);
  }
}

async function cmdCapabilities(roots: RootSet): Promise<void> {
  // Capabilities remain available before initialization, but once a commit
  // manifest exists this command also validates the persisted configuration so
  // desktop startup cannot mistake a damaged initialized profile for a ready
  // core. The check is read-only and does not synthesize any files.
  if (await readInitManifest(roots.configRoot)) await loadLoopConfig(roots.configRoot);
  console.log(JSON.stringify({
    kind: "agent-loop-capabilities",
    protocolVersion: CORE_PROTOCOL_VERSION,
    stateSchemaVersion: CORE_STATE_SCHEMA_VERSION,
    implementationVersion: IMPLEMENTATION_VERSION,
    capabilities: [...CORE_CAPABILITIES],
    roots: {
      codeRoot: roots.codeRoot,
      configRoot: roots.configRoot,
      projectRoot: roots.projectRoot,
      dataRoot: roots.dataRoot,
    },
  }));
}

async function cmdModels(options: CliOptions, roots: RootSet): Promise<void> {
  const config = await loadLoopConfig(roots.configRoot);
  const indexPath = path.join(roots.dataRoot, config.paths.sessionsIndexFileName);
  const discoveries = await discoverProviders(config.providers);
  const index = await discoverAndMergeSessionIndex(
    indexPath,
    path.join(roots.dataRoot, config.paths.registryLockFileName),
    discoveries,
    config.variantDefaults
  );
  if (options.json === "true") {
    console.log(JSON.stringify({ schemaVersion: 2, discoveredAt: index.modelsDiscoveredAt, providers: discoveries, models: index.availableModels }, null, 2));
    return;
  }
  console.log(index.availableModels.join("\n"));
}

async function cmdInit(roots: RootSet): Promise<void> {
  const existingManifest = await readInitManifest(roots.configRoot);
  if (existingManifest) {
    // A structurally valid manifest is not enough to claim a committed
    // installation. Verify its digest, copied definitions, and authoritative
    // v4 index before returning the idempotency error; a tampered or partial
    // profile must fail closed instead of being treated as initialized.
    const configured = await loadLoopConfig(roots.configRoot);
    await validateInitializedRoots(roots, IMPLEMENTATION_VERSION, configured.paths.sessionsIndexFileName);
    throw new Error(`ALREADY_INITIALIZED: Agent Loop is already initialized at ${roots.configRoot}.`);
  }

  // Validate every packaged document before changing user-owned state. Both
  // the schema documents and the definition payloads are held in memory for
  // this pass; no destination file is touched until every check succeeds.
  const packagedConfigRoot = resolvePackagedConfigRoot(roots.codeRoot);
  const packagedSource = await loadDefinitionSource(packagedConfigRoot);
  const packagedDocuments = new Map<string, unknown>();
  for (const fileName of INIT_DEFINITION_FILES) {
    const source = path.join(packagedConfigRoot, fileName);
    const stat = await fsp.stat(source);
    if (!stat.isFile()) throw new Error(`Packaged definition is not a file: ${source}`);
    let parsed: unknown;
    try { parsed = JSON.parse(await fsp.readFile(source, "utf8")) as unknown; }
    catch (error) {
      if (error instanceof SyntaxError) throw new Error(`Packaged definition is not valid JSON: ${source}`);
      throw error;
    }
    packagedDocuments.set(fileName, parsed);
  }
  const schemaFiles = new Map<string, JsonSchema>();
  for (const fileName of ["agents.schema.json", "tasks.schema.json", "workflow.schema.json", "loop_config.schema.json"] as const) {
    schemaFiles.set(fileName, validatePackagedSchemaDocument(packagedDocuments.get(fileName), fileName));
  }
  assertJsonSchema(packagedSource.agents as unknown as JsonValue, schemaFiles.get("agents.schema.json")!, "agents.json");
  assertJsonSchema(packagedSource.tasks as unknown as JsonValue, schemaFiles.get("tasks.schema.json")!, "tasks.json");
  assertJsonSchema(packagedSource.workflow as unknown as JsonValue, schemaFiles.get("workflow.schema.json")!, "workflow.json");
  assertJsonSchema(packagedDocuments.get("loop_config.json") as JsonValue, schemaFiles.get("loop_config.schema.json")!, "loop_config.json");
  compileWorkflow(packagedSource, createDefaultDefinitionRegistries());
  const packagedHash = await hashDefinitionFiles(packagedConfigRoot);
  const packagedConfig = await loadLoopConfig(packagedConfigRoot);
  const indexPath = path.join(roots.dataRoot, packagedConfig.paths.sessionsIndexFileName);

  await fsp.mkdir(roots.configRoot, { recursive: true });
  await fsp.mkdir(roots.dataRoot, { recursive: true });
  // A pre-existing data index is authoritative user state and is preserved;
  // only a partially present config definition set is considered an unsafe
  // initialization attempt.
  const existingIndex = await readSessionIndexStrict(indexPath);
  if (existingIndex) validateSessionIndexProjectionV4(existingIndex);
  const destinations = INIT_DEFINITION_FILES.map((fileName) => path.join(roots.configRoot, fileName));
  for (const destination of destinations) {
    try {
      await fsp.lstat(destination);
      throw new Error(`PARTIAL_INITIALIZATION: refusing to overwrite existing path ${destination}.`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  const temporaryFiles: string[] = [];
  const removeTemporaryFiles = async (): Promise<void> => {
    const failures: unknown[] = [];
    await Promise.all(temporaryFiles.map(async (filePath) => {
      try { await fsp.rm(filePath, { force: true }); }
      catch (error) { failures.push(error); }
    }));
    if (failures.length > 0) throw new AggregateError(failures, "Initialization temporary-file cleanup failed.");
  };
  try {
    for (const fileName of INIT_DEFINITION_FILES) {
      const source = path.join(packagedConfigRoot, fileName);
      const destination = path.join(roots.configRoot, fileName);
      const temporary = `${destination}.tmp.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}`;
      temporaryFiles.push(temporary);
      await fsp.copyFile(source, temporary);
      await renameWithRetry(temporary, destination);
      temporaryFiles.splice(temporaryFiles.indexOf(temporary), 1);
    }
    if (!existingIndex) await atomicWriteJson(indexPath, createEmptySessionIndexProjection());
    await atomicWriteJson(
      initManifestPath(roots.configRoot),
      createInitManifest(IMPLEMENTATION_VERSION, packagedHash)
    );
  } catch (error) {
    try { await removeTemporaryFiles(); }
    catch (releaseError) { throw new AggregateError([error, releaseError], "Initialization failed and temporary-file cleanup also failed."); }
    throw error;
  }
  console.log(`Initialized Agent Loop definitions at ${roots.configRoot}.`);
}

async function assertInitialized(roots: RootSet): Promise<void> {
  const configured = await loadLoopConfig(roots.configRoot);
  await validateInitializedRoots(roots, IMPLEMENTATION_VERSION, configured.paths.sessionsIndexFileName);
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    usage();
    return argv.length === 0 ? 1 : 0;
  }
  const command = argv[0];
  const options = parseCliArgs(argv.slice(1));
  const roots = await prepareRoots(options);
  if (command !== "init" && command !== "capabilities") await assertInitialized(roots);
  const secrets = command === "run" || command === "resume" || command === "revise-plan" || command === "interrupt"
    ? consumeSecretValues()
    : {};
  switch (command) {
    case "init":
      await cmdInit(roots);
      return 0;
    case "run":
      await cmdRun(options, roots, secrets);
      return 0;
    case "resume":
      await cmdResume(options, roots, secrets);
      return 0;
    case "approve-plan":
      await respondToPlanGate(options, roots, "approved");
      return 0;
    case "revise-plan":
      await cmdRevisePlan(options, roots, secrets);
      return 0;
    case "approve-verification":
      await cmdVerificationDecision(options, roots, secrets, true);
      return 0;
    case "reject-verification":
      await cmdVerificationDecision(options, roots, secrets, false);
      return 0;
    case "cancel-plan":
      await respondToPlanGate(options, roots, "cancelled");
      return 0;
    case "set-access":
      await cmdSetAccess(options, roots);
      return 0;
    case "stop":
      await cmdStop(options, roots);
      return 0;
    case "interrupt":
      await cmdInterrupt(options, roots, secrets);
      return 0;
    case "status":
      await cmdStatus(options, roots);
      return 0;
    case "capabilities":
      await cmdCapabilities(roots);
      return 0;
    case "models":
      await cmdModels(options, roots);
      return 0;
    default:
      console.error(`Unknown command: ${command}`);
      usage();
      return 1;
  }
}

if (require.main === module) {
  void main().then(
    (exitCode) => {
      process.exitCode = exitCode;
      // Electron utilityProcess keeps its message loop alive after the CLI
      // promise resolves. Exit on the next turn so stdout/stderr can flush,
      // while ordinary Node CLI invocations retain their normal semantics.
      if (RUNNING_IN_UTILITY_PROCESS) setImmediate(() => process.exit(exitCode));
    },
    (error: unknown) => {
      console.error(`[fatal] ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
      if (RUNNING_IN_UTILITY_PROCESS) setImmediate(() => process.exit(1));
    }
  );
}
