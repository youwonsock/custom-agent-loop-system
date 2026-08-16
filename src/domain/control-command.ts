export type RunControlType = "stop" | "interrupt";

export interface RunControlCommand {
  schemaVersion: 1;
  requestId: string;
  runId: string;
  type: RunControlType;
  message: string | null;
  createdAt: string;
}
