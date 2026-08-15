import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import type { AgentRuntime } from "../../agent_runtime";
import type { LoopState } from "../../loop_state";
import { stageById } from "../../pipeline";
import type { SessionRepository } from "../../session_repository";
import { LoopStatus } from "../../workflow_contracts";
import { CurrentWorkflowEngine } from "../../workflow_engine";
import { deriveExtensionOperatorSnapshot } from "../../vscode-extension/src/operatorProjection";
import type { LoopState as ExtensionLoopState } from "../../vscode-extension/src/types";
import {
  cloneEvaluationState,
  createEvaluationRegistry,
  createEvaluationState,
  findWorkspaceRoot,
} from "./evaluation_fixture";
import {
  LangGraphSpikeInvariantError,
  LangGraphWorkflowEngineAdapter,
  ReservedStageInvocation,
} from "./langgraph_adapter";

interface EvaluationDependencies {
  adapter: LangGraphWorkflowEngineAdapter;
  getLoadCount(): number;
  getRuntimeLaunchCount(): number;
}

function invocationFor(state: LoopState): ReservedStageInvocation {
  assert.ok(state.currentActivation);
  return {
    sessionId: state.sessionId,
    stageId: state.phase,
    activationId: state.currentActivation.activationId,
    expectedAggregateRevision: state.aggregateRevision,
    expectedFencingEpoch: state.fencingEpoch,
  };
}

function createDependencies(
  readState: () => LoopState,
  execute: () => Promise<void> = async () => undefined
): EvaluationDependencies {
  let loadCount = 0;
  let runtimeLaunchCount = 0;
  const repository: Pick<SessionRepository, "load"> = {
    load: async () => {
      loadCount += 1;
      return readState();
    },
  };
  const runtime: Pick<AgentRuntime, "launch"> = {
    launch: async () => {
      runtimeLaunchCount += 1;
      throw new Error("The wrapper must not launch a provider directly.");
    },
  };
  const adapter = new LangGraphWorkflowEngineAdapter({
    sessionRepository: repository,
    agentRuntime: runtime,
    stageExecutors: createEvaluationRegistry(async () => execute()),
  });
  return {
    adapter,
    getLoadCount: () => loadCount,
    getRuntimeLaunchCount: () => runtimeLaunchCount,
  };
}

test("current and LangGraph adapters preserve identical transition semantics", () => {
  const initial = createEvaluationState();
  const current = new CurrentWorkflowEngine<LoopState>();
  const { adapter } = createDependencies(() => initial);
  const targets = [
    stageById(initial.pipeline, initial.phase).onSuccess,
    "SUCCESS",
    "PAUSED",
    "BLOCKED",
  ];

  for (const target of targets) {
    const currentState = cloneEvaluationState(initial);
    const graphState = cloneEvaluationState(initial);
    const currentDecision = current.applyTarget(currentState, target);
    const graphDecision = adapter.applyTarget(graphState, target);
    assert.deepEqual(graphDecision, currentDecision);
    assert.equal(graphState.phase, currentState.phase);
    assert.equal(graphState.status, currentState.status);
  }

  const invalidState = cloneEvaluationState(initial);
  assert.throws(() => adapter.applyTarget(invalidState, "missing-stage"), /Unknown pipeline stage/);
  assert.equal(invalidState.phase, initial.phase);
  assert.equal(invalidState.status, LoopStatus.RUNNING);
});

test("LangGraph wrapper delegates one reserved stage through existing boundaries", async () => {
  const state = createEvaluationState();
  let executions = 0;
  const dependencies = createDependencies(
    () => state,
    async () => {
      executions += 1;
    }
  );

  const result = await dependencies.adapter.executeReservedStage(invocationFor(state));
  assert.equal(result.executed, true);
  assert.equal(result.stageId, state.phase);
  assert.equal(result.checkedAggregateRevision, state.aggregateRevision);
  assert.equal(executions, 1);
  assert.equal(dependencies.getLoadCount(), 2);
  assert.equal(dependencies.getRuntimeLaunchCount(), 0);
  assert.deepEqual(dependencies.adapter.inspect(), {
    productionEligible: false,
    persistenceAuthority: "session_repository",
    langGraphCheckpointer: "disabled",
    automaticNodeRetries: false,
    providerLaunchBoundary: "agent_runtime_via_existing_stage_executor",
    transitionAuthority: "current_workflow_engine",
  });
});

