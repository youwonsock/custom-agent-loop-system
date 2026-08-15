import { AgentRunResult } from "./agent_runtime";
import { ErrorSignature } from "./loop_state";
import { PipelineStage, roleForStage, stageTypeForStage } from "./pipeline";
import { evaluateRequirementCoverage } from "./requirement_ledger";
import { StageExecutionServices } from "./stage_execution_contracts";
import { LoopStatus, StageExecutor } from "./workflow_contracts";
import { applyPipelineTarget } from "./workflow_engine";

export interface ApprovalStageExecutorServices extends StageExecutionServices {
  readProgressNotes(): Promise<string>;
  isResearchBlockedResponse(output: string): boolean;
  extractVerdictFromOutput(result: AgentRunResult): string;
  parseMasterVerdict(output: string): "approved" | "rejected" | "unknown";
  approvalDecisionSignature(output: string): string;
  stripAnsi(value: string): string;
  pushAndCheckOscillation(
    queue: ErrorSignature[],
    entry: ErrorSignature
  ): { queue: ErrorSignature[]; oscillation: boolean };
  enterInterruptPhase(): void;
  emitFinalSummary(): Promise<void>;
  saveRegistry(): Promise<void>;
}

export class ApprovalStageExecutor implements StageExecutor {
  constructor(private readonly services: ApprovalStageExecutorServices) {}

  async execute(stage: PipelineStage): Promise<void> {
    const { state } = this.services;
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
    const prompt = this.services.buildPrompt(role.id, payload, role, stage, stageType);
    const startedAt = new Date();
    const result = await this.services.executeAgent(
      role.id,
      prompt,
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

    const fullOutput = this.services.extractOutput(result);
    if (this.services.isResearchBlockedResponse(fullOutput)) {
      this.services.recordStageResult(stage, fullOutput, null, result);
      state.status = LoopStatus.WAITING_USER;
      state.statusReason =
        "Final acceptance could not independently verify the named reference from web sources. Clarify the reference or provide a reliable source before resuming.";
      await this.services.appendProgressNote(
        `[Loop ${state.loopCount}] ${stage.id}: Research blocked; final approval withheld pending operator clarification.`
      );
      await this.services.commitPhaseResult({ masterApproved: false });
      return;
    }
    const verdictText = this.services.extractVerdictFromOutput(result);
    const verdict = this.services.parseMasterVerdict(verdictText);
    const requirementCoverage = evaluateRequirementCoverage(fullOutput, state.requirements.items);
    const approved =
      result.exitCode === 0 &&
      verdict === "approved" &&
      requirementCoverage.allSatisfied;
    this.services.recordStageResult(
      stage,
      fullOutput,
      approved ? "APPROVED" : verdict === "rejected" ? "REJECTED" : null,
      result
    );

    console.log(`[orchestrator] Master verdict: ${verdict} (exitCode=${result.exitCode})`);
    console.log(`[orchestrator] Verdict text (last 200 chars): ${verdictText.slice(-200)}`);

    if (approved) {
      applyPipelineTarget(state, stage.onSuccess);
      await this.services.commitPhaseResult({ masterApproved: true, lastFailureDigest: null });
      await this.services.appendProgressNote(
        `[Loop ${state.loopCount}] ${stage.id}: APPROVED by ${role.id}.`
      );
      if (state.status === LoopStatus.SUCCESS) {
        await this.services.emitFinalSummary();
        await this.services.saveRegistry();
        console.log(`[orchestrator] Session ${state.sessionId} achieved SUCCESS.`);
      }
    } else if (verdict === "approved") {
      const protocolFailure =
        `Master APPROVED rejected by requirement gate. Missing evidence: ` +
        `${requirementCoverage.missing.join(", ") || "none"}; unresolved: ` +
        `${requirementCoverage.unresolved.join(", ") || "none"}.`;
      await this.services.appendProgressNote(
        `[Loop ${state.loopCount}] ${stage.id}: APPROVED rejected because mandatory requirement evidence was incomplete.`
      );
      state.statusReason = protocolFailure;
      this.services.enterInterruptPhase();
      await this.services.commitPhaseResult({
        masterApproved: false,
        lastFailureDigest: protocolFailure,
      });
    } else if (verdict === "unknown") {
      const protocolFailure =
        "Master completed without an extractable APPROVED or REJECTED decision. " +
        "Implementation will not be repeated for a decision-protocol failure.";
      await this.services.appendProgressNote(
        `[Loop ${state.loopCount}] ${stage.id}: INVALID DECISION; entering INTERRUPT instead of re-running implementation.`
      );
      const rejectEntry: ErrorSignature = {
        signature: this.services.approvalDecisionSignature(verdictText),
        rawMessage: protocolFailure,
        timestamp: Date.now(),
        phase: stage.id,
      };
      state.errorQueue = this.services.pushAndCheckOscillation(
        state.errorQueue,
        rejectEntry
      ).queue;
      state.statusReason = protocolFailure;
      this.services.enterInterruptPhase();
      await this.services.commitPhaseResult({
        masterApproved: false,
        lastFailureDigest: protocolFailure,
      });
    } else {
      await this.services.appendProgressNote(
        `[Loop ${state.loopCount}] ${stage.id}: REJECTED (${verdict}).`
      );
      const rejectionDigest = this.services.stripAnsi(verdictText).trim().slice(-4000);
      const rejectEntry: ErrorSignature = {
        signature: this.services.approvalDecisionSignature(verdictText),
        rawMessage: rejectionDigest.slice(0, 400),
        timestamp: Date.now(),
        phase: stage.id,
      };
      const rejectOsc = this.services.pushAndCheckOscillation(state.errorQueue, rejectEntry);
      state.errorQueue = rejectOsc.queue;
      if (rejectOsc.oscillation) {
        this.services.enterInterruptPhase();
      } else {
        applyPipelineTarget(state, stage.onFailure);
      }
      await this.services.commitPhaseResult({
        masterApproved: false,
        lastFailureDigest:
          rejectionDigest || "Master rejected the implementation without additional details.",
      });
    }
  }
}
