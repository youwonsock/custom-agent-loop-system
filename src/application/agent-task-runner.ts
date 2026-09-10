import type { ResolvedAgentDefinition } from "../domain/agent";
import type { TaskDefinition } from "../domain/task";
import {
  FORMAT_RECOVERY_TOOL_POLICY,
  intersectToolPolicies,
} from "../domain/tool-policy";
import type {
  ArtifactReference,
  NodeFailure,
  TaskExecutionResult,
  TaskResultEnvelopeV1,
} from "../domain/task-result";
import type { DefinitionRegistries } from "../definitions/registries";
import type { NodeExecutionContext } from "./node-execution-context";
import type { AgentRuntimePort, AgentRuntimeResponse } from "./ports/agent-runtime-port";
import type { ArtifactStorePort } from "./ports/artifact-store";
import { PromptComposer } from "./prompt-composer";
import { TaskInputAssembler } from "./task-input-assembler";
import { TaskResultParser, TaskResultValidationError } from "./task-result-parser";

function failedResult(
  failure: NodeFailure,
  artifacts: ArtifactReference[]
): TaskExecutionResult {
  return {
    status: failure.kind === "security"
      ? "blocked"
      : failure.kind === "stopped"
        ? "stopped"
        : "failed",
    signal: "error",
    output: null,
    effects: [],
    artifacts,
    failure,
    pendingInput: null,
  };
}

function validationFailure(
  error: unknown,
  task: Readonly<TaskDefinition>,
  attemptId: string
): NodeFailure {
  if (error instanceof TaskResultValidationError) {
    return {
      kind: error.kind === "format" ? "format" : "schema",
      message: error.message,
      retryable: false,
      ambiguousMutation: task.sideEffect === "workspace_mutation",
      attemptId,
    };
  }
  return {
    kind: "guardrail",
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
    ambiguousMutation: task.sideEffect === "workspace_mutation",
    attemptId,
  };
}

