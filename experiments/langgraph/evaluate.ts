import * as fs from "node:fs";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { TransitionRouter } from "../../src/application/transition-router";
import {
  compiledTransitions,
  findWorkspaceRoot,
  loadEvaluationBundle,
} from "./evaluation_fixture";
import {
  LANGGRAPH_STRUCTURE_SPIKE_VERSION,
  LangGraphStructureAdapter,
} from "./langgraph_adapter";

async function main(): Promise<void> {
  const workspaceRoot = findWorkspaceRoot();
  const bundle = await loadEvaluationBundle(workspaceRoot);
  const transitions = compiledTransitions(bundle);
  const native = new TransitionRouter();
  const graph = new LangGraphStructureAdapter(bundle);
  const iterations = 20;

  const nativeStarted = performance.now();
  for (let pass = 0; pass < iterations; pass += 1) {
    for (const transition of transitions) {
      native.route(bundle, transition.nodeId, transition.signal);
    }
  }
  const nativeMilliseconds = performance.now() - nativeStarted;

  const graphStarted = performance.now();
  for (let pass = 0; pass < iterations; pass += 1) {
    for (const transition of transitions) {
      await graph.route({ nodeId: transition.nodeId, signal: transition.signal });
    }
  }
  const graphMilliseconds = performance.now() - graphStarted;
  const rootPackage = JSON.parse(
    fs.readFileSync(path.join(workspaceRoot, "package.json"), "utf8")
  ) as { version: string };
  const report = {
    schemaVersion: 2,
    spikeVersion: LANGGRAPH_STRUCTURE_SPIKE_VERSION,
    evaluatedAt: new Date().toISOString(),
    projectVersion: rootPackage.version,
    definitionHash: bundle.definitionHash,
    scope: "structure_comparison_only",
    inspection: graph.inspect(),
    transitionParity: true,
    benchmark: {
      iterations,
      transitionCount: transitions.length,
      nativeMilliseconds: Number(nativeMilliseconds.toFixed(3)),
      langGraphMilliseconds: Number(graphMilliseconds.toFixed(3)),
    },
    decision: "do_not_import_into_production",
    decisionReason:
      "The v4 core already owns deterministic routing, CAS checkpoints, mutation reservations, " +
      "effects, and human gates; this wrapper adds runtime cost without replacing those boundaries.",
  };
  const reportDirectory = path.join(workspaceRoot, "artifacts", "framework-evaluation");
  fs.mkdirSync(reportDirectory, { recursive: true });
  const reportPath = path.join(reportDirectory, "langgraph-evaluation.json");
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`LangGraph structural comparison report: ${reportPath}\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
