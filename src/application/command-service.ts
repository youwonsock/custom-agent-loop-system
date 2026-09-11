import type { RunAggregate, RunStatus } from "../domain/run-aggregate";
import type { HumanGateResponse } from "../domain/workflow";
import type { RunControlType } from "../domain/control-command";
import type { RunControlCommandPort } from "./ports/control-command";
import type { ProjectionPort } from "./ports/projection";
import type { RunRepositoryPort } from "./ports/run-repository";
import { RunReducer } from "./run-reducer";
import type { VerificationContractService } from "./verification-contract-service";
import { requiresCoreVerification } from "../domain/success-policy";

const NOOP_CONTROLS: RunControlCommandPort = {
  enqueue: async () => {
    throw new Error("Run control commands are not configured.");
  },
  recover: async () => undefined,
  claim: async () => null,
  complete: async () => undefined,
};

export class CommandService {
  constructor(
    private readonly repository: RunRepositoryPort,
    private readonly reducer: RunReducer,
    private readonly projection: ProjectionPort,
    private readonly controls: RunControlCommandPort = NOOP_CONTROLS,
    private readonly verificationContracts?: VerificationContractService
  ) {}

  async respondToHumanGate(
    runId: string,
    response: HumanGateResponse
  ): Promise<RunAggregate> {
    const aggregate = await this.repository.load(runId);
    let candidate = this.reducer.applyHumanResponse(aggregate, response);

    // A plan approval includes the verification policy approval. Capture the
    // baseline while the operator's decision is still the current CAS
    // boundary, then persist the plan response and contract together. This
    // prevents VERIFY from silently creating a later, unapproved contract.
    if (
      response.signal === "approved" &&
      aggregate.pendingInput?.kind === "plan_approval" &&
      requiresCoreVerification(candidate)
    ) {
      if (!this.verificationContracts) {
        throw new Error("Core verification contract service is not configured.");
      }
      const choiceId = candidate.context.selectedPlanChoiceId;
      const draft = candidate.context.selectedVerificationDraft;
      if (!choiceId || !draft) {
        throw new Error("Plan approval did not select a verification contract draft.");
      }
      const prepared = await this.verificationContracts.createInitial(
        draft.commands,
        candidate.context.targetProjectPath,
        candidate.context.additionalAllowedPaths,
        response.requestId,
        draft
      );
      const previousRevision = aggregate.context.verificationContract?.revision ?? 0;
      const contract = {
        ...prepared.contract,
        revision: previousRevision + 1,
        approvedRequestId: response.requestId,
        approvedAt: response.respondedAt,
      };
      candidate = this.reducer.setVerificationContract(
        candidate,
        contract,
        response.respondedAt,
        prepared.baseline
      );
    }
    const committed = await this.repository.commitOffline(
      candidate,
      aggregate.revision,
      response.requestId
    );
    await this.projection.update(committed);
    return committed;
  }

  async approveVerification(
    runId: string,
    requestId: string,
    candidateHash: string,
    message?: string
  ): Promise<RunAggregate> {
    // A CLI/UI retry may arrive after the first CAS already committed the
    // response and the runner moved past the approval gate.  Return the
    // authoritative aggregate instead of requiring the now-cleared pending
    // request to still exist.
    const current = await this.repository.load(runId);
    if (current.processedRequestIds.includes(requestId)) {
      this.assertProcessedVerificationCandidate(current, requestId, candidateHash);
      return current;
    }
    await this.assertFreshVerificationCandidate(runId, requestId, candidateHash);
    return this.respondToHumanGate(runId, {
      requestId,
      nodeId: await this.pendingNode(runId, "verification_approval"),
      signal: "approved",
      value: { candidateHash, ...(message ? { message } : {}) },
      respondedAt: new Date().toISOString(),
    });
  }

  async rejectVerification(
    runId: string,
    requestId: string,
    candidateHash: string,
    message: string
  ): Promise<RunAggregate> {
    const current = await this.repository.load(runId);
    if (current.processedRequestIds.includes(requestId)) {
      this.assertProcessedVerificationCandidate(current, requestId, candidateHash);
      return current;
    }
    await this.assertFreshVerificationCandidate(runId, requestId, candidateHash);
    return this.respondToHumanGate(runId, {
      requestId,
      nodeId: await this.pendingNode(runId, "verification_approval"),
      signal: "rejected",
      value: { candidateHash, message },
      respondedAt: new Date().toISOString(),
    });
  }

  /**
   * A repeated response with the same request id is idempotent only when it
   * carries the candidate that was actually processed.  Treating an old
   * request id plus a different hash as a successful retry would let a stale
   * approval appear to authorize a different verification surface.
   */
  private assertProcessedVerificationCandidate(
    aggregate: Readonly<RunAggregate>,
    requestId: string,
    candidateHash: string
  ): void {
    const response = Object.values(aggregate.context.humanResponses).find(
      (item) => item.requestId === requestId
    );
    const value = response?.value && typeof response.value === "object" && !Array.isArray(response.value)
      ? response.value as Record<string, unknown>
      : null;
    const processedHash = typeof value?.candidateHash === "string"
      ? value.candidateHash
      : null;
    if (processedHash === null || processedHash !== candidateHash) {
      throw new Error("Verification approval request or candidate hash is stale.");
    }
  }

