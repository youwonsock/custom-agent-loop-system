import * as fs from "node:fs";
import * as path from "node:path";
import { createDefaultDefinitionRegistries } from "../../src/definitions/default-registries";
import { loadDefinitionSource } from "../../src/definitions/definition-loader";
import { compileWorkflow } from "../../src/definitions/workflow-compiler";
import type { CompiledWorkflowBundle } from "../../src/domain/workflow";

export function findWorkspaceRoot(startDirectory = __dirname): string {
  let current = path.resolve(startDirectory);
  for (;;) {
    const packagePath = path.join(current, "package.json");
    if (fs.existsSync(packagePath)) {
      const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8")) as { name?: string };
      if (packageJson.name === "custom-agent-loop-system") return current;
    }
    const parent = path.dirname(current);
    if (parent === current) throw new Error("Could not locate the Agent Loop workspace root.");
    current = parent;
  }
}

export async function loadEvaluationBundle(
  workspaceRoot = findWorkspaceRoot()
): Promise<CompiledWorkflowBundle> {
  const source = await loadDefinitionSource(workspaceRoot);
  return compileWorkflow(source, createDefaultDefinitionRegistries());
}

export function compiledTransitions(bundle: Readonly<CompiledWorkflowBundle>): Array<{
  nodeId: string;
  signal: string;
  targetId: string;
}> {
  return Object.entries(bundle.transitions).flatMap(([nodeId, transitions]) =>
    Object.entries(transitions).map(([signal, targetId]) => ({ nodeId, signal, targetId }))
  );
}
