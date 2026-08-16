import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { TransitionRouter } from "../../src/application/transition-router";
import {
  compiledTransitions,
  findWorkspaceRoot,
  loadEvaluationBundle,
} from "./evaluation_fixture";
import { LangGraphStructureAdapter } from "./langgraph_adapter";

test("LangGraph structural routes match the v4 TransitionRouter", async () => {
  const bundle = await loadEvaluationBundle();
  const native = new TransitionRouter();
  const graph = new LangGraphStructureAdapter(bundle);

  for (const transition of compiledTransitions(bundle)) {
    const expected = native.route(bundle, transition.nodeId, transition.signal);
    const actual = await graph.route({
      nodeId: transition.nodeId,
      signal: transition.signal,
    });
    assert.deepEqual(actual, {
      nodeId: transition.nodeId,
      signal: transition.signal,
      targetId: expected.targetId,
      terminalStatus: expected.terminalStatus,
    });
  }
});

test("the structural experiment cannot execute or persist production work", async () => {
  const bundle = await loadEvaluationBundle();
  const adapter = new LangGraphStructureAdapter(bundle);
  const inspection = adapter.inspect();
  assert.equal(inspection.productionEligible, false);
  assert.equal(inspection.persistenceAuthority, "v4_run_repository");
  assert.equal(inspection.langGraphCheckpointer, "disabled");
  assert.equal(inspection.providerExecution, "disabled");
  assert.equal(inspection.stateMutation, "disabled");
  assert.equal(inspection.automaticNodeRetries, false);
  assert.equal(inspection.definitionHash, bundle.definitionHash);
  await assert.rejects(
    adapter.route({ nodeId: "PLANNING", signal: "undeclared" }),
    /No compiled transition/u
  );
});

test("framework packages and spike sources stay outside production artifacts", () => {
  const workspaceRoot = findWorkspaceRoot();
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(workspaceRoot, "package.json"), "utf8")
  ) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
  const extensionPackage = JSON.parse(
    fs.readFileSync(path.join(workspaceRoot, "vscode-extension", "package.json"), "utf8")
  ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const spikePackage = JSON.parse(
    fs.readFileSync(path.join(workspaceRoot, "experiments", "langgraph", "package.json"), "utf8")
  ) as { devDependencies: Record<string, string>; engines: { node: string } };
  const npmIgnore = fs.readFileSync(path.join(workspaceRoot, ".npmignore"), "utf8");
  const rootTsconfig = fs.readFileSync(path.join(workspaceRoot, "tsconfig.json"), "utf8");

  assert.equal(packageJson.dependencies["@langchain/langgraph"], undefined);
  assert.equal(packageJson.devDependencies["@langchain/langgraph"], undefined);
  assert.equal(extensionPackage.dependencies?.["@langchain/langgraph"], undefined);
  assert.equal(extensionPackage.devDependencies?.["@langchain/langgraph"], undefined);
  assert.equal(spikePackage.devDependencies["@langchain/langgraph"], "1.4.10");
  assert.equal(spikePackage.engines.node, ">=20.0.0");
  assert.match(npmIgnore, /^experiments\/$/m);
  assert.doesNotMatch(rootTsconfig, /experiments\/langgraph/u);
});
