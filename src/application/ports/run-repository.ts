import type { RunAggregate } from "../../domain/run-aggregate";

export interface RunRepositoryPort {
  init(aggregate: RunAggregate): Promise<RunAggregate>;
  load(runId: string): Promise<RunAggregate>;
  acquireFencingEpoch(runId: string): Promise<RunAggregate>;
  commit(
    aggregate: RunAggregate,
    expectedRevision: number,
    fencingEpoch: number
  ): Promise<RunAggregate>;
  commitOffline(
    aggregate: RunAggregate,
    expectedRevision: number,
    requestId: string
  ): Promise<RunAggregate>;
}
