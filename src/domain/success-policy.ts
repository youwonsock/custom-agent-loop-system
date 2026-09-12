import type { RunAggregate } from "./run-aggregate";
import { resolveVerificationActivationScope } from "./verification-activation-scope";

export class SuccessEligibilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SuccessEligibilityError";
  }
}

/** All compiled v8 workflows require the core-owned verification path. */
export function requiresCoreVerification(aggregate: Readonly<RunAggregate>): boolean {
  if (typeof aggregate.definition.applicationPolicy.verificationNodeId !== "string" || !aggregate.definition.applicationPolicy.verificationNodeId) {
    throw new SuccessEligibilityError("Compiled workflow is missing the required verification node policy.");
  }
  return true;
}

function expectedVerificationActivations(aggregate: Readonly<RunAggregate>): {
  implementation: string | null;
  test: string | null;
} {
  const proof = aggregate.context.verificationProof;
  const verificationActivationId = proof
    ? Object.values(aggregate.nodeExecutions).find(
        (execution) => `${execution.activationId}_verification` === proof.verificationId
      )?.activationId
    : null;
  const scope = verificationActivationId
    ? resolveVerificationActivationScope(aggregate, verificationActivationId)
    : null;
  return {
    implementation: scope?.implementationActivationId ?? null,
    test: scope?.testActivationId ?? null,
  };
}

export function assertSuccessEligible(aggregate: Readonly<RunAggregate>): void {
  requiresCoreVerification(aggregate);
  if (!aggregate.context.approvedPlan || !aggregate.context.selectedPlanChoiceId) {
    throw new SuccessEligibilityError("SUCCESS requires an approved plan and selected plan choice.");
  }
  const proof = aggregate.context.verificationProof;
  if (!proof || !proof.passed || !proof.watcherReliable || proof.executionError) {
    throw new SuccessEligibilityError("SUCCESS requires a valid core verification proof.");
  }
  if (proof.contractRevision !== aggregate.context.verificationContract?.revision) {
    throw new SuccessEligibilityError("Verification proof uses an obsolete contract revision.");
  }
  if (proof.contractHash !== aggregate.context.verificationContract?.contractHash) {
    throw new SuccessEligibilityError("Verification proof uses an obsolete contract hash.");
  }
  if (proof.baselineFingerprint !== aggregate.context.verificationContract?.baselineFingerprint ||
      proof.beforeFingerprint !== proof.afterFingerprint) {
    throw new SuccessEligibilityError("Verification proof does not match the approved file baseline.");
  }
  const expectedActivations = expectedVerificationActivations(aggregate);
  const proofVerificationActivation = Object.values(aggregate.nodeExecutions).find(
    (execution) => `${execution.activationId}_verification` === proof.verificationId
  );
  if (
    !proofVerificationActivation ||
    proofVerificationActivation.nodeId !== aggregate.definition.applicationPolicy.verificationNodeId
  ) {
    throw new SuccessEligibilityError("Verification proof was not produced by the configured verification node.");
  }
  const latestImplementation = expectedActivations.implementation;
  const latestTest = expectedActivations.test;
  if (latestImplementation === null || latestTest === null) {
    throw new SuccessEligibilityError("SUCCESS requires proof for the current implementation and test activations.");
  }
  // Custom definitions use the configured implementation/test role IDs. A
  // missing role activation is therefore an invalid proof; every present
  // activation must still name exactly that latest activation.
  if ((latestImplementation !== null && proof.implementationActivationId !== latestImplementation) ||
      (latestTest !== null && proof.testActivationId !== latestTest) ||
      (latestImplementation === null && proof.implementationActivationId !== null) ||
      (latestTest === null && proof.testActivationId !== null)) {
    throw new SuccessEligibilityError("Verification proof does not cover the latest implementation and test activations.");
  }
  if (aggregate.context.verificationInvalidationReason) {
    throw new SuccessEligibilityError(
      `Verification proof was invalidated: ${aggregate.context.verificationInvalidationReason}`
    );
  }
  if (aggregate.context.verificationCriteriaChanges.length > 0) {
    throw new SuccessEligibilityError("Pending verification criteria changes prevent success.");
  }
  if (aggregate.context.reviewApprovals.length < 2) {
    throw new SuccessEligibilityError("SUCCESS requires QA and master approvals.");
  }
  const approvals = aggregate.context.reviewApprovals.slice(-2);
  if (
    approvals[0].stage !== "qa" ||
    approvals[1].stage !== "master" ||
    approvals.some(
      (approval) =>
        approval.proofId !== proof.proofId ||
        approval.contractRevision !== proof.contractRevision
    )
  ) {
    throw new SuccessEligibilityError("QA and master approvals must reference the current proof.");
  }
  if (aggregate.context.findings.some((finding) => finding.status === "open")) {
    throw new SuccessEligibilityError("SUCCESS cannot contain unresolved findings.");
  }
  if (aggregate.pendingInput || aggregate.context.verificationCandidate) {
    throw new SuccessEligibilityError("A pending verification decision prevents success.");
  }
  if (Object.values(aggregate.nodeExecutions).some((execution) => execution.status === "unknown_mutation")) {
    throw new SuccessEligibilityError("An unknown mutation prevents success.");
  }
  const latestEvidence = new Map<string, (typeof aggregate.context.requirementEvidence)[number]>();
  for (const evidence of aggregate.context.requirementEvidence) {
    latestEvidence.set(evidence.requirementId, evidence);
  }
  if (aggregate.context.requirements.some((requirement) =>
    latestEvidence.get(requirement.id)?.status !== "satisfied"
  )) {
    throw new SuccessEligibilityError("Every requirement needs satisfied evidence before success.");
  }
  if (aggregate.context.latestWorkspaceFingerprint !== proof.afterFingerprint) {
    throw new SuccessEligibilityError("The latest core workspace fingerprint does not match the verification proof.");
  }
}
