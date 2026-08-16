import * as path from "node:path";
import * as fsp from "node:fs/promises";
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
  const root = path.resolve(configRoot);
  const [agents, tasks, workflow] = await Promise.all([
    readJson<AgentDefinitionsDocument>(path.join(root, "agents.json")),
    readJson<TaskDefinitionsDocument>(path.join(root, "tasks.json")),
    readJson<WorkflowDefinitionDocument>(path.join(root, "workflow.json")),
  ]);
  return { agents, tasks, workflow };
}
