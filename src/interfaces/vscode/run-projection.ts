import * as path from "node:path";
import type { RunAggregate } from "../../domain/run-aggregate";
import type { ArtifactStorePort } from "../../application/ports/artifact-store";
import type { ProjectionPort } from "../../application/ports/projection";
import { atomicWriteJson, atomicWriteText } from "../../../json_file_store";
import { withShortFileLock } from "../../../resilience";

export interface RunProjection {
  projectionSchemaVersion: 1;
  stateVersion: 4;
  sessionId: string;
  runId: string;
  definitionHash: string;
  revision: number;
  fencingEpoch: number;
  status: RunAggregate["execution"]["status"];
  statusReason: string | null;
  phase: string;
  currentNodeId: string;
  currentAgentId: string | null;
  activeActivation: {
    activationId: string;
    nodeId: string;
    status: string;
    workflowStep: number;
    attemptIds: string[];
    sideEffect: "none" | "workspace_mutation";
  } | null;
  pendingInput: RunAggregate["pendingInput"];
  goal: string;
  targetProjectPath: string;
  additionalAllowedPaths: string[];
  accessMode: RunAggregate["context"]["accessMode"];
  awaitingPlanApproval: boolean;
  planApproved: boolean;
  selectedPlanChoiceId: string | null;
  planChoices: Array<{ id: string; title: string; body: string }>;
  interruptBriefing: string | null;
  requirements: RunAggregate["context"]["requirements"];
  requirementEvidence: RunAggregate["context"]["requirementEvidence"];
  budgets: {
    workflowSteps: { consumed: number; limit: number; remaining: number };
    cycles: { consumed: number; completed: number; limit: number; remaining: number };
  };
  latestEvent: RunAggregate["events"][number] | null;
  events: RunAggregate["events"];
  createdAt: string;
  updatedAt: string;
}

export interface SessionIndexProjection {
  version: 4;
  activeSessionIds: string[];
  sessionMetas: Array<{
    sessionId: string;
    goal: string;
    targetProjectPath: string;
    status: RunProjection["status"];
    createdAt: string;
  }>;
  availableModels: string[];
  modelsDiscoveredAt: string | null;
  modelsDiscoveredCli: string | null;
  manualModelsOverride: null;
  modelVariants: Record<string, string[]> | null;
  providerCatalog?: Record<string, unknown>;
}

export interface FileProjectionOptions {
  runsRoot: string;
  indexPath: string;
  projectionFileName?: string;
  progressFileName?: string;
  finalSummaryFileName?: string;
  indexLockFileName?: string;
}

export class FileRunProjection implements ProjectionPort {
  private readonly projectionFileName: string;
  private readonly progressFileName: string;
  private readonly finalSummaryFileName: string;
  private readonly indexLockFileName: string;

  constructor(
    private readonly options: FileProjectionOptions,
    private readonly artifacts: ArtifactStorePort
  ) {
    this.projectionFileName = options.projectionFileName ?? "run_projection.json";
    this.progressFileName = options.progressFileName ?? "progress_notes.txt";
    this.finalSummaryFileName = options.finalSummaryFileName ?? "final_summary.json";
    this.indexLockFileName = options.indexLockFileName ?? "sessions_index.lock";
  }

  async update(aggregate: Readonly<RunAggregate>): Promise<void> {
    const projection = await this.build(aggregate);
    const runDirectory = path.join(this.options.runsRoot, aggregate.runId);
    await atomicWriteJson(path.join(runDirectory, this.projectionFileName), projection);
    await atomicWriteText(
      path.join(runDirectory, this.progressFileName),
      aggregate.events
        .map((event) => `[${event.recordedAt}] ${event.type}: ${event.summary}`)
        .join("\n") + (aggregate.events.length > 0 ? "\n" : "")
    );
    await this.writePlanDocuments(runDirectory, projection);
    if (aggregate.execution.status === "SUCCESS") {
      await atomicWriteJson(path.join(runDirectory, this.finalSummaryFileName), {
        schemaVersion: 1,
        runId: aggregate.runId,
        goal: aggregate.context.goal,
        achievedAt: aggregate.updatedAt,
        definitionHash: aggregate.definition.definitionHash,
        workflowSteps: aggregate.execution.workflowStepsConsumed,
        cyclesCompleted: aggregate.execution.cyclesCompleted,
        requirementEvidence: aggregate.context.requirementEvidence,
      });
    }
    await this.updateIndex(projection);
  }

  private async writePlanDocuments(
    runDirectory: string,
    projection: RunProjection
  ): Promise<void> {
    if (projection.planChoices.length === 0) return;
    await atomicWriteJson(
      path.join(runDirectory, "plan_choices.json"),
      projection.planChoices
    );
    const overview = projection.planChoices
      .map((choice) => `# ${choice.title}\n\n${choice.body.trim()}\n`)
      .join("\n---\n\n");
    await atomicWriteText(path.join(runDirectory, "plan_options.md"), overview);
    for (const choice of projection.planChoices) {
      await atomicWriteText(
        path.join(runDirectory, "plan_options", `option_${choice.id}.md`),
        `# ${choice.title}\n\n${choice.body.trim()}\n`
      );
    }
    if (projection.selectedPlanChoiceId) {
      const selected = projection.planChoices.find(
        (choice) => choice.id === projection.selectedPlanChoiceId
      );
      if (selected) {
        await atomicWriteText(
          path.join(runDirectory, "plan.md"),
          `# ${selected.title}\n\n${selected.body.trim()}\n`
        );
      }
    }
  }

