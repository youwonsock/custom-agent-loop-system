import { AttemptFailure } from "./resilience";

export class ImplementationPreflightError extends Error {
  constructor(
    readonly failure: AttemptFailure,
    readonly outsidePaths: string[]
  ) {
    super(failure.message);
    this.name = "ImplementationPreflightError";
  }
}