  /** Recompute the candidate at the approval boundary so an approval screen
   * cannot authorize files that changed while the operator was deciding. */
  private async assertFreshVerificationCandidate(
    runId: string,
    requestId: string,
    candidateHash: string
  ): Promise<void> {
    const aggregate = await this.repository.load(runId);
    const pending = aggregate.pendingInput;
    if (!pending || pending.kind !== "verification_approval" || pending.requestId !== requestId) {
      throw new Error(`Run ${runId} has no matching pending verification approval request.`);
    }
    if (!this.verificationContracts) return;
    const contract = aggregate.context.verificationContract;
    if (!contract) throw new Error("Verification approval has no active contract.");
    const stored = aggregate.context.verificationCandidate;
    if (!stored || stored.candidateHash !== candidateHash) {
      throw new Error("Verification approval candidate is no longer pending.");
    }
    const candidate = await this.verificationContracts.candidate({
      contract,
      projectRoot: aggregate.context.targetProjectPath,
      additionalRoots: aggregate.context.additionalAllowedPaths,
      baselinePaths: contract.baselinePaths,
      baselineFileHashes: contract.baselineFileHashes,
      baselineFileModes: contract.baselineFileModes,
      proposedDraft: {
        commands: stored.commands,
        totalTimeoutMs: stored.totalTimeoutMs,
        protectedPaths: stored.protectedPaths,
        testRoots: stored.testRoots,
        allowedNewTestRoots: stored.allowedNewTestRoots,
        generatedOutputPaths: stored.generatedOutputPaths,
      },
    });
    if (candidate.candidate.candidateHash !== candidateHash) {
      const refreshed = this.reducer.refreshVerificationApprovalCandidate(
        aggregate,
        candidate.candidate,
        new Date().toISOString(),
        "The workspace changed while approval was pending. Review the refreshed verification candidate.",
        candidate.diff,
        candidate.baseline
      );
      const refreshRequestId = `refresh_${requestId}_${candidate.candidate.candidateHash.slice(0, 16)}`;
      const committed = await this.repository.commitOffline(
        refreshed,
        aggregate.revision,
        refreshRequestId
      );
      await this.projection.update(committed);
      throw new Error(
        `Verification approval candidate is stale; a new request was issued: ${committed.pendingInput?.requestId ?? "unknown"}.`
      );
    }
  }

  private async pendingNode(
    runId: string,
    kind: "verification_approval"
  ): Promise<string> {
    const aggregate = await this.repository.load(runId);
    if (aggregate.pendingInput?.kind !== kind) {
      throw new Error(`Run ${runId} has no pending ${kind} request.`);
    }
    return aggregate.pendingInput.nodeId;
  }

  async setRunStatus(
    runId: string,
    requestId: string,
    status: Extract<RunStatus, "RUNNING" | "PAUSED" | "STOPPED">,
    reason: string | null
  ): Promise<RunAggregate> {
    const aggregate = await this.repository.load(runId);
    const candidate = this.reducer.setStatus(
      aggregate,
      status,
      reason,
      new Date().toISOString()
    );
    const committed = await this.repository.commitOffline(
      candidate,
      aggregate.revision,
      requestId
    );
    await this.projection.update(committed);
    return committed;
  }

  async setAccessMode(
    runId: string,
    requestId: string,
    accessMode: "ask" | "full_access"
  ): Promise<RunAggregate> {
    const aggregate = await this.repository.load(runId);
    const candidate = this.reducer.setAccessMode(
      aggregate,
      accessMode,
      new Date().toISOString()
    );
    const committed = await this.repository.commitOffline(
      candidate,
      aggregate.revision,
      requestId
    );
    await this.projection.update(committed);
    return committed;
  }

  async resumeRun(runId: string, requestId: string, reason: string): Promise<RunAggregate> {
    const aggregate = await this.repository.load(runId);
    const candidate = this.reducer.resumeRun(
      aggregate,
      reason,
      new Date().toISOString()
    );
    const committed = await this.repository.commitOffline(
      candidate,
      aggregate.revision,
      requestId
    );
    await this.projection.update(committed);
    return committed;
  }

  async requestControl(
    runId: string,
    requestId: string,
    type: RunControlType,
    message: string | null
  ): Promise<{ aggregate: RunAggregate; queuedRequestId: string | null }> {
    for (let pass = 0; pass < 3; pass += 1) {
      const aggregate = await this.repository.load(runId);
      if (type === "stop" && ["STOPPED", "SUCCESS"].includes(aggregate.execution.status)) {
        return { aggregate, queuedRequestId: null };
      }
      if (type === "interrupt" && ["SUCCESS", "BLOCKED", "STOPPED"].includes(aggregate.execution.status)) {
        throw new Error(`Cannot interrupt a run while it is ${aggregate.execution.status}.`);
      }
      const activeId = aggregate.execution.activeActivationId;
      const active = activeId ? aggregate.nodeExecutions[activeId] : null;
      if (active?.status === "running") {
        const queued = await this.controls.enqueue(runId, type, message);
        return { aggregate, queuedRequestId: queued.requestId };
      }
      const candidate = this.reducer.applyBoundaryControl(
        aggregate,
        requestId,
        type,
        message,
        new Date().toISOString()
      );
      try {
        const committed = await this.repository.commitOffline(
          candidate,
          aggregate.revision,
          requestId
        );
        await this.projection.update(committed);
        return { aggregate: committed, queuedRequestId: null };
      } catch (error) {
        const latest = await this.repository.load(runId);
        if (latest.revision === aggregate.revision || pass === 2) throw error;
      }
    }
    throw new Error(`Could not apply ${type} control to run ${runId}.`);
  }
}
