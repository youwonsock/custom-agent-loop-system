import type { RunAggregate } from "../domain/run-aggregate";
import type { ProjectionPort } from "./ports/projection";
import type { RunRepositoryPort } from "./ports/run-repository";
import { RunReducer } from "./run-reducer";

export class RecoveryService {
  constructor(
    private readonly repository: RunRepositoryPort,
    private readonly reducer: RunReducer,
    private readonly projection: ProjectionPort
  ) {}

  async recoverAfterOwnershipChange(runId: string): Promise<RunAggregate> {
    const aggregate = await this.repository.acquireFencingEpoch(runId);
    const activeId = aggregate.execution.activeActivationId;
    const activeNode = activeId
      ? aggregate.definition.nodes[aggregate.nodeExecutions[activeId]?.nodeId]
      : null;
    if (activeNode?.kind === "human_gate") return aggregate;
    const candidate = this.reducer.recoverStaleActivation(
      aggregate,
      new Date().toISOString()
    );
    if (JSON.stringify(candidate) === JSON.stringify(aggregate)) return aggregate;
    const committed = await this.repository.commit(
      candidate,
      aggregate.revision,
      aggregate.fencingEpoch
    );
    await this.projection.update(committed);
    return committed;
  }
}
