import type { NodeExecutionRecord, RunAggregate } from "./run-aggregate";

export interface VerificationActivationScope {
  verificationActivationId: string;
  verificationNodeId: string;
  cycleNumber: number | null;
  workflowStep: number;
  implementationActivationId: string | null;
  testActivationId: string | null;
}

function isVerificationExecution(
  aggregate: Readonly<RunAggregate>,
  execution: Readonly<NodeExecutionRecord>
): boolean {
  return aggregate.definition.nodes[execution.nodeId]?.kind === "verification";
}

function latestCompletedActivation(
  executions: ReadonlyArray<Readonly<NodeExecutionRecord>>,
  nodeId: string | undefined
): string | null {
  if (!nodeId) return null;
  return executions
    .filter((execution) => execution.nodeId === nodeId)
    .sort((left, right) => right.workflowStep - left.workflowStep)[0]?.activationId ?? null;
}

/**
 * Resolve the exact mutation activations covered by one verification round.
 * The scope is tied to the verification activation's persisted cycle and
 * workflow step, never to a global "latest" or conventional node name.
 */
export function resolveVerificationActivationScope(
  aggregate: Readonly<RunAggregate>,
  verificationActivationId: string
): VerificationActivationScope | null {
  const verification = aggregate.nodeExecutions[verificationActivationId];
  if (!verification || !isVerificationExecution(aggregate, verification)) return null;
  const mutations = Object.values(aggregate.nodeExecutions)
    .filter((execution) => {
      const node = aggregate.definition.nodes[execution.nodeId];
      return execution.status === "completed" &&
        execution.sideEffect === "workspace_mutation" &&
        node?.kind !== "verification" &&
        execution.workflowStep < verification.workflowStep &&
        (verification.cycleNumber === null || execution.cycleNumber === verification.cycleNumber);
    })
    .sort((left, right) => left.workflowStep - right.workflowStep);
  const policy = aggregate.definition.applicationPolicy;
  const implementationActivationId = policy.implementationNodeId
    ? latestCompletedActivation(mutations, policy.implementationNodeId)
    : mutations.length > 1
      ? mutations[mutations.length - 2].activationId
      : mutations[0]?.activationId ?? null;
  const testActivationId = policy.testNodeId
    ? latestCompletedActivation(mutations, policy.testNodeId)
    : mutations.length > 1
      ? mutations[mutations.length - 1].activationId
      : null;
  return {
    verificationActivationId,
    verificationNodeId: verification.nodeId,
    cycleNumber: verification.cycleNumber,
    workflowStep: verification.workflowStep,
    implementationActivationId,
    testActivationId,
  };
}

/** Find the most relevant verification scope for recovery/resume decisions. */
export function latestVerificationActivationScope(
  aggregate: Readonly<RunAggregate>
): VerificationActivationScope | null {
  const proofActivationId = aggregate.context.verificationProof
    ? Object.values(aggregate.nodeExecutions).find(
        (execution) => `${execution.activationId}_verification` ===
          aggregate.context.verificationProof?.verificationId
      )?.activationId
    : null;
  const activeActivationId = aggregate.execution.activeActivationId;
  const candidates = [
    activeActivationId,
    proofActivationId,
    ...Object.values(aggregate.nodeExecutions)
      .filter((execution) => isVerificationExecution(aggregate, execution))
      .sort((left, right) => right.workflowStep - left.workflowStep)
      .map((execution) => execution.activationId),
  ].filter((value): value is string => Boolean(value));
  for (const activationId of candidates) {
    const scope = resolveVerificationActivationScope(aggregate, activationId);
    if (scope) return scope;
  }
  return null;
}
