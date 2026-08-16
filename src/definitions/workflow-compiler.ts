import { createHash } from "node:crypto";
import type {
  AgentDefinition,
  AgentRuntimeOverride,
  ResolvedAgentDefinition,
} from "../domain/agent";
import { canonicalJson, deepFreeze, type JsonValue } from "../domain/json";
import { assertNarrowingToolPolicy, normalizeToolPolicy } from "../domain/tool-policy";
import type {
  CompiledWorkflowBundle,
  CompiledWorkflowNode,
  DefinitionSourceBundle,
  TerminalDefinition,
  WorkflowNode,
} from "../domain/workflow";
import type { DefinitionRegistries } from "./registries";

const SAFE_ID = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/u;

export interface WorkflowCompilerOptions {
  runtimeOverrides?: Record<string, AgentRuntimeOverride>;
  defaultProvider?: string;
  defaultModel?: string;
}

function assertSafeId(value: string, label: string): void {
  if (!SAFE_ID.test(value)) throw new Error(`${label} has an unsafe id: ${value}.`);
}

function uniqueRecord<T extends { id: string }>(values: readonly T[], label: string): Record<string, T> {
  const record: Record<string, T> = {};
  for (const value of values) {
    assertSafeId(value.id, label);
    if (record[value.id]) throw new Error(`Duplicate ${label} id: ${value.id}.`);
    record[value.id] = value;
  }
  return record;
}

function resolvedAgent(
  agent: AgentDefinition,
  override: AgentRuntimeOverride | undefined,
  options: WorkflowCompilerOptions
): ResolvedAgentDefinition {
  const provider = override?.provider ?? agent.runtimeDefaults.provider ?? options.defaultProvider;
  const model = override?.model ?? agent.runtimeDefaults.model ?? options.defaultModel;
  const variant = override?.variant ?? agent.runtimeDefaults.variant;
  if (!provider?.trim()) throw new Error(`Agent ${agent.id} has no resolved provider.`);
  if (!model?.trim()) throw new Error(`Agent ${agent.id} has no resolved model.`);
  assertSafeId(provider, `Agent ${agent.id} provider`);
  if (variant !== undefined && !variant.trim()) {
    throw new Error(`Agent ${agent.id} has an empty variant.`);
  }
  if (agent.access === "read_only" && agent.toolPolicy.workspace === "write") {
    throw new Error(`Read-only agent ${agent.id} cannot declare workspace write tools.`);
  }
  return {
    ...agent,
    runtimeDefaults: { ...agent.runtimeDefaults },
    toolPolicy: normalizeToolPolicy(agent.toolPolicy),
    runtime: {
      provider,
      model,
      ...(variant ? { variant } : {}),
    },
  };
}

function nodeTargets(
  nodeId: string,
  transitions: Readonly<Record<string, Readonly<Record<string, string>>>>
): string[] {
  return [...new Set(Object.values(transitions[nodeId] ?? {}))];
}

function reachableNodes(
  startNodeId: string,
  nodes: Readonly<Record<string, WorkflowNode | CompiledWorkflowNode>>,
  transitions: Readonly<Record<string, Readonly<Record<string, string>>>>,
  additionalEntrypoints: readonly string[] = []
): Set<string> {
  const reachable = new Set<string>();
  const pending = [startNodeId, ...additionalEntrypoints];
  while (pending.length > 0) {
    const nodeId = pending.pop()!;
    if (reachable.has(nodeId)) continue;
    reachable.add(nodeId);
    for (const target of nodeTargets(nodeId, transitions)) {
      if (nodes[target] && !reachable.has(target)) pending.push(target);
    }
  }
  return reachable;
}

function canReach(
  sourceId: string,
  targetId: string,
  nodes: Readonly<Record<string, WorkflowNode | CompiledWorkflowNode>>,
  transitions: Readonly<Record<string, Readonly<Record<string, string>>>>
): boolean {
  const visited = new Set<string>();
  const pending = [sourceId];
  while (pending.length > 0) {
    const nodeId = pending.pop()!;
    if (nodeId === targetId) return true;
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);
    for (const target of nodeTargets(nodeId, transitions)) {
      if (nodes[target] && !visited.has(target)) pending.push(target);
    }
  }
  return false;
}

function nodesWithTerminalRoute(
  nodes: Readonly<Record<string, WorkflowNode | CompiledWorkflowNode>>,
  transitions: Readonly<Record<string, Readonly<Record<string, string>>>>,
  terminalIds: ReadonlySet<string>
): Set<string> {
  const routable = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const nodeId of Object.keys(nodes)) {
      if (routable.has(nodeId)) continue;
      if (
        nodeTargets(nodeId, transitions).some(
          (target) => terminalIds.has(target) || routable.has(target)
        )
      ) {
        routable.add(nodeId);
        changed = true;
      }
    }
  }
  return routable;
}

