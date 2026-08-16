import type { JsonObject, JsonValue } from "../domain/json";
import { isJsonValue } from "../domain/json";
import type { ArtifactReference, TaskResultEnvelopeV1 } from "../domain/task-result";
import type { NodeInputBinding } from "../domain/workflow";
import { assertJsonSchema } from "../definitions/json-schema";
import type { SchemaRegistry } from "../definitions/registries";
import type { ArtifactStorePort } from "./ports/artifact-store";
import type {
  AssembledTaskInput,
  InputProvenance,
  NodeExecutionContext,
} from "./node-execution-context";

interface LoadedValue {
  value: JsonValue;
  activationId: string | null;
  artifactId: string | null;
  bytesLoaded: number;
  sourceId: string;
}

function parseArtifactJson(bytes: Buffer, reference: ArtifactReference): JsonValue {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`Artifact ${reference.artifactId} does not contain JSON.`);
  }
  if (!isJsonValue(parsed)) throw new Error(`Artifact ${reference.artifactId} is not JSON-safe.`);
  return parsed;
}

function envelopePayload(value: JsonValue, artifactId: string): JsonValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Task output artifact ${artifactId} is not an envelope object.`);
  }
  if (value.schemaVersion !== 1 || !("payload" in value)) {
    throw new Error(`Task output artifact ${artifactId} is not a v1 result envelope.`);
  }
  return (value as unknown as TaskResultEnvelopeV1).payload;
}

export class TaskInputAssembler {
  constructor(
    private readonly artifacts: ArtifactStorePort,
    private readonly schemas: SchemaRegistry
  ) {}

  async assemble(
    context: NodeExecutionContext,
    inputSchemaId?: string
  ): Promise<AssembledTaskInput> {
    const value: JsonObject = {};
    const provenance: InputProvenance[] = [];
    let bytesLoaded = 0;
    for (const binding of context.node.inputs) {
      const loaded = await this.resolveBinding(context, binding, bytesLoaded);
      if (loaded === null) {
        if (binding.required) throw new Error(`Required input ${binding.name} is unavailable.`);
        continue;
      }
      bytesLoaded += loaded.bytesLoaded;
      if (bytesLoaded > context.aggregate.definition.budgets.maxArtifactInputBytes) {
        throw new Error(
          `Task input artifact budget exceeded: ${bytesLoaded}/` +
            `${context.aggregate.definition.budgets.maxArtifactInputBytes} bytes.`
        );
      }
      value[binding.name] = loaded.value;
      provenance.push({
        inputName: binding.name,
        sourceKind: binding.source.kind,
        sourceId: loaded.sourceId,
        activationId: loaded.activationId,
        artifactId: loaded.artifactId,
        bytesLoaded: loaded.bytesLoaded,
      });
    }
    if (inputSchemaId) {
      assertJsonSchema(value, this.schemas.get(inputSchemaId), `Task input ${inputSchemaId}`);
    }
    return { value, provenance, bytesLoaded };
  }

  private async resolveBinding(
    context: NodeExecutionContext,
    binding: NodeInputBinding,
    bytesAlreadyLoaded: number
  ): Promise<LoadedValue | null> {
    const source = binding.source;
    if (source.kind === "run_context") {
      if (source.key === "approved_plan") {
        const approved = context.aggregate.context.approvedPlan;
        if (!approved) return null;
        const loaded = await this.loadOutputReference(context, approved, bytesAlreadyLoaded);
        const payload = loaded.value;
        if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
          const choices = payload.choices;
          const choiceId = context.aggregate.context.selectedPlanChoiceId;
          if (Array.isArray(choices) && choiceId) {
            const selected = choices.find(
              (choice) =>
                choice !== null &&
                typeof choice === "object" &&
                !Array.isArray(choice) &&
                choice.id === choiceId
            );
            if (selected !== undefined) loaded.value = selected;
          }
        }
        return { ...loaded, sourceId: source.key };
      }
      const runContextValues: Record<string, JsonValue> = {
        goal: context.aggregate.context.goal,
        requirements: context.aggregate.context.requirements as unknown as JsonValue,
        approved_plan: null,
        selected_plan_choice_id: context.aggregate.context.selectedPlanChoiceId,
        target_project_path: context.aggregate.context.targetProjectPath,
        additional_allowed_paths: context.aggregate.context.additionalAllowedPaths,
      };
      return {
        value: runContextValues[source.key],
        activationId: null,
        artifactId: null,
        bytesLoaded: 0,
        sourceId: source.key,
      };
    }
    if (source.kind === "node_output") {
      const activationId = context.aggregate.latestCompletedByNode[source.nodeId];
      if (!activationId) return null;
      const output = context.aggregate.nodeExecutions[activationId]?.output;
      if (!output) return null;
      const loaded = await this.loadOutputReference(context, output, bytesAlreadyLoaded);
      return { ...loaded, sourceId: source.nodeId };
    }
    if (source.kind === "failure") {
      const failure = context.aggregate.execution.lastFailure;
      return {
        value: (failure ?? { kind: "internal", message: "No failure was recorded." }) as unknown as JsonValue,
        activationId: null,
        artifactId: null,
        bytesLoaded: 0,
        sourceId: "current_failure",
      };
    }
    if (source.kind === "recovery") {
      return {
        value: context.aggregate.context.recovery,
        activationId: null,
        artifactId: null,
        bytesLoaded: 0,
        sourceId: "current_recovery",
      };
    }
    const response = context.aggregate.context.humanResponses[source.nodeId];
    if (!response) return null;
    return {
      value: response as unknown as JsonValue,
      activationId: null,
      artifactId: null,
      bytesLoaded: 0,
      sourceId: source.nodeId,
    };
  }

  private async loadOutputReference(
    context: NodeExecutionContext,
    output: { artifactId: string; activationId: string },
    bytesAlreadyLoaded: number
  ): Promise<LoadedValue> {
    const reference = context.aggregate.artifacts[output.artifactId];
    if (!reference) throw new Error(`Missing artifact reference ${output.artifactId}.`);
    const remaining = Math.max(
      0,
      context.aggregate.definition.budgets.maxArtifactInputBytes - bytesAlreadyLoaded
    );
    const bytes = await this.artifacts.read(reference, remaining);
    const parsed = parseArtifactJson(bytes, reference);
    return {
      value: envelopePayload(parsed, reference.artifactId),
      activationId: output.activationId,
      artifactId: reference.artifactId,
      bytesLoaded: bytes.length,
      sourceId: output.activationId,
    };
  }
}
