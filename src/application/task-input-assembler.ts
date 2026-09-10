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

function inlineBytes(value: JsonValue): number {
  const serialized = JSON.stringify(value);
  return Buffer.byteLength(serialized === undefined ? "null" : serialized, "utf8");
}

function planApprovalNodeId(aggregate: NodeExecutionContext["aggregate"]): string | null {
  return Object.values(aggregate.definition.nodes).find(
    (node) => node.kind === "human_gate" && node.gate?.type === "plan_approval"
  )?.id ?? null;
}

function planningNodeId(aggregate: NodeExecutionContext["aggregate"]): string | null {
  const gateId = planApprovalNodeId(aggregate);
  const gate = gateId ? aggregate.definition.nodes[gateId] : null;
  const source = gate?.kind === "human_gate"
    ? gate.inputs.find((binding) => binding.source.kind === "node_output")
    : undefined;
  return source?.source.kind === "node_output" ? source.source.nodeId : null;
}

function verificationNodeId(aggregate: NodeExecutionContext["aggregate"]): string | null {
  return aggregate.definition.applicationPolicy.verificationNodeId ??
    Object.values(aggregate.definition.nodes).find((node) => node.kind === "verification")?.id ??
    null;
}

/**
 * Feedback is an input contract of its own.  Keep the original core record in
 * `payload`, while exposing the same envelope fields as a task result so a
 * provider cannot confuse a diagnostic with a fresh node output.  The
 * activation and artifact references stay attached to the envelope for audit
 * and bounded replay.
 */
