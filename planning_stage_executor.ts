import * as path from "node:path";
import { ReferenceIdentity } from "./loop_state";
import { PipelineStage, roleForStage, stageTypeForStage } from "./pipeline";
import { StageExecutionServices, PlanChoice } from "./stage_execution_contracts";
import { StageExecutor } from "./workflow_contracts";
import { LoopStatus } from "./workflow_contracts";
import { applyPipelineTarget } from "./workflow_engine";

export interface PlanningStageExecutorServices extends StageExecutionServices {
  sessionDir: string;
  planFileNames: {
    plan: string;
    planChoices: string;
    planOverview: string;
    planOptionsDir: string;
  };
  goalRequiresExternalResearch(goal: string): boolean;
  goalRequiresNamedReferenceVerification(goal: string): boolean;
  isResearchBlockedResponse(output: string): boolean;
  parseReferenceIdentity(output: string): ReferenceIdentity | null;
  parsePlanChoices(output: string): PlanChoice[];
  materializePlanChoiceMarkdown(
    sessionDir: string,
    choices: PlanChoice[],
    overviewFileName: string,
    optionsDirName: string
  ): Promise<{ choices: PlanChoice[]; overviewPath: string }>;
  writeJson(filePath: string, value: unknown): Promise<void>;
  writeText(filePath: string, value: string): Promise<void>;
  storeArtifact(key: string, content: string, mediaType: string): Promise<void>;
}

export class PlanningStageExecutor implements StageExecutor {
  constructor(private readonly services: PlanningStageExecutorServices) {}

  async execute(stage: PipelineStage): Promise<void> {
    const { state } = this.services;
    if (state.planningComplete && state.stageResults[stage.id]) {
      applyPipelineTarget(state, stage.onSuccess);
      return;
    }

    if (state.awaitingPlanApproval) return;

    if (
      this.services.goalRequiresExternalResearch(state.goal) &&
      !state.toolAccess.webSearch.enabled
    ) {
      state.status = LoopStatus.WAITING_USER;
      state.statusReason =
        "The original goal explicitly requires internet research, but Web Search is disabled. Enable Web Search and resume the session.";
      await this.services.appendProgressNote(
        "[Loop 0] PLANNING: Waiting for Web Search because the original goal explicitly requires internet research."
      );
      await this.services.commitPhaseResult({});
      return;
    }

    const payload = {
      sessionId: state.sessionId,
      originalGoal: state.goal,
      approvedPlan: null,
      lockedReferenceIdentity: null,
      targetProjectPath: state.targetProjectPath,
      additionalAllowedPaths: state.additionalAllowedPaths,
      accessMode: state.accessMode,
      progressNotes: "",
      failureDigest: null,
      phase: stage.id,
      loopCount: 0,
      toolAccess: state.toolAccess,
      requirements: state.requirements,
    };
    const role = roleForStage(state.pipeline, stage);
    const stageType = stageTypeForStage(state.pipeline, stage);
    const prompt = this.services.buildPrompt(role.id, payload, role, stage, stageType);
    const result = await this.services.executeAgent(
      role.id,
      prompt,
      undefined,
      stageType,
      role.modelRole,
      stage.planOptionsCount
    );

    if (result.exitCode !== 0) {
      throw new Error(`Planner exited with code ${result.exitCode}`);
    }

    const output = this.services.extractOutput(result);
    if (this.services.isResearchBlockedResponse(output)) {
      state.referenceIdentity = null;
      this.services.recordStageResult(stage, output, null, result);
      state.status = LoopStatus.WAITING_USER;
      state.statusReason =
        "Internet research did not establish the named reference's core gameplay. Clarify the reference or provide a reliable source before resuming.";
      await this.services.appendProgressNote(
        "[Loop 0] PLANNING: Research evidence was insufficient; waiting for operator clarification instead of guessing."
      );
      await this.services.archiveLoop(0, stage.id, role.id, result, new Date(), new Date());
      await this.services.commitPhaseResult({});
      return;
    }
    if (this.services.goalRequiresNamedReferenceVerification(state.goal)) {
      const identity = this.services.parseReferenceIdentity(output);
      if (!identity) {
        throw new Error("Planner completed without a valid locked reference identity.");
      }
      state.referenceIdentity = identity;
    } else {
      state.referenceIdentity = null;
    }
    let choices = this.services.parsePlanChoices(output);

    const planPath = path.join(this.services.sessionDir, this.services.planFileNames.plan);
    const choicesPath = path.join(
      this.services.sessionDir,
      this.services.planFileNames.planChoices
    );
    const materialized = await this.services.materializePlanChoiceMarkdown(
      this.services.sessionDir,
      choices,
      this.services.planFileNames.planOverview,
      this.services.planFileNames.planOptionsDir
    );
    choices = materialized.choices;
    await this.services.writeJson(choicesPath, choices);
    await Promise.all([
      this.services.storeArtifact(`stage.${stage.id}.output`, output, "text/plain"),
      ...choices.map((choice) =>
        this.services.storeArtifact(
          `plan.option.${choice.id}`,
          choice.body,
          "text/markdown"
        )
      ),
    ]);

    state.planPath = planPath;
    state.planOverviewPath = materialized.overviewPath;
    state.selectedPlanChoiceId = null;
    this.services.recordStageResult(stage, output, null, result);
    if (!stage.requiresPlanApproval) {
      const selected = choices[0];
      await this.services.writeText(planPath, `${selected.body.trim()}\n`);
      await this.services.storeArtifact("plan.selected", selected.body, "text/markdown");
      state.refinedGoal = selected.body;
      state.planningComplete = true;
      state.awaitingPlanApproval = false;
      state.planApproved = true;
      state.selectedPlanChoiceId = selected.id;
      await this.services.appendProgressNote(
        `[Loop 0] ${stage.id}: ${choices.length} plan options generated; option ${selected.id} selected automatically.`
      );
      await this.services.archiveLoop(0, stage.id, role.id, result, new Date(), new Date());
      applyPipelineTarget(state, stage.onSuccess);
      await this.services.commitPhaseResult({});
      return;
    }

    state.awaitingPlanApproval = true;
    state.planApproved = false;
    state.status = LoopStatus.WAITING_USER;
    state.statusReason = "Select and approve a plan before implementation starts.";

    await this.services.appendProgressNote(
      `[Loop 0] PLANNING: ${choices.length} plan options generated. Awaiting user selection.`
    );
    await this.services.archiveLoop(0, stage.id, role.id, result, new Date(), new Date());
    await this.services.commitPhaseResult({
      phase: stage.id,
      status: LoopStatus.WAITING_USER,
      awaitingPlanApproval: true,
      planApproved: false,
      planPath,
      planOverviewPath: materialized.overviewPath,
      selectedPlanChoiceId: null,
    });
  }
}
