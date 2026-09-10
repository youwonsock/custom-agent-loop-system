/**
 * Neutral operator projection entry point.
 *
 * The implementation keeps the current file names while exposing the 7.0
 * projection schema/state contract through a neutral operator-facing entry
 * point.
 */
export {
  FileRunProjection,
  initPlanOutput,
  type FileProjectionOptions,
  type RunProjection,
  type SessionIndexProjection,
  type RunProjectionV2,
  type SessionIndexProjectionV4,
} from "./run-projection-impl";
export {
  type OperatorSnapshotV3,
  type ProviderDiscoveryResultV2,
  validateRunProjectionV2,
  validateSessionIndexProjectionV4,
  validateProviderDiscoveryResultV2,
  validateOperatorSnapshotV3,
  createOperatorSnapshotV3,
  createEmptySessionIndexProjection,
  emptyOperatorSnapshot,
} from "./contracts";
