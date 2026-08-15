import { ErrorSignature } from "./loop_state";
import {
  PipelineStage,
  executorForStage,
  roleForStage,
  stageTypeForStage,
} from "./pipeline";
import { evaluateRequirementCoverage } from "./requirement_ledger";
import { StageExecutionServices } from "./stage_execution_contracts";
import { LoopStatus, StageExecutor } from "./workflow_contracts";
import { applyPipelineTarget } from "./workflow_engine";

export interface ReviewStageExecutorServices extends StageExecutionServices {
  readProgressNotes(): Promise<string>;
  stripAnsi(value: string): string;
  isResearchBlockedResponse(output: string): boolean;
  parseMasterVerdict(output: string): "approved" | "rejected" | "unknown";
  extractFailureDigest(output: string): string;
  normalizeSignature(value: string): string;
  pushAndCheckOscillation(
    queue: ErrorSignature[],
    entry: ErrorSignature
  ): { queue: ErrorSignature[]; oscillation: boolean };
  enterInterruptPhase(): void;
}

export class ReviewStageExecutor implements StageExecutor {
  constructor(private readonly services: ReviewStageExecutorServices) {}

  async execute(stage: PipelineStage): Promise<void> {
    const { state } = this.services;
    const evidence = Object.values(state.stageResults)
      .filter((result) => {
        const sourceStage = state.pipeline.stages.find(
          (candidate) => candidate.id === result.stageId
        );
        return sourceStage
          ? executorForStage(state.pipeline, sourceStage) === "test"
          : result.executor === "test";
      })
      .map((result) => `[${result.stageId}] ${result.verdict ?? "UNKNOWN"}\n${result.output}`)
      .join("\n\n");
    const notes = await this.services.readProgressNotes();
    const payload = {
      sessionId: state.sessionId,
      originalGoal: state.goal,
      approvedPlan: state.refinedGoal,
      lockedReferenceIdentity: state.referenceIdentity,
      targetProjectPath: state.targetProjectPath,
      additionalAllowedPaths: state.additionalAllowedPaths,
      accessMode: state.accessMode,
      progressNotes: notes,
      failureDigest: null,
      phase: stage.id,
      loopCount: state.loopCount,
      toolAccess: state.toolAccess,
      requirements: state.requirements,
    };
    const role = roleForStage(state.pipeline, stage);
    const stageType = stageTypeForStage(state.pipeline, stage);
    const reviewPrompt =
      this.services.buildPrompt(role.id, payload, role, stage, stageType) +
      `\n\n=== PRIOR TEST EVIDENCE (truncated) ===\n${this.services.stripAnsi(evidence).slice(-6000)}`;
    const startedAt = new Date();
    const result = await this.services.executeAgent(
      role.id,
      reviewPrompt,
      undefined,
      stageType,
      role.modelRole
    );
    const endedAt = new Date();
    await this.services.archiveLoop(
      state.loopCount,
      stage.id,
      role.id,
      result,
      startedAt,
      endedAt
    );

    const output = this.services.extractOutput(result);
    if (this.services.isResearchBlockedResponse(output)) {
      this.services.recordStageResult(stage, output, null, result);
      state.status = LoopStatus.WAITING_USER;
      state.statusReason =
        "QA could not independently verify the named reference from web sources. Clarify the reference or provide a reliable source before resuming.";
      await this.services.appendProgressNote(
        `[Loop ${state.loopCount}] ${stage.id}: Research blocked; waiting for operator clarification.`
      );
      await this.services.commitPhaseResult({});
      return;
    }
    const verdict = this.services.parseMasterVerdict(output);
    const requirementCoverage = evaluateRequirementCoverage(output, state.requirements.items);
    const approved = verdict === "approved" && requirementCoverage.allSatisfied;
    this.services.recordStageResult(stage, output, approved ? "APPROVED" : "REJECTED", result);
    if (approved) {
      await this.services.appendProgressNote(
        `[Loop ${state.loopCount}] ${stage.id}: APPROVED by ${role.id}.`
      );
      applyPipelineTarget(state, stage.onSuccess);
      await this.services.commitPhaseResult({ lastFailureDigest: null });
      return;
    }

    const requirementGateFailure =
      verdict === "approved" && !requirementCoverage.allSatisfied
        ? `QA APPROVED rejected by requirement gate. Missing evidence: ` +
          `${requirementCoverage.missing.join(", ") || "none"}; unresolved: ` +
          `${requirementCoverage.unresolved.join(", ") || "none"}.`
        : "";
    const failureDigest =
      requirementGateFailure || this.services.extractFailureDigest(`${output}\n${evidence}`);
    const entry: ErrorSignature = {
      signature: this.services.normalizeSignature(failureDigest),
      rawMessage: failureDigest,
      timestamp: Date.now(),
      phase: stage.id,
    };
    const oscillation = this.services.pushAndCheckOscillation(state.errorQueue, entry);
    state.errorQueue = oscillation.queue;
    if (oscillation.oscillation || state.convergence.stagnantCycles >= 1) {
      this.services.enterInterruptPhase();
    } else {
      applyPipelineTarget(state, stage.onFailure);
    }
    await this.services.appendProgressNote(
      `[Loop ${state.loopCount}] ${stage.id}: REJECTED by ${role.id}; next=${state.phase}.`
    );
    await this.services.commitPhaseResult({ lastFailureDigest: failureDigest });
  }
}
