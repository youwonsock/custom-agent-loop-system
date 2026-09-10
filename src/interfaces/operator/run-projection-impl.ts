import * as path from "node:path";
import * as fsp from "node:fs/promises";
import type { RunAggregate } from "../../domain/run-aggregate";
import type { VerificationContract, VerificationContractDraft } from "../../domain/verification";
import type { ArtifactStorePort } from "../../application/ports/artifact-store";
import type { ProjectionPort } from "../../application/ports/projection";
import { atomicWriteJson, atomicWriteText } from "../../../json_file_store";
import { withShortFileLock } from "../../../resilience";
import { validateSessionIndexProjectionV4 } from "./contracts";

const WINDOWS_RESERVED_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/iu;

function safePathSegment(value: string, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty path segment.`);
  const candidate = value.trim();
  if (path.isAbsolute(candidate) || path.win32.isAbsolute(candidate) || path.posix.isAbsolute(candidate) || candidate.includes("\0")) {
    throw new Error(`${label} must be a relative path segment.`);
  }
  const normalized = candidate.replace(/\\/gu, "/");
  const parts = normalized.split("/");
  if (parts.length !== 1 || !parts[0] || parts[0] === "." || parts[0] === "..") {
    throw new Error(`${label} contains an unsafe path segment.`);
  }
  if (/[\x00-\x1f<>:"|?*]/u.test(parts[0]) || /[ .]$/u.test(parts[0]) || WINDOWS_RESERVED_NAME.test(parts[0])) {
    throw new Error(`${label} contains a non-portable path segment.`);
  }
  return parts[0];
}

function currentVerificationId(aggregate: Readonly<RunAggregate>): string | null {
  const activeId = aggregate.execution.activeActivationId;
  if (activeId) {
    const active = aggregate.nodeExecutions[activeId];
    if (active && aggregate.definition.nodes[active.nodeId]?.kind === "verification") {
      return `${activeId}_verification`;
    }
  }
  const latestRecord = aggregate.context.verificationRecords.length > 0
    ? aggregate.context.verificationRecords[aggregate.context.verificationRecords.length - 1]?.verificationId ?? null
    : null;
  return latestRecord ?? aggregate.context.verificationProof?.verificationId ?? null;
}

export interface RunProjectionV2 {
  projectionSchemaVersion: 2;
  stateVersion: 5;
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
  planChoices: Array<{ id: string; title: string; body: string; verification?: VerificationContractDraft }>;
  interruptBriefing: string | null;
  requirements: RunAggregate["context"]["requirements"];
  requirementEvidence: RunAggregate["context"]["requirementEvidence"];
  verification?: {
    /** The exact policy currently approved for core execution. */
    contract: {
      revision: number;
      contractHash: string;
      commands: VerificationContract["commands"];
      totalTimeoutMs: number;
      protectedPaths: string[];
      testRoots: string[];
      allowedNewTestRoots: string[];
      generatedOutputPaths: string[];
      baselineArtifactId: string;
      baselineFingerprint: string;
    } | null;
    /** Cumulative wall-clock budget consumed by the current verification round. */
    elapsedMs: number;
    contractRevision: number | null;
    contractHash: string | null;
    currentVerificationId: string | null;
    currentCommandId: string | null;
    completedCommands: number;
    commandCount: number;
    proofId: string | null;
    proofValid: boolean;
    pendingApproval: RunAggregate["context"]["verificationCandidate"];
    criteriaChanges?: string[];
    invalidationReason: string | null;
    resultArtifactId?: string | null;
    commands: Array<{
      verificationId: string;
      commandId: string;
      status: string;
      executable: string;
      args: string[];
      cwd: string;
      exitCode: number | null;
      signal: string | null;
      timedOut: boolean;
      processTreeClean: boolean | null;
      summary: string;
      elapsedMs?: number;
      outputTruncated?: boolean;
    }>;
  };
  budgets: {
    workflowSteps: { consumed: number; limit: number; remaining: number };
    cycles: { consumed: number; completed: number; limit: number; remaining: number };
  };
  latestEvent: RunAggregate["events"][number] | null;
  events: RunAggregate["events"];
  createdAt: string;
  updatedAt: string;
}

export interface SessionIndexProjectionV4 {
  version: 4;
  activeSessionIds: string[];
  sessionMetas: Array<{
    sessionId: string;
    goal: string;
    targetProjectPath: string;
    status: RunProjectionV2["status"];
    createdAt: string;
  }>;
  availableModels: string[];
  modelsDiscoveredAt: string | null;
  modelsDiscoveredCli: string | null;
  manualModelsOverride: null;
  modelVariants: Record<string, string[]> | null;
  providerCatalog?: Record<string, unknown>;
}

/** The current operator wire projection emitted by the core. */
export type RunProjection = RunProjectionV2;
export type SessionIndexProjection = SessionIndexProjectionV4;

export interface FileProjectionOptions {
  runsRoot: string;
  indexPath: string;
  projectionFileName?: string;
  progressFileName?: string;
  finalSummaryFileName?: string;
  indexLockFileName?: string;
}

/** Initialize the dynamic plan-output directory before writing option files. */
export async function initPlanOutput(runDirectory: string): Promise<void> {
  const parent = await fsp.stat(runDirectory);
  if (!parent.isDirectory()) throw new Error(`Run storage is not a directory: ${runDirectory}`);
  const directory = path.join(runDirectory, "plan_options");
  await fsp.mkdir(directory, { recursive: true });
  const stat = await fsp.stat(directory);
  if (!stat.isDirectory()) throw new Error(`Plan output storage is not a directory: ${directory}`);
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
    this.projectionFileName = safePathSegment(options.projectionFileName ?? "run_projection.json", "projectionFileName");
    this.progressFileName = safePathSegment(options.progressFileName ?? "progress_notes.txt", "progressFileName");
    this.finalSummaryFileName = safePathSegment(options.finalSummaryFileName ?? "final_summary.json", "finalSummaryFileName");
    this.indexLockFileName = safePathSegment(options.indexLockFileName ?? "sessions_index.lock", "indexLockFileName");
  }

  async update(aggregate: Readonly<RunAggregate>): Promise<void> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(aggregate.runId)) throw new Error(`Unsafe run id: ${aggregate.runId}.`);
    const projection = await this.build(aggregate);
    const runDirectory = path.join(this.options.runsRoot, aggregate.runId);
    const runStat = await fsp.stat(runDirectory);
    if (!runStat.isDirectory()) throw new Error(`Run storage is not a directory: ${runDirectory}`);
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
    await initPlanOutput(runDirectory);
    await atomicWriteJson(
      path.join(runDirectory, "plan_choices.json"),
      projection.planChoices
    );
    const overview = projection.planChoices
      .map((choice) => `# ${choice.title}\n\n${choice.body.trim()}\n`)
      .join("\n---\n\n");
    await atomicWriteText(path.join(runDirectory, "plan_options.md"), overview);
    for (const choice of projection.planChoices) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(choice.id)) throw new Error(`Unsafe plan choice id: ${choice.id}.`);
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
    const verificationId = currentVerificationId(aggregate);
    const verificationRecords = verificationId
      ? aggregate.context.verificationRecords.filter((record) => record.verificationId === verificationId)
      : [];
    return {
      projectionSchemaVersion: 2,
      stateVersion: 5,
      sessionId: aggregate.runId,
      runId: aggregate.runId,
      definitionHash: aggregate.definition.definitionHash,
      revision: aggregate.revision,
      fencingEpoch: aggregate.fencingEpoch,
      status: aggregate.execution.status,
      statusReason: aggregate.execution.reason,
      phase: aggregate.execution.currentNodeId,
      currentNodeId: aggregate.execution.currentNodeId,
      currentAgentId: currentNode?.kind === "task" ? currentNode.agentId : null,
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
        ...(choice.verification
          ? { verification: JSON.parse(JSON.stringify(choice.verification)) as VerificationContractDraft }
          : {}),
      })),
      interruptBriefing: aggregate.context.interruptBriefing?.summary ?? null,
      requirements: aggregate.context.requirements.map((item) => ({ ...item })),
      requirementEvidence: aggregate.context.requirementEvidence.map((item) => ({
        ...item,
        artifactIds: [...item.artifactIds],
      })),
      verification: {
        contract: aggregate.context.verificationContract
          ? {
              revision: aggregate.context.verificationContract.revision,
              contractHash: aggregate.context.verificationContract.contractHash,
              commands: aggregate.context.verificationContract.commands.map((command) => ({
                ...command,
                args: [...command.args],
                requirementIds: [...command.requirementIds],
              })),
              totalTimeoutMs: aggregate.context.verificationContract.totalTimeoutMs,
              protectedPaths: [...aggregate.context.verificationContract.protectedPaths],
              testRoots: [...aggregate.context.verificationContract.testRoots],
              allowedNewTestRoots: [...aggregate.context.verificationContract.allowedNewTestRoots],
              generatedOutputPaths: [...aggregate.context.verificationContract.generatedOutputPaths],
              baselineArtifactId: aggregate.context.verificationContract.baselineArtifactId,
              baselineFingerprint: aggregate.context.verificationContract.baselineFingerprint,
            }
          : null,
        elapsedMs: aggregate.context.verificationElapsedMs,
        contractRevision: aggregate.context.verificationContract?.revision ?? null,
        contractHash: aggregate.context.verificationContract?.contractHash ?? null,
        currentVerificationId: verificationId,
        currentCommandId: verificationRecords.find((record) => record.status === "running")?.commandId ?? null,
        completedCommands: verificationRecords.filter((record) => record.status === "completed").length,
        commandCount: aggregate.context.verificationContract?.commands.length ?? 0,
        proofId: aggregate.context.verificationProof?.proofId ?? null,
        proofValid: Boolean(aggregate.context.verificationProof?.passed && !aggregate.context.verificationInvalidationReason),
        pendingApproval: aggregate.context.verificationCandidate,
        criteriaChanges: [...(aggregate.context.verificationCriteriaChanges ?? [])],
        invalidationReason: aggregate.context.verificationInvalidationReason,
        resultArtifactId: aggregate.context.verificationProof?.resultArtifactId ?? null,
        commands: verificationRecords.map((record) => ({
          verificationId: record.verificationId,
          commandId: record.commandId,
          status: record.status,
          executable: record.executable,
          args: [...record.args],
          cwd: record.cwd,
          exitCode: record.exitCode,
          signal: record.signal,
          timedOut: record.timedOut,
          processTreeClean: record.processTreeClean,
          summary: record.summary.slice(0, 8_000),
          ...(record.elapsedMs !== undefined ? { elapsedMs: record.elapsedMs } : {}),
          ...(record.outputTruncated !== undefined ? { outputTruncated: record.outputTruncated } : {}),
        })),
      },
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
      if (!reference) throw new Error(`Plan artifact reference ${artifactId} is missing.`);
      const bytes = await this.artifacts.read(
        reference,
        aggregate.definition.budgets.maxArtifactInputBytes
      );
      let parsed: unknown;
      try { parsed = JSON.parse(bytes.toString("utf8")) as unknown; }
      catch (error) {
        throw new Error(`Plan artifact ${artifactId} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Plan artifact ${artifactId} is not an object envelope.`);
      const envelope = parsed as { schemaVersion?: unknown; payload?: unknown };
      if (envelope.schemaVersion !== 1 || !envelope.payload || typeof envelope.payload !== "object" || Array.isArray(envelope.payload)) {
        throw new Error(`Plan artifact ${artifactId} is not a v1 result envelope.`);
      }
      const choices = (envelope.payload as { choices?: unknown }).choices;
      if (!Array.isArray(choices)) throw new Error(`Plan artifact ${artifactId} does not contain plan choices.`);
      for (const choice of choices) {
        if (!choice || typeof choice !== "object" || Array.isArray(choice)) throw new Error(`Plan artifact ${artifactId} contains an invalid choice.`);
        const item = choice as { id?: unknown; plan?: unknown };
        if (typeof item.id !== "string" || typeof item.plan !== "string" || !item.id.trim() || !item.plan.trim()) {
          throw new Error(`Plan artifact ${artifactId} contains an invalid choice body.`);
        }
        bodies.set(item.id, item.plan);
      }
    }
    for (const choice of aggregate.context.planChoices) {
      if (!bodies.has(choice.id)) throw new Error(`Plan artifact ${choice.planArtifactId} is missing choice ${choice.id}.`);
    }
    return bodies;
  }

  private async updateIndex(projection: RunProjection): Promise<void> {
    const lockPath = path.join(path.dirname(this.options.indexPath), this.indexLockFileName);
    await withShortFileLock(lockPath, async () => {
      let current: SessionIndexProjection;
      try {
        current = validateSessionIndexProjectionV4(
          JSON.parse(await fsp.readFile(this.options.indexPath, "utf8")) as unknown
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error(`Session index is not initialized: ${this.options.indexPath}`);
        }
        if (error instanceof SyntaxError) throw new Error(`Session index is not valid JSON: ${this.options.indexPath}`);
        throw error;
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
        .filter((item) => !["SUCCESS", "STOPPED", "FAILED", "BLOCKED"].includes(item.status))
        .map((item) => item.sessionId);
      await atomicWriteJson(this.options.indexPath, current);
    });
  }
}
