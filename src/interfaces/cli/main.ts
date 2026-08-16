#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import * as path from "node:path";
import * as fsp from "node:fs/promises";
import { parseCliArgs, type CliOptions } from "../../../cli_application";
import { canonicalizeRootSet, resolveRootSet, type RootSet } from "../../../root_set";
import { loadLoopConfig, type LoopConfig } from "../../../runtime_config";
import { atomicWriteJson } from "../../../json_file_store";
import { SessionOwnership } from "../../../resilience";
import { composeApplication } from "../../composition/application";
import { createRunAggregate, deriveWorkflowRequirements } from "../../application/run-factory";
import { createDefaultDefinitionRegistries } from "../../definitions/default-registries";
import { loadDefinitionSource } from "../../definitions/definition-loader";
import { compileWorkflow } from "../../definitions/workflow-compiler";
import type { AgentRuntimeOverride } from "../../domain/agent";
import type { DefinitionSourceBundle, HumanGateResponse } from "../../domain/workflow";

const IMPLEMENTATION_VERSION = "4.0.0";
const SECRET_VALUES_ENV = "AGENT_LOOP_SECRET_VALUES";
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

function usage(): void {
  console.log(`Custom Agent Loop System ${IMPLEMENTATION_VERSION}

Usage:
  agent-loop init [--config-root <path>]
  agent-loop run --goal <text> --target <path> [--session <id>]
  agent-loop resume --session <id>
  agent-loop approve-plan --session <id> --choice-id <id>
  agent-loop revise-plan --session <id> --message <text>
  agent-loop cancel-plan --session <id>
  agent-loop set-access --session <id> --mode <ask|full_access>
  agent-loop stop --session <id>
  agent-loop interrupt --session <id> --message <text>
  agent-loop status --session <id> [--json]
  agent-loop models
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

function numberOption(options: CliOptions, name: string, fallback: number): number {
  const raw = options[name];
  if (!raw || raw === "true") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`--${name} must be a positive integer.`);
  }
  return value;
}

function listOption(options: CliOptions, name: string, fallback: number[]): number[] {
  const raw = options[name];
  if (!raw || raw === "true") return fallback;
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
  const ownership = new SessionOwnership({
    sessionDir: sessionDirectory,
    ownerLockFileName: config.paths.ownerLockFileName,
    leaseFileName: config.paths.leaseFileName,
    heartbeatIntervalMs: config.defaults.heartbeatIntervalMs,
    leaseTtlMs: config.defaults.leaseTtlMs,
  });
  await ownership.acquire();
  try {
    return await operation(composeApplication({
      dataRoot: roots.dataRoot,
      runId,
      config,
      secretValues: options.secretValues,
      onChildPid: (pid) => ownership.setChildPid(pid),
    }));
  } finally {
    await ownership.release();
  }
}

async function definitionSource(roots: RootSet): Promise<DefinitionSourceBundle> {
  try {
    return await loadDefinitionSource(roots.configRoot);
  } catch (configError) {
    if (path.resolve(roots.configRoot) === path.resolve(roots.codeRoot)) throw configError;
    try {
      return await loadDefinitionSource(roots.codeRoot);
    } catch {
      throw configError;
    }
  }
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
  console.log(
    [
      `Run: ${aggregate.runId}`,
      `Status: ${aggregate.execution.status}`,
      `Node: ${aggregate.execution.currentNodeId}`,
      `Activation: ${active?.activationId ?? "none"}`,
      `Workflow steps: ${aggregate.execution.workflowStepsConsumed}/${aggregate.definition.budgets.maxWorkflowSteps}`,
      `Cycles: ${aggregate.execution.cyclesStarted}/${aggregate.definition.budgets.maxCycles}`,
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
    },
    async (app) => {
      const initialized = await app.repository.initialize(initial);
      await app.projection.update(initialized);
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
  const aggregate = await withOwnedApplication(
    roots,
    runId,
    config,
    {
      secretValues: secrets,
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

async function respondToPlanGate(
  options: CliOptions,
  roots: RootSet,
  signal: "approved" | "revision_requested" | "cancelled"
): Promise<void> {
  const runId = requiredOption(options, "session");
  const config = await loadLoopConfig(roots.configRoot);
  const app = composeApplication({ dataRoot: roots.dataRoot, runId, config });
  const aggregate = await app.repository.load(runId);
  const pending = aggregate.pendingInput;
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
  const committed = await app.commands.respondToHumanGate(runId, response);
  printRunStatus(committed);
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
        { secretValues: secrets },
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
    console.log(JSON.stringify({
      schemaVersion: 1,
      runId: aggregate.runId,
      status: aggregate.execution.status,
      currentNodeId: aggregate.execution.currentNodeId,
      activeActivationId: aggregate.execution.activeActivationId,
      pendingInput: aggregate.pendingInput,
      reason: aggregate.execution.reason,
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
  console.log(JSON.stringify({
    kind: "agent-loop-capabilities",
    protocolVersion: 2,
    stateSchemaVersion: 1,
    implementationVersion: IMPLEMENTATION_VERSION,
    capabilities: [
      "compiled-workflow-bundle-v1",
      "agent-task-runner-v1",
      "structured-task-result-v1",
      "activation-checkpoint-v1",
      "human-gate-v1",
      "read-only-projection-v1",
      "cas-fencing-v1",
      "mutation-no-replay-v1",
    ],
    roots: {
      codeRoot: roots.codeRoot,
      configRoot: roots.configRoot,
      projectRoot: roots.projectRoot,
      dataRoot: roots.dataRoot,
    },
  }));
}

async function cmdModels(roots: RootSet): Promise<void> {
  const config = await loadLoopConfig(roots.configRoot);
  const availableModels = [...new Set(
    Object.values(config.providers)
      .filter((provider) => provider.enabled)
      .flatMap((provider) => provider.fallbackModels)
  )].sort();
  const indexPath = path.join(roots.dataRoot, config.paths.sessionsIndexFileName);
  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(await fsp.readFile(indexPath, "utf8")) as Record<string, unknown>;
  } catch {
    current = {};
  }
  await atomicWriteJson(indexPath, {
    version: 4,
    activeSessionIds: Array.isArray(current.activeSessionIds) ? current.activeSessionIds : [],
    sessionMetas: Array.isArray(current.sessionMetas) ? current.sessionMetas : [],
    availableModels,
    modelsDiscoveredAt: new Date().toISOString(),
    modelsDiscoveredCli: "configured-provider-fallbacks",
    manualModelsOverride: null,
    modelVariants: config.variantDefaults,
    providerCatalog: Object.fromEntries(
      Object.entries(config.providers).map(([id, provider]) => [id, {
        id,
        label: provider.label,
        adapter: provider.adapter,
        binary: provider.binary,
        enabled: provider.enabled,
        available: true,
        models: provider.fallbackModels,
        discoveredAt: new Date().toISOString(),
        error: null,
      }])
    ),
  });
  console.log(availableModels.join("\n"));
}

async function cmdInit(roots: RootSet): Promise<void> {
  await fsp.mkdir(roots.configRoot, { recursive: true });
  const files = [
    "agents.json",
    "agents.schema.json",
    "tasks.json",
    "tasks.schema.json",
    "workflow.json",
    "workflow.schema.json",
    "loop_config.json",
    "loop_config.schema.json",
  ];
  for (const fileName of files) {
    const source = path.join(roots.codeRoot, fileName);
    const destination = path.join(roots.configRoot, fileName);
    try {
      await fsp.copyFile(source, destination, (await import("node:fs")).constants.COPYFILE_EXCL);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  console.log(`Initialized v4 definitions at ${roots.configRoot}.`);
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    usage();
    return argv.length === 0 ? 1 : 0;
  }
  const command = argv[0];
  const options = parseCliArgs(argv.slice(1));
  const roots = await prepareRoots(options);
  const secrets = consumeSecretValues();
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
      await cmdModels(roots);
      return 0;
    default:
      console.error(`Unknown command: ${command}`);
      usage();
      return 1;
  }
}

if (require.main === module) {
  void main().then(
    (exitCode) => { process.exitCode = exitCode; },
    (error: unknown) => {
      console.error(`[fatal] ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  );
}