function accessApprovalResult(
  context: Readonly<NodeExecutionContext>,
  response: Extract<AgentRuntimeResponse, { status: "failed" }>,
  artifacts: ArtifactReference[]
): TaskExecutionResult {
  const requestedPaths = [
    ...response.failure.message.matchAll(/[A-Za-z]:\\[^?\r\n"'<>|]+/gu),
    ...response.failure.message.matchAll(/(?:^|[\s("'`])((?:\/[^?\s"'<>|]+)+)/gu),
  ]
    .map((match) => String(match[1] ?? match[0]).trim().replace(/[\s,.;:!\])}]+$/u, ""))
    .filter((value) => /^[A-Za-z]:[\\/]/u.test(value) || /^\/(?!\/)/u.test(value));
  return {
    status: "waiting_user",
    signal: null,
    output: null,
    effects: [],
    artifacts,
    failure: null,
    pendingInput: {
      requestId: `access_${response.attemptId}`,
      kind: "access_approval",
      nodeId: context.node.id,
      activationId: context.activationId,
      prompt:
        "The provider stopped at an access boundary. Retry with the approved scope or grant full access.",
      allowedSignals: ["retry", "full_access"],
      context: {
        failure: response.failure.message,
        requestedPaths: [...new Set(requestedPaths)],
      },
      createdAt: new Date().toISOString(),
    },
  };
}

export interface AgentTaskRunner {
  run(
    context: Readonly<NodeExecutionContext>,
    agent: Readonly<ResolvedAgentDefinition>,
    task: Readonly<TaskDefinition>
  ): Promise<TaskExecutionResult>;
}

export class DefaultAgentTaskRunner implements AgentTaskRunner {
  private readonly parser: TaskResultParser;

  constructor(
    private readonly runtime: AgentRuntimePort,
    private readonly artifacts: ArtifactStorePort,
    private readonly assembler: TaskInputAssembler,
    private readonly composer: PromptComposer,
    private readonly registries: DefinitionRegistries
  ) {
    this.parser = new TaskResultParser(registries.schemas);
  }

  async run(
    context: Readonly<NodeExecutionContext>,
    agent: Readonly<ResolvedAgentDefinition>,
    task: Readonly<TaskDefinition>
  ): Promise<TaskExecutionResult> {
    let assembled;
    let toolPolicy;
    try {
      assembled = await this.assembler.assemble(context, task.inputSchemaId);
      toolPolicy = intersectToolPolicies(agent.toolPolicy, task.toolPolicy);
    } catch (error) {
      return failedResult(
        {
          kind: "schema",
          message: error instanceof Error ? error.message : String(error),
          retryable: false,
          ambiguousMutation: false,
          attemptId: context.attemptId,
        },
        []
      );
    }
    if (task.sideEffect === "workspace_mutation" && agent.access !== "workspace_write") {
      return failedResult(
        {
          kind: "security",
          message: `Mutation task ${task.id} cannot execute with read-only agent ${agent.id}.`,
          retryable: false,
          ambiguousMutation: false,
          attemptId: context.attemptId,
        },
        []
      );
    }
    const resultSchema = this.registries.schemas.get(task.resultSchemaId);
    const prompt = this.composer.compose(agent, task, assembled, resultSchema);
    const response = await this.runtime.execute({
      runId: context.aggregate.runId,
      nodeId: context.node.id,
      activationId: context.activationId,
      attemptId: context.attemptId,
      taskId: task.id,
      agent,
      prompt,
      toolPolicy,
      mode: "task",
      workspaceMode: toolPolicy.workspace,
      targetProjectPath: context.aggregate.context.targetProjectPath,
      additionalAllowedPaths: context.aggregate.context.additionalAllowedPaths,
      fullAccess: context.aggregate.context.accessMode === "full_access",
    });
    const storedArtifacts = await this.storeProviderEvidence(response);
    if (response.status === "failed") {
      if (response.failure.kind === "permission" && response.failure.providerStarted) {
        return accessApprovalResult(context, response, storedArtifacts);
      }
      return failedResult(
        {
          kind: response.failure.kind,
          message: response.failure.message,
          retryable: response.failure.retryable,
          ambiguousMutation:
            task.sideEffect === "workspace_mutation" && response.failure.providerStarted,
          attemptId: response.attemptId,
          ...(response.failure.controlCommand
            ? { controlCommand: { ...response.failure.controlCommand } }
            : {}),
        },
        storedArtifacts
      );
    }

    let envelope: TaskResultEnvelopeV1;
    let acceptedAttemptId = response.attemptId;
    try {
      envelope = this.parser.parse(response.assistantText, task);
    } catch (initialError) {
      if (
        !(initialError instanceof TaskResultValidationError) ||
        !["format", "schema"].includes(initialError.kind) ||
        task.retryPolicy.formatRecoveryAttempts !== 1
      ) {
        return failedResult(
          validationFailure(initialError, task, response.attemptId),
          storedArtifacts
        );
      }
      const recoveryAttemptId = `${context.attemptId}_format_1`;
      const recovery = await this.runtime.execute({
        runId: context.aggregate.runId,
        nodeId: context.node.id,
        activationId: context.activationId,
        attemptId: recoveryAttemptId,
        taskId: task.id,
        agent,
        prompt: this.composer.composeFormatRecovery(
          task,
          response.assistantText,
          resultSchema,
          initialError.message
        ),
        toolPolicy: FORMAT_RECOVERY_TOOL_POLICY,
        mode: "format_recovery",
        workspaceMode: "none",
        targetProjectPath: context.aggregate.context.targetProjectPath,
        additionalAllowedPaths: [],
        fullAccess: false,
      });
      storedArtifacts.push(...(await this.storeProviderEvidence(recovery)));
      if (recovery.status === "failed") {
        return failedResult(
          {
            kind: recovery.failure.kind,
            message: `Format-only recovery failed: ${recovery.failure.message}`,
            retryable: false,
            ambiguousMutation: task.sideEffect === "workspace_mutation",
            attemptId: recovery.attemptId,
            ...(recovery.failure.controlCommand
              ? { controlCommand: { ...recovery.failure.controlCommand } }
              : {}),
          },
          storedArtifacts
        );
      }
      try {
        envelope = this.parser.parse(recovery.assistantText, task);
        acceptedAttemptId = recovery.attemptId;
      } catch (recoveryError) {
        return failedResult(
          validationFailure(recoveryError, task, recovery.attemptId),
          storedArtifacts
        );
      }
      if (task.sideEffect === "workspace_mutation") {
        // The recovery invocation is deliberately tool-free and can repair
        // only the response format. It cannot establish what the original
        // mutation-capable provider did to the workspace, so accepting its
        // parsed envelope would clear an unknown mutation boundary and could
        // let the workflow advance toward SUCCESS without a fresh core
        // verification pass.
        return failedResult(
          {
            kind: "unknown_mutation",
            message:
              "Format recovery produced a valid response, but the original workspace mutation outcome is unknown.",
            retryable: false,
            ambiguousMutation: true,
            attemptId: response.attemptId,
          },
          storedArtifacts
        );
      }
    }

    try {
      for (const reference of task.guardrails) {
        await this.registries.guardrails.get(reference.id)({
          aggregate: context.aggregate,
          agent,
          task,
          input: assembled.value,
          envelope,
          reference,
        });
      }
    } catch (error) {
      return failedResult(validationFailure(error, task, acceptedAttemptId), storedArtifacts);
    }

    const envelopeArtifact = await this.artifacts.put(
      JSON.stringify(envelope, null, 2),
      "application/vnd.custom-agent-loop.task-result+json;version=1"
    );
    storedArtifacts.push(envelopeArtifact);
    const output = {
      activationId: context.activationId,
      artifactId: envelopeArtifact.artifactId,
      schemaId: task.resultSchemaId,
      signal: envelope.signal,
      summary: envelope.summary,
    };
    const effects = task.effectMapper
      ? await this.registries.effectMappers.get(task.effectMapper)({
          aggregate: context.aggregate,
          task,
          envelope,
          output,
        })
      : [];
    return {
      status: "succeeded",
      signal: envelope.signal,
      output,
      effects,
      artifacts: storedArtifacts,
      failure: null,
      pendingInput: null,
    };
  }

  private async storeProviderEvidence(
    response: AgentRuntimeResponse
  ): Promise<ArtifactReference[]> {
    const artifacts: ArtifactReference[] = [];
    if (response.providerTranscript !== undefined) {
      artifacts.push(
        await this.artifacts.put(response.providerTranscript, "text/plain;profile=provider-transcript")
      );
    }
    const assistantText = response.assistantText;
    if (assistantText !== undefined) {
      artifacts.push(
        await this.artifacts.put(assistantText, "text/plain;profile=assistant-final-response")
      );
    }
    return artifacts;
  }
}
