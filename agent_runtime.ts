import { resolveBinaryForSpawn } from "./binary_resolution";
import {
  ProcessSupervisor,
  ProcessSupervisorOptions,
  SupervisorResult,
} from "./process_supervisor";

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