function feedbackEnvelope(
  item: Readonly<import("../domain/verification").VerificationFeedback>,
  aggregate: NodeExecutionContext["aggregate"]
): JsonObject {
  const referencedArtifactIds = [...new Set(item.artifactIds ?? [])];
  for (const artifactId of referencedArtifactIds) {
    if (!aggregate.artifacts[artifactId]) {
      throw new Error(`Feedback references unavailable artifact ${artifactId}.`);
    }
  }
  const evidence = aggregate.context.requirementEvidence
    .filter((candidate) => item.requirementIds.includes(candidate.requirementId))
    .slice(-200)
    .map((candidate) => ({
      requirementId: candidate.requirementId,
      status: candidate.status,
      evidence: candidate.evidence,
      artifactIds: candidate.artifactIds.map((artifactId) => {
        if (!aggregate.artifacts[artifactId]) {
          throw new Error(`Feedback requirement evidence references unavailable artifact ${artifactId}.`);
        }
        return artifactId;
      }),
    }));
  const summary = item.diagnostics.join("; ").slice(0, 8_000) ||
    `${item.verificationId} ${item.passed ? "passed" : "failed"}.`;
  return {
    // Preserve the original feedback fields at the envelope level for
    // existing consumers while adding the explicit signal/summary/payload
    // contract required by feedback-only bindings.
    ...(JSON.parse(JSON.stringify(item)) as JsonObject),
    signal: item.passed ? "pass" : "fail",
    summary,
    requirementEvidence: evidence as unknown as JsonValue,
    payload: JSON.parse(JSON.stringify(item)) as JsonValue,
    sourceActivationId: item.sourceActivationId,
    artifactIds: referencedArtifactIds.slice(0, 64),
  };
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
        if (binding.required) {
          throw new Error(`Required input ${binding.name} is unavailable.`);
        }
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
        verification_contract: context.aggregate.context.verificationContract as unknown as JsonValue,
        verification_result: context.aggregate.context.verificationProof as unknown as JsonValue,
        verification_feedback: context.aggregate.context.verificationFeedback
          .map((item) => feedbackEnvelope(item, context.aggregate)) as unknown as JsonValue,
        verification_criteria_changes: (context.aggregate.context.verificationCriteriaChanges ?? []) as unknown as JsonValue,
        previous_cycle_feedback: context.aggregate.context.verificationFeedback
          .filter((item) => {
            const currentCycle = context.aggregate.execution.activeCycleNumber;
            // Once a cycle is active, only feedback with an explicit older
            // cycle number belongs in this binding. Unknown/legacy cycle
            // metadata is not silently promoted to "previous" feedback.
            return currentCycle === null ||
              (item.cycleNumber !== undefined && item.cycleNumber !== null && item.cycleNumber < currentCycle);
          })
          .map((item) => ({
            ...item,
            ...feedbackEnvelope(item, context.aggregate),
          })) as unknown as JsonValue,
        open_findings: context.aggregate.context.findings as unknown as JsonValue,
      };
      const inlineValue = runContextValues[source.key] ?? null;
      // A required run-context binding must represent an available value.
      // Keeping a missing contract as JSON null would satisfy the structural
      // schema while allowing a task to start before plan approval created
      // the core-owned verification contract.
      if (inlineValue === null) return null;
      return {
        value: inlineValue,
        activationId: null,
        artifactId: null,
        bytesLoaded: inlineBytes(inlineValue),
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
      const value = (failure ?? { kind: "internal", message: "No failure was recorded." }) as unknown as JsonValue;
      return {
        value,
        activationId: null,
        artifactId: null,
        bytesLoaded: inlineBytes(value),
        sourceId: "current_failure",
      };
    }
    if (source.kind === "recovery") {
      const value = context.aggregate.context.recovery;
      return {
        value,
        activationId: null,
        artifactId: null,
        bytesLoaded: inlineBytes(value),
        sourceId: "current_recovery",
      };
    }
    if (source.kind === "feedback") {
      const approvalNodeId = planApprovalNodeId(context.aggregate);
      const response = approvalNodeId
        ? context.aggregate.context.humanResponses[approvalNodeId]
        : undefined;
      const responseValue = response?.value && typeof response.value === "object" && !Array.isArray(response.value)
        ? response.value as Record<string, unknown>
        : null;
      const responseArtifactIds = Array.isArray(responseValue?.artifactIds)
        ? responseValue.artifactIds.map((value) => {
            if (typeof value !== "string" || !context.aggregate.artifacts[value]) {
              throw new Error(
                `Feedback references unavailable artifact ${String(value)}.`
              );
            }
            return value;
          })
        : [];
      const planningNode = planningNodeId(context.aggregate);
      const planningActivationId = planningNode
        ? context.aggregate.latestCompletedByNode[planningNode]
        : undefined;
      const planningArtifactId = planningActivationId
        ? context.aggregate.nodeExecutions[planningActivationId]?.output?.artifactId
        : null;
      const priorCycleItems = context.aggregate.context.verificationFeedback.filter((item) => {
        const currentCycle = context.aggregate.execution.activeCycleNumber;
        return currentCycle === null ||
          (item.cycleNumber !== undefined && item.cycleNumber !== null && item.cycleNumber < currentCycle);
      });
      const priorCycleEnvelopes = priorCycleItems.map((item) => ({
        ...item,
        ...feedbackEnvelope(item, context.aggregate),
        payload: {
          ...item,
          diagnostics: item.diagnostics.slice(0, 8),
        } as unknown as JsonValue,
      }));
      const feedback = source.scope === "planning"
        ? response
          ? {
              signal: response.signal,
              summary: typeof response.value === "string"
                ? response.value
                : response.value && typeof response.value === "object" && !Array.isArray(response.value) &&
                    typeof (response.value as Record<string, unknown>).summary === "string"
                  ? String((response.value as Record<string, unknown>).summary)
                  : "",
              requirementEvidence: response.value && typeof response.value === "object" && !Array.isArray(response.value) &&
                  Array.isArray((response.value as Record<string, unknown>).requirementEvidence)
                ? (response.value as Record<string, unknown>).requirementEvidence
                : [],
              payload: response.value ?? null,
              requestId: response.requestId,
              sourceActivationId: approvalNodeId
                ? context.aggregate.latestCompletedByNode[approvalNodeId] ?? null
                : null,
              artifactIds: [...new Set([
                ...responseArtifactIds,
                ...(planningArtifactId && context.aggregate.artifacts[planningArtifactId]
                  ? [planningArtifactId]
                  : []),
              ])].slice(0, 32),
            }
          : null
        : source.scope === "previous_cycle"
          ? priorCycleEnvelopes
          : {
            verification: context.aggregate.context.verificationFeedback
              .filter((item) => priorCycleItems.includes(item))
              .map((item) => priorCycleEnvelopes.find((candidate) => candidate.verificationId === item.verificationId) ?? feedbackEnvelope(item, context.aggregate)),
            findings: context.aggregate.context.findings
              .filter((finding) => finding.status === "open")
              .map((finding) => ({
                id: finding.id,
                text: finding.text,
                source: finding.source,
                artifactIds: [...finding.artifactIds],
              })),
            failure: context.aggregate.execution.lastFailure,
            sourceActivationId: (() => {
              const nodeId = verificationNodeId(context.aggregate);
              return nodeId ? context.aggregate.latestCompletedByNode[nodeId] ?? null : null;
            })(),
          };
      const value = feedback as unknown as JsonValue;
      return {
        value,
        activationId: null,
        artifactId: null,
        bytesLoaded: inlineBytes(value),
        sourceId: source.scope,
      };
    }
    const response = context.aggregate.context.humanResponses[source.nodeId];
    if (!response) return null;
    const value = response as unknown as JsonValue;
    return {
      value,
      activationId: null,
      artifactId: null,
      bytesLoaded: inlineBytes(value),
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
