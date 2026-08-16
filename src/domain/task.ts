import type { JsonObject } from "./json";
import type { NarrowingToolPolicy } from "./tool-policy";

export interface GuardrailReference {
  id: string;
  config?: JsonObject;
}

export interface RetryPolicy {
  maxAttempts: number;
  formatRecoveryAttempts: 0 | 1;
  backoffMs: number[];
}

export interface TaskDefinition {
  id: string;
  runner: "agent";
  description: string;
  expectedOutput: string;
  inputSchemaId: string;
  resultSchemaId: string;
  allowedSignals: string[];
  sideEffect: "none" | "workspace_mutation";
  toolPolicy?: NarrowingToolPolicy;
  guardrails: GuardrailReference[];
  effectMapper?: string;
  retryPolicy: RetryPolicy;
}
