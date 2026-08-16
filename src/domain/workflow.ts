import type { AgentDefinition, ResolvedAgentDefinition } from "./agent";
import type { JsonValue } from "./json";
import type { TaskDefinition } from "./task";

export type NamedRunContextKey =
  | "goal"
  | "requirements"
  | "approved_plan"
  | "selected_plan_choice_id"
  | "target_project_path"
  | "additional_allowed_paths";

export type NodeInputSource =
  | { kind: "run_context"; key: NamedRunContextKey }
  | { kind: "node_output"; nodeId: string }
  | { kind: "failure" }
  | { kind: "recovery" }
  | { kind: "human_response"; nodeId: string };

export interface NodeInputBinding {
  name: string;
  source: NodeInputSource;
  required?: boolean;
}

export interface HumanGateDefinition {
  type: "plan_approval" | "access_approval" | "custom";
  prompt: string;
  allowedSignals: string[];
  requiredForSuccess?: boolean;
}

export type WorkflowNode =
  | {
      id: string;
      kind: "task";
      taskId: string;
      agentId: string;
      inputs: NodeInputBinding[];
    }
  | {
      id: string;
      kind: "human_gate";
      gate: HumanGateDefinition;
      inputs: NodeInputBinding[];
    };

export interface TransitionRule {
  from: string;
  on: string;
  to: string;
}

export type TerminalStatus = "succeeded" | "paused" | "blocked" | "stopped";

export interface TerminalDefinition {
  id: string;
  status: TerminalStatus;
}

export interface WorkflowBudget {
  maxWorkflowSteps: number;
  maxCycles: number;
  maxArtifactInputBytes: number;
  maxEvents: number;
  maxNodeExecutions: number;
}

export interface AgentDefinitionsDocument {
  schemaVersion: 1;
  agents: AgentDefinition[];
}

export interface TaskDefinitionsDocument {
  schemaVersion: 1;
  tasks: TaskDefinition[];
}

export interface WorkflowDefinitionDocument {
  schemaVersion: 1;
  name: string;
  startNodeId: string;
  nodes: WorkflowNode[];
  transitions: TransitionRule[];
  terminals: TerminalDefinition[];
  cyclePolicy: {
    startNodeId: string;
    completionNodeId: string;
  };
  applicationPolicy: {
    interruptNodeId: string;
    blockedTerminalId: string;
  };
  budgets: WorkflowBudget;
}

export interface CompiledWorkflowNode {
  id: string;
  kind: WorkflowNode["kind"];
  taskId?: string;
  agentId?: string;
  gate?: HumanGateDefinition;
  inputs: NodeInputBinding[];
}

export interface WorkflowCompilationAnalysis {
  reachableNodeIds: string[];
  terminalIds: string[];
  requiredApprovalGateIds: string[];
  cyclicComponents: string[][];
}

export interface CompiledWorkflowBundle {
  schemaVersion: 1;
  definitionHash: string;
  agents: Record<string, ResolvedAgentDefinition>;
  tasks: Record<string, TaskDefinition>;
  nodes: Record<string, CompiledWorkflowNode>;
  transitions: Record<string, Record<string, string>>;
  startNodeId: string;
  terminals: TerminalDefinition[];
  cyclePolicy: {
    startNodeId: string;
    completionNodeId: string;
  };
  applicationPolicy: {
    interruptNodeId: string;
    blockedTerminalId: string;
  };
  budgets: WorkflowBudget;
  analysis: WorkflowCompilationAnalysis;
}

export interface DefinitionSourceBundle {
  agents: AgentDefinitionsDocument;
  tasks: TaskDefinitionsDocument;
  workflow: WorkflowDefinitionDocument;
}

export interface HumanGateResponse {
  requestId: string;
  nodeId: string;
  signal: string;
  choiceId?: string;
  value?: JsonValue;
  respondedAt: string;
}