test("crash replay is refused after an unknown mutation outcome", async () => {
  const state = createEvaluationState("IMPLEMENTATION");
  const request = invocationFor(state);
  let executions = 0;
  const { adapter } = createDependencies(
    () => state,
    async () => {
      executions += 1;
      throw new Error("injected crash after an external side effect");
    }
  );

  await assert.rejects(
    adapter.executeReservedStage(request),
    /injected crash after an external side effect/
  );
  assert.equal(executions, 1, "LangGraph node retry must remain disabled");

  assert.ok(state.currentActivation);
  state.currentActivation.status = "unknown_mutation";
  state.status = LoopStatus.PAUSED;
  await assert.rejects(
    adapter.executeReservedStage(request),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return message.includes("unknown mutation outcome") ||
        (error instanceof LangGraphSpikeInvariantError &&
          error.code === "UNKNOWN_MUTATION_OUTCOME");
    }
  );
  assert.equal(executions, 1, "unknown mutation must require explicit operator reconciliation");
});

test("authority, fencing, activation, and super-step races fail closed", async () => {
  const state = createEvaluationState();
  let executions = 0;
  const revisionMismatch = createDependencies(
    () => state,
    async () => {
      executions += 1;
    }
  );
  const staleRequest = { ...invocationFor(state), expectedAggregateRevision: 6 };
  await assert.rejects(
    revisionMismatch.adapter.executeReservedStage(staleRequest),
    /Expected aggregate revision 6/
  );
  assert.equal(executions, 0);

  let reads = 0;
  const race = createDependencies(
    () => {
      reads += 1;
      if (reads === 2) state.aggregateRevision += 1;
      return state;
    },
    async () => {
      executions += 1;
    }
  );
  await assert.rejects(
    race.adapter.executeReservedStage(invocationFor(state)),
    /Expected aggregate revision 7|changed between LangGraph super-steps/
  );
  assert.equal(executions, 0);
});

test("extension projection remains engine-neutral", () => {
  const initial = createEvaluationState();
  const currentState = cloneEvaluationState(initial);
  const graphState = cloneEvaluationState(initial);
  const current = new CurrentWorkflowEngine<LoopState>();
  const { adapter } = createDependencies(() => graphState);
  const target = stageById(initial.pipeline, initial.phase).onSuccess;

  current.applyTarget(currentState, target);
  adapter.applyTarget(graphState, target);
  const currentProjection = deriveExtensionOperatorSnapshot(
    currentState as unknown as ExtensionLoopState,
    Date.parse("2026-08-16T00:00:30.000Z")
  );
  const graphProjection = deriveExtensionOperatorSnapshot(
    graphState as unknown as ExtensionLoopState,
    Date.parse("2026-08-16T00:00:30.000Z")
  );
  assert.deepEqual(graphProjection, currentProjection);
});

test("framework packages and spike sources stay outside production artifacts", () => {
  const workspaceRoot = findWorkspaceRoot();
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(workspaceRoot, "package.json"), "utf8")
  ) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  const extensionPackage = JSON.parse(
    fs.readFileSync(path.join(workspaceRoot, "vscode-extension", "package.json"), "utf8")
  ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const npmIgnore = fs.readFileSync(path.join(workspaceRoot, ".npmignore"), "utf8");
  const rootTsconfig = fs.readFileSync(path.join(workspaceRoot, "tsconfig.json"), "utf8");

  assert.equal(packageJson.dependencies["@langchain/langgraph"], undefined);
  assert.equal(packageJson.devDependencies["@langchain/langgraph"], undefined);
  const spikePackage = JSON.parse(
    fs.readFileSync(path.join(workspaceRoot, "experiments", "langgraph", "package.json"), "utf8")
  ) as { devDependencies: Record<string, string>; engines: { node: string } };
  assert.equal(spikePackage.devDependencies["@langchain/langgraph"], "1.4.10");
  assert.equal(spikePackage.engines.node, ">=20.0.0");
  assert.equal(extensionPackage.dependencies?.["@langchain/langgraph"], undefined);
  assert.equal(extensionPackage.devDependencies?.["@langchain/langgraph"], undefined);
  assert.match(npmIgnore, /^experiments\/$/m);
  assert.doesNotMatch(rootTsconfig, /experiments\/langgraph/);
});

test("latest LangGraph peer stack does not satisfy the declared Node 18 floor", () => {
  const workspaceRoot = findWorkspaceRoot();
  const corePackage = JSON.parse(
    fs.readFileSync(
      path.join(
        workspaceRoot,
        "experiments",
        "langgraph",
        "node_modules",
        "@langchain",
        "core",
        "package.json"
      ),
      "utf8"
    )
  ) as { engines?: { node?: string } };
  const rootPackage = JSON.parse(
    fs.readFileSync(path.join(workspaceRoot, "package.json"), "utf8")
  ) as { engines?: { node?: string } };
  assert.equal(rootPackage.engines?.node, ">=18.0.0");
  assert.equal(corePackage.engines?.node, ">=20");
});
