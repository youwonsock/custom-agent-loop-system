export interface ProjectLease {
  leaseId: string;
  /** Generation token persisted with the lease record. */
  generation: string;
  /** Last successful lease heartbeat, expressed as Unix milliseconds. */
  updatedAt: number;
  roots: string[];
  /** Fail closed when another process replaced or removed this lease. */
  assertOwned?(): Promise<void>;
  release(): Promise<void>;
}

export interface ProjectLeasePort {
  acquire(
    projectRoots: readonly string[],
    ownerId: string,
    ttlMs: number
  ): Promise<ProjectLease>;
}