function stronglyConnectedComponents(
  nodes: Readonly<Record<string, WorkflowNode | CompiledWorkflowNode>>,
  transitions: Readonly<Record<string, Readonly<Record<string, string>>>>,
  reachable: ReadonlySet<string>
): string[][] {
  const indexByNode = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];
  let nextIndex = 0;
  const visit = (nodeId: string): void => {
    indexByNode.set(nodeId, nextIndex);
    lowLink.set(nodeId, nextIndex);
    nextIndex += 1;
    stack.push(nodeId);
    onStack.add(nodeId);
    for (const target of nodeTargets(nodeId, transitions)) {
      if (!nodes[target] || !reachable.has(target)) continue;
      if (!indexByNode.has(target)) {
        visit(target);
        lowLink.set(nodeId, Math.min(lowLink.get(nodeId)!, lowLink.get(target)!));
      } else if (onStack.has(target)) {
        lowLink.set(nodeId, Math.min(lowLink.get(nodeId)!, indexByNode.get(target)!));
      }
    }
    if (lowLink.get(nodeId) !== indexByNode.get(nodeId)) return;
    const component: string[] = [];
    while (stack.length > 0) {
      const member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
      if (member === nodeId) break;
    }
    components.push(component.sort());
  };
  for (const nodeId of [...reachable].sort()) {
    if (!indexByNode.has(nodeId)) visit(nodeId);
  }
  return components;
}

function cyclicComponents(
  nodes: Readonly<Record<string, WorkflowNode | CompiledWorkflowNode>>,
  transitions: Readonly<Record<string, Readonly<Record<string, string>>>>,
  reachable: ReadonlySet<string>
): string[][] {
  return stronglyConnectedComponents(nodes, transitions, reachable).filter((component) =>
    component.length > 1 || nodeTargets(component[0], transitions).includes(component[0])
  );
}

function assertNoRequiredGateBypass(
  startNodeId: string,
  nodes: Readonly<Record<string, CompiledWorkflowNode>>,
  transitions: Readonly<Record<string, Readonly<Record<string, string>>>>,
  terminals: Readonly<Record<string, TerminalDefinition>>,
  requiredGateIds: readonly string[]
): void {
  for (const requiredGateId of requiredGateIds) {
    const pending: Array<{ nodeId: string; visited: boolean }> = [
      { nodeId: startNodeId, visited: startNodeId === requiredGateId },
    ];
    const seen = new Set<string>();
    while (pending.length > 0) {
      const current = pending.pop()!;
      const key = `${current.nodeId}:${current.visited ? "1" : "0"}`;
      if (seen.has(key)) continue;
      seen.add(key);
      for (const target of nodeTargets(current.nodeId, transitions)) {
        const terminal = terminals[target];
        if (terminal?.status === "succeeded" && !current.visited) {
          throw new Error(
            `Workflow can reach successful terminal ${target} without required gate ${requiredGateId}.`
          );
        }
        if (nodes[target]) {
          pending.push({
            nodeId: target,
            visited: current.visited || target === requiredGateId,
          });
        }
      }
    }
  }
}

