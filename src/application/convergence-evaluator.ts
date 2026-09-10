import { createHash } from "node:crypto";
import { canonicalJson, type JsonValue } from "../domain/json";

export interface ConvergenceObservation {
  contractHash: string | null;
  /** Null means this observation did not reach a workflow stage. */
  reachedStep: number | null;
  failedCommandIds: string[];
  unsatisfiedRequirementIds: string[];
  unresolvedFindingIds: string[];
}

export interface ConvergenceState {
  contractHash: string | null;
  reachedStep: number | null;
  /** Highest step observed for this contract, used to detect regressions. */
  highestReachedStep?: number | null;
  failedCommandIds: string[];
  unsatisfiedRequirementIds: string[];
  unresolvedFindingIds: string[];
  stagnantCycles: number;
  history: Array<{ signature: string; improved: boolean; recordedAt: string }>;
}

export interface ConvergenceDecision {
  signature: string;
  improved: boolean;
  stagnantCycles: number;
  shouldInterrupt: boolean;
}

function sorted(values: ReadonlyArray<string>): string[] {
  return [...new Set(values)].sort();
}

function unresolvedCount(observation: ConvergenceObservation): number {
  return observation.failedCommandIds.length +
    observation.unsatisfiedRequirementIds.length +
    observation.unresolvedFindingIds.length;
}

function unresolvedSet(observation: Readonly<ConvergenceObservation>): Set<string> {
  return new Set([
    ...observation.failedCommandIds.map((id) => `command:${id}`),
    ...observation.unsatisfiedRequirementIds.map((id) => `requirement:${id}`),
    ...observation.unresolvedFindingIds.map((id) => `finding:${id}`),
  ]);
}

export function evaluateConvergence(
  previous: Readonly<ConvergenceState> | null,
  observation: Readonly<ConvergenceObservation>,
  recordedAt: string
): ConvergenceDecision {
  void recordedAt;
  const normalized: ConvergenceObservation = {
    contractHash: observation.contractHash,
    reachedStep: observation.reachedStep,
    failedCommandIds: sorted(observation.failedCommandIds),
    unsatisfiedRequirementIds: sorted(observation.unsatisfiedRequirementIds),
    unresolvedFindingIds: sorted(observation.unresolvedFindingIds),
  };
  const signature = createHash("sha256")
    .update(canonicalJson(normalized as unknown as JsonValue))
    .digest("hex");
  if (!previous) return { signature, improved: true, stagnantCycles: 0, shouldInterrupt: false };
  const sameContract = previous.contractHash === normalized.contractHash;
  const priorUnresolved = previous.failedCommandIds.length +
    previous.unsatisfiedRequirementIds.length +
    previous.unresolvedFindingIds.length;
  const currentUnresolved = unresolvedCount(normalized);
  const previousHighest = previous.highestReachedStep ?? previous.reachedStep;
  const highestBefore = previousHighest ?? null;
  const advanced = normalized.reachedStep !== null &&
    (highestBefore === null || normalized.reachedStep > highestBefore);
  // A null stage means the current cycle did not reach a comparable point.
  // Treat it as a regression when a prior observation did reach a stage so it
  // cannot be counted as progress merely because its unresolved set shrank.
  const retreated = normalized.reachedStep === null
    ? highestBefore !== null
    : highestBefore !== null && normalized.reachedStep < highestBefore;
  // A contract revision is a new comparison baseline.  It must not inherit
  // stagnation from a previous command set, while the workflow/cycle budgets
  // remain in the aggregate untouched.
  if (!sameContract) {
    return {
      signature,
      improved: true,
      stagnantCycles: 0,
      shouldInterrupt: false,
    };
  }
  const previousSet = unresolvedSet(previous);
  const currentSet = unresolvedSet(normalized);
  const removed = [...previousSet].some((item) => !currentSet.has(item));
  const introduced = [...currentSet].some((item) => !previousSet.has(item));
  const sameReachedStage = normalized.reachedStep !== null &&
    previous.reachedStep !== null && normalized.reachedStep === previous.reachedStep;
  const improved = !retreated && (
    (advanced && !introduced) ||
    (sameReachedStage && removed && !introduced && currentUnresolved < priorUnresolved)
  );
  const stagnantCycles = improved ? 0 : previous.stagnantCycles + 1;
  return {
    signature,
    improved,
    stagnantCycles,
    shouldInterrupt: stagnantCycles >= 2,
  };
}

export class ConvergenceEvaluator {
  evaluate(
    previous: Readonly<ConvergenceState> | null,
    observation: Readonly<ConvergenceObservation>,
    recordedAt: string
  ): ConvergenceDecision {
    return evaluateConvergence(previous, observation, recordedAt);
  }
}
