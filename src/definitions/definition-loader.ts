import * as path from "node:path";
import * as fsp from "node:fs/promises";
import { resolvePackagedConfigRoot } from "../config/package-config-root";
import type {
  AgentDefinitionsDocument,
  DefinitionSourceBundle,
  TaskDefinitionsDocument,
  WorkflowDefinitionDocument,
} from "../domain/workflow";

async function readJson<T>(filePath: string): Promise<T> {
  const absolutePath = path.resolve(filePath);
  try {
    return JSON.parse(await fsp.readFile(absolutePath, "utf8")) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot load definition ${absolutePath}: ${message}`);
  }
}

export async function loadDefinitionSource(
  configRoot: string
): Promise<DefinitionSourceBundle> {
  let root = path.resolve(configRoot);
  // Callers may provide the immutable code root (for example a packaged CLI)
  // rather than its explicit definition directory. Resolve only the declared
  // codeRoot/config layout; never fall back to legacy root-level definitions.
  try {
    await fsp.access(path.join(root, "agents.json"));
  } catch {
    root = resolvePackagedConfigRoot(root);
  }
  const [agents, tasks, workflow] = await Promise.all([
    readJson<AgentDefinitionsDocument>(path.join(root, "agents.json")),
    readJson<TaskDefinitionsDocument>(path.join(root, "tasks.json")),
    readJson<WorkflowDefinitionDocument>(path.join(root, "workflow.json")),
  ]);
  return { agents, tasks, workflow };
}