function definitionHash(value: JsonValue): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function compileWorkflow(
  source: DefinitionSourceBundle,
  registries: DefinitionRegistries,
  options: WorkflowCompilerOptions = {}
): CompiledWorkflowBundle {
  if (
    source.agents.schemaVersion !== 1 ||
    source.tasks.schemaVersion !== 1 ||
    source.workflow.schemaVersion !== 1
  ) {
    throw new Error("Agent, task, and workflow definition schemaVersion must all be 1.");
  }
  const rawAgents = uniqueRecord(source.agents.agents, "agent");
  const agents: Record<string, ResolvedAgentDefinition> = {};
  for (const agent of Object.values(rawAgents)) {
    agents[agent.id] = resolvedAgent(agent, options.runtimeOverrides?.[agent.id], options);
  }
  const tasks = uniqueRecord(source.tasks.tasks, "task");
  for (const task of Object.values(tasks)) {
    if (task.runner !== "agent") throw new Error(`Task ${task.id} has unsupported runner.`);
    if (!registries.schemas.has(task.inputSchemaId)) {
      throw new Error(`Task ${task.id} references unknown input schema ${task.inputSchemaId}.`);
    }
    if (!registries.schemas.has(task.resultSchemaId)) {
      throw new Error(`Task ${task.id} references unknown result schema ${task.resultSchemaId}.`);
    }
    if (task.allowedSignals.length === 0 || new Set(task.allowedSignals).size !== task.allowedSignals.length) {
      throw new Error(`Task ${task.id} must declare unique allowed signals.`);
    }
    task.allowedSignals.forEach((signal) => assertSafeId(signal, `Task ${task.id} signal`));
    if (!Number.isSafeInteger(task.retryPolicy.maxAttempts) || task.retryPolicy.maxAttempts < 1) {
      throw new Error(`Task ${task.id} retry maxAttempts must be positive.`);
    }
    if (![0, 1].includes(task.retryPolicy.formatRecoveryAttempts)) {
      throw new Error(`Task ${task.id} format recovery must be 0 or 1.`);
    }
    if (task.retryPolicy.backoffMs.some((delay) => !Number.isSafeInteger(delay) || delay < 0)) {
      throw new Error(`Task ${task.id} has an invalid retry backoff.`);
    }
    for (const reference of task.guardrails) {
      if (!registries.guardrails.has(reference.id)) {
        throw new Error(`Task ${task.id} references unknown guardrail ${reference.id}.`);
      }
    }
    if (task.effectMapper && !registries.effectMappers.has(task.effectMapper)) {
      throw new Error(`Task ${task.id} references unknown effect mapper ${task.effectMapper}.`);
    }
  }
  const rawNodes = uniqueRecord(source.workflow.nodes, "node");
  const nodes: Record<string, CompiledWorkflowNode> = {};
  for (const node of Object.values(rawNodes)) {
    const inputNames = node.inputs.map((binding) => binding.name);
    if (new Set(inputNames).size !== inputNames.length) {
      throw new Error(`Node ${node.id} has duplicate input names.`);
    }
    for (const binding of node.inputs) assertSafeId(binding.name, `Node ${node.id} input`);
    if (node.kind === "task") {
      const task = tasks[node.taskId];
      const agent = agents[node.agentId];
      if (!task) throw new Error(`Node ${node.id} references unknown task ${node.taskId}.`);
      if (!agent) throw new Error(`Node ${node.id} references unknown agent ${node.agentId}.`);
      assertNarrowingToolPolicy(agent.toolPolicy, task.toolPolicy);
      if (task.sideEffect === "workspace_mutation" && agent.access !== "workspace_write") {
        throw new Error(`Mutation task ${task.id} cannot use read-only agent ${agent.id}.`);
      }
      nodes[node.id] = {
        id: node.id,
        kind: "task",
        taskId: node.taskId,
        agentId: node.agentId,
        inputs: node.inputs,
      };
    } else {
      if (node.gate.allowedSignals.length === 0) {
        throw new Error(`Human gate ${node.id} must declare allowed signals.`);
      }
      node.gate.allowedSignals.forEach((signal) =>
        assertSafeId(signal, `Human gate ${node.id} signal`)
      );
      nodes[node.id] = {
        id: node.id,
        kind: "human_gate",
        gate: node.gate,
        inputs: node.inputs,
      };
    }
  }
  if (!nodes[source.workflow.startNodeId]) {
    throw new Error(`Unknown workflow start node ${source.workflow.startNodeId}.`);
  }
  const terminalRecord = uniqueRecord(source.workflow.terminals, "terminal");
  const transitions: Record<string, Record<string, string>> = {};
  for (const rule of source.workflow.transitions) {
    const from = nodes[rule.from];
    if (!from) throw new Error(`Transition references unknown source node ${rule.from}.`);
    if (!nodes[rule.to] && !terminalRecord[rule.to]) {
      throw new Error(`Transition ${rule.from}.${rule.on} references unknown target ${rule.to}.`);
    }
    const allowedSignals = from.kind === "task"
      ? tasks[from.taskId!].allowedSignals
      : from.gate!.allowedSignals;
    if (!allowedSignals.includes(rule.on)) {
      throw new Error(`Transition ${rule.from}.${rule.on} uses an undeclared signal.`);
    }
    transitions[rule.from] ??= {};
    if (transitions[rule.from][rule.on]) {
      throw new Error(`Duplicate transition for ${rule.from}.${rule.on}.`);
    }
    transitions[rule.from][rule.on] = rule.to;
  }
  for (const node of Object.values(nodes)) {
    const allowedSignals = node.kind === "task"
      ? tasks[node.taskId!].allowedSignals
      : node.gate!.allowedSignals;
    const missing = allowedSignals.filter((signal) => !transitions[node.id]?.[signal]);
    if (missing.length > 0) {
      throw new Error(`Node ${node.id} has no transition for signal(s): ${missing.join(", ")}.`);
    }
  }
  const interruptNodeId = source.workflow.applicationPolicy.interruptNodeId;
  const blockedTerminalId = source.workflow.applicationPolicy.blockedTerminalId;
  if (!nodes[interruptNodeId]) {
    throw new Error(`Application policy references unknown interrupt node ${interruptNodeId}.`);
  }
  if (!terminalRecord[blockedTerminalId] || terminalRecord[blockedTerminalId].status !== "blocked") {
    throw new Error(
      `Application policy blocked terminal ${blockedTerminalId} must exist with blocked status.`
    );
  }
  const reachable = reachableNodes(
    source.workflow.startNodeId,
    nodes,
    transitions,
    [interruptNodeId]
  );
  const unreachable = Object.keys(nodes).filter((nodeId) => !reachable.has(nodeId));
  if (unreachable.length > 0) {
    throw new Error(`Workflow has unreachable node(s): ${unreachable.join(", ")}.`);
  }
  const terminalIds = new Set(Object.keys(terminalRecord));
  const routable = nodesWithTerminalRoute(nodes, transitions, terminalIds);
  const terminalFree = [...reachable].filter((nodeId) => !routable.has(nodeId));
  if (terminalFree.length > 0) {
    throw new Error(`Workflow node(s) have no terminal route: ${terminalFree.join(", ")}.`);
  }
  for (const node of Object.values(nodes)) {
    for (const binding of node.inputs) {
      if (binding.source.kind === "node_output") {
        const sourceNode = nodes[binding.source.nodeId];
        if (!sourceNode) {
          throw new Error(`Node ${node.id} input references unknown node ${binding.source.nodeId}.`);
        }
        if (sourceNode.id === node.id || !canReach(sourceNode.id, node.id, nodes, transitions)) {
          throw new Error(
            `Node ${node.id} input source ${sourceNode.id} cannot precede it on a workflow path.`
          );
        }
      }
      if (binding.source.kind === "human_response") {
        const gateNode = nodes[binding.source.nodeId];
        if (!gateNode || gateNode.kind !== "human_gate") {
          throw new Error(
            `Node ${node.id} input requires unknown human gate ${binding.source.nodeId}.`
          );
        }
        if (!canReach(gateNode.id, node.id, nodes, transitions)) {
          throw new Error(`Human gate ${gateNode.id} cannot precede node ${node.id}.`);
        }
      }
    }
  }
  const { startNodeId: cycleStart, completionNodeId: cycleCompletion } =
    source.workflow.cyclePolicy;
  if (!nodes[cycleStart] || !nodes[cycleCompletion]) {
    throw new Error("Cycle policy references an unknown node.");
  }
  if (!canReach(cycleStart, cycleCompletion, nodes, transitions)) {
    throw new Error(`Cycle completion node ${cycleCompletion} is unreachable from ${cycleStart}.`);
  }
  const budgets = source.workflow.budgets;
  for (const [name, value] of Object.entries(budgets)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`Workflow budget ${name} must be a positive integer.`);
    }
  }
  const requiredGateIds = Object.values(nodes)
    .filter((node) => node.kind === "human_gate" && node.gate?.requiredForSuccess)
    .map((node) => node.id)
    .sort();
  assertNoRequiredGateBypass(
    source.workflow.startNodeId,
    nodes,
    transitions,
    terminalRecord,
    requiredGateIds
  );
  const components = cyclicComponents(nodes, transitions, reachable);
  const hashInput = {
    agents,
    tasks,
    nodes,
    transitions,
    startNodeId: source.workflow.startNodeId,
    terminals: source.workflow.terminals,
    cyclePolicy: source.workflow.cyclePolicy,
    applicationPolicy: source.workflow.applicationPolicy,
    budgets,
  } as unknown as JsonValue;
  const compiled: CompiledWorkflowBundle = {
    schemaVersion: 1,
    definitionHash: definitionHash(hashInput),
    agents,
    tasks,
    nodes,
    transitions,
    startNodeId: source.workflow.startNodeId,
    terminals: source.workflow.terminals,
    cyclePolicy: source.workflow.cyclePolicy,
    applicationPolicy: source.workflow.applicationPolicy,
    budgets,
    analysis: {
      reachableNodeIds: [...reachable].sort(),
      terminalIds: Object.keys(terminalRecord).sort(),
      requiredApprovalGateIds: requiredGateIds,
      cyclicComponents: components,
    },
  };
  return deepFreeze(compiled);
}
