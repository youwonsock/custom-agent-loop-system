import type { RunAggregate } from "../domain/run-aggregate";
import type { ProjectionPort } from "./ports/projection";
import type { RunRepositoryPort } from "./ports/run-repository";
import { RunReducer } from "./run-reducer";
import type { WorkspaceIntegrityPort } from "./ports/workspace-integrity-port";

export class RecoveryService {
  constructor(
    private readonly repository: RunRepositoryPort,
    private readonly reducer: RunReducer,
    private readonly projection: ProjectionPort,
    private readonly integrity?: WorkspaceIntegrityPort
  ) {}

  async recoverAfterOwnershipChange(runId: string): Promise<RunAggregate> {
    const aggregate = await this.repository.acquireFencingEpoch(runId);
    const activeId = aggregate.execution.activeActivationId;
    const activeNode = activeId
      ? aggregate.definition.nodes[aggregate.nodeExecutions[activeId]?.nodeId]
      : null;
    if (activeNode?.kind === "human_gate") return aggregate;
    let candidate = aggregate;
    const proof = aggregate.context.verificationProof;
    if (proof && this.integrity) {
      try {
        const fingerprint = await this.integrity.fingerprint(
          aggregate.context.targetProjectPath,
          aggregate.context.additionalAllowedPaths,
          aggregate.context.verificationContract?.generatedOutputPaths ?? []
        );
        if (fingerprint.digest !== proof.afterFingerprint) {
          candidate = this.reducer.pauseForVerificationInvalidation(
            candidate,
            "Workspace fingerprint changed after verification; evidence was invalidated.",
            new Date().toISOString()
          );
        }
      } catch (error) {
        candidate = this.reducer.pauseForVerificationInvalidation(
          candidate,
          `Workspace fingerprint could not be confirmed: ${error instanceof Error ? error.message : String(error)}`,
          new Date().toISOString()
        );
      }
    }
    candidate = this.reducer.recoverStaleActivation(candidate, new Date().toISOString());
    if (JSON.stringify(candidate) === JSON.stringify(aggregate)) return aggregate;
    const committed = await this.repository.commit(
      candidate,
      aggregate.revision,
      aggregate.fencingEpoch
    );
    await this.projection.update(committed);
    return committed;
  }
}
