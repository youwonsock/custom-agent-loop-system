export type WorkspaceToolAccess = "none" | "read" | "write";

export interface ToolPolicy {
  workspace: WorkspaceToolAccess;
  webSearch: boolean;
  mcpServers: string[];
}

export interface NarrowingToolPolicy {
  workspace?: WorkspaceToolAccess;
  webSearch?: boolean;
  mcpServers?: string[];
}

const WORKSPACE_RANK: Record<WorkspaceToolAccess, number> = {
  none: 0,
  read: 1,
  write: 2,
};

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

export function normalizeToolPolicy(policy: ToolPolicy): ToolPolicy {
  return {
    workspace: policy.workspace,
    webSearch: Boolean(policy.webSearch),
    mcpServers: uniqueSorted(policy.mcpServers),
  };
}

export function assertNarrowingToolPolicy(
  agentPolicy: ToolPolicy,
  taskPolicy: NarrowingToolPolicy | undefined
): void {
  if (!taskPolicy) return;
  if (
    taskPolicy.workspace !== undefined &&
    WORKSPACE_RANK[taskPolicy.workspace] > WORKSPACE_RANK[agentPolicy.workspace]
  ) {
    throw new Error(
      `Task workspace policy '${taskPolicy.workspace}' expands agent policy '${agentPolicy.workspace}'.`
    );
  }
  if (taskPolicy.webSearch === true && !agentPolicy.webSearch) {
    throw new Error("Task web-search policy expands the agent policy.");
  }
  const agentServers = new Set(agentPolicy.mcpServers);
  const expandedServers = (taskPolicy.mcpServers ?? []).filter(
    (serverId) => !agentServers.has(serverId)
  );
  if (expandedServers.length > 0) {
    throw new Error(
      `Task MCP policy expands the agent policy: ${expandedServers.join(", ")}.`
    );
  }
}

export function intersectToolPolicies(
  agentPolicy: ToolPolicy,
  taskPolicy: NarrowingToolPolicy | undefined
): ToolPolicy {
  assertNarrowingToolPolicy(agentPolicy, taskPolicy);
  const requestedWorkspace = taskPolicy?.workspace ?? agentPolicy.workspace;
  const workspace =
    WORKSPACE_RANK[requestedWorkspace] <= WORKSPACE_RANK[agentPolicy.workspace]
      ? requestedWorkspace
      : agentPolicy.workspace;
  const requestedServers = taskPolicy?.mcpServers ?? agentPolicy.mcpServers;
  const agentServers = new Set(agentPolicy.mcpServers);
  return normalizeToolPolicy({
    workspace,
    webSearch: agentPolicy.webSearch && (taskPolicy?.webSearch ?? true),
    mcpServers: requestedServers.filter((serverId) => agentServers.has(serverId)),
  });
}

export const FORMAT_RECOVERY_TOOL_POLICY: ToolPolicy = Object.freeze({
  workspace: "none",
  webSearch: false,
  mcpServers: [],
});
