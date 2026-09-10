import type { JsonObject } from "../domain/json";
import type { RunAggregate } from "../domain/run-aggregate";
import type { CompiledWorkflowNode } from "../domain/workflow";

export interface InputProvenance {
  inputName: string;
  sourceKind: "run_context" | "node_output" | "failure" | "recovery" | "human_response" | "feedback";
  sourceId: string;
  activationId: string | null;
  artifactId: string | null;
  bytesLoaded: number;
}

export interface AssembledTaskInput {
  value: JsonObject;
  provenance: InputProvenance[];
  bytesLoaded: number;
}

export interface NodeExecutionContext {
  aggregate: Readonly<RunAggregate>;
  node: Readonly<CompiledWorkflowNode>;
  activationId: string;
  attemptId: string;
  attemptNumber: number;
}
