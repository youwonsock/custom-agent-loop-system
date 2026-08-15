import { PipelineStage, roleForStage, stageTypeForStage } from "./pipeline";
import {
  FailureEvidenceSummary,
  StageExecutionServices,
} from "./stage_execution_contracts";
import { LoopStatus, StageExecutor } from "./workflow_contracts";
import { applyPipelineTarget } from "./workflow_engine";

export interface InterruptStageExecutorServices extends StageExecutionServices {
  rootDir: string;
  readProgressNotes(): Promise<string>;
  collectFailureEvidence(): Promise<FailureEvidenceSummary>;
}

export class InterruptStageExecutor implements StageExecutor {
  constructor(private readonly services: InterruptStageExecutorServices) {}

  async execute(stage: PipelineStage): Promise<void> {
    const { state } = this.services;
    const notes = await this.services.readProgressNotes();
    const failureEvidence = await this.services.collectFailureEvidence();
    const queuedErrors = state.errorQueue
      .map((error) => `[${error.phase}] ${error.signature}`)
      .join("\n");
    const errorSummary = [
      state.lastFailure
        ? `[${state.lastFailure.phase ?? state.phase}] ${state.lastFailure.kind}: ${state.lastFailure.message}`
        : "",
      queuedErrors,
      state.interruptBriefing ?? "",
    ]
      .filter((value) => value.trim().length > 0)
      .join("\n");

    const humanMessage = state.interruptMessage;
    const payload = {
      sessionId: state.sessionId,
      originalGoal: state.goal,
      approvedPlan: state.refinedGoal,
      lockedReferenceIdentity: state.referenceIdentity,
      targetProjectPath: state.targetProjectPath,
      additionalAllowedPaths: state.additionalAllowedPaths,
      accessMode: state.accessMode,
      progressNotes: notes,
      failureDigest: errorSummary,
      phase: stage.id,
      loopCount: state.loopCount,
      interruptMessage: humanMessage,
      failureEvidence,
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
      1,
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

    const briefing = this.services.extractOutput(result);
    this.services.recordStageResult(stage, briefing, null, result);
    state.interruptBriefing = briefing;
    console.warn("\n=== INTERRUPTER BRIEFING ===");
    console.warn(briefing);
    console.warn("============================");
    const terminalStatus = humanMessage ? LoopStatus.STOPPED : LoopStatus.PAUSED;
    console.warn(`Session ${state.sessionId} is ${terminalStatus}. Review the briefing and resume with:`);
    console.warn(`  agent-loop resume --session ${state.sessionId} --root ${this.services.rootDir}`);

    if (humanMessage) {
      state.interruptMessage = undefined;
      state.status = LoopStatus.STOPPED;
      state.statusReason = "Operator interrupt completed after producing a briefing.";
    } else {
      applyPipelineTarget(state, stage.onSuccess);
      state.statusReason = "Repeated token-consuming work showed no meaningful convergence.";
    }
    await this.services.commitPhaseResult({});
  }
}
