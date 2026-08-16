import * as path from "node:path";
import * as fsp from "node:fs/promises";
import type {
  AgentRuntimeFailure,
  AgentRuntimePort,
  AgentRuntimeRequest,
  AgentRuntimeResponse,
} from "../application/ports/agent-runtime-port";
import type {
  RunControlCommand,
  RunControlCommandPort,
} from "../application/ports/control-command";
import { SUPERVISED_AGENT_RUNTIME } from "../../agent_runtime";
import {
  buildProviderInvocation,
  claudeMcpDocument,
  collectMcpSensitiveValues,
  collectSensitiveEnvironmentValues,
  enabledMcpServers,
  resolveMcpServerSecrets,
  type ProviderConfig,
  type ToolAccessConfig,
} from "../../provider_runtime";
import type { LoopDefaultsConfig } from "../../runtime_config";
import type { FailureKind } from "../../resilience";

const RETRYABLE_FAILURES = new Set<FailureKind>([
  "transport_timeout",
  "idle_timeout",
  "tool_timeout",
  "phase_timeout",
  "process_exit",
  "incomplete_response",
  "network",
  "rate_limited",
  "model_unavailable",
]);

function runtimeFailure(
  kind: FailureKind | null,
  message: string | null,
  providerStarted: boolean
): AgentRuntimeFailure {
  const normalized = kind ?? "unknown";
  return {
    kind: normalized === "permission"
      ? "permission"
      : normalized === "role_violation" || normalized === "orphaned_process"
        ? "security"
        : normalized.endsWith("timeout")
          ? "timeout"
          : "provider",
    message: message ?? `Provider execution failed with ${normalized}.`,
    retryable: RETRYABLE_FAILURES.has(normalized),
    providerStarted,
  };
}

function processEnvironment(extra: Readonly<Record<string, string>>): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] =>
        entry[1] !== undefined
      )
    ),
    ...extra,
  };
}

export interface SupervisedAgentRuntimeOptions {
  providers: Readonly<Record<string, ProviderConfig>>;
  toolAccess: Readonly<ToolAccessConfig>;
  defaults: Readonly<LoopDefaultsConfig>;
  destructivePrompts: readonly string[];
  runDataRoot: string;
  secretValues?: Readonly<Record<string, string>>;
  controls?: RunControlCommandPort;
  onChildPid?: (pid: number | null) => void;
}

export class SupervisedAgentRuntime implements AgentRuntimePort {
  constructor(private readonly options: SupervisedAgentRuntimeOptions) {}

