export interface WorkspaceFingerprint {
  digest: string;
  files: number;
  paths: string[];
  /** Empty directories are included in the digest even though they are not
   * file candidates for reapproval diffs. */
  directoryPaths?: string[];
  /** Per-path content digests used to classify reapproval diffs. */
  fileHashes?: Record<string, string>;
  /** File modes are part of the fingerprint and are retained for diagnostics. */
  fileModes?: Record<string, number>;
}

export interface WorkspaceWatch {
  readonly reliable: boolean;
  dirty(): boolean;
  close(): void;
}

export interface WorkspaceIntegrityPort {
  fingerprint(
    projectRoot: string,
    additionalRoots: readonly string[],
    excludedPaths: readonly string[]
  ): Promise<WorkspaceFingerprint>;
  watch(
    projectRoot: string,
    additionalRoots: readonly string[],
    excludedPaths: readonly string[]
  ): WorkspaceWatch;
}
