import type { ResolvedAgentDefinition } from "../../domain/agent";
import type { ToolPolicy } from "../../domain/tool-policy";
import type { RunControlCommand } from "./control-command";

export type AgentRuntimeMode = "task" | "format_recovery";
export type AgentWorkspaceMode = "none" | "read" | "write";

export interface AgentRuntimeRequest {
  runId: string;
  nodeId: string;
  activationId: string;
  attemptId: string;
  taskId: string;
  agent: ResolvedAgentDefinition;
  prompt: string;
  toolPolicy: ToolPolicy;
  mode: AgentRuntimeMode;
  /** Explicit workspace tool mode, including the tool-free recovery mode. */
  workspaceMode?: AgentWorkspaceMode;
  targetProjectPath: string;
  additionalAllowedPaths: string[];
  fullAccess: boolean;
}

export interface AgentRuntimeFailure {
  kind:
    | "provider"
    | "timeout"
    | "permission"
    | "security"
    | "stopped"
    | "interrupted"
    | "internal";
  message: string;
  retryable: boolean;
  providerStarted: boolean;
  controlCommand?: RunControlCommand;
}

export type AgentRuntimeResponse =
  | {
      status: "succeeded";
      attemptId: string;
      assistantText: string;
      providerTranscript?: string;
    }
  | {
      status: "failed";
      attemptId: string;
      assistantText?: string;
      providerTranscript?: string;
      failure: AgentRuntimeFailure;
    };

export interface AgentRuntimePort {
  execute(request: AgentRuntimeRequest): Promise<AgentRuntimeResponse>;
}
