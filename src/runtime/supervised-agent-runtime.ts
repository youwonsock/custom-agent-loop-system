import * as path from "node:path";
import * as fsp from "node:fs/promises";
import type {
  AgentRuntimeFailure,
  AgentRuntimePort,
  AgentRuntimeRequest,
  AgentRuntimeResponse,
} from "../application/ports/agent-runtime-port";
import type {
  ProviderCapabilityDecision,
  ProviderCapabilityRuntimePort,
} from "../application/ports/provider-capability-runtime-port";
import type {
  RunControlCommand,
  RunControlCommandPort,
} from "../application/ports/control-command";
import { SUPERVISED_AGENT_RUNTIME } from "./agent-runtime";
import {
  buildProviderInvocation,
  claudeMcpDocument,
  collectMcpSensitiveValues,
  collectSensitiveEnvironmentValues,
  enabledMcpServers,
  resolveMcpServerSecrets,
  type ProviderConfig,
  type ToolAccessConfig,
} from "./providers/provider-runtime";
import type { LoopDefaultsConfig } from "../config/runtime-config";
import { assertSafeSessionId, type FailureKind } from "../infrastructure/resilience";
import { initAttemptLog } from "./process-supervisor";
import { ProviderCapabilityRuntime } from "./provider-capability-runtime";

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
const SAFE_ATTEMPT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/u;

function ownedPathSegment(value: string | undefined, label: string, defaultValue: string): string {
  const candidate = value ?? defaultValue;
  if (
    !candidate.trim() ||
    path.isAbsolute(candidate) ||
    path.win32.isAbsolute(candidate) ||
    path.posix.isAbsolute(candidate) ||
    candidate.includes("\0") ||
    candidate.replace(/\\/gu, "/").split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`${label} must be a contained path segment.`);
  }
  return candidate;
}

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
  attemptLogsDirName?: string;
  runtimeInputsDirName?: string;
  secretValues?: Readonly<Record<string, string>>;
  providerCapabilityRuntime?: ProviderCapabilityRuntimePort;
  controls?: RunControlCommandPort;
  onChildPid?: (pid: number | null) => void;
}

export class SupervisedAgentRuntime implements AgentRuntimePort {
  private readonly capabilityRuntime: ProviderCapabilityRuntimePort;

  constructor(private readonly options: SupervisedAgentRuntimeOptions) {
    this.capabilityRuntime = options.providerCapabilityRuntime ?? new ProviderCapabilityRuntime();
  }

