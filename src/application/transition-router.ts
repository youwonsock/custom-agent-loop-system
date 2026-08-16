import type { RunStatus } from "../domain/run-aggregate";
import type { CompiledWorkflowBundle } from "../domain/workflow";

export interface TransitionRoute {
  targetId: string;
  terminalStatus: RunStatus | null;
}

const TERMINAL_STATUS: Record<string, RunStatus> = {
  succeeded: "SUCCESS",
  paused: "PAUSED",
  blocked: "BLOCKED",
  stopped: "STOPPED",
};

export class TransitionRouter {
  route(
    definition: Readonly<CompiledWorkflowBundle>,
    nodeId: string,
    signal: string
  ): TransitionRoute {
    const targetId = definition.transitions[nodeId]?.[signal];
    if (!targetId) {
      throw new Error(`No transition exists for ${nodeId}.${signal}.`);
    }
    const terminal = definition.terminals.find((candidate) => candidate.id === targetId);
    return {
      targetId,
      terminalStatus: terminal ? TERMINAL_STATUS[terminal.status] ?? null : null,
    };
  }
}
