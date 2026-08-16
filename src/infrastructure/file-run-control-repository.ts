import * as path from "node:path";
import type {
  RunControlCommand,
  RunControlCommandPort,
  RunControlType,
} from "../application/ports/control-command";
import {
  claimNextControlRequest,
  completeControlRequest,
  enqueueControlRequest,
  getControlQueuePaths,
  recoverClaimedControlRequests,
  type ClaimedControlRequest,
  type ControlRequest,
} from "../../resilience";

const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

function externalType(type: RunControlType): ControlRequest["type"] {
  return type === "stop" ? "STOP" : "INTERRUPT";
}

function applicationType(type: ControlRequest["type"]): RunControlType {
  return type === "STOP" ? "stop" : "interrupt";
}

export class FileRunControlRepository implements RunControlCommandPort {
  constructor(
    private readonly runsRoot: string,
    private readonly controlDirectoryName = "control"
  ) {}

  async enqueue(
    runId: string,
    type: RunControlType,
    message: string | null
  ): Promise<RunControlCommand> {
    const request = await enqueueControlRequest(
      this.paths(runId),
      externalType(type),
      message
    );
    return this.toApplication(runId, request);
  }

  recover(runId: string): Promise<void> {
    return recoverClaimedControlRequests(this.paths(runId));
  }

  async claim(runId: string): Promise<RunControlCommand | null> {
    const claimed = await claimNextControlRequest(this.paths(runId));
    return claimed ? this.toApplication(runId, claimed.request) : null;
  }

  complete(
    command: Readonly<RunControlCommand>,
    result: "completed" | "cancelled" | "failed",
    message: string | null
  ): Promise<void> {
    const claimed: ClaimedControlRequest = {
      request: {
        requestId: command.requestId,
        type: externalType(command.type),
        createdAt: command.createdAt,
        message: command.message,
      },
    };
    return completeControlRequest(this.paths(command.runId), claimed, result, message);
  }

  private paths(runId: string) {
    if (!SAFE_RUN_ID.test(runId)) throw new Error(`Unsafe run id: ${runId}.`);
    const root = path.resolve(this.runsRoot);
    const runDirectory = path.resolve(root, runId);
    const relative = path.relative(root, runDirectory);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Run path escapes the configured root: ${runId}.`);
    }
    return getControlQueuePaths(runDirectory, this.controlDirectoryName);
  }

  private toApplication(runId: string, request: ControlRequest): RunControlCommand {
    return {
      schemaVersion: 1,
      requestId: request.requestId,
      runId,
      type: applicationType(request.type),
      message: request.message,
      createdAt: request.createdAt,
    };
  }
}