  async execute(request: AgentRuntimeRequest): Promise<AgentRuntimeResponse> {
    const provider = this.options.providers[request.agent.runtime.provider];
    if (!provider?.enabled) {
      return {
        status: "failed",
        attemptId: request.attemptId,
        failure: {
          kind: "provider",
          message: `Provider '${request.agent.runtime.provider}' is missing or disabled.`,
          retryable: false,
          providerStarted: false,
        },
      };
    }
    const selectedServers = enabledMcpServers(
      this.options.toolAccess as ToolAccessConfig,
      request.toolPolicy.mcpServers
    );
    let resolvedServers;
    try {
      resolvedServers = resolveMcpServerSecrets(
        selectedServers,
        this.options.secretValues ?? {}
      );
    } catch (error) {
      return {
        status: "failed",
        attemptId: request.attemptId,
        failure: {
          kind: "permission",
          message: error instanceof Error ? error.message : String(error),
          retryable: false,
          providerStarted: false,
        },
      };
    }
    const readOnly = request.toolPolicy.workspace !== "write";
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/u.test(request.attemptId)) {
      return {
        status: "failed",
        attemptId: request.attemptId,
        failure: {
          kind: "security",
          message: `Unsafe attempt id: ${request.attemptId}.`,
          retryable: false,
          providerStarted: false,
        },
      };
    }
    const runtimeInputDirectory = path.resolve(
      this.options.runDataRoot,
      request.runId,
      "runtime_inputs"
    );
    const promptFilePath = provider.adapter === "kilo" && Buffer.byteLength(request.prompt, "utf8") > 8_000
      ? path.join(runtimeInputDirectory, `${request.attemptId}.prompt.md`)
      : undefined;
    const claudeMcpConfigPath = provider.adapter === "claude" && resolvedServers.length > 0
      ? path.join(runtimeInputDirectory, `${request.attemptId}.claude-mcp.json`)
      : undefined;
    const cleanupRuntimeInputs = async (): Promise<void> => {
      await Promise.all(
        [promptFilePath, claudeMcpConfigPath]
          .filter((candidate): candidate is string => Boolean(candidate))
          .map((candidate) => fsp.rm(candidate, { force: true }))
      ).catch(() => undefined);
    };
    let invocation;
    try {
      if (promptFilePath || claudeMcpConfigPath) {
        await fsp.mkdir(runtimeInputDirectory, { recursive: true });
      }
      if (promptFilePath) {
        await fsp.writeFile(promptFilePath, request.prompt, { encoding: "utf8", mode: 0o600 });
      }
      if (claudeMcpConfigPath) {
        await fsp.writeFile(
          claudeMcpConfigPath,
          JSON.stringify(claudeMcpDocument(resolvedServers), null, 2),
          { encoding: "utf8", mode: 0o600 }
        );
      }
      invocation = buildProviderInvocation(provider, {
        model: request.agent.runtime.model,
        targetProjectPath: request.targetProjectPath,
        additionalAllowedPaths: readOnly ? [] : request.additionalAllowedPaths,
        prompt: request.prompt,
        variant: request.agent.runtime.variant,
        fullAccess: request.fullAccess && !readOnly,
        readOnly,
        webSearch:
          request.toolPolicy.webSearch && this.options.toolAccess.webSearch.enabled,
        webSearchMode: this.options.toolAccess.webSearch.mode,
        mcpServers: resolvedServers,
        secretValues: { ...(this.options.secretValues ?? {}) },
        readOnlyAgentName: `agent-loop-${request.activationId}`,
        promptFilePath,
        claudeMcpConfigPath,
      });
    } catch (error) {
      await cleanupRuntimeInputs();
      return {
        status: "failed",
        attemptId: request.attemptId,
        failure: {
          kind: "security",
          message: error instanceof Error ? error.message : String(error),
          retryable: false,
          providerStarted: false,
        },
      };
    }
    const environment = processEnvironment(invocation.env);
    const sensitiveValues = [
      ...collectMcpSensitiveValues(resolvedServers),
      ...collectSensitiveEnvironmentValues(environment),
    ];
    const logDirectory = path.resolve(
      this.options.runDataRoot,
      request.runId,
      "attempt_logs"
    );
    const rawLogPath = path.join(logDirectory, `${request.attemptId}.log`);
    const controlState: { claimed: RunControlCommand | null } = { claimed: null };
    if (this.options.controls) {
      try {
        await this.options.controls.recover(request.runId);
      } catch (error) {
        await cleanupRuntimeInputs();
        return {
          status: "failed",
          attemptId: request.attemptId,
          failure: {
            kind: "security",
            message: `Control command recovery failed: ${error instanceof Error ? error.message : String(error)}`,
            retryable: false,
            providerStarted: false,
          },
        };
      }
    }
    let result: Awaited<ReturnType<typeof SUPERVISED_AGENT_RUNTIME.launch>>;
    try {
      result = await SUPERVISED_AGENT_RUNTIME.launch({
        binary: invocation.binary,
        args: invocation.args,
        cwd: request.targetProjectPath,
        env: environment,
        cols: this.options.defaults.ptyCols,
        rows: this.options.defaults.ptyRows,
        useConpty: false,
        transportTimeoutMs: this.options.defaults.transportTimeoutMs,
        idleTimeoutMs: this.options.defaults.idleTimeoutMs,
        toolTimeoutMs: this.options.defaults.toolTimeoutMs,
        phaseTimeoutMs: this.options.defaults.phaseTimeoutMs,
        terminationGraceMs: this.options.defaults.terminationGraceMs,
        killTimeoutMs: this.options.defaults.killTimeoutMs,
        maxInMemoryOutputBytes: this.options.defaults.maxInMemoryOutputBytes,
        rawLogPath,
        interactionWhitelist: provider.interactionWhitelist ?? [],
        destructivePrompts: [...this.options.destructivePrompts],
        sensitiveValues,
        pollControl: this.options.controls
          ? async () => {
              if (controlState.claimed) return null;
              controlState.claimed = await this.options.controls!.claim(request.runId);
              if (!controlState.claimed) return null;
              return {
                request: {
                  requestId: controlState.claimed.requestId,
                  type: controlState.claimed.type === "stop" ? "STOP" : "INTERRUPT",
                  createdAt: controlState.claimed.createdAt,
                  message: controlState.claimed.message,
                },
              };
            }
          : undefined,
        onProgress: (progress) => this.options.onChildPid?.(progress.childPid),
      });
    } finally {
      this.options.onChildPid?.(null);
      await cleanupRuntimeInputs();
    }
    const claimedControl = controlState.claimed;
    if (claimedControl !== null) {
      return {
        status: "failed",
        attemptId: request.attemptId,
        assistantText: result.assistantText || undefined,
        providerTranscript: result.output,
        failure: {
          kind: claimedControl.type === "stop" ? "stopped" : "interrupted",
          message: claimedControl.message ?? (
            claimedControl.type === "stop"
              ? "Operator stopped the run."
              : "Operator interrupted the run."
          ),
          retryable: false,
          providerStarted: result.pid > 0,
          controlCommand: { ...claimedControl },
        },
      };
    }
    if (result.outcome !== "succeeded" || result.exitCode !== 0) {
      return {
        status: "failed",
        attemptId: request.attemptId,
        assistantText: result.assistantText || undefined,
        providerTranscript: result.output,
        failure: runtimeFailure(
          result.failureKind,
          result.failureMessage,
          result.pid > 0
        ),
      };
    }
    return {
      status: "succeeded",
      attemptId: request.attemptId,
      assistantText: result.assistantText,
      providerTranscript: result.output,
    };
  }
}
