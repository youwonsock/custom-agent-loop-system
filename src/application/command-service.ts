import type { RunAggregate, RunStatus } from "../domain/run-aggregate";
import type { HumanGateResponse } from "../domain/workflow";
import type { RunControlType } from "../domain/control-command";
import type { RunControlCommandPort } from "./ports/control-command";
import type { ProjectionPort } from "./ports/projection";
import type { RunRepositoryPort } from "./ports/run-repository";
import { RunReducer } from "./run-reducer";

const NOOP_CONTROLS: RunControlCommandPort = {
  enqueue: async () => {
    throw new Error("Run control commands are not configured.");
  },
  recover: async () => undefined,
  claim: async () => null,
  complete: async () => undefined,
};

export class CommandService {
  constructor(
    private readonly repository: RunRepositoryPort,
    private readonly reducer: RunReducer,
    private readonly projection: ProjectionPort,
    private readonly controls: RunControlCommandPort = NOOP_CONTROLS
  ) {}

  async respondToHumanGate(
    runId: string,
    response: HumanGateResponse
  ): Promise<RunAggregate> {
    const aggregate = await this.repository.load(runId);
    const candidate = this.reducer.applyHumanResponse(aggregate, response);
    const committed = await this.repository.commitOffline(
      candidate,
      aggregate.revision,
      response.requestId
    );
    await this.projection.update(committed);
    return committed;
  }

  async setRunStatus(
    runId: string,
    requestId: string,
    status: Extract<RunStatus, "RUNNING" | "PAUSED" | "STOPPED">,
    reason: string | null
  ): Promise<RunAggregate> {
    const aggregate = await this.repository.load(runId);
    const candidate = this.reducer.setStatus(
      aggregate,
      status,
      reason,
      new Date().toISOString()
    );
    const committed = await this.repository.commitOffline(
      candidate,
      aggregate.revision,
      requestId
    );
    await this.projection.update(committed);
    return committed;
  }

  async setAccessMode(
    runId: string,
    requestId: string,
    accessMode: "ask" | "full_access"
  ): Promise<RunAggregate> {
    const aggregate = await this.repository.load(runId);
    const candidate = this.reducer.setAccessMode(
      aggregate,
      accessMode,
      new Date().toISOString()
    );
    const committed = await this.repository.commitOffline(
      candidate,
      aggregate.revision,
      requestId
    );
    await this.projection.update(committed);
    return committed;
  }

  async resumeRun(runId: string, requestId: string, reason: string): Promise<RunAggregate> {
    const aggregate = await this.repository.load(runId);
    const candidate = this.reducer.resumeRun(
      aggregate,
      reason,
      new Date().toISOString()
    );
    const committed = await this.repository.commitOffline(
      candidate,
      aggregate.revision,
      requestId
    );
    await this.projection.update(committed);
    return committed;
  }

  async requestControl(
    runId: string,
    requestId: string,
    type: RunControlType,
    message: string | null
  ): Promise<{ aggregate: RunAggregate; queuedRequestId: string | null }> {
    for (let pass = 0; pass < 3; pass += 1) {
      const aggregate = await this.repository.load(runId);
      if (type === "stop" && ["STOPPED", "SUCCESS"].includes(aggregate.execution.status)) {
        return { aggregate, queuedRequestId: null };
      }
      if (type === "interrupt" && ["SUCCESS", "BLOCKED", "STOPPED"].includes(aggregate.execution.status)) {
        throw new Error(`Cannot interrupt a run while it is ${aggregate.execution.status}.`);
      }
      const activeId = aggregate.execution.activeActivationId;
      const active = activeId ? aggregate.nodeExecutions[activeId] : null;
      if (active?.status === "running") {
        const queued = await this.controls.enqueue(runId, type, message);
        return { aggregate, queuedRequestId: queued.requestId };
      }
      const candidate = this.reducer.applyBoundaryControl(
        aggregate,
        requestId,
        type,
        message,
        new Date().toISOString()
      );
      try {
        const committed = await this.repository.commitOffline(
          candidate,
          aggregate.revision,
          requestId
        );
        await this.projection.update(committed);
        return { aggregate: committed, queuedRequestId: null };
      } catch (error) {
        const latest = await this.repository.load(runId);
        if (latest.revision === aggregate.revision || pass === 2) throw error;
      }
    }
    throw new Error(`Could not apply ${type} control to run ${runId}.`);
  }
}
