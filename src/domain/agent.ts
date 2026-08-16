import type { ToolPolicy } from "./tool-policy";

export interface AgentDefinition {
  id: string;
  role: string;
  objective: string;
  instructions: string;
  runtimeDefaults: {
    provider?: string;
    model?: string;
    variant?: string;
  };
  access: "read_only" | "workspace_write";
  toolPolicy: ToolPolicy;
}

export interface ResolvedAgentDefinition extends AgentDefinition {
  runtime: {
    provider: string;
    model: string;
    variant?: string;
  };
}

export interface AgentRuntimeOverride {
  provider?: string;
  model?: string;
  variant?: string;
}
