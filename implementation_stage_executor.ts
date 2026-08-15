import { PipelineStage, roleForStage, stageTypeForStage } from "./pipeline";
import { StageExecutionServices } from "./stage_execution_contracts";
import { ImplementationPreflightError } from "./stage_execution_errors";
import { StageExecutor } from "./workflow_contracts";
import { applyPipelineTarget } from "./workflow_engine";

export interface ImplementationStageExecutorServices extends StageExecutionServices {
  findAbsolutePathsOutsideAllowedRoots(
    input: string,
    targetProjectPath: string,
    additionalAllowedPaths: string[]
  ): string[];
  readProgressNotes(): Promise<string>;
}

export class ImplementationStageExecutor implements StageExecutor {
  constructor(private readonly services: ImplementationStageExecutorServices) {}

  async execute(stage: PipelineStage, failureDigest?: string | null): Promise<void> {
    const { state } = this.services;
    const implementationGoal = [state.goal, state.refinedGoal ?? ""]
      .filter((value) => value.trim().length > 0)
      .join("\n\n");
    const outsidePaths =
      state.accessMode === "full_access"
        ? []
        : this.services.findAbsolutePathsOutsideAllowedRoots(
            implementationGoal,
            state.targetProjectPath,
            state.additionalAllowedPaths
          );
    if (outsidePaths.length > 0) {
      throw new ImplementationPreflightError(
        {
          kind: "permission",
          message:
            `Approved implementation plan references path(s) outside the configured write-access roots ` +
            `(${[state.targetProjectPath, ...state.additionalAllowedPaths].join(", ")}): ` +
            outsidePaths.join(", "),
          retryable: false,
          occurredAt: new Date().toISOString(),
          attemptId: null,
          role: stage.role,
          phase: stage.id,
          exitCode: null,
          cliSessionId: null,
        },
        outsidePaths
      );
    }
    const planRevised = !!state.planRevisionPending;

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
      failureDigest: failureDigest ?? null,
      phase: stage.id,
      loopCount: state.loopCount,
      planRevised,
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

    if (result.exitCode !== 0) {
      throw new Error(
        `Implementer exited with code ${result.exitCode}: ${this.services.extractOutput(result).slice(0, 200)}`
      );
    }

    if (planRevised) {
      state.planRevisionPending = false;
      await this.services.appendProgressNote(
        `[Loop ${state.loopCount}] IMPLEMENTATION: Code re-implemented after plan revision.`
      );
    } else {
      await this.services.appendProgressNote(
        `[Loop ${state.loopCount}] IMPLEMENTATION: Code changes applied.`
      );
    }
    this.services.recordStageResult(stage, this.services.extractOutput(result), null, result);
    applyPipelineTarget(state, stage.onSuccess);
    await this.services.commitPhaseResult({
      planRevisionPending: false,
      lastFailureDigest: null,
    });
  }
}
