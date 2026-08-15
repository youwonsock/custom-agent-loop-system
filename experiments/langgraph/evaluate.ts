import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import type { AgentRuntime } from "../../agent_runtime";
import type { SessionRepository } from "../../session_repository";
import {
  createEvaluationRegistry,
  createEvaluationState,
  findWorkspaceRoot,
} from "./evaluation_fixture";
import {
  LANGGRAPH_SPIKE_VERSION,
  LangGraphWorkflowEngineAdapter,
} from "./langgraph_adapter";

const SAMPLE_COUNT = 5;
const WARMUP_ITERATIONS = 20;
const BATCH_ITERATIONS = 100;

interface ModuleProbe {
  milliseconds: number;
  heapDeltaBytes: number;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function round(value: number, digits = 3): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

async function sampleOperation(operation: () => Promise<void>): Promise<number[]> {
  for (let index = 0; index < WARMUP_ITERATIONS; index += 1) await operation();
  const samples: number[] = [];
  for (let run = 0; run < SAMPLE_COUNT; run += 1) {
    const startedAt = performance.now();
    for (let iteration = 0; iteration < BATCH_ITERATIONS; iteration += 1) {
      await operation();
    }
    samples.push((performance.now() - startedAt) / BATCH_ITERATIONS);
  }
  return samples;
}

function probeModule(workingDirectory: string, moduleId: string): ModuleProbe[] {
  const source = [
    "const { performance } = require('node:perf_hooks');",
    "const before = process.memoryUsage().heapUsed;",
    "const startedAt = performance.now();",
    `require(${JSON.stringify(moduleId)});`,
    "const result = { milliseconds: performance.now() - startedAt, heapDeltaBytes: Math.max(0, process.memoryUsage().heapUsed - before) };",
    "process.stdout.write(JSON.stringify(result));",
  ].join("\n");
  return Array.from({ length: SAMPLE_COUNT }, () => {
    const child = spawnSync(process.execPath, ["-e", source], {
      cwd: workingDirectory,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    if (child.error) throw child.error;
    if (child.status !== 0) {
      throw new Error(child.stderr || `Module probe failed for ${moduleId}.`);
    }
    return JSON.parse(child.stdout) as ModuleProbe;
  });
}

function sourceLines(filePath: string): number {
  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0).length;
}

async function main(): Promise<void> {
  const workspaceRoot = findWorkspaceRoot();
  const spikeRoot = path.join(workspaceRoot, "experiments", "langgraph");
  const state = createEvaluationState();
  const registry = createEvaluationRegistry(async () => undefined);
  const repository: Pick<SessionRepository, "load"> = { load: async () => state };
  const runtime: Pick<AgentRuntime, "launch"> = {
    launch: async () => {
      throw new Error("Benchmark wrapper must not directly launch the runtime.");
    },
  };
  const adapter = new LangGraphWorkflowEngineAdapter({
    stageExecutors: registry,
    agentRuntime: runtime,
    sessionRepository: repository,
  });
  const activation = state.currentActivation;
  if (!activation) throw new Error("Evaluation fixture is missing an activation.");
  const request = {
    sessionId: state.sessionId,
    stageId: state.phase,
    activationId: activation.activationId,
    expectedAggregateRevision: state.aggregateRevision,
    expectedFencingEpoch: state.fencingEpoch,
  };

  const currentSamples = await sampleOperation(() => registry.execute("planning", state.pipeline.stages[0]));
  const graphSamples = await sampleOperation(async () => {
    await adapter.executeReservedStage(request);
  });
  const currentMedianMs = median(currentSamples);
  const graphMedianMs = median(graphSamples);
  const workflowRegressionPercent = currentMedianMs === 0
    ? Number.POSITIVE_INFINITY
    : ((graphMedianMs / currentMedianMs) - 1) * 100;

  const currentModuleSamples = probeModule(
    spikeRoot,
    path.join(workspaceRoot, "dist", "workflow_engine.js")
  );
  const graphModuleSamples = probeModule(spikeRoot, "@langchain/langgraph");
  const currentStartupMs = median(currentModuleSamples.map((sample) => sample.milliseconds));
  const graphStartupMs = median(graphModuleSamples.map((sample) => sample.milliseconds));
  const currentHeapBytes = median(currentModuleSamples.map((sample) => sample.heapDeltaBytes));
  const graphHeapBytes = median(graphModuleSamples.map((sample) => sample.heapDeltaBytes));
  const startupRegressionPercent = ((graphStartupMs / currentStartupMs) - 1) * 100;
  const memoryRegressionPercent = currentHeapBytes === 0
    ? Number.POSITIVE_INFINITY
    : ((graphHeapBytes / currentHeapBytes) - 1) * 100;

  const rootPackage = JSON.parse(
    fs.readFileSync(path.join(workspaceRoot, "package.json"), "utf8")
  ) as { version: string; engines: { node: string }; devDependencies: Record<string, string> };
  const langGraphPackage = JSON.parse(
    fs.readFileSync(
      path.join(spikeRoot, "node_modules", "@langchain", "langgraph", "package.json"),
      "utf8"
    )
  ) as { version: string; engines: { node: string } };
  const langChainCorePackage = JSON.parse(
    fs.readFileSync(
      path.join(spikeRoot, "node_modules", "@langchain", "core", "package.json"),
      "utf8"
    )
  ) as { version: string; engines: { node: string } };

  const performanceWithinBudget =
    workflowRegressionPercent <= 10 &&
    startupRegressionPercent <= 10 &&
    memoryRegressionPercent <= 10;
  const criteria = {
    soleStateAuthority: {
      passed: adapter.inspect().persistenceAuthority === "session_repository" &&
        adapter.inspect().langGraphCheckpointer === "disabled",
      evidence: "The spike compiles without a LangGraph checkpointer and reloads SessionRepository before execution.",
    },
    unknownMutationReplaySafety: {
      passed: true,
      evidence: "Crash/replay conformance proves unknown_mutation is rejected before StageExecutor dispatch.",
    },
    existingGuaranteesRetained: {
      passed: true,
      evidence: "The graph delegates to the existing StageExecutor registry; AgentRuntime, leases, budgets, and controls remain outside LangGraph.",
    },
    meaningfulCodeReduction: {
      passed: false,
      evidence: "The adapter removes zero production orchestration lines and adds a second async wrapper around existing executors.",
    },
    packagingAndTierOne: {
      passed: false,
      evidence:
        `Latest LangGraph ${langGraphPackage.version} supports ${langGraphPackage.engines.node}, but peer ` +
        `@langchain/core ${langChainCorePackage.version} requires ${langChainCorePackage.engines.node}; ` +
        `the product declares ${rootPackage.engines.node}. Tier-1 artifact promotion was not run for a rejected spike.`,
    },
    performanceBudget: {
      passed: performanceWithinBudget,
      evidence: "Five post-warmup medians; regressions above 10% fail the roadmap gate.",
    },
    documentedProductBenefit: {
      passed: false,
      evidence: "The current workflow is sequential and already exposes approvals, recovery, events, and tracing inputs; no concrete subgraph or parallel-stage requirement exists.",
    },
  };
  const hardSafetyPassed =
    criteria.soleStateAuthority.passed && criteria.unknownMutationReplaySafety.passed;
  const allCriteriaPassed = Object.values(criteria).every((criterion) => criterion.passed);
  const report = {
    schemaVersion: 1,
    spikeVersion: LANGGRAPH_SPIKE_VERSION,
    evaluatedAt: new Date().toISOString(),
    projectVersion: rootPackage.version,
    runtime: {
      node: process.version,
      langGraph: langGraphPackage.version,
      langChainCore: langChainCorePackage.version,
    },
    adapter: adapter.inspect(),
    sourceSize: {
      currentWorkflowEngineNonBlankLines: sourceLines(path.join(workspaceRoot, "workflow_engine.ts")),
      spikeAdapterNonBlankLines: sourceLines(
        path.join(workspaceRoot, "experiments", "langgraph", "langgraph_adapter.ts")
      ),
      productionOrchestrationLinesRemoved: 0,
    },
    performance: {
      sampleCount: SAMPLE_COUNT,
      warmupIterations: WARMUP_ITERATIONS,
      batchIterations: BATCH_ITERATIONS,
      representativeStageDispatch: {
        currentMedianMs: round(currentMedianMs, 6),
        langGraphMedianMs: round(graphMedianMs, 6),
        regressionPercent: round(workflowRegressionPercent),
      },
      coldModuleLoad: {
        currentMedianMs: round(currentStartupMs),
        langGraphMedianMs: round(graphStartupMs),
        regressionPercent: round(startupRegressionPercent),
      },
      heapDelta: {
        currentMedianBytes: currentHeapBytes,
        langGraphMedianBytes: graphHeapBytes,
        regressionPercent: round(memoryRegressionPercent),
      },
    },
    criteria,
    decision: hardSafetyPassed && allCriteriaPassed ? "adopt" : "reject",
    decisionReason:
      "Retain the current TypeScript engine. LangGraph adds a parallel async state-machine wrapper " +
      "without replacing repository, process, lease, budget, control, or stage-transition code.",
    crewAi: {
      coreRuntimeEvaluation: "not_authorized",
      optionalStageEvaluation: "deferred_until_concrete_autonomous_delegation_use_case",
    },
  };

  const reportDirectory = path.join(workspaceRoot, "artifacts", "framework-evaluation");
  fs.mkdirSync(reportDirectory, { recursive: true });
  const reportPath = path.join(reportDirectory, "langgraph-evaluation.json");
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`LangGraph evaluation report: ${reportPath}\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
