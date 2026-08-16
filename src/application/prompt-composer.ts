import type { ResolvedAgentDefinition } from "../domain/agent";
import type { TaskDefinition } from "../domain/task";
import type { JsonSchema } from "../definitions/json-schema";
import type { AssembledTaskInput } from "./node-execution-context";

export class PromptComposer {
  compose(
    agent: Readonly<ResolvedAgentDefinition>,
    task: Readonly<TaskDefinition>,
    input: Readonly<AssembledTaskInput>,
    resultSchema: Readonly<JsonSchema>
  ): string {
    const provenance = input.provenance.map((entry) => ({
      input: entry.inputName,
      source: entry.sourceKind,
      sourceId: entry.sourceId,
      activationId: entry.activationId,
      artifactId: entry.artifactId,
      bytesLoaded: entry.bytesLoaded,
    }));
    return [
      "You are executing one bounded task in a deterministic workflow.",
      "",
      `ROLE: ${agent.role}`,
      `OBJECTIVE: ${agent.objective}`,
      `AGENT INSTRUCTIONS: ${agent.instructions}`,
      "",
      `TASK: ${task.description}`,
      `EXPECTED OUTPUT: ${task.expectedOutput}`,
      "",
      "INPUT (JSON):",
      JSON.stringify(input.value, null, 2),
      "",
      "INPUT PROVENANCE (JSON):",
      JSON.stringify(provenance, null, 2),
      "",
      "RESULT PAYLOAD JSON SCHEMA:",
      JSON.stringify(resultSchema, null, 2),
      "",
      "FINAL RESPONSE CONTRACT:",
      "Return exactly one JSON object as the final assistant response.",
      "Do not use Markdown fences and do not write text before or after the object.",
      "The object must have exactly these top-level fields:",
      '{"schemaVersion":1,"signal":"<allowed signal>","summary":"<bounded summary>","requirementEvidence":[],"payload":{}}',
      `Allowed signal(s): ${task.allowedSignals.join(", ")}.`,
      "payload must satisfy the supplied result schema.",
      "Do not provide run, node, activation, or attempt identifiers; the core assigns them.",
    ].join("\n");
  }

  composeFormatRecovery(
    task: Readonly<TaskDefinition>,
    rejectedAssistantText: string,
    resultSchema: Readonly<JsonSchema>,
    reason: string
  ): string {
    return [
      "Convert the prior assistant response into the required JSON result envelope.",
      "This is output-format recovery only. Do not inspect or modify the workspace, call tools,",
      "repeat the task, add new evidence, or claim work not present in the prior response.",
      `Validation reason: ${reason}`,
      `Allowed signal(s): ${task.allowedSignals.join(", ")}.`,
      "RESULT PAYLOAD JSON SCHEMA:",
      JSON.stringify(resultSchema, null, 2),
      "PRIOR ASSISTANT RESPONSE:",
      rejectedAssistantText,
      "FINAL RESPONSE CONTRACT:",
      "Return one JSON object only, without Markdown fences or surrounding text.",
      "Use exactly schemaVersion, signal, summary, requirementEvidence, and payload.",
    ].join("\n");
  }
}
