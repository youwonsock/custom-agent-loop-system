import { PipelineStage, roleForStage, stageTypeForStage } from "./pipeline";
import { evaluateRequirementCoverage } from "./requirement_ledger";
import { AgentRoom, StageExecutionServices } from "./stage_execution_contracts";
import { StageExecutor } from "./workflow_contracts";
import { applyPipelineTarget } from "./workflow_engine";

export interface TestStageExecutorServices extends StageExecutionServices {
  rooms: Record<string, AgentRoom>;
  readProgressNotes(): Promise<string>;
  parseTesterVerdict(output: string): "PASS" | "FAIL" | null;
  writeJson(filePath: string, value: unknown): Promise<void>;
}

export class TestStageExecutor implements StageExecutor {
  constructor(private readonly services: TestStageExecutorServices) {}

  async execute(stage: PipelineStage): Promise<void> {
    const { state } = this.services;
    const notes = await this.services.readProgressNotes();
    const priorStageFailure =
      state.lastFailure?.phase === stage.id
        ? `[${state.lastFailure.kind}] ${state.lastFailure.message}\n` +
          "Inspect and run any existing tests before creating more test infrastructure."
        : null;
    const payload = {
      sessionId: state.sessionId,
      originalGoal: state.goal,
      approvedPlan: state.refinedGoal,
      lockedReferenceIdentity: state.referenceIdentity,
      targetProjectPath: state.targetProjectPath,
      additionalAllowedPaths: state.additionalAllowedPaths,
      accessMode: state.accessMode,
      progressNotes: notes,
      failureDigest: priorStageFailure,
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

    if (result.exitCode !== 0) {
      throw new Error(
        `Tester exited with code ${result.exitCode}: ${this.services.extractOutput(result).slice(0, 200)}`
      );
    }

    const testerOutput = this.services.extractOutput(result);
    const assertedVerdict = this.services.parseTesterVerdict(testerOutput) ?? "FAIL";
    const requirementCoverage = evaluateRequirementCoverage(
      testerOutput,
      state.requirements.items
    );
    const verdict =
      assertedVerdict === "PASS" && !requirementCoverage.allSatisfied
        ? "FAIL"
        : assertedVerdict;
    if (assertedVerdict === "PASS" && verdict === "FAIL") {
      state.lastFailureDigest =
        `Tester PASS rejected by requirement gate. Missing evidence: ` +
        `${requirementCoverage.missing.join(", ") || "none"}; unresolved: ` +
        `${requirementCoverage.unresolved.join(", ") || "none"}.`;
    }
    await this.services.writeJson(this.services.rooms[role.id].outputPayloadPath, {
      loopCount: state.loopCount,
      producedAt: endedAt.toISOString(),
      output: testerOutput,
      verdict,
    });

    this.services.recordStageResult(stage, testerOutput, verdict, result);
    await this.services.appendProgressNote(
      `[Loop ${state.loopCount}] ${stage.id}: Test role ${role.id} verdict: ${verdict}.`
    );
    applyPipelineTarget(state, verdict === "PASS" ? stage.onSuccess : stage.onFailure);
    await this.services.commitPhaseResult({});
  }
}
