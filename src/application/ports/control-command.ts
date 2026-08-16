import type { RunControlCommand, RunControlType } from "../../domain/control-command";

export type { RunControlCommand, RunControlType } from "../../domain/control-command";

export interface RunControlCommandPort {
  enqueue(
    runId: string,
    type: RunControlType,
    message: string | null
  ): Promise<RunControlCommand>;
  recover(runId: string): Promise<void>;
  claim(runId: string): Promise<RunControlCommand | null>;
  complete(
    command: Readonly<RunControlCommand>,
    result: "completed" | "cancelled" | "failed",
    message: string | null
  ): Promise<void>;
}
