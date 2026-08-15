import { BuiltinModelRole, PipelineStageType } from "./pipeline";
import { resolveBinaryForSpawn } from "./binary_resolution";
import {
  ProcessSupervisor,
  ProcessSupervisorOptions,
  SupervisorResult,
} from "./process_supervisor";
import { AgentAttemptState, ClaimedControlRequest, FailureKind } from "./resilience";
import type { StructuredStageOutcomeObservation } from "./stage_outcome";

export interface AgentRunResult {
  pid: number;
  exitCode: number;
  output: string;
  events: Record<string, unknown>[];
  timedOut: boolean;
  cancelled: boolean;
  autoInjected: { prompt: string; response: string; timestamp: string }[];
  outcome?: AgentAttemptState["status"];
  failureKind?: FailureKind | null;
  failureMessage?: string | null;
  assistantText?: string;
  cliSessionId?: string | null;
  rawLogPath?: string;
  controlRequest?: ClaimedControlRequest | null;
  structuredStageOutcome?: StructuredStageOutcomeObservation;
}

export interface AgentRuntimeRequest {
  role: string;
  prompt: string;
  maxAttempts?: number;
  stageType: PipelineStageType;
  modelRole?: BuiltinModelRole;
  planOptionsCount?: number;
}

export interface AgentExecutionCoordinator<TResult> {
  execute(request: AgentRuntimeRequest): Promise<TResult>;
}

export class CurrentAgentExecutionCoordinator<TResult> implements AgentExecutionCoordinator<TResult> {
  constructor(
    private readonly executeCurrent: (request: AgentRuntimeRequest) => Promise<TResult>
  ) {}

  execute(request: AgentRuntimeRequest): Promise<TResult> {
    return this.executeCurrent(request);
  }
}

/**
 * The only live provider-process launch boundary. Keeping the supervisor behind
 * this runtime makes process-tree containment, logging, redaction, and watchdogs
 * impossible for an adapter call site to accidentally bypass.
 */
export class AgentRuntime {
  constructor(
    private readonly createSupervisor: () => ProcessSupervisor = () => new ProcessSupervisor()
  ) {}

  launch(options: ProcessSupervisorOptions): Promise<SupervisorResult> {
    return this.createSupervisor().run({
      ...options,
      binary: resolveBinaryForSpawn(options.binary),
    });
  }
}

export const SUPERVISED_AGENT_RUNTIME = new AgentRuntime();
