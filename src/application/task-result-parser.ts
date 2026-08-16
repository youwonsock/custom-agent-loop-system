import { isJsonValue } from "../domain/json";
import type { TaskDefinition } from "../domain/task";
import type { TaskResultEnvelopeV1 } from "../domain/task-result";
import { assertJsonSchema } from "../definitions/json-schema";
import type { SchemaRegistry } from "../definitions/registries";

export type TaskResultValidationKind = "format" | "schema" | "signal";

export class TaskResultValidationError extends Error {
  constructor(readonly kind: TaskResultValidationKind, message: string) {
    super(message);
    this.name = "TaskResultValidationError";
  }
}

export class TaskResultParser {
  constructor(private readonly schemas: SchemaRegistry) {}

  parse(assistantText: string, task: Readonly<TaskDefinition>): TaskResultEnvelopeV1 {
    const trimmed = assistantText.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
      throw new TaskResultValidationError(
        "format",
        "The last assistant response must be one unfenced JSON object."
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new TaskResultValidationError("format", `Invalid JSON: ${message}`);
    }
    if (!isJsonValue(parsed) || parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new TaskResultValidationError("format", "The task result must be a JSON object.");
    }
    try {
      assertJsonSchema(
        parsed,
        this.schemas.get("task_result_envelope.v1"),
        "Task result envelope"
      );
    } catch (error) {
      throw new TaskResultValidationError(
        "schema",
        error instanceof Error ? error.message : String(error)
      );
    }
    const envelope = parsed as unknown as TaskResultEnvelopeV1;
    if (!task.allowedSignals.includes(envelope.signal)) {
      throw new TaskResultValidationError(
        "signal",
        `Signal '${envelope.signal}' is not allowed for task ${task.id}.`
      );
    }
    try {
      assertJsonSchema(
        envelope.payload,
        this.schemas.get(task.resultSchemaId),
        `Task result payload ${task.resultSchemaId}`
      );
    } catch (error) {
      throw new TaskResultValidationError(
        "schema",
        error instanceof Error ? error.message : String(error)
      );
    }
    return envelope;
  }
}
