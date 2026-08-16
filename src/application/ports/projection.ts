import type { RunAggregate } from "../../domain/run-aggregate";

export interface ProjectionPort {
  update(aggregate: Readonly<RunAggregate>): Promise<void>;
}

export class NoopProjection implements ProjectionPort {
  update(_aggregate: Readonly<RunAggregate>): Promise<void> {
    return Promise.resolve();
  }
}
