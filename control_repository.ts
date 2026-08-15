import {
  ClaimedControlRequest,
  ControlQueuePaths,
  claimNextControlRequest,
  completeControlRequest,
  ensureControlQueue,
  importLegacyControlFiles,
  recoverClaimedControlRequests,
} from "./resilience";

export type ControlCompletionResult = "completed" | "cancelled" | "failed";

export interface ControlRepository {
  initialize(): Promise<void>;
  recoverClaims(): Promise<void>;
  importLegacy(stopRequestPath: string, interruptMessagePath: string): Promise<void>;
  claimNext(): Promise<ClaimedControlRequest | null>;
  complete(
    claimed: ClaimedControlRequest,
    result: ControlCompletionResult,
    message: string
  ): Promise<void>;
}

export class FileControlRepository implements ControlRepository {
  constructor(private readonly paths: ControlQueuePaths) {}

  initialize(): Promise<void> {
    return ensureControlQueue(this.paths);
  }

  recoverClaims(): Promise<void> {
    return recoverClaimedControlRequests(this.paths);
  }

  importLegacy(stopRequestPath: string, interruptMessagePath: string): Promise<void> {
    return importLegacyControlFiles(this.paths, stopRequestPath, interruptMessagePath);
  }

  claimNext(): Promise<ClaimedControlRequest | null> {
    return claimNextControlRequest(this.paths);
  }

  complete(
    claimed: ClaimedControlRequest,
    result: ControlCompletionResult,
    message: string
  ): Promise<void> {
    return completeControlRequest(this.paths, claimed, result, message);
  }
}