  async execute(request: AgentRuntimeRequest): Promise<AgentRuntimeResponse> {
    if (typeof request.runId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(request.runId)) {
      return {
        status: "failed",
        attemptId: request.attemptId,
        failure: {
          kind: "security",
          message: `Unsafe run id: ${request.runId}.`,
          retryable: false,
          providerStarted: false,
        },
      };
    }
    assertSafeSessionId(request.runId);
    if (!SAFE_ATTEMPT_ID.test(request.attemptId)) {
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
    // Formatting recovery is a separate, tool-free execution contract. Force
    // the explicit workspace mode here as well as at the task-runner call
    // site so adapters cannot accidentally inherit a task's read/write mode
    // when a caller omits the optional field.
    const workspaceMode = request.mode === "format_recovery"
      ? "none"
      : request.workspaceMode ?? request.toolPolicy.workspace;
    const toolsNone = workspaceMode === "none";
    let toolsNoneCapability: ProviderCapabilityDecision | undefined;
    if (toolsNone) {
      try {
        toolsNoneCapability = await this.capabilityRuntime.inspect(
          provider.adapter,
          provider.binary,
          "tools-none"
        );
      } catch (error) {
        return {
          status: "failed",
          attemptId: request.attemptId,
          failure: {
            kind: "permission",
            message: `Tool-free capability inspection failed: ${error instanceof Error ? error.message : String(error)}`,
            retryable: false,
            providerStarted: false,
          },
        };
      }
      if (toolsNoneCapability.status !== "verified") {
        const diagnostic = toolsNoneCapability.diagnostic
          ? ` ${toolsNoneCapability.diagnostic}`
          : "";
        return {
          status: "failed",
          attemptId: request.attemptId,
          failure: {
            kind: "permission",
            message:
              `Tool-free recovery is ${toolsNoneCapability.status}: ${toolsNoneCapability.reason}` +
              diagnostic,
            retryable: false,
            providerStarted: false,
          },
        };
      }
    }
    const selectedServers = toolsNone
      ? []
      : enabledMcpServers(
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
    const readOnly = toolsNone || request.toolPolicy.workspace !== "write";
    const dataRoot = path.resolve(this.options.runDataRoot);
    const runDirectory = path.resolve(dataRoot, request.runId);
    const runRelative = path.relative(dataRoot, runDirectory);
    if (!runRelative || runRelative.startsWith("..") || path.isAbsolute(runRelative)) {
      throw new Error(`Run path escapes the configured runtime data root: ${request.runId}.`);
    }
    const runtimeInputsName = ownedPathSegment(this.options.runtimeInputsDirName, "runtimeInputsDirName", "runtime_inputs");
    const runtimeInputDirectory = path.join(runDirectory, runtimeInputsName);
    if (toolsNone && provider.adapter === "kilo" && Buffer.byteLength(request.prompt, "utf8") > 8_000) {
      return {
        status: "failed",
        attemptId: request.attemptId,
        failure: {
          kind: "permission",
          message: "Kilo has no verified tool-free prompt transport for a prompt of this size.",
          retryable: false,
          providerStarted: false,
        },
      };
    }
    const promptFilePath = !toolsNone && provider.adapter === "kilo" && Buffer.byteLength(request.prompt, "utf8") > 8_000
      ? path.join(runtimeInputDirectory, `${request.attemptId}.prompt.md`)
      : undefined;
    const claudeMcpConfigPath = provider.adapter === "claude" && resolvedServers.length > 0
      ? path.join(runtimeInputDirectory, `${request.attemptId}.claude-mcp.json`)
      : undefined;
    const releaseRuntimeInputs = async (): Promise<void> => {
      const failures: unknown[] = [];
      await Promise.all(
        [promptFilePath, claudeMcpConfigPath]
          .filter((candidate): candidate is string => Boolean(candidate))
          .map(async (candidate) => {
            try { await fsp.rm(candidate, { force: true }); }
            catch (error) { failures.push(error); }
          })
      );
      if (failures.length > 0) throw new AggregateError(failures, "Runtime input release failed.");
    };
    let invocation;
    try {
      if (promptFilePath || claudeMcpConfigPath) {
      const directory = await fsp.stat(runtimeInputDirectory);
        if (!directory.isDirectory()) throw new Error(`Runtime input storage is not a directory: ${runtimeInputDirectory}`);
      }
      if (promptFilePath) {
        await fsp.writeFile(promptFilePath, request.prompt, { encoding: "utf8", mode: 0o600, flag: "wx" });
      }
      if (claudeMcpConfigPath) {
        await fsp.writeFile(
          claudeMcpConfigPath,
          JSON.stringify(claudeMcpDocument(resolvedServers), null, 2),
          { encoding: "utf8", mode: 0o600, flag: "wx" }
        );
      }
      invocation = buildProviderInvocation(provider, {
        model: request.agent.runtime.model,
        targetProjectPath: request.targetProjectPath,
        additionalAllowedPaths: readOnly ? [] : request.additionalAllowedPaths,
        prompt: request.prompt,
        variant: request.agent.runtime.variant,
        fullAccess: request.fullAccess && !readOnly && !toolsNone,
        readOnly,
        workspaceMode,
        webSearch:
          !toolsNone && request.toolPolicy.webSearch && this.options.toolAccess.webSearch.enabled,
        webSearchMode: this.options.toolAccess.webSearch.mode,
        mcpServers: resolvedServers,
        secretValues: { ...(this.options.secretValues ?? {}) },
        readOnlyAgentName: `agent-loop-${request.activationId}`,
        promptFilePath,
        claudeMcpConfigPath,
        toolsNoneCapability,
      });
    } catch (error) {
      try { await releaseRuntimeInputs(); }
      catch (releaseError) { throw new AggregateError([error, releaseError], "Provider setup and runtime input release failed."); }
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
    const attemptLogsName = ownedPathSegment(this.options.attemptLogsDirName, "attemptLogsDirName", "attempt_logs");
    const logDirectory = path.join(runDirectory, attemptLogsName);
    const rawLogPath = path.join(logDirectory, `${request.attemptId}.log`);
    const controlState: { claimed: RunControlCommand | null } = { claimed: null };
    if (this.options.controls) {
      try {
        await this.options.controls.recover(request.runId);
      } catch (error) {
        try { await releaseRuntimeInputs(); }
        catch (releaseError) { throw new AggregateError([error, releaseError], "Control recovery and runtime input release failed."); }
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
    try {
      await initAttemptLog(logDirectory);
    } catch (error) {
      try { await releaseRuntimeInputs(); }
      catch (releaseError) { throw new AggregateError([error, releaseError], "Attempt log initialization and runtime input release failed."); }
      return {
        status: "failed",
        attemptId: request.attemptId,
        failure: {
          kind: "permission",
          message: `Attempt log initialization failed: ${error instanceof Error ? error.message : String(error)}`,
          retryable: false,
          providerStarted: false,
        },
      };
    }
    let result!: Awaited<ReturnType<typeof SUPERVISED_AGENT_RUNTIME.launch>>;
    let launchError: unknown;
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
    } catch (error) {
      launchError = error;
    }
    try {
      this.options.onChildPid?.(null);
      await releaseRuntimeInputs();
    } catch (releaseError) {
      if (launchError !== undefined) throw new AggregateError([launchError, releaseError], "Provider launch and runtime input release failed.");
      throw releaseError;
    }
    if (launchError !== undefined) throw launchError;
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