  private async build(aggregate: Readonly<RunAggregate>): Promise<RunProjection> {
    const activeId = aggregate.execution.activeActivationId;
    const active = activeId ? aggregate.nodeExecutions[activeId] : null;
    const currentNode = aggregate.definition.nodes[aggregate.execution.currentNodeId];
    const planBodies = await this.loadPlanBodies(aggregate);
    return {
      projectionSchemaVersion: 1,
      stateVersion: 4,
      sessionId: aggregate.runId,
      runId: aggregate.runId,
      definitionHash: aggregate.definition.definitionHash,
      revision: aggregate.revision,
      fencingEpoch: aggregate.fencingEpoch,
      status: aggregate.execution.status,
      statusReason: aggregate.execution.reason,
      phase: aggregate.execution.currentNodeId,
      currentNodeId: aggregate.execution.currentNodeId,
      currentAgentId: currentNode?.agentId ?? null,
      activeActivation: active
        ? {
            activationId: active.activationId,
            nodeId: active.nodeId,
            status: active.status,
            workflowStep: active.workflowStep,
            attemptIds: [...active.attemptIds],
            sideEffect: active.sideEffect,
          }
        : null,
      pendingInput: aggregate.pendingInput ? { ...aggregate.pendingInput } : null,
      goal: aggregate.context.goal,
      targetProjectPath: aggregate.context.targetProjectPath,
      additionalAllowedPaths: [...aggregate.context.additionalAllowedPaths],
      accessMode: aggregate.context.accessMode,
      awaitingPlanApproval:
        aggregate.pendingInput?.kind === "plan_approval" &&
        aggregate.execution.status === "WAITING_USER",
      planApproved: aggregate.context.approvedPlan !== null,
      selectedPlanChoiceId: aggregate.context.selectedPlanChoiceId,
      planChoices: aggregate.context.planChoices.map((choice) => ({
        id: choice.id,
        title: choice.title,
        body: planBodies.get(choice.id) ?? "",
      })),
      interruptBriefing: aggregate.context.interruptBriefing?.summary ?? null,
      requirements: aggregate.context.requirements.map((item) => ({ ...item })),
      requirementEvidence: aggregate.context.requirementEvidence.map((item) => ({
        ...item,
        artifactIds: [...item.artifactIds],
      })),
      budgets: {
        workflowSteps: {
          consumed: aggregate.execution.workflowStepsConsumed,
          limit: aggregate.definition.budgets.maxWorkflowSteps,
          remaining: Math.max(
            0,
            aggregate.definition.budgets.maxWorkflowSteps -
              aggregate.execution.workflowStepsConsumed
          ),
        },
        cycles: {
          consumed: aggregate.execution.cyclesStarted,
          completed: aggregate.execution.cyclesCompleted,
          limit: aggregate.definition.budgets.maxCycles,
          remaining: Math.max(
            0,
            aggregate.definition.budgets.maxCycles - aggregate.execution.cyclesStarted
          ),
        },
      },
      latestEvent: aggregate.events[aggregate.events.length - 1] ?? null,
      events: aggregate.events.map((event) => ({ ...event, detail: { ...event.detail } })),
      createdAt: aggregate.createdAt,
      updatedAt: aggregate.updatedAt,
    };
  }

  private async loadPlanBodies(
    aggregate: Readonly<RunAggregate>
  ): Promise<Map<string, string>> {
    const bodies = new Map<string, string>();
    const artifactIds = [...new Set(
      aggregate.context.planChoices.map((choice) => choice.planArtifactId)
    )];
    for (const artifactId of artifactIds) {
      const reference = aggregate.artifacts[artifactId];
      if (!reference) continue;
      try {
        const bytes = await this.artifacts.read(
          reference,
          aggregate.definition.budgets.maxArtifactInputBytes
        );
        const envelope = JSON.parse(bytes.toString("utf8")) as {
          payload?: { choices?: Array<{ id?: unknown; plan?: unknown }> };
        };
        for (const choice of envelope.payload?.choices ?? []) {
          if (typeof choice.id === "string" && typeof choice.plan === "string") {
            bodies.set(choice.id, choice.plan);
          }
        }
      } catch {
        // Projection failure for a non-authoritative display body must not alter the run.
      }
    }
    return bodies;
  }

  private async updateIndex(projection: RunProjection): Promise<void> {
    const lockPath = path.join(path.dirname(this.options.indexPath), this.indexLockFileName);
    await withShortFileLock(lockPath, async () => {
      let current: SessionIndexProjection = {
        version: 4,
        activeSessionIds: [],
        sessionMetas: [],
        availableModels: [],
        modelsDiscoveredAt: null,
        modelsDiscoveredCli: null,
        manualModelsOverride: null,
        modelVariants: null,
      };
      try {
        current = JSON.parse(
          await import("node:fs/promises").then((fsp) =>
            fsp.readFile(this.options.indexPath, "utf8")
          )
        ) as SessionIndexProjection;
      } catch {
        // Start a new v4 projection. Legacy registries are intentionally ignored.
      }
      if (current.version !== 4) {
        current = {
          version: 4,
          activeSessionIds: [],
          sessionMetas: [],
          availableModels: [],
          modelsDiscoveredAt: null,
          modelsDiscoveredCli: null,
          manualModelsOverride: null,
          modelVariants: null,
        };
      }
      const meta = {
        sessionId: projection.sessionId,
        goal: projection.goal,
        targetProjectPath: projection.targetProjectPath,
        status: projection.status,
        createdAt: projection.createdAt,
      };
      current.sessionMetas = [
        ...current.sessionMetas.filter((item) => item.sessionId !== projection.sessionId),
        meta,
      ].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      current.activeSessionIds = current.sessionMetas
        .filter((item) => !["SUCCESS", "STOPPED"].includes(item.status))
        .map((item) => item.sessionId);
      await atomicWriteJson(this.options.indexPath, current);
    });
  }
}
