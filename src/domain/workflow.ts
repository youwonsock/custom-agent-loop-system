import type { AgentDefinition, ResolvedAgentDefinition } from "./agent";
import type { JsonValue } from "./json";
import type { TaskDefinition } from "./task";
import type { VerificationCommandSpec } from "./verification";

export type NamedRunContextKey =
  | "goal"
  | "requirements"
  | "approved_plan"
  | "selected_plan_choice_id"
  | "target_project_path"
  | "additional_allowed_paths";

export type VerificationRunContextKey =
  | "verification_contract"
  | "verification_result"
  | "verification_feedback"
  | "verification_criteria_changes"
  | "previous_cycle_feedback"
  | "open_findings";

export type ExtendedRunContextKey = NamedRunContextKey | VerificationRunContextKey;

export type NodeInputSource =
  | { kind: "run_context"; key: ExtendedRunContextKey }
  | { kind: "node_output"; nodeId: string }
  | { kind: "failure" }
  | { kind: "recovery" }
  | { kind: "human_response"; nodeId: string }
  | { kind: "feedback"; scope: "planning" | "previous_cycle" };

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
    }
  | {
      id: string;
      kind: "verification";
      commands: VerificationCommandSpec[];
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
  schemaVersion: 2;
  name: string;
  startNodeId: string;
  nodes: WorkflowNode[];
  transitions: TransitionRule[];
  terminals: TerminalDefinition[];
  cyclePolicy: {
    startNodeId: string;
    completionNodeIds: string[];
  };
  applicationPolicy: {
    interruptNodeId: string;
    blockedTerminalId: string;
    implementationNodeId: string;
    testNodeId: string;
    verificationNodeId: string;
    qaNodeId: string;
    completionApprovalNodeId: string;
  };
  budgets: WorkflowBudget;
}

interface CompiledWorkflowNodeBase {
  id: string;
  inputs: NodeInputBinding[];
}

/** Compiled nodes are intentionally discriminated so verification can never
 * accidentally flow through a task/agent execution path. */
export type CompiledWorkflowNode =
  | (CompiledWorkflowNodeBase & {
      kind: "task";
      taskId: string;
      agentId: string;
      sideEffect: "none" | "workspace_mutation";
    })
  | (CompiledWorkflowNodeBase & {
      kind: "human_gate";
      gate: HumanGateDefinition;
      sideEffect: "none";
    })
  | (CompiledWorkflowNodeBase & {
      kind: "verification";
      commands: VerificationCommandSpec[];
      sideEffect: "workspace_mutation";
    });

export interface WorkflowCompilationAnalysis {
  reachableNodeIds: string[];
  terminalIds: string[];
  requiredApprovalGateIds: string[];
  cyclicComponents: string[][];
}

export interface CompiledWorkflowBundle {
  schemaVersion: 2;
  definitionHash: string;
  agents: Record<string, ResolvedAgentDefinition>;
  tasks: Record<string, TaskDefinition>;
  nodes: Record<string, CompiledWorkflowNode>;
  transitions: Record<string, Record<string, string>>;
  startNodeId: string;
  terminals: TerminalDefinition[];
  cyclePolicy: {
    startNodeId: string;
    completionNodeIds: string[];
  };
  applicationPolicy: {
    interruptNodeId: string;
    blockedTerminalId: string;
    implementationNodeId: string;
    testNodeId: string;
    verificationNodeId: string;
    qaNodeId: string;
    completionApprovalNodeId: string;
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
