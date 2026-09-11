import { createHash } from "node:crypto";
import * as path from "node:path";
import type { DomainEffect } from "../domain/domain-effect";
import { canonicalJson, type JsonObject, type JsonValue } from "../domain/json";
import type {
  DomainEvent,
  DomainEventType,
  NodeOutcome,
  RunAggregate,
  RunStatus,
} from "../domain/run-aggregate";
import type { ArtifactReference } from "../domain/task-result";
import type { HumanGateResponse } from "../domain/workflow";
import { assertSuccessEligible, requiresCoreVerification } from "../domain/success-policy";
import {
  latestVerificationActivationScope,
  resolveVerificationActivationScope,
} from "../domain/verification-activation-scope";
import type { VerificationProof } from "../domain/verification";
import {
  FindingRecord,
  ReviewApprovalRecord,
  VerificationApprovalCandidate,
  VerificationCommandRecord,
  VerificationContract,
  VerificationContractDraft,
  candidateNeedsVerificationApproval,
  hashVerificationCandidate,
  validateVerificationContractDraft,
} from "../domain/verification";
import type { RunControlType } from "./ports/control-command";
import { evaluateConvergence, type ConvergenceObservation } from "./convergence-evaluator";

export class WorkflowBudgetError extends Error {
  constructor(readonly budget: "workflow_steps" | "cycles" | "node_executions") {
    super(`Workflow ${budget.replaceAll("_", " ")} budget is exhausted.`);
    this.name = "WorkflowBudgetError";
  }
}

function cloneAggregate(aggregate: Readonly<RunAggregate>): RunAggregate {
  return JSON.parse(JSON.stringify(aggregate)) as RunAggregate;
}

function appendEvent(
  aggregate: RunAggregate,
  type: DomainEventType,
  summary: string,
  detail: JsonObject,
  recordedAt: string,
  identity: {
    nodeId?: string | null;
    activationId?: string | null;
    attemptId?: string | null;
  } = {}
): DomainEvent {
  aggregate.eventSequence += 1;
  const event: DomainEvent = {
    schemaVersion: 1,
    sequence: aggregate.eventSequence,
    eventId: `event_${String(aggregate.eventSequence).padStart(12, "0")}`,
    runId: aggregate.runId,
    nodeId: identity.nodeId ?? null,
    activationId: identity.activationId ?? null,
    attemptId: identity.attemptId ?? null,
    type,
    summary: summary.slice(0, 1_000),
    detail,
    recordedAt,
  };
  aggregate.events = [...aggregate.events, event].slice(
    -aggregate.definition.budgets.maxEvents
  );
  return event;
}

function isNodeTarget(aggregate: RunAggregate, targetId: string | null): targetId is string {
  return targetId !== null && aggregate.definition.nodes[targetId] !== undefined;
}

/**
 * Resolve a transition exactly as the compiled definition does.  A caller
 * must never be able to provide an arbitrary target together with a valid
 * looking signal: the reducer is the last authority before a state commit.
 */
function assertOutcomeTransition(
  aggregate: Readonly<RunAggregate>,
  outcome: Readonly<NodeOutcome>
): void {
  if (!outcome.result.signal) {
    throw new Error("Node outcome requires a transition signal.");
  }
  const expectedTarget = aggregate.definition.transitions[outcome.nodeId]?.[outcome.result.signal];
  if (!expectedTarget) {
    throw new Error(`No transition exists for ${outcome.nodeId}.${outcome.result.signal}.`);
  }
  if (outcome.targetId !== expectedTarget) {
    throw new Error(
      `Outcome target ${String(outcome.targetId)} does not match the compiled transition ` +
      `${outcome.nodeId}.${outcome.result.signal} -> ${expectedTarget}.`
    );
  }
  const terminal = aggregate.definition.terminals.find((candidate) => candidate.id === expectedTarget);
  if (terminal) {
    const expectedStatus: RunStatus = terminal.status === "succeeded"
      ? "SUCCESS"
      : terminal.status === "paused"
        ? "PAUSED"
        : terminal.status === "blocked"
          ? "BLOCKED"
          : "STOPPED";
    if (outcome.terminalStatus !== expectedStatus) {
      throw new Error(
        `Outcome terminal status ${String(outcome.terminalStatus)} does not match ` +
        `${expectedTarget} (${expectedStatus}).`
      );
    }
  } else if (outcome.terminalStatus !== null) {
    throw new Error(`Node target ${expectedTarget} is not a terminal.`);
  }
}

function expectedFailureTarget(
  aggregate: Readonly<RunAggregate>,
  nodeId: string,
  failure: NonNullable<NodeOutcome["result"]["failure"]>
): { targetId: string | null; terminalStatus: RunStatus | null } {
  if (failure.kind === "stopped" || failure.controlCommand?.type === "stop") {
    const terminal = aggregate.definition.terminals.find((item) => item.status === "stopped");
    return { targetId: terminal?.id ?? "STOPPED", terminalStatus: "STOPPED" };
  }
  if (failure.kind === "interrupted" || failure.controlCommand?.type === "interrupt") {
    return { targetId: aggregate.definition.applicationPolicy.interruptNodeId, terminalStatus: null };
  }
  if (failure.ambiguousMutation || ["security", "budget", "unknown_mutation"].includes(failure.kind)) {
    return { targetId: aggregate.definition.applicationPolicy.blockedTerminalId, terminalStatus: "BLOCKED" };
  }
  if (nodeId === aggregate.definition.applicationPolicy.interruptNodeId) {
    const terminal = aggregate.definition.terminals.find((item) => item.status === "paused");
    return { targetId: terminal?.id ?? null, terminalStatus: terminal ? "PAUSED" : null };
  }
  return { targetId: aggregate.definition.applicationPolicy.interruptNodeId, terminalStatus: null };
}

function contractHash(contract: VerificationContractDraft): string {
  return createHash("sha256").update(canonicalJson({
    commands: contract.commands,
    totalTimeoutMs: contract.totalTimeoutMs,
    protectedPaths: [...contract.protectedPaths],
    testRoots: [...contract.testRoots],
    allowedNewTestRoots: [...contract.allowedNewTestRoots],
    generatedOutputPaths: [...contract.generatedOutputPaths],
  } as unknown as JsonValue)).digest("hex");
}

function validDigest(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value);
}

function assertArtifactReference(
  reference: Readonly<import("../domain/task-result").ArtifactReference>,
  label: string,
  expectedMediaType?: string
): void {
  if (
    reference.artifactId !== `artifact_${reference.sha256}` ||
    !validDigest(reference.sha256) ||
    !Number.isSafeInteger(reference.bytes) || reference.bytes < 0 ||
    typeof reference.mediaType !== "string" || !reference.mediaType.trim() ||
    !Number.isFinite(Date.parse(reference.createdAt)) ||
    (expectedMediaType !== undefined && reference.mediaType !== expectedMediaType)
  ) {
    throw new Error(`${label} artifact metadata or media type is invalid.`);
  }
}

function assertKnownArtifactId(
  aggregate: Readonly<RunAggregate>,
  artifactId: string,
  label: string
): void {
  if (typeof artifactId !== "string" || !artifactId.trim()) {
    throw new Error(`${label} must reference a non-empty artifact id.`);
  }
  const reference = aggregate.artifacts[artifactId];
  if (!reference) throw new Error(`${label} references a missing artifact ${artifactId}.`);
  assertArtifactReference(reference, label);
}

function assertKnownArtifactIds(
  aggregate: Readonly<RunAggregate>,
  artifactIds: ReadonlyArray<string>,
  label: string
): void {
  for (const artifactId of artifactIds) assertKnownArtifactId(aggregate, artifactId, label);
}

function verificationPreparationNodeId(aggregate: Readonly<RunAggregate>): string {
  const scope = latestVerificationActivationScope(aggregate);
  const scopedTest = scope?.testActivationId
    ? aggregate.nodeExecutions[scope.testActivationId]
    : null;
  if (scopedTest?.sideEffect === "workspace_mutation") return scopedTest.nodeId;
  const verificationNodeId = aggregate.definition.applicationPolicy.verificationNodeId;
  if (!verificationNodeId) throw new Error("Compiled workflow is missing its verification node policy.");
  const predecessor = Object.entries(aggregate.definition.transitions)
    .filter(([, transitions]) => Object.values(transitions).includes(verificationNodeId))
    .map(([nodeId]) => aggregate.definition.nodes[nodeId])
    .find((node) => node?.kind !== "verification" && node?.sideEffect === "workspace_mutation");
  if (!predecessor) throw new Error(`Verification node ${verificationNodeId} has no workspace-mutating predecessor.`);
  return predecessor.id;
}

function planningNodeId(aggregate: Readonly<RunAggregate>): string | null {
  const planApprovalNode = Object.values(aggregate.definition.nodes).find(
    (node) => node.kind === "human_gate" && node.gate?.type === "plan_approval"
  );
  const source = planApprovalNode?.inputs.find((binding) => binding.source.kind === "node_output");
  return source?.source.kind === "node_output" ? source.source.nodeId : null;
}

function sameVerificationCommandRecord(
  left: Readonly<VerificationCommandRecord>,
  right: Readonly<VerificationCommandRecord>
): boolean {
  return left.verificationId === right.verificationId &&
    left.commandId === right.commandId &&
    left.status === right.status &&
    left.executable === right.executable &&
    JSON.stringify(left.args) === JSON.stringify(right.args) &&
    left.cwd === right.cwd &&
    left.approvedExecutable === right.approvedExecutable &&
    JSON.stringify(left.approvedArgs) === JSON.stringify(right.approvedArgs) &&
    left.approvedCwd === right.approvedCwd &&
    left.startedAt === right.startedAt &&
    left.completedAt === right.completedAt &&
    left.exitCode === right.exitCode &&
    left.signal === right.signal &&
    left.timedOut === right.timedOut &&
    left.processTreeClean === right.processTreeClean &&
    left.logArtifactId === right.logArtifactId &&
    left.summary === right.summary &&
    (left.elapsedMs ?? null) === (right.elapsedMs ?? null) &&
    (left.outputTruncated ?? null) === (right.outputTruncated ?? null);
}

function commandRecordMatchesSpec(
  record: Readonly<VerificationCommandRecord>,
  spec: Readonly<import("../domain/verification").VerificationCommandSpec>,
  projectRoot?: string
): boolean {
  const isAbsolutePath = (value: string): boolean =>
    path.isAbsolute(value) || /^[A-Za-z]:[\\/]/u.test(value);
  const basename = (value: string): string => value.replace(/\\/gu, "/").split("/").pop()?.toLowerCase() ?? "";
  const sameArgs = (left: readonly string[], right: readonly string[]): boolean =>
    left.length === right.length && left.every((value, index) => value === right[index]);
  const expectedExecutable = basename(spec.executable);
  const actualExecutable = basename(record.executable);
  const expectedAbsolute = isAbsolutePath(spec.executable);
  const normalizedPath = (value: string): string =>
    value.replace(/\\/gu, "/").replace(/\/+$/u, "").toLowerCase();
  const executableMatches = expectedAbsolute
    ? isAbsolutePath(record.executable) && normalizedPath(record.executable) === normalizedPath(spec.executable)
    : expectedExecutable === "npm" || expectedExecutable === "npm.cmd"
      ? actualExecutable === "node" || actualExecutable === "node.exe"
      : actualExecutable.replace(/\.exe$/u, "") === expectedExecutable.replace(/\.(?:exe|cmd|bat)$/u, "");
  const approvedExecutable = record.approvedExecutable;
  const approvedArgs = record.approvedArgs;
  const approvedCwd = record.approvedCwd;
  const actualCwd = record.cwd;
  const approvedExecutableMatches = approvedExecutable === spec.executable;
  const npmWrapperArgs = (expectedExecutable === "npm" || expectedExecutable === "npm.cmd") &&
    record.args.length === spec.args.length + 1 &&
    basename(record.args[0]) === "npm-cli.js" &&
    sameArgs(record.args.slice(1), spec.args);
  const actualArgsMatches = sameArgs(record.args, spec.args) || npmWrapperArgs;
  const actualCwdMatches = isAbsolutePath(actualCwd) && (() => {
    if (!projectRoot) return true;
    const root = path.resolve(projectRoot);
    const cwd = path.resolve(actualCwd);
    const expectedCwd = path.resolve(root, spec.cwd);
    const relative = path.relative(root, cwd);
    const insideProject = relative === "" ||
      (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    // The runtime may return the real path spelling (and Windows may change
    // case), but it must still be the exact directory approved by the
    // contract. Merely staying somewhere inside the project would let a
    // forged or misconfigured runtime execute a different command context.
    const normalizeAbsolute = (value: string): string => {
      const normalized = path.normalize(value).replace(/[\\/]$/u, "");
      return process.platform === "win32" ? normalized.toLowerCase() : normalized;
    };
    return insideProject && normalizeAbsolute(cwd) === normalizeAbsolute(expectedCwd);
  })();
  return typeof approvedExecutable === "string" && approvedExecutable.trim().length > 0 &&
    typeof actualExecutable === "string" && actualExecutable.trim().length > 0 &&
    typeof approvedCwd === "string" && approvedCwd === spec.cwd && actualCwdMatches &&
    approvedExecutableMatches && executableMatches && actualArgsMatches &&
    Array.isArray(approvedArgs) && sameArgs(approvedArgs, spec.args);
}

function assertCommandRecordShape(
  record: Readonly<VerificationCommandRecord>,
  spec: Readonly<import("../domain/verification").VerificationCommandSpec>,
  projectRoot?: string
): void {
  if (!commandRecordMatchesSpec(record, spec, projectRoot)) {
    throw new Error(`Verification command ${record.commandId} does not match the approved command.`);
  }
  if (!Array.isArray(record.args) || record.args.some((arg) => typeof arg !== "string")) {
    throw new Error(`Verification command ${record.commandId} arguments are invalid.`);
  }
  if (typeof record.approvedExecutable !== "string" || !record.approvedExecutable.trim()) {
    throw new Error(`Verification command ${record.commandId} approved executable is invalid.`);
  }
  if (!Array.isArray(record.approvedArgs) || record.approvedArgs.some((arg) => typeof arg !== "string")) {
    throw new Error(`Verification command ${record.commandId} approved arguments are invalid.`);
  }
  if (typeof record.approvedCwd !== "string") {
    throw new Error(`Verification command ${record.commandId} approved cwd is invalid.`);
  }
  if (record.status === "reserved") {
    if (record.startedAt !== null || record.completedAt !== null || record.exitCode !== null ||
        record.signal !== null || record.timedOut || record.processTreeClean !== null ||
        record.logArtifactId !== null) {
      throw new Error("A reserved verification command cannot contain execution results.");
    }
  } else if (record.status === "running") {
    if (!record.startedAt || !Number.isFinite(Date.parse(record.startedAt)) ||
        record.completedAt !== null || record.exitCode !== null || record.signal !== null ||
        record.timedOut || record.processTreeClean !== null || record.logArtifactId !== null) {
      throw new Error("A running verification command requires only a valid start checkpoint.");
    }
  } else if (record.status === "completed") {
    if (!record.startedAt || !Number.isFinite(Date.parse(record.startedAt)) ||
        !record.completedAt || !Number.isFinite(Date.parse(record.completedAt)) ||
        Date.parse(record.completedAt) < Date.parse(record.startedAt) ||
        (record.exitCode !== null && !Number.isSafeInteger(record.exitCode)) ||
        (record.signal !== null && typeof record.signal !== "string") ||
        typeof record.timedOut !== "boolean" || typeof record.processTreeClean !== "boolean") {
      throw new Error("A completed verification command has invalid execution metadata.");
    }
  } else if (record.status === "not_run") {
    if (record.startedAt !== null || record.completedAt !== null || record.exitCode !== null ||
        record.signal !== null || record.timedOut || record.processTreeClean === true ||
        record.logArtifactId !== null) {
      throw new Error("A not_run verification command cannot contain execution results.");
    }
  } else {
    throw new Error(`Unknown verification command status: ${String(record.status)}.`);
  }
  if (typeof record.summary !== "string" || record.summary.length > 8_000) {
    throw new Error(`Verification command ${record.commandId} summary is invalid.`);
  }
  if (record.elapsedMs !== undefined &&
      (!Number.isSafeInteger(record.elapsedMs) || record.elapsedMs < 0)) {
    throw new Error(`Verification command ${record.commandId} elapsed time is invalid.`);
  }
  if (record.outputTruncated !== undefined && typeof record.outputTruncated !== "boolean") {
    throw new Error(`Verification command ${record.commandId} output truncation flag is invalid.`);
  }
}

function applyEffect(
  aggregate: RunAggregate,
  effect: DomainEffect,
  activationId: string,
  recordedAt: string
): void {
  switch (effect.type) {
    case "record_plan_choices":
      aggregate.context.planChoices = effect.choices.map((choice) => {
        if (
          typeof choice.id !== "string" || !choice.id.trim() ||
          typeof choice.title !== "string" || !choice.title.trim()
        ) {
          throw new Error("Plan choice identity is invalid.");
        }
        assertKnownArtifactId(aggregate, choice.planArtifactId, "Plan choice");
        if (choice.verification) {
          validateVerificationContractDraft(
            choice.verification,
            new Set(aggregate.context.requirements.map((requirement) => requirement.id))
          );
        }
        return {
          ...choice,
          ...(choice.verification
            ? {
                verification: {
                  ...choice.verification,
                  commands: choice.verification.commands.map((command) => ({
                    ...command,
                    args: [...command.args],
                    requirementIds: [...command.requirementIds],
                  })),
                  protectedPaths: [...choice.verification.protectedPaths],
                  testRoots: [...choice.verification.testRoots],
                  allowedNewTestRoots: [...choice.verification.allowedNewTestRoots],
                  generatedOutputPaths: [...choice.verification.generatedOutputPaths],
                },
              }
            : {}),
        };
      });
      aggregate.context.selectedVerificationDraft = null;
      return;
    case "set_approved_plan": {
      const execution = aggregate.nodeExecutions[activationId];
      if (!execution.output) throw new Error("Approved-plan effect requires a task output.");
      assertKnownArtifactId(aggregate, effect.planArtifactId, "Approved plan");
      aggregate.context.selectedPlanChoiceId = effect.choiceId;
      aggregate.context.selectedVerificationDraft = null;
      const selectedChoice = aggregate.context.planChoices.find((choice) => choice.id === effect.choiceId);
      if (selectedChoice?.verification) {
        aggregate.context.selectedVerificationDraft = JSON.parse(JSON.stringify(selectedChoice.verification));
      }
      aggregate.context.approvedPlan = {
        ...execution.output,
        artifactId: effect.planArtifactId,
      };
      return;
    }
    case "add_requirement_evidence":
      for (const item of effect.evidence) {
        assertKnownArtifactIds(aggregate, item.artifactIds ?? [], "Requirement evidence");
      }
      aggregate.context.requirementEvidence = [
        ...aggregate.context.requirementEvidence,
        ...effect.evidence.map((item) => ({
          activationId,
          requirementId: item.requirementId,
          status: item.status,
          evidence: item.evidence,
          artifactIds: [...(item.artifactIds ?? [])],
        })),
      ].slice(-2_000);
      return;
    case "set_failure_summary":
      aggregate.context.failureSummary = effect.summary.slice(0, 20_000);
      return;
    case "clear_failure_summary":
      aggregate.context.failureSummary = null;
      return;
    case "update_convergence":
      aggregate.context.convergence.history = [
        ...aggregate.context.convergence.history,
        { signature: effect.signature.slice(0, 2_000), improved: effect.improved, recordedAt },
      ].slice(-100);
      aggregate.context.convergence.stagnantCycles = effect.improved
        ? 0
        : aggregate.context.convergence.stagnantCycles + 1;
      return;
    case "record_interrupt_briefing":
      assertKnownArtifactId(aggregate, effect.artifactId, "Interrupt briefing");
      aggregate.context.interruptBriefing = {
        artifactId: effect.artifactId,
        summary: effect.summary.slice(0, 4_096),
      };
      return;
    case "record_verification_criteria_changes":
      assertKnownArtifactId(aggregate, effect.artifactId, "Verification criteria changes");
      aggregate.context.verificationCriteriaChanges = [
        ...new Set([
          ...(aggregate.context.verificationCriteriaChanges ?? []),
          ...effect.changes.map((change) => change.trim()).filter(Boolean),
        ]),
      ].slice(-200);
      return;
    case "record_review_approval": {
      const proof = aggregate.context.verificationProof;
      const contract = aggregate.context.verificationContract;
      if (!proof || !proof.passed || !proof.watcherReliable || proof.executionError) {
        throw new Error("Review approval requires a reliable passing verification proof.");
      }
      if (effect.proofId !== proof.proofId || effect.contractRevision !== contract?.revision) {
        throw new Error("Review approval does not match the active verification proof.");
      }
      if (aggregate.context.latestWorkspaceFingerprint !== proof.afterFingerprint) {
        throw new Error("Review approval requires a fresh core workspace fingerprint.");
      }
      if (aggregate.context.reviewApprovals.some((item) => item.stage === effect.stage)) {
        throw new Error(`A ${effect.stage} approval is already recorded for this proof.`);
      }
      if (effect.stage === "master" && aggregate.context.reviewApprovals[aggregate.context.reviewApprovals.length - 1]?.stage !== "qa") {
        throw new Error("Master approval requires a matching QA approval first.");
      }
      const required = new Set(aggregate.context.requirements.map((item) => item.id));
      const unknownRequirements = effect.requirementIds.filter((id) => !required.has(id));
      if (unknownRequirements.length > 0) {
        throw new Error(`Review approval references unknown requirements: ${[...new Set(unknownRequirements)].join(", ")}.`);
      }
      if ([...required].some((id) => !effect.requirementIds.includes(id))) {
        throw new Error("Review approval is missing requirement evidence.");
      }
      const expectedNodeId = effect.stage === "qa"
        ? aggregate.definition.applicationPolicy.qaNodeId
        : aggregate.definition.applicationPolicy.completionApprovalNodeId;
      const approvalExecution = aggregate.nodeExecutions[activationId];
      if (!expectedNodeId || !approvalExecution || approvalExecution.nodeId !== expectedNodeId) {
        throw new Error(`The ${effect.stage} approval activation does not match the compiled policy.`);
      }
      const resolvedFindingIds = new Set(effect.resolvedFindingIds);
      const unknownFindingIds = effect.resolvedFindingIds.filter(
        (findingId) => !aggregate.context.findings.some((finding) => finding.id === findingId)
      );
      if (unknownFindingIds.length > 0) {
        throw new Error(`Review approval references unknown findings: ${[...new Set(unknownFindingIds)].join(", ")}.`);
      }
      const omittedFindings = aggregate.context.findings.filter(
        (finding) => finding.status === "open" && !resolvedFindingIds.has(finding.id)
      );
      if (omittedFindings.length > 0) {
        throw new Error(`Review approval must resolve every open finding: ${omittedFindings.map((finding) => finding.id).join(", ")}.`);
      }
      if (new Set(effect.requirementIds).size !== effect.requirementIds.length ||
          new Set(effect.resolvedFindingIds).size !== effect.resolvedFindingIds.length ||
          !effect.rationale.trim()) {
        throw new Error("Review approval contains duplicate evidence ids or an empty rationale.");
      }
      aggregate.context.reviewApprovals.push({
        stage: effect.stage,
        activationId,
        proofId: effect.proofId,
        contractRevision: effect.contractRevision,
        requirementIds: [...effect.requirementIds],
        resolvedFindingIds: [...effect.resolvedFindingIds],
        rationale: effect.rationale.slice(0, 20_000),
        recordedAt,
      });
      for (const findingId of effect.resolvedFindingIds) {
        const finding = aggregate.context.findings.find((item) => item.id === findingId);
        if (finding) {
          finding.status = "resolved";
          finding.resolvedAt = recordedAt;
        }
      }
      return;
    }
    case "record_findings": {
      assertKnownArtifactIds(aggregate, effect.artifactIds, "Finding evidence");
      for (const raw of effect.findings) {
        const text = raw.trim();
        if (!text) continue;
        const id = `finding_${createHash("sha256").update(`${effect.source}:${text}`).digest("hex").slice(0, 16)}`;
        const existing = aggregate.context.findings.find((item) => item.id === id);
        if (existing) {
          existing.text = text.slice(0, 8_000);
          existing.status = "open";
          existing.resolvedAt = null;
          existing.artifactIds = [...effect.artifactIds];
        } else {
          aggregate.context.findings.push({
            id,
            text: text.slice(0, 8_000),
            status: "open",
            source: effect.source,
            artifactIds: [...effect.artifactIds],
            firstSeenAt: recordedAt,
            resolvedAt: null,
          });
        }
      }
      return;
    }
    default: {
      const exhaustive: never = effect;
      throw new Error(`Unsupported domain effect: ${JSON.stringify(exhaustive)}`);
    }
  }
}

export class RunReducer {
  applyBoundaryControl(
    source: Readonly<RunAggregate>,
    requestId: string,
    type: RunControlType,
    message: string | null,
    recordedAt: string,
    permitRecordedAttempt = false
  ): RunAggregate {
    const aggregate = cloneAggregate(source);
    if (aggregate.processedRequestIds.includes(requestId)) return aggregate;
    const activationId = aggregate.execution.activeActivationId;
    const execution = activationId ? aggregate.nodeExecutions[activationId] : null;
    if (execution?.status === "running" && !permitRecordedAttempt) {
      throw new Error(`Control ${type} must be delivered through the active provider boundary.`);
    }
    const cancelledVerification = Boolean(
      execution && aggregate.definition.nodes[execution.nodeId]?.kind === "verification"
    );
    const verificationId = cancelledVerification && activationId
      ? `${activationId}_verification`
      : null;
    // A STOP/INTERRUPT observed after the verification runtime has reported
    // an unconfirmed process tree is not a clean operator cancellation.  The
    // command may still be mutating the workspace, so the boundary must stay
    // blocked until an operator reconciles it instead of being downgraded to
    // STOPPED/PAUSED.
    const verificationProcessUncertain = Boolean(
      cancelledVerification && (
        aggregate.context.verificationProof?.executionError === true ||
        (verificationId && aggregate.context.verificationRecords.some((record) =>
          record.verificationId === verificationId && (
            record.status === "running" ||
            (record.status === "completed" && record.processTreeClean !== true)
          )
        ))
      )
    );
    if (execution) {
      execution.status = "cancelled";
      execution.completedAt = recordedAt;
    }
    aggregate.execution.activeActivationId = null;
    aggregate.pendingInput = null;
    if (cancelledVerification) {
      // A cancelled verification activation is an observed end of that
      // verification round. Keep its command checkpoints for audit, but make
      // every proof/approval derived from the round unusable and force the
      // next replay through TEST. This prevents STOP/INTERRUPT recovery from
      // reserving VERIFY again and replaying a command whose process outcome
      // was intentionally cancelled.
      aggregate.context.verificationProof = null;
      aggregate.context.latestWorkspaceFingerprint = null;
      aggregate.context.reviewApprovals = [];
      aggregate.context.verificationCandidate = null;
      aggregate.context.verificationInvalidationReason ??=
        `Verification activation ${activationId} was cancelled by operator control.`;
      aggregate.context.resumeNodeId = verificationPreparationNodeId(aggregate);
    }
    aggregate.processedRequestIds = [
      ...aggregate.processedRequestIds,
      requestId,
    ].slice(-256);
    const reason = message?.trim() || (
      type === "stop" ? "Operator stopped the run." : "Operator interrupted the run."
    );
    if (verificationProcessUncertain) {
      const failure = {
        kind: "unknown_mutation" as const,
        message: `Verification process cleanup could not be confirmed before control '${type}'. ${reason}`.slice(0, 8_000),
        retryable: false,
        ambiguousMutation: true,
        attemptId: null,
      };
      if (execution) {
        execution.status = "unknown_mutation";
        execution.signal = "error";
        execution.failure = { ...failure };
      }
      aggregate.execution.status = "BLOCKED";
      aggregate.execution.reason = failure.message;
      aggregate.execution.lastFailure = { ...failure };
      aggregate.context.failureSummary = failure.message;
      aggregate.context.verificationInvalidationReason = failure.message;
      aggregate.context.verificationProof = null;
      aggregate.context.latestWorkspaceFingerprint = null;
      aggregate.context.reviewApprovals = [];
      appendEvent(
        aggregate,
        "node.failed",
        failure.message,
        { control: type, requestId, ambiguousMutation: true },
        recordedAt,
        { nodeId: execution?.nodeId ?? null, activationId }
      );
      aggregate.updatedAt = recordedAt;
      return aggregate;
    }
    if (type === "stop") {
      aggregate.execution.status = "STOPPED";
      aggregate.execution.reason = reason;
      appendEvent(
        aggregate,
        "run.paused",
        reason,
        { control: "stop", requestId },
        recordedAt,
        {
          nodeId: execution?.nodeId ?? aggregate.execution.currentNodeId,
          activationId,
        }
      );
    } else {
      const failure = {
        kind: "interrupted" as const,
        message: reason,
        retryable: false,
        ambiguousMutation: false,
        attemptId: null,
      };
      aggregate.execution.lastFailure = failure;
      aggregate.context.failureSummary = reason;
      aggregate.context.recovery = {
        source: "operator_interrupt",
        message: reason,
        interruptedNodeId: execution?.nodeId ?? aggregate.execution.currentNodeId,
        recordedAt,
      };
      aggregate.execution.currentNodeId = aggregate.definition.applicationPolicy.interruptNodeId;
      aggregate.execution.status = "RUNNING";
      aggregate.execution.reason = null;
      appendEvent(
        aggregate,
        "run.resumed",
        `Interrupt analysis requested: ${reason}`,
        { control: "interrupt", requestId },
        recordedAt,
        {
          nodeId: execution?.nodeId ?? null,
          activationId,
        }
      );
    }
    aggregate.updatedAt = recordedAt;
    return aggregate;
  }

  resumeRun(
    source: Readonly<RunAggregate>,
    reason: string,
    recordedAt: string
  ): RunAggregate {
    const unresolvedMutation = Object.values(source.nodeExecutions).find(
      (execution) => execution.status === "unknown_mutation"
    );
    if (unresolvedMutation) {
      throw new Error(
        `Mutation activation ${unresolvedMutation.activationId} has an unknown outcome; ` +
        "operator reconciliation is required before any replay."
      );
    }
    if (source.execution.status === "BLOCKED") {
      throw new Error(source.execution.reason ?? "Blocked runs cannot be resumed automatically.");
    }
    const aggregate = cloneAggregate(source);
    if (
      aggregate.execution.status === "PAUSED" &&
      aggregate.execution.currentNodeId === aggregate.definition.applicationPolicy.interruptNodeId
    ) {
      aggregate.execution.currentNodeId = aggregate.context.verificationInvalidationReason
        ? verificationPreparationNodeId(aggregate)
        : aggregate.context.approvedPlan
          ? aggregate.definition.cyclePolicy.startNodeId
          : aggregate.definition.startNodeId;
    }
    if (aggregate.context.verificationInvalidationReason) {
      aggregate.execution.currentNodeId = verificationPreparationNodeId(aggregate);
      // The persisted resume location is consumed by this transition. If the
      // run is stopped again, the current node itself is the authoritative
      // location; retaining the old marker could later redirect a valid
      // post-verification stop back to TEST.
      aggregate.context.resumeNodeId = null;
    } else if (aggregate.context.resumeNodeId) {
      aggregate.execution.currentNodeId = aggregate.context.resumeNodeId;
      aggregate.context.resumeNodeId = null;
    }
    aggregate.execution.status = "RUNNING";
    aggregate.execution.reason = reason;
    appendEvent(
      aggregate,
      "run.resumed",
      reason,
      { fromStatus: source.execution.status },
      recordedAt
    );
    aggregate.updatedAt = recordedAt;
    return aggregate;
  }

  reserveNode(
    source: Readonly<RunAggregate>,
    activationId: string,
    recordedAt: string
  ): RunAggregate {
    const aggregate = cloneAggregate(source);
    if (aggregate.execution.status !== "RUNNING") {
      throw new Error(`Cannot reserve a node while run is ${aggregate.execution.status}.`);
    }
    if (aggregate.execution.activeActivationId) {
      throw new Error(`Activation ${aggregate.execution.activeActivationId} is already active.`);
    }
    if (
      aggregate.execution.workflowStepsConsumed >=
      aggregate.definition.budgets.maxWorkflowSteps
    ) {
      throw new WorkflowBudgetError("workflow_steps");
    }
    if (
      Object.keys(aggregate.nodeExecutions).length >=
      aggregate.definition.budgets.maxNodeExecutions
    ) {
      throw new WorkflowBudgetError("node_executions");
    }
    const nodeId = aggregate.execution.currentNodeId;
    const node = aggregate.definition.nodes[nodeId];
    if (!node) throw new Error(`Current node ${nodeId} is not in the compiled definition.`);
    // Any new workspace mutation invalidates proof and downstream approvals.
    // Keep the failed verification feedback for the next implementation input,
    // but require VERIFY to produce a fresh proof before a later SUCCESS.
    if (node.sideEffect === "workspace_mutation" && node.kind !== "verification" &&
        (aggregate.context.verificationProof?.passed === true || aggregate.context.reviewApprovals.length > 0)) {
      aggregate.context.verificationProof = null;
      aggregate.context.latestWorkspaceFingerprint = null;
      aggregate.context.reviewApprovals = [];
      aggregate.context.verificationInvalidationReason ??=
        `Workspace mutation at ${node.id} requires a new core verification proof.`;
    }
    let cycleNumber = aggregate.execution.activeCycleNumber;
    if (nodeId === aggregate.definition.cyclePolicy.startNodeId && cycleNumber === null) {
      if (aggregate.execution.cyclesStarted >= aggregate.definition.budgets.maxCycles) {
        throw new WorkflowBudgetError("cycles");
      }
      aggregate.execution.cyclesStarted += 1;
      cycleNumber = aggregate.execution.cyclesStarted;
      aggregate.execution.activeCycleNumber = cycleNumber;
    }
    aggregate.execution.workflowStepsConsumed += 1;
    aggregate.execution.activeActivationId = activationId;
    aggregate.nodeExecutions[activationId] = {
      activationId,
      nodeId,
      taskId: node.kind === "task" ? node.taskId : null,
      agentId: node.kind === "task" ? node.agentId : null,
      workflowStep: aggregate.execution.workflowStepsConsumed,
      cycleNumber,
      status: "reserved",
      sideEffect: node.sideEffect,
      attemptIds: [],
      reservedAt: recordedAt,
      startedAt: null,
      completedAt: null,
      output: null,
      signal: null,
      failure: null,
    };
    appendEvent(
      aggregate,
      "node.reserved",
      `Node ${nodeId} activation reserved.`,
      {
        workflowStep: aggregate.execution.workflowStepsConsumed,
        cycleNumber,
        sideEffect: node.sideEffect,
      },
      recordedAt,
      { nodeId, activationId }
    );
    aggregate.updatedAt = recordedAt;
    return aggregate;
  }

  startAttempt(
    source: Readonly<RunAggregate>,
    activationId: string,
    attemptId: string,
    recordedAt: string
  ): RunAggregate {
    const aggregate = cloneAggregate(source);
    if (aggregate.execution.activeActivationId !== activationId) {
      throw new Error(`Activation ${activationId} is not active.`);
    }
    const execution = aggregate.nodeExecutions[activationId];
    if (!execution || !["reserved", "running"].includes(execution.status)) {
      throw new Error(`Activation ${activationId} cannot start an attempt.`);
    }
    const node = aggregate.definition.nodes[execution.nodeId];
    if (!node || node.kind !== "task") {
      throw new Error(`Activation ${activationId} is not a task activation.`);
    }
    if (execution.attemptIds.includes(attemptId)) {
      throw new Error(`Attempt ${attemptId} is already recorded.`);
    }
    execution.attemptIds.push(attemptId);
    execution.status = "running";
    execution.startedAt ??= recordedAt;
    appendEvent(
      aggregate,
      "node.started",
      `Node ${execution.nodeId} attempt ${execution.attemptIds.length} started.`,
      { attemptNumber: execution.attemptIds.length },
      recordedAt,
      { nodeId: execution.nodeId, activationId, attemptId }
    );
    aggregate.updatedAt = recordedAt;
    return aggregate;
  }

  requestHumanInput(
    source: Readonly<RunAggregate>,
    context: JsonValue,
    recordedAt: string
  ): RunAggregate {
    const aggregate = cloneAggregate(source);
    const activationId = aggregate.execution.activeActivationId;
    if (!activationId) throw new Error("A human gate requires an active activation.");
    const execution = aggregate.nodeExecutions[activationId];
    const node = aggregate.definition.nodes[execution.nodeId];
    if (!node || node.kind !== "human_gate" || !node.gate) {
      throw new Error(`Activation ${activationId} is not a human gate.`);
    }
    if (execution.status !== "reserved") {
      throw new Error(`Human gate activation ${activationId} is not reserved.`);
    }
    aggregate.context.requestSequence += 1;
    const effectiveRequestId =
      `request_${activationId}_${node.gate.type}_${aggregate.context.requestSequence}`;
    execution.status = "waiting_user";
    aggregate.pendingInput = {
      requestId: effectiveRequestId,
      kind: node.gate.type,
      nodeId: node.id,
      activationId,
      prompt: node.gate.prompt,
      allowedSignals: [...node.gate.allowedSignals],
      context,
      createdAt: recordedAt,
    };
    aggregate.execution.status = "WAITING_USER";
    aggregate.execution.reason = node.gate.prompt;
    appendEvent(
      aggregate,
      "human_input.requested",
      `Human input requested for ${node.id}.`,
      { requestId: effectiveRequestId, kind: node.gate.type },
      recordedAt,
      { nodeId: node.id, activationId }
    );
    aggregate.updatedAt = recordedAt;
    return aggregate;
  }

  requestTaskHumanInput(
    source: Readonly<RunAggregate>,
    result: import("../domain/task-result").TaskExecutionResult,
    recordedAt: string
  ): RunAggregate {
    const aggregate = cloneAggregate(source);
    const pending = result.pendingInput;
    const activationId = aggregate.execution.activeActivationId;
    if (result.status !== "waiting_user" || !pending || !activationId) {
      throw new Error("Task human-input request is incomplete.");
    }
    if (pending.activationId !== activationId) {
      throw new Error(`Pending input activation ${pending.activationId} is not active.`);
    }
    const execution = aggregate.nodeExecutions[activationId];
    const node = execution ? aggregate.definition.nodes[execution.nodeId] : null;
    if (!execution || node?.kind !== "task" || execution.status !== "running") {
      throw new Error(`Activation ${activationId} cannot wait for task human input.`);
    }
    for (const artifact of result.artifacts) {
      assertArtifactReference(artifact, "Task human-input result");
      aggregate.artifacts[artifact.artifactId] = { ...artifact };
    }
    aggregate.context.requestSequence += 1;
    const effectiveRequestId =
      `request_${activationId}_${pending.kind}_${aggregate.context.requestSequence}`;
    execution.status = "waiting_user";
    aggregate.pendingInput = {
      ...pending,
      requestId: effectiveRequestId,
      allowedSignals: [...pending.allowedSignals],
    };
    aggregate.execution.status = "WAITING_USER";
    aggregate.execution.reason = pending.prompt;
    appendEvent(
      aggregate,
      "human_input.requested",
      `Human input requested for ${execution.nodeId}.`,
      { requestId: effectiveRequestId, kind: pending.kind },
      recordedAt,
      {
        nodeId: execution.nodeId,
        activationId,
        attemptId: execution.attemptIds[execution.attemptIds.length - 1] ?? null,
      }
    );
    aggregate.updatedAt = recordedAt;
    return aggregate;
  }

  requestVerificationApproval(
    source: Readonly<RunAggregate>,
    candidate: VerificationApprovalCandidate,
    recordedAt: string,
    prompt = "Verification criteria or protected files changed. Review and approve the proposed verification contract.",
    diffArtifact?: import("../domain/task-result").ArtifactReference,
    baselineArtifact?: import("../domain/task-result").ArtifactReference
  ): RunAggregate {
    const aggregate = cloneAggregate(source);
    const activationId = aggregate.execution.activeActivationId;
    if (!activationId) throw new Error("Verification approval requires an active activation.");
    const execution = aggregate.nodeExecutions[activationId];
    const node = execution ? aggregate.definition.nodes[execution.nodeId] : null;
    if (!execution || node?.kind !== "verification") {
      throw new Error(`Activation ${activationId} cannot request verification approval.`);
    }
    if (hashVerificationCandidate(candidate) !== candidate.candidateHash) {
      throw new Error("Verification approval candidate hash does not match its contents.");
    }
    if (aggregate.context.verificationContract && candidate.baseRevision !== aggregate.context.verificationContract.revision) {
      throw new Error("Verification approval candidate is based on an old contract revision.");
    }
    if (aggregate.pendingInput) {
      if (aggregate.pendingInput.kind !== "verification_approval") {
        throw new Error("Another human input request is already pending.");
      }
      if (aggregate.context.verificationCandidate?.candidateHash !== candidate.candidateHash) {
        throw new Error("A different verification approval candidate is already pending.");
      }
      // Re-delivery of the same candidate is idempotent.  Never mint another
      // request id for an approval that is already waiting on the operator.
      return aggregate;
    }
    if (execution.status !== "reserved") {
      throw new Error(`Activation ${activationId} cannot request verification approval.`);
    }
    aggregate.context.requestSequence += 1;
    const requestId = `request_${activationId}_verification_approval_${aggregate.context.requestSequence}`;
    aggregate.context.verificationCandidate = JSON.parse(JSON.stringify(candidate)) as VerificationApprovalCandidate;
    if (diffArtifact) {
      assertArtifactReference(diffArtifact, "Verification diff", "application/vnd.custom-agent-loop.verification-diff+json;version=1");
      if (candidate.diffArtifactId !== diffArtifact.artifactId) {
        throw new Error("Verification diff artifact id does not match the candidate.");
      }
      aggregate.artifacts[diffArtifact.artifactId] = { ...diffArtifact };
    }
    if (baselineArtifact) {
      assertArtifactReference(baselineArtifact, "Verification baseline", "application/vnd.custom-agent-loop.workspace-fingerprint+json;version=1");
      if (candidate.baselineArtifactId !== baselineArtifact.artifactId) {
        throw new Error("Verification baseline artifact id does not match the candidate.");
      }
      aggregate.artifacts[baselineArtifact.artifactId] = { ...baselineArtifact };
    }
    aggregate.pendingInput = {
      requestId,
      kind: "verification_approval",
      nodeId: node.id,
      activationId,
      prompt,
      allowedSignals: ["approved", "rejected"],
      context: JSON.parse(JSON.stringify(candidate)) as JsonValue,
      createdAt: recordedAt,
    };
    execution.status = "waiting_user";
    aggregate.execution.status = "WAITING_USER";
    aggregate.execution.reason = prompt;
    appendEvent(
      aggregate,
      "human_input.requested",
      `Verification contract approval requested for ${node.id}.`,
      {
        requestId,
        kind: "verification_approval",
        candidateHash: candidate.candidateHash,
        contractRevision: candidate.baseRevision,
      },
      recordedAt,
      { nodeId: node.id, activationId }
    );
    aggregate.updatedAt = recordedAt;
    return aggregate;
  }

  /**
   * Replace a pending verification candidate after the approval screen
   * observed a workspace change. The old request remains immutable and a new
   * monotonic request id is issued for the newly captured candidate.
   */
  refreshVerificationApprovalCandidate(
    source: Readonly<RunAggregate>,
    candidate: VerificationApprovalCandidate,
    recordedAt: string,
    prompt?: string,
    diffArtifact?: import("../domain/task-result").ArtifactReference,
    baselineArtifact?: import("../domain/task-result").ArtifactReference
  ): RunAggregate {
    const aggregate = cloneAggregate(source);
    const pending = aggregate.pendingInput;
    const activationId = aggregate.execution.activeActivationId;
    const execution = activationId ? aggregate.nodeExecutions[activationId] : null;
    const node = execution ? aggregate.definition.nodes[execution.nodeId] : null;
    const contract = aggregate.context.verificationContract;
    if (
      !pending || pending.kind !== "verification_approval" ||
      !activationId || !execution || node?.kind !== "verification" ||
      execution.status !== "waiting_user" || !contract
    ) {
      throw new Error("A pending verification approval is required before refreshing its candidate.");
    }
    if (candidate.baseRevision !== contract.revision) {
      throw new Error("Verification approval candidate is based on an old contract revision.");
    }
    if (hashVerificationCandidate(candidate) !== candidate.candidateHash) {
      throw new Error("Verification approval candidate hash does not match its contents.");
    }
    if (aggregate.context.verificationCandidate?.candidateHash === candidate.candidateHash) {
      return aggregate;
    }
    if (candidate.diffArtifactId !== null && candidate.diffArtifactId !== undefined) {
      if (diffArtifact && candidate.diffArtifactId !== diffArtifact.artifactId) {
        throw new Error("Verification diff artifact id does not match the refreshed candidate.");
      }
      const diff = diffArtifact ?? aggregate.artifacts[candidate.diffArtifactId];
      if (!diff) throw new Error("Verification approval candidate diff artifact is missing.");
      assertArtifactReference(diff, "Verification diff", "application/vnd.custom-agent-loop.verification-diff+json;version=1");
      aggregate.artifacts[diff.artifactId] = { ...diff };
    }
    if (candidate.baselineArtifactId !== null && candidate.baselineArtifactId !== undefined) {
      if (baselineArtifact && candidate.baselineArtifactId !== baselineArtifact.artifactId) {
        throw new Error("Verification baseline artifact id does not match the refreshed candidate.");
      }
      const baseline = baselineArtifact ?? aggregate.artifacts[candidate.baselineArtifactId];
      if (!baseline) throw new Error("Verification approval candidate baseline artifact is missing.");
      assertArtifactReference(baseline, "Verification baseline", "application/vnd.custom-agent-loop.workspace-fingerprint+json;version=1");
      aggregate.artifacts[baseline.artifactId] = { ...baseline };
    }
    const nextDraft: VerificationContractDraft = {
      commands: candidate.commands.map((command) => ({
        ...command,
        args: [...command.args],
        requirementIds: [...command.requirementIds],
      })),
      totalTimeoutMs: candidate.totalTimeoutMs,
      protectedPaths: [...candidate.protectedPaths],
      testRoots: [...candidate.testRoots],
      allowedNewTestRoots: [...candidate.allowedNewTestRoots],
      generatedOutputPaths: [...candidate.generatedOutputPaths],
    };
    validateVerificationContractDraft(
      nextDraft,
      new Set(aggregate.context.requirements.map((requirement) => requirement.id))
    );
    aggregate.context.requestSequence += 1;
    const requestId = `request_${activationId}_verification_approval_${aggregate.context.requestSequence}`;
    aggregate.context.verificationCandidate = JSON.parse(JSON.stringify(candidate)) as VerificationApprovalCandidate;
    aggregate.pendingInput = {
      ...pending,
      requestId,
      prompt: prompt ?? pending.prompt,
      context: JSON.parse(JSON.stringify(candidate)) as JsonValue,
      createdAt: recordedAt,
    };
    aggregate.execution.status = "WAITING_USER";
    aggregate.execution.reason = aggregate.pendingInput.prompt;
    appendEvent(
      aggregate,
      "human_input.requested",
      `Verification approval request refreshed for ${node.id}.`,
      {
        requestId,
        kind: "verification_approval",
        candidateHash: candidate.candidateHash,
        contractRevision: candidate.baseRevision,
        replacedRequestId: pending.requestId,
      },
      recordedAt,
      { nodeId: node.id, activationId }
    );
    aggregate.updatedAt = recordedAt;
    return aggregate;
  }

  setVerificationContract(
    source: Readonly<RunAggregate>,
    contract: VerificationContract,
    recordedAt: string,
    baselineArtifact?: import("../domain/task-result").ArtifactReference
  ): RunAggregate {
    const aggregate = cloneAggregate(source);
    if (!Number.isSafeInteger(contract.revision) || contract.revision < 1 ||
        !Number.isFinite(Date.parse(contract.approvedAt)) ||
        !/^[a-f0-9]{64}$/u.test(contract.baselineFingerprint) ||
        !contract.baselineArtifactId ||
        contract.commands.length < 1 || contract.commands.length > 10) throw new Error("Verification contract metadata is invalid.");
    validateVerificationContractDraft(
      contract,
      new Set(aggregate.context.requirements.map((requirement) => requirement.id))
    );
    if (contractHash(contract) !== contract.contractHash) {
      throw new Error("Verification contract hash does not match its policy.");
    }
    if (baselineArtifact && baselineArtifact.artifactId !== contract.baselineArtifactId) {
      throw new Error("Verification baseline artifact id does not match the contract.");
    }
    const baselineReference = baselineArtifact ?? aggregate.artifacts[contract.baselineArtifactId];
    if (!baselineReference) {
      throw new Error("Verification contract baseline artifact is missing.");
    }
    assertArtifactReference(baselineReference, "Verification baseline", "application/vnd.custom-agent-loop.workspace-fingerprint+json;version=1");
    if (aggregate.context.verificationContract &&
      contract.revision <= aggregate.context.verificationContract.revision) {
      if (contract.revision === aggregate.context.verificationContract.revision &&
          contract.contractHash === aggregate.context.verificationContract.contractHash) return aggregate;
      throw new Error("Verification contract revisions must increase monotonically.");
    }
    aggregate.context.verificationContract = JSON.parse(JSON.stringify(contract)) as VerificationContract;
    if (baselineArtifact) aggregate.artifacts[baselineArtifact.artifactId] = { ...baselineArtifact };
    aggregate.context.verificationCandidate = null;
    aggregate.context.verificationCriteriaChanges = [];
    // A new contract is a new evidence universe.  Retaining command records
    // or approvals from the previous revision would allow an old proof to be
    // paired with a new policy after a restart.
    aggregate.context.verificationRecords = [];
    aggregate.context.verificationProof = null;
    aggregate.context.reviewApprovals = [];
    aggregate.context.latestWorkspaceFingerprint = null;
    aggregate.context.verificationElapsedMs = 0;
    aggregate.context.verificationInvalidationReason = null;
    aggregate.updatedAt = recordedAt;
    appendEvent(aggregate, "node.completed", `Verification contract revision ${contract.revision} approved.`, {
      contractRevision: contract.revision,
      contractHash: contract.contractHash,
    }, recordedAt);
    return aggregate;
  }

  recordVerificationCommand(
    source: Readonly<RunAggregate>,
    record: VerificationCommandRecord,
    recordedAt: string,
    logArtifact?: import("../domain/task-result").ArtifactReference
  ): RunAggregate {
    const aggregate = cloneAggregate(source);
    const activeId = aggregate.execution.activeActivationId;
    const active = activeId ? aggregate.nodeExecutions[activeId] : null;
    const activeNode = active ? aggregate.definition.nodes[active.nodeId] : null;
    if (!active || activeNode?.kind !== "verification") {
      throw new Error("Verification command checkpoint requires an active verification node.");
    }
    const contract = aggregate.context.verificationContract;
    const expectedVerificationId = `${active.activationId}_verification`;
    if (!contract || record.verificationId !== expectedVerificationId) {
      throw new Error("Verification command checkpoint does not belong to the active contract.");
    }
    const spec = contract.commands.find((command) => command.id === record.commandId);
    if (!spec) throw new Error(`Verification command ${record.commandId} is not in the active contract.`);
    assertCommandRecordShape(record, spec, aggregate.context.targetProjectPath);
    if (logArtifact) {
      if (record.logArtifactId !== logArtifact.artifactId || !validDigest(logArtifact.sha256) ||
          logArtifact.artifactId !== `artifact_${logArtifact.sha256}` ||
          !Number.isSafeInteger(logArtifact.bytes) || logArtifact.bytes < 0 ||
          !Number.isFinite(Date.parse(logArtifact.createdAt)) ||
          logArtifact.mediaType !== "application/vnd.custom-agent-loop.verification-log+json;version=1") {
        throw new Error(`Verification command ${record.commandId} log artifact metadata is invalid.`);
      }
      const existingArtifact = aggregate.artifacts[logArtifact.artifactId];
      if (existingArtifact && existingArtifact.sha256 !== logArtifact.sha256) {
        throw new Error(`Artifact id collision for ${logArtifact.artifactId}.`);
      }
      aggregate.artifacts[logArtifact.artifactId] = { ...logArtifact };
    } else if (record.logArtifactId) {
      const storedLog = aggregate.artifacts[record.logArtifactId];
      if (!storedLog) throw new Error(`Verification command ${record.commandId} log artifact is missing.`);
      assertArtifactReference(
        storedLog,
        `Verification command ${record.commandId} log`,
        "application/vnd.custom-agent-loop.verification-log+json;version=1"
      );
    }
    const index = aggregate.context.verificationRecords.findIndex(
      (item) => item.verificationId === record.verificationId && item.commandId === record.commandId
    );
    const commandIndex = contract.commands.findIndex((command) => command.id === record.commandId);
    const priorCommands = contract.commands.slice(0, commandIndex).map((command) =>
      aggregate.context.verificationRecords.find((item) =>
        item.verificationId === record.verificationId && item.commandId === command.id
      )
    );
    // Verification is deliberately sequential.  A later command cannot be
    // reserved, started, or marked not_run until every earlier command has a
    // durable terminal checkpoint.  This keeps an injected/out-of-order
    // checkpoint from being mistaken for a valid proof after recovery.
    if (priorCommands.some((item) => !item || !["completed", "not_run"].includes(item.status))) {
      throw new Error(`Verification command ${record.commandId} is out of execution order.`);
    }
    // A not_run checkpoint, timeout, signal termination, or unconfirmed
    // process tree is a hard boundary for the rest of the ordered contract.
    // The runner records all remaining commands as not_run; the reducer must
    // reject an injected later execution that tries to bypass that boundary.
    const priorStop = priorCommands.some((item) => item && (
      item.status === "not_run" ||
      (item.status === "completed" && (
        item.signal !== null || item.timedOut || item.processTreeClean !== true
      ))
    ));
    if (priorStop && record.status !== "not_run") {
      throw new Error(`Verification command ${record.commandId} cannot run after an earlier command stopped the contract.`);
    }
    const copy = { ...record, args: [...record.args] };
    if (index < 0) {
      // A command normally starts with a durable reservation.  A first
      // not_run record is also valid when verification failed during its
      // preflight, before any process could be spawned; it can never satisfy
      // the success invariant.
      if (record.status !== "reserved" && record.status !== "not_run") {
        throw new Error("A verification command must be reserved before it starts.");
      }
      aggregate.context.verificationRecords.push(copy);
    } else {
      const previous = aggregate.context.verificationRecords[index];
      const validTransition =
        (previous.status === "reserved" && (record.status === "reserved" || record.status === "running" || record.status === "not_run")) ||
        (previous.status === "running" && (record.status === "running" || record.status === "completed"));
      if (!validTransition) {
        if (sameVerificationCommandRecord(previous, record)) return aggregate;
        throw new Error(`Invalid verification command state transition ${previous.status} -> ${record.status}.`);
      }
      if (record.status === previous.status && sameVerificationCommandRecord(previous, record)) return aggregate;
      if (previous.status === "running" && record.status === "running" && previous.startedAt !== record.startedAt) {
        throw new Error("A running verification command cannot change its start checkpoint.");
      }
      aggregate.context.verificationRecords[index] = copy;
    }
    // Persist the consumed portion of the current verification contract at
    // every durable checkpoint.  If the process dies after a command has
    // completed but before the final proof commit, the next invocation must
    // inherit that time instead of restarting the total timeout window.
    const currentVerificationElapsed = aggregate.context.verificationRecords
      .filter((item) => item.verificationId === record.verificationId && item.status === "completed")
      .reduce((total, item) => total + (item.elapsedMs ?? 0), 0);
    aggregate.context.verificationElapsedMs = currentVerificationElapsed;
    appendEvent(
      aggregate,
      record.status === "running" ? "node.started" : "node.completed",
      `Verification command ${record.commandId} is ${record.status}.`,
      {
        verificationId: record.verificationId,
        commandId: record.commandId,
        status: record.status,
        exitCode: record.exitCode,
        signal: record.signal,
      },
      recordedAt,
      { nodeId: active.nodeId, activationId: active.activationId }
    );
    aggregate.updatedAt = recordedAt;
    return aggregate;
  }

  startVerification(
    source: Readonly<RunAggregate>,
    activationId: string,
    recordedAt: string
  ): RunAggregate {
    const aggregate = cloneAggregate(source);
    if (aggregate.execution.activeActivationId !== activationId) {
      throw new Error(`Activation ${activationId} is not active.`);
    }
    const execution = aggregate.nodeExecutions[activationId];
    const node = execution ? aggregate.definition.nodes[execution.nodeId] : null;
    if (!execution || node?.kind !== "verification" || execution.status !== "reserved" ||
        !aggregate.context.verificationContract) {
      throw new Error(`Verification activation ${activationId} cannot start.`);
    }
    // A fresh activation starts a new timed verification round.  During
    // recovery, completed checkpoints for this activation already exist and
    // must remain the source of the elapsed budget.
    const verificationId = `${activationId}_verification`;
    if (!aggregate.context.verificationRecords.some((record) => record.verificationId === verificationId)) {
      aggregate.context.verificationElapsedMs = 0;
    }
    execution.status = "running";
    execution.startedAt ??= recordedAt;
    appendEvent(
      aggregate,
      "node.started",
      `Verification ${execution.nodeId} started.`,
      { verificationId },
      recordedAt,
      { nodeId: execution.nodeId, activationId }
    );
    aggregate.updatedAt = recordedAt;
    return aggregate;
  }

  invalidateVerificationProof(
    source: Readonly<RunAggregate>,
    reason: string,
    recordedAt: string
  ): RunAggregate {
    const aggregate = cloneAggregate(source);
    aggregate.context.verificationProof = null;
    aggregate.context.latestWorkspaceFingerprint = null;
    aggregate.context.verificationInvalidationReason = reason.slice(0, 8_000);
    aggregate.context.reviewApprovals = [];
    appendEvent(aggregate, "node.failed", `Verification evidence invalidated: ${reason}`, {
      reason: reason.slice(0, 8_000),
    }, recordedAt);
    aggregate.updatedAt = recordedAt;
    return aggregate;
  }

  /** Adopt an allowed, newly-created test baseline without changing policy. */
  adoptVerificationBaseline(
    source: Readonly<RunAggregate>,
    candidate: VerificationApprovalCandidate,
    recordedAt: string,
    baselineArtifact?: import("../domain/task-result").ArtifactReference
  ): RunAggregate {
    const aggregate = cloneAggregate(source);
    const contract = aggregate.context.verificationContract;
    if (!contract || candidate.baseRevision !== contract.revision) {
      throw new Error("Verification baseline candidate is based on an old contract revision.");
    }
    if (hashVerificationCandidate(candidate) !== candidate.candidateHash) {
      throw new Error("Verification baseline candidate hash does not match its contents.");
    }
    if (candidateNeedsVerificationApproval(
      contract,
      candidate,
      aggregate.context.targetProjectPath
    )) {
      throw new Error("Verification candidate contains a policy or protected-scope change and needs reapproval.");
    }
    if (!candidate.baselineFingerprint || !/^[a-f0-9]{64}$/u.test(candidate.baselineFingerprint)) {
      throw new Error("Verification baseline candidate is missing a valid fingerprint.");
    }
    if (baselineArtifact) {
      assertArtifactReference(baselineArtifact, "Verification baseline", "application/vnd.custom-agent-loop.workspace-fingerprint+json;version=1");
      if (candidate.baselineArtifactId !== baselineArtifact.artifactId) {
        throw new Error("Verification baseline artifact id does not match the candidate.");
      }
      aggregate.artifacts[baselineArtifact.artifactId] = { ...baselineArtifact };
    }
    if (candidate.baselineArtifactId) {
      const stored = baselineArtifact ?? aggregate.artifacts[candidate.baselineArtifactId];
      if (!stored) throw new Error("Verification baseline artifact is missing.");
      assertArtifactReference(stored, "Verification baseline", "application/vnd.custom-agent-loop.workspace-fingerprint+json;version=1");
    }
    aggregate.context.verificationContract = {
      ...contract,
      baselineArtifactId: baselineArtifact?.artifactId ?? candidate.baselineArtifactId ?? contract.baselineArtifactId,
      baselineFingerprint: candidate.baselineFingerprint,
      baselinePaths: [...candidate.baselinePaths],
      baselineFileHashes: { ...candidate.baselineFileHashes },
      baselineFileModes: { ...candidate.baselineFileModes },
    };
    aggregate.context.verificationCandidate = null;
    aggregate.context.verificationCriteriaChanges = [];
    aggregate.context.verificationProof = null;
    aggregate.context.verificationRecords = [];
    aggregate.context.reviewApprovals = [];
    aggregate.context.latestWorkspaceFingerprint = null;
    aggregate.context.verificationElapsedMs = 0;
    aggregate.context.verificationInvalidationReason = null;
    appendEvent(aggregate, "node.completed", "Approved-scope workspace changes were adopted into the verification baseline.", {
      contractRevision: contract.revision,
      candidateHash: candidate.candidateHash,
      addedPaths: candidate.addedPaths.length,
    }, recordedAt);
    aggregate.updatedAt = recordedAt;
    return aggregate;
  }

  pauseForVerificationInvalidation(
    source: Readonly<RunAggregate>,
    reason: string,
    recordedAt: string
  ): RunAggregate {
    const aggregate = this.invalidateVerificationProof(source, reason, recordedAt);
    aggregate.execution.status = "PAUSED";
    aggregate.execution.currentNodeId = verificationPreparationNodeId(aggregate);
    const activeId = aggregate.execution.activeActivationId;
    if (activeId) {
      const execution = aggregate.nodeExecutions[activeId];
      if (execution) {
        execution.status = "cancelled";
        execution.completedAt = recordedAt;
      }
      aggregate.execution.activeActivationId = null;
    }
    aggregate.context.resumeNodeId = aggregate.execution.currentNodeId;
    aggregate.execution.reason = reason.slice(0, 8_000);
    aggregate.updatedAt = recordedAt;
    return aggregate;
  }

  /**
   * Persist a verification preflight failure before any command can run.
   * Fingerprint/root validation is part of the core execution boundary.  If
   * it cannot be completed, leaving a reserved activation in RUNNING would
   * make a later invocation look replay-safe even though the workspace state
   * was never observed.  Mark the activation as unknown_mutation and block
   * the run so an operator must reconcile the boundary explicitly.
   */
  recordVerificationPreflightFailure(
    source: Readonly<RunAggregate>,
    activationId: string,
    reason: string,
    recordedAt: string
  ): RunAggregate {
    const aggregate = cloneAggregate(source);
    if (aggregate.execution.activeActivationId !== activationId) {
      throw new Error(`Verification preflight activation ${activationId} is not active.`);
    }
    const execution = aggregate.nodeExecutions[activationId];
    const node = execution ? aggregate.definition.nodes[execution.nodeId] : null;
    if (!execution || node?.kind !== "verification" ||
        !["reserved", "running"].includes(execution.status)) {
      throw new Error(`Verification preflight activation ${activationId} cannot be blocked.`);
    }
    const message = reason.trim().slice(0, 8_000) || "Verification preflight could not establish a trustworthy workspace boundary.";
    const failure = {
      kind: "unknown_mutation" as const,
      message,
      retryable: false,
      ambiguousMutation: true,
      attemptId: null,
    };
    execution.status = "unknown_mutation";
    execution.failure = { ...failure };
    execution.signal = "error";
    execution.completedAt = recordedAt;
    aggregate.execution.activeActivationId = null;
    aggregate.execution.status = "BLOCKED";
    aggregate.execution.reason = message;
    aggregate.execution.lastFailure = { ...failure };
    aggregate.context.failureSummary = message;
    aggregate.context.verificationInvalidationReason = message;
    aggregate.context.verificationProof = null;
    aggregate.context.latestWorkspaceFingerprint = null;
    aggregate.context.reviewApprovals = [];
    aggregate.context.resumeNodeId = verificationPreparationNodeId(aggregate);
    appendEvent(
      aggregate,
      "node.failed",
      `Verification preflight failed: ${message}`,
      { kind: failure.kind, ambiguousMutation: true },
      recordedAt,
      { nodeId: execution.nodeId, activationId }
    );
    aggregate.updatedAt = recordedAt;
    return aggregate;
  }

  recordReviewApproval(
    source: Readonly<RunAggregate>,
    approval: ReviewApprovalRecord,
    recordedAt: string
  ): RunAggregate {
    const aggregate = cloneAggregate(source);
    const proof = aggregate.context.verificationProof;
    const contract = aggregate.context.verificationContract;
    if (!proof || !proof.passed || !proof.watcherReliable || proof.executionError) {
      throw new Error("Review approval requires a reliable passing core verification proof.");
    }
    if (!contract || approval.proofId !== proof.proofId || approval.contractRevision !== contract.revision) {
      throw new Error("Review approval does not match the current verification proof.");
    }
    if (aggregate.context.latestWorkspaceFingerprint !== proof.afterFingerprint) {
      throw new Error("Review approval requires a fresh core workspace fingerprint.");
    }
    const expectedNodeId = approval.stage === "qa"
      ? aggregate.definition.applicationPolicy.qaNodeId
      : aggregate.definition.applicationPolicy.completionApprovalNodeId;
    const approvalExecution = aggregate.nodeExecutions[approval.activationId];
    if (!expectedNodeId || !approvalExecution || approvalExecution.nodeId !== expectedNodeId) {
      throw new Error(`The ${approval.stage} approval activation does not match the compiled policy.`);
    }
    const expectedPrevious = approval.stage === "master" ? "qa" : null;
    if (expectedPrevious && aggregate.context.reviewApprovals[aggregate.context.reviewApprovals.length - 1]?.stage !== expectedPrevious) {
      throw new Error("Master approval requires a matching QA approval first.");
    }
    if (aggregate.context.reviewApprovals.some((item) => item.stage === approval.stage)) {
      throw new Error(`A ${approval.stage} approval is already recorded for this proof.`);
    }
    const required = new Set(aggregate.context.requirements.map((item) => item.id));
    const unknownRequirements = approval.requirementIds.filter((id) => !required.has(id));
    if (unknownRequirements.length > 0) {
      throw new Error(`Review approval references unknown requirements: ${[...new Set(unknownRequirements)].join(", ")}.`);
    }
    for (const requirementId of required) {
      if (!approval.requirementIds.includes(requirementId)) {
        throw new Error(`Review approval is missing requirement evidence for ${requirementId}.`);
      }
    }
    const openFindings = aggregate.context.findings.filter((finding) => finding.status === "open");
    const resolved = new Set(approval.resolvedFindingIds);
    const unknown = approval.resolvedFindingIds.filter(
      (findingId) => !aggregate.context.findings.some((finding) => finding.id === findingId)
    );
    if (unknown.length > 0) {
      throw new Error(`Review approval references unknown findings: ${[...new Set(unknown)].join(", ")}.`);
    }
    const omitted = openFindings.filter((finding) => !resolved.has(finding.id));
    if (omitted.length > 0) {
      throw new Error(`Review approval must resolve every open finding: ${omitted.map((finding) => finding.id).join(", ")}.`);
    }
    if (new Set(approval.requirementIds).size !== approval.requirementIds.length ||
        new Set(approval.resolvedFindingIds).size !== approval.resolvedFindingIds.length ||
        !approval.rationale.trim()) {
      throw new Error("Review approval contains duplicate evidence ids or an empty rationale.");
    }
    aggregate.context.reviewApprovals.push({
      ...approval,
      requirementIds: [...approval.requirementIds],
      resolvedFindingIds: [...approval.resolvedFindingIds],
    });
    for (const findingId of approval.resolvedFindingIds) {
      const finding = aggregate.context.findings.find((item) => item.id === findingId);
      if (finding) {
        finding.status = "resolved";
        finding.resolvedAt = recordedAt;
      }
    }
    aggregate.updatedAt = recordedAt;
    return aggregate;
  }

  recordFindings(
    source: Readonly<RunAggregate>,
    values: ReadonlyArray<{ text: string; source: FindingRecord["source"]; artifactIds?: string[] }>,
    activationId: string,
    recordedAt: string
  ): RunAggregate {
    const aggregate = cloneAggregate(source);
    for (const value of values) {
      const text = value.text.trim();
      if (!text) continue;
      assertKnownArtifactIds(aggregate, value.artifactIds ?? [], "Finding evidence");
      const id = `finding_${createHash("sha256").update(`${value.source}:${text}`).digest("hex").slice(0, 16)}`;
      const existing = aggregate.context.findings.find((item) => item.id === id);
      if (existing) {
        existing.text = text;
        existing.status = "open";
        existing.resolvedAt = null;
        existing.artifactIds = [...(value.artifactIds ?? [])];
      } else {
        aggregate.context.findings.push({
          id,
          text: text.slice(0, 8_000),
          status: "open",
          source: value.source,
          artifactIds: [...(value.artifactIds ?? [])],
          firstSeenAt: recordedAt,
          resolvedAt: null,
        });
      }
    }
    appendEvent(aggregate, "node.completed", `Recorded findings from ${activationId}.`, {
      findingCount: values.length,
      activationId,
    }, recordedAt);
    aggregate.updatedAt = recordedAt;
    return aggregate;
  }

  recordReviewFeedback(
    source: Readonly<RunAggregate>,
    stage: "qa" | "master",
    activationId: string,
    summary: string,
    diagnostics: ReadonlyArray<string>,
    recordedAt: string,
    artifactIds: ReadonlyArray<string> = [],
    artifactReferences: ReadonlyArray<ArtifactReference> = []
  ): RunAggregate {
    const aggregate = cloneAggregate(source);
    for (const artifact of artifactReferences) {
      assertArtifactReference(artifact, "Review feedback");
      const existing = aggregate.artifacts[artifact.artifactId];
      if (existing && existing.sha256 !== artifact.sha256) {
        throw new Error(`Artifact id collision for ${artifact.artifactId}.`);
      }
      aggregate.artifacts[artifact.artifactId] = { ...artifact };
    }
    assertKnownArtifactIds(aggregate, [...new Set(artifactIds)], "Review feedback");
    const proof = aggregate.context.verificationProof;
    const findingText = summary.trim() ||
      `${stage.toUpperCase()} review rejected the current implementation.`;
    if (findingText) {
      // A rejected review is itself a core-issued unresolved problem even if
      // the model omitted a separate findings array. Keep that problem ID
      // stable until a later approval explicitly resolves it.
      const findingId = `finding_${createHash("sha256").update(`${stage}:${findingText}`).digest("hex").slice(0, 16)}`;
      const existing = aggregate.context.findings.find((finding) => finding.id === findingId);
      if (existing) {
        existing.text = findingText.slice(0, 8_000);
        existing.status = "open";
        existing.resolvedAt = null;
        existing.artifactIds = [...new Set(artifactIds)].slice(0, 32);
      } else {
        aggregate.context.findings.push({
          id: findingId,
          text: findingText.slice(0, 8_000),
          status: "open",
          source: stage,
          artifactIds: [...new Set(artifactIds)].slice(0, 32),
          firstSeenAt: recordedAt,
          resolvedAt: null,
        });
      }
    }
    aggregate.context.verificationFeedback = [{
      verificationId: `review_${activationId}`,
      proofId: proof?.proofId ?? null,
      passed: false,
      failedCommandIds: [],
      diagnostics: [summary, ...diagnostics].map((item) => item.slice(0, 8_000)).slice(0, 8),
      requirementIds: aggregate.context.requirements.map((item) => item.id),
      sourceActivationId: activationId,
      cycleNumber: aggregate.nodeExecutions[activationId]?.cycleNumber ?? aggregate.execution.activeCycleNumber,
       artifactIds: [...new Set(artifactIds)].slice(0, 32),
    }, ...aggregate.context.verificationFeedback].slice(0, 20);
    aggregate.context.failureSummary = summary.slice(0, 20_000);
    appendEvent(aggregate, "node.failed", `${stage.toUpperCase()} review feedback recorded.`, {
      stage,
      activationId,
    }, recordedAt, { activationId });
    aggregate.updatedAt = recordedAt;
    return aggregate;
  }

  recordConvergence(
    source: Readonly<RunAggregate>,
    observation: ConvergenceObservation,
    recordedAt: string
  ): RunAggregate {
    const aggregate = cloneAggregate(source);
    const previous = aggregate.context.convergence.history.length === 0 ? null : {
      contractHash: aggregate.context.convergence.lastContractHash ?? null,
      reachedStep: aggregate.context.convergence.lastReachedStep ?? null,
      highestReachedStep: aggregate.context.convergence.highestReachedStep,
      failedCommandIds: aggregate.context.convergence.lastFailedCommandIds ?? [],
      unsatisfiedRequirementIds: aggregate.context.convergence.lastUnsatisfiedRequirementIds ?? [],
      unresolvedFindingIds: aggregate.context.convergence.lastUnresolvedFindingIds ?? [],
      stagnantCycles: aggregate.context.convergence.stagnantCycles,
      history: aggregate.context.convergence.history,
    };
    const decision = evaluateConvergence(previous, observation, recordedAt);
    aggregate.context.convergence.lastContractHash = observation.contractHash;
    aggregate.context.convergence.lastReachedStep = observation.reachedStep;
    aggregate.context.convergence.highestReachedStep =
      previous?.contractHash !== observation.contractHash
        ? observation.reachedStep
        : observation.reachedStep === null
          ? aggregate.context.convergence.highestReachedStep ?? null
          : aggregate.context.convergence.highestReachedStep === null ||
              aggregate.context.convergence.highestReachedStep === undefined
            ? observation.reachedStep
            : Math.max(aggregate.context.convergence.highestReachedStep, observation.reachedStep);
    aggregate.context.convergence.lastFailedCommandIds = [...observation.failedCommandIds];
    aggregate.context.convergence.lastUnsatisfiedRequirementIds = [...observation.unsatisfiedRequirementIds];
    aggregate.context.convergence.lastUnresolvedFindingIds = [...observation.unresolvedFindingIds];
    aggregate.context.convergence.stagnantCycles = decision.stagnantCycles;
    aggregate.context.convergence.history = [
      ...aggregate.context.convergence.history,
      { signature: decision.signature, improved: decision.improved, recordedAt },
    ].slice(-100);
    aggregate.updatedAt = recordedAt;
    return aggregate;
  }

  applyHumanResponse(
    source: Readonly<RunAggregate>,
    response: HumanGateResponse
  ): RunAggregate {
    const aggregate = cloneAggregate(source);
    if (aggregate.processedRequestIds.includes(response.requestId)) return aggregate;
    const pending = aggregate.pendingInput;
    if (!pending || pending.requestId !== response.requestId) {
      throw new Error(`Human input request ${response.requestId} is not pending.`);
    }
    if (pending.nodeId !== response.nodeId || !pending.allowedSignals.includes(response.signal)) {
      throw new Error(`Invalid human response for ${pending.nodeId}: ${response.signal}.`);
    }
    const execution = aggregate.nodeExecutions[pending.activationId];
    if (!execution) throw new Error(`Pending activation ${pending.activationId} is missing.`);
    if (pending.kind === "plan_approval" && response.signal === "approved") {
      if (!response.choiceId) throw new Error("Plan approval requires a plan choice id.");
      const choice = aggregate.context.planChoices.find(
        (candidate) => candidate.id === response.choiceId
      );
      if (!choice) throw new Error(`Unknown plan choice id: ${response.choiceId}.`);
      assertKnownArtifactId(aggregate, choice.planArtifactId, "Selected plan");
      const planningNode = planningNodeId(aggregate);
      const planningActivationId = planningNode
        ? aggregate.latestCompletedByNode[planningNode] ?? null
        : null;
      const planningOutput = planningActivationId
        ? aggregate.nodeExecutions[planningActivationId]?.output
        : undefined;
      if (!planningOutput) throw new Error("Plan approval has no completed planning output.");
      if (requiresCoreVerification(aggregate) && !choice.verification) {
        throw new Error("Plan approval must include a verification contract draft.");
      }
      if (choice.verification) {
        validateVerificationContractDraft(
          choice.verification,
          new Set(aggregate.context.requirements.map((requirement) => requirement.id))
        );
      }
      aggregate.context.selectedPlanChoiceId = choice.id;
      aggregate.context.approvedPlan = { ...planningOutput };
      const selected = aggregate.context.planChoices.find((candidate) => candidate.id === choice.id);
      aggregate.context.selectedVerificationDraft = selected?.verification
        ? JSON.parse(JSON.stringify(selected.verification))
        : null;
    } else if (pending.kind === "plan_approval" && response.signal === "revision_requested") {
      aggregate.context.selectedPlanChoiceId = null;
      aggregate.context.approvedPlan = null;
      aggregate.context.selectedVerificationDraft = null;
    } else if (pending.kind === "access_approval") {
      if (response.signal === "full_access") {
        aggregate.context.accessMode = "full_access";
      } else if (response.signal === "retry") {
        const pendingContext = pending.context && typeof pending.context === "object" &&
          !Array.isArray(pending.context)
          ? pending.context as Record<string, unknown>
          : null;
        const approvedPaths = Array.isArray(pendingContext?.requestedPaths)
          ? pendingContext.requestedPaths.filter((value): value is string =>
              typeof value === "string" &&
              (/^[A-Za-z]:[\\/]/u.test(value) || /^\/(?!\/)/u.test(value))
            )
          : [];
        aggregate.context.additionalAllowedPaths = [
          ...new Set([...aggregate.context.additionalAllowedPaths, ...approvedPaths]),
        ];
      }
    } else if (pending.kind === "verification_approval") {
      const candidate = aggregate.context.verificationCandidate;
      const responseValue = response.value && typeof response.value === "object" && !Array.isArray(response.value)
        ? response.value as Record<string, unknown>
        : null;
      const candidateHash = typeof responseValue?.candidateHash === "string"
        ? responseValue.candidateHash
        : null;
      if (!candidate || !candidateHash || candidateHash !== candidate.candidateHash) {
        throw new Error("Verification approval candidate hash is missing or stale.");
      }
      const activeContract = aggregate.context.verificationContract;
      if (!activeContract || candidate.baseRevision !== activeContract.revision) {
        throw new Error("Verification approval candidate is based on an old contract revision.");
      }
      if (hashVerificationCandidate(candidate) !== candidate.candidateHash) {
        throw new Error("Verification approval candidate hash does not match its contents.");
      }
      if (response.signal === "approved") {
        if (candidate.baselineFingerprint !== undefined && !validDigest(candidate.baselineFingerprint)) {
          throw new Error("Verification approval candidate baseline fingerprint is invalid.");
        }
        if (candidate.diffArtifactId !== null && candidate.diffArtifactId !== undefined) {
          const diff = aggregate.artifacts[candidate.diffArtifactId];
          if (!diff) throw new Error("Verification approval candidate diff artifact is missing.");
          assertArtifactReference(diff, "Verification diff", "application/vnd.custom-agent-loop.verification-diff+json;version=1");
        }
        if (candidate.baselineArtifactId !== null && candidate.baselineArtifactId !== undefined) {
          const baseline = aggregate.artifacts[candidate.baselineArtifactId];
          if (!baseline) throw new Error("Verification approval candidate baseline artifact is missing.");
          assertArtifactReference(baseline, "Verification baseline", "application/vnd.custom-agent-loop.workspace-fingerprint+json;version=1");
        } else if (candidate.baselineFingerprint !== undefined &&
                   candidate.baselineFingerprint !== activeContract.baselineFingerprint) {
          throw new Error("A changed verification baseline requires a captured baseline artifact.");
        }
        const nextDraft: VerificationContractDraft = {
          commands: candidate.commands.map((command) => ({
            ...command,
            args: [...command.args],
            requirementIds: [...command.requirementIds],
          })),
          totalTimeoutMs: candidate.totalTimeoutMs,
          protectedPaths: [...candidate.protectedPaths],
          testRoots: [...candidate.testRoots],
          allowedNewTestRoots: [...candidate.allowedNewTestRoots],
          generatedOutputPaths: [...candidate.generatedOutputPaths],
        };
        validateVerificationContractDraft(
          nextDraft,
          new Set(aggregate.context.requirements.map((requirement) => requirement.id))
        );
        aggregate.context.verificationContract = {
          ...nextDraft,
          revision: activeContract.revision + 1,
          contractHash: contractHash(nextDraft),
          approvedRequestId: response.requestId,
          approvedAt: response.respondedAt,
          baselineArtifactId: candidate.baselineArtifactId ?? activeContract.baselineArtifactId,
          baselineFingerprint: candidate.baselineFingerprint,
          baselinePaths: [...candidate.baselinePaths],
          baselineFileHashes: { ...candidate.baselineFileHashes },
          baselineFileModes: { ...candidate.baselineFileModes },
        };
        aggregate.context.verificationCandidate = null;
        aggregate.context.verificationCriteriaChanges = [];
        aggregate.context.verificationProof = null;
        aggregate.context.verificationRecords = [];
        aggregate.context.reviewApprovals = [];
        aggregate.context.latestWorkspaceFingerprint = null;
        aggregate.context.verificationElapsedMs = 0;
        aggregate.context.verificationInvalidationReason = null;
      } else {
        const reason = typeof response.value === "string"
          ? response.value
          : typeof responseValue?.message === "string"
            ? responseValue.message
            : "Verification contract proposal was rejected.";
        aggregate.context.verificationCandidate = null;
        // A rejected candidate was raised because the previously observed
        // verification surface is no longer acceptable. Retain the rejection
        // feedback for TEST, but discard any proof/records that could be
        // mistaken for evidence for the next cycle.
        aggregate.context.verificationProof = null;
        aggregate.context.verificationRecords = [];
        aggregate.context.latestWorkspaceFingerprint = null;
        aggregate.context.verificationInvalidationReason = reason.slice(0, 8_000);
        aggregate.context.reviewApprovals = [];
        // Keep the operator's rejection as explicit core feedback for the
        // next TEST/implementation cycle.  `humanResponses` is keyed by node
        // and can later be replaced by another response, so it is not a
        // durable feedback channel by itself.  Carry only content-addressed
        // artifacts that are already present in the aggregate.
        const rejectionArtifactIds = [
          candidate.diffArtifactId,
          candidate.baselineArtifactId,
        ].filter((artifactId): artifactId is string =>
          Boolean(artifactId && aggregate.artifacts[artifactId])
        );
        aggregate.context.verificationFeedback = [{
          verificationId: `approval_rejection_${response.requestId}`,
          proofId: null,
          passed: false,
          failedCommandIds: [],
          diagnostics: [reason.slice(0, 8_000)],
          requirementIds: aggregate.context.requirements.map((requirement) => requirement.id),
          sourceActivationId: pending.activationId,
          cycleNumber: execution.cycleNumber,
          artifactIds: [...new Set(rejectionArtifactIds)].slice(0, 64),
        }, ...aggregate.context.verificationFeedback].slice(0, 20);
        execution.status = "cancelled";
        execution.completedAt = response.respondedAt;
        aggregate.execution.activeActivationId = null;
        aggregate.execution.currentNodeId = verificationPreparationNodeId(aggregate);
        aggregate.context.resumeNodeId = aggregate.execution.currentNodeId;
      }
    }
    aggregate.context.humanResponses[pending.nodeId] = { ...response };
    aggregate.processedRequestIds = [
      ...aggregate.processedRequestIds,
      response.requestId,
    ].slice(-256);
    aggregate.pendingInput = null;
    aggregate.execution.status = "RUNNING";
    aggregate.execution.reason = null;
    if (pending.kind === "verification_approval" && response.signal === "rejected") {
      execution.status = "cancelled";
      aggregate.execution.activeActivationId = null;
    } else {
      execution.status = pending.kind === "access_approval" || pending.kind === "verification_approval"
        ? "reserved"
        : "running";
    }
    appendEvent(
      aggregate,
      "human_input.received",
      `Human response ${response.signal} received for ${pending.nodeId}.`,
      { requestId: response.requestId, signal: response.signal, choiceId: response.choiceId ?? null },
      response.respondedAt,
      { nodeId: pending.nodeId, activationId: pending.activationId }
    );
    aggregate.updatedAt = response.respondedAt;
    return aggregate;
  }

  completeNode(source: Readonly<RunAggregate>, outcome: NodeOutcome): RunAggregate {
    const aggregate = cloneAggregate(source);
    if (aggregate.execution.activeActivationId !== outcome.activationId) {
      throw new Error(`Outcome activation ${outcome.activationId} is not active.`);
    }
    const execution = aggregate.nodeExecutions[outcome.activationId];
    if (!execution || execution.nodeId !== outcome.nodeId) {
      throw new Error(`Outcome node ${outcome.nodeId} does not match the activation.`);
    }
    if (execution.status !== "running") {
      throw new Error(
        `Outcome activation ${outcome.activationId} is not running (status ${execution.status}).`
      );
    }
    for (const artifact of outcome.result.artifacts) {
      assertArtifactReference(artifact, "Node result");
      const existing = aggregate.artifacts[artifact.artifactId];
      if (existing && existing.sha256 !== artifact.sha256) {
        throw new Error(`Artifact id collision for ${artifact.artifactId}.`);
      }
      aggregate.artifacts[artifact.artifactId] = { ...artifact };
    }
    if (outcome.result.output) {
      assertKnownArtifactId(aggregate, outcome.result.output.artifactId, "Node output");
    }
    execution.output = outcome.result.output ? { ...outcome.result.output } : null;
    execution.signal = outcome.result.signal;
    execution.failure = outcome.result.failure ? { ...outcome.result.failure } : null;
    execution.completedAt = outcome.completedAt;
    if (outcome.result.status === "succeeded") {
      if (!outcome.result.signal || !outcome.targetId) {
        throw new Error("Successful node outcome requires a signal and target.");
      }
      const node = aggregate.definition.nodes[execution.nodeId];
      if (outcome.result.signal === "convergence_stalled") {
        const isConfiguredCheckpoint = execution.nodeId === aggregate.definition.applicationPolicy.verificationNodeId ||
          execution.nodeId === aggregate.definition.applicationPolicy.qaNodeId ||
          execution.nodeId === aggregate.definition.applicationPolicy.completionApprovalNodeId;
        if (!isConfiguredCheckpoint || aggregate.context.convergence.stagnantCycles < 2) {
          throw new Error("Convergence stall is a core-owned transition and requires two stagnant observations.");
        }
      }
      if (node?.kind === "verification") {
        const proof = aggregate.context.verificationProof;
        if (!proof || proof.verificationId !== `${outcome.activationId}_verification`) {
          throw new Error("Verification node completion requires a durable proof for the active verification round.");
        }
        if (outcome.result.signal !== "convergence_stalled" &&
            (outcome.result.signal === "pass") !== proof.passed) {
          throw new Error("Verification node outcome does not match the durable proof result.");
        }
      }
      assertOutcomeTransition(aggregate, outcome);
      // Convergence is a core observation derived from durable verification,
      // requirement, and finding state.  A provider/model effect must never
      // be able to assert that an iteration improved (or reset stagnation)
      // before that observation is recorded by the reducer.
      if (outcome.effects.some((effect) => effect.type === "update_convergence")) {
        throw new Error("Model effects cannot set convergence; the core evaluator owns this state.");
      }
      execution.status = "completed";
      aggregate.latestCompletedByNode[outcome.nodeId] = outcome.activationId;
      for (const effect of outcome.effects) {
        applyEffect(aggregate, effect, outcome.activationId, outcome.completedAt);
      }
      const cycleCompletionNodes = aggregate.definition.cyclePolicy.completionNodeIds;
      // A completion node can have both a continuation route and a cycle
      // closing route (VERIFY.pass continues to QA while VERIFY.fail starts
      // the next implementation cycle). Count the cycle only on the route
      // that actually closes it, otherwise a passing VERIFY would detach the
      // QA/master approvals from their implementation cycle.
      const closesCycle = outcome.targetId === aggregate.definition.cyclePolicy.startNodeId ||
        outcome.terminalStatus !== null ||
        (outcome.nodeId === aggregate.definition.applicationPolicy.verificationNodeId &&
          (outcome.result.signal === "fail" || outcome.result.signal === "convergence_stalled")) ||
        ((outcome.nodeId === aggregate.definition.applicationPolicy.qaNodeId ||
          outcome.nodeId === aggregate.definition.applicationPolicy.completionApprovalNodeId) &&
          (outcome.result.signal === "rejected" || outcome.result.signal === "convergence_stalled"));
      if (cycleCompletionNodes.includes(outcome.nodeId) && closesCycle &&
          aggregate.execution.activeCycleNumber !== null) {
        aggregate.execution.cyclesCompleted += 1;
        aggregate.execution.activeCycleNumber = null;
      }
      if (isNodeTarget(aggregate, outcome.targetId)) {
        aggregate.execution.currentNodeId = outcome.targetId;
        aggregate.execution.status = "RUNNING";
        aggregate.execution.reason = null;
      } else if (outcome.terminalStatus) {
        if (outcome.terminalStatus === "SUCCESS") assertSuccessEligible(aggregate);
        aggregate.execution.status = outcome.terminalStatus;
        aggregate.execution.reason = execution.output?.summary ?? null;
      } else {
        throw new Error(`Outcome target ${outcome.targetId} is neither a node nor terminal.`);
      }
      appendEvent(
        aggregate,
        outcome.terminalStatus === "SUCCESS" ? "run.completed" : "node.completed",
        execution.output?.summary ?? `Node ${outcome.nodeId} completed with ${outcome.result.signal}.`,
        { signal: outcome.result.signal, targetId: outcome.targetId },
        outcome.completedAt,
        {
          nodeId: outcome.nodeId,
          activationId: outcome.activationId,
          attemptId: execution.attemptIds[execution.attemptIds.length - 1] ?? null,
        }
      );
    } else {
      const failure = outcome.result.failure;
      if (!failure) throw new Error("Unsuccessful node outcome requires a failure.");
      const expected = expectedFailureTarget(aggregate, outcome.nodeId, failure);
      if (outcome.targetId !== expected.targetId || outcome.terminalStatus !== expected.terminalStatus) {
        throw new Error(
          `Failure outcome target ${String(outcome.targetId)} does not match the compiled failure route ` +
          `${String(expected.targetId)}.`
        );
      }
      if (failure.controlCommand) {
        aggregate.processedRequestIds = [
          ...aggregate.processedRequestIds.filter(
            (requestId) => requestId !== failure.controlCommand!.requestId
          ),
          failure.controlCommand.requestId,
        ].slice(-256);
        if (failure.controlCommand.type === "interrupt") {
          aggregate.context.recovery = {
            source: "operator_interrupt",
            requestId: failure.controlCommand.requestId,
            message: failure.controlCommand.message ?? failure.message,
            interruptedNodeId: outcome.nodeId,
            activationId: outcome.activationId,
            recordedAt: outcome.completedAt,
          };
        }
      }
      execution.status = failure.ambiguousMutation ? "unknown_mutation" : "failed";
      aggregate.execution.lastFailure = { ...failure };
      aggregate.context.failureSummary = failure.message;
      if (outcome.terminalStatus) {
        aggregate.execution.status = outcome.terminalStatus;
      } else if (isNodeTarget(aggregate, outcome.targetId)) {
        aggregate.execution.currentNodeId = outcome.targetId;
        aggregate.execution.status = "RUNNING";
      } else {
        aggregate.execution.status = failure.ambiguousMutation ? "BLOCKED" : "FAILED";
      }
      aggregate.execution.reason = failure.message;
      appendEvent(
        aggregate,
        "node.failed",
        failure.message,
        {
          kind: failure.kind,
          retryable: failure.retryable,
          ambiguousMutation: failure.ambiguousMutation,
          targetId: outcome.targetId,
        },
        outcome.completedAt,
        {
          nodeId: outcome.nodeId,
          activationId: outcome.activationId,
          attemptId: failure.attemptId,
        }
      );
    }
    aggregate.execution.activeActivationId = null;
    aggregate.updatedAt = outcome.completedAt;
    return aggregate;
  }

  recordRetryableFailure(
    source: Readonly<RunAggregate>,
    activationId: string,
    result: import("../domain/task-result").TaskExecutionResult,
    recordedAt: string
  ): RunAggregate {
    const aggregate = cloneAggregate(source);
    if (aggregate.execution.activeActivationId !== activationId) {
      throw new Error(`Activation ${activationId} is not active.`);
    }
    const execution = aggregate.nodeExecutions[activationId];
    if (!result.failure || !result.failure.retryable || result.failure.ambiguousMutation) {
      throw new Error("Only unambiguous retryable failures can be recorded for another attempt.");
    }
    for (const artifact of result.artifacts) {
      assertArtifactReference(artifact, "Retryable task result");
      aggregate.artifacts[artifact.artifactId] = { ...artifact };
    }
    execution.failure = { ...result.failure };
    execution.status = "running";
    appendEvent(
      aggregate,
      "node.failed",
      `Retryable attempt failed: ${result.failure.message}`,
      { kind: result.failure.kind, retryable: true, willRetry: true },
      recordedAt,
      {
        nodeId: execution.nodeId,
        activationId,
        attemptId: result.failure.attemptId,
      }
    );
    aggregate.updatedAt = recordedAt;
    return aggregate;
  }

  recordVerificationProof(
    source: Readonly<RunAggregate>,
    proof: VerificationProof,
    recordedAt: string,
    resultArtifact?: import("../domain/task-result").ArtifactReference
  ): RunAggregate {
    const aggregate = cloneAggregate(source);
    const contract = aggregate.context.verificationContract;
    const activeId = aggregate.execution.activeActivationId;
    const activeExecution = activeId ? aggregate.nodeExecutions[activeId] : null;
    const activeNode = activeExecution ? aggregate.definition.nodes[activeExecution.nodeId] : null;
    if (!activeId || !activeExecution || activeNode?.kind !== "verification" || activeExecution.status !== "running") {
      throw new Error("Verification proof requires a running verification activation.");
    }
    if (proof.verificationId !== `${activeId}_verification`) {
      throw new Error("Verification proof does not belong to the active verification activation.");
    }
    if (activeExecution.nodeId !== aggregate.definition.applicationPolicy.verificationNodeId) {
      throw new Error("Verification proof must be produced by the configured verification node.");
    }
    const activationScope = resolveVerificationActivationScope(aggregate, activeId);
    if (!activationScope ||
        proof.implementationActivationId !== activationScope.implementationActivationId ||
        proof.testActivationId !== activationScope.testActivationId) {
      throw new Error("Verification proof does not cover the current implementation and test activations.");
    }
    if (proof.contractRevision !== contract?.revision || proof.contractHash !== contract?.contractHash) {
      throw new Error("Verification proof does not match the active contract.");
    }
    if (!validDigest(proof.baselineFingerprint) || !validDigest(proof.beforeFingerprint) || !validDigest(proof.afterFingerprint)) {
      throw new Error("Verification proof fingerprints must be SHA-256 digests.");
    }
    if (proof.baselineFingerprint !== contract.baselineFingerprint) {
      throw new Error("Verification proof does not match the contract baseline fingerprint.");
    }
    // A preflight/runtime error may prevent the core from obtaining a
    // trustworthy before fingerprint.  Keep that bounded failure proof
    // durable so recovery can distinguish it from an uncommitted attempt,
    // while still making it permanently ineligible for SUCCESS through the
    // executionError/evidenceInvalid checks below.  A proof without an
    // execution error must always prove that it started at the approved
    // baseline.
    if (proof.beforeFingerprint !== contract.baselineFingerprint && !proof.executionError) {
      throw new Error("Verification proof started from a workspace outside the approved baseline.");
    }
    if (typeof proof.proofId !== "string" || !proof.proofId.trim() ||
        typeof proof.verifiedAt !== "string" || !Number.isFinite(Date.parse(proof.verifiedAt)) ||
        (proof.elapsedMs !== undefined && (!Number.isSafeInteger(proof.elapsedMs) || proof.elapsedMs < 0)) ||
        typeof proof.watcherReliable !== "boolean" || typeof proof.passed !== "boolean" ||
        (proof.executionError !== undefined && typeof proof.executionError !== "boolean") ||
        (proof.failureReason !== undefined && (typeof proof.failureReason !== "string" || proof.failureReason.length > 8_000))) {
      throw new Error("Verification proof metadata is invalid.");
    }
    if (proof.resultArtifactId) {
      const existing = aggregate.artifacts[proof.resultArtifactId];
      if (!existing && !resultArtifact) throw new Error("Verification proof result artifact is missing.");
      if (resultArtifact) {
        if (resultArtifact.artifactId !== proof.resultArtifactId) throw new Error("Verification result artifact id does not match the proof.");
        if (resultArtifact.artifactId !== `artifact_${resultArtifact.sha256}` ||
            !validDigest(resultArtifact.sha256) || !Number.isSafeInteger(resultArtifact.bytes) ||
            resultArtifact.bytes < 0 || !Number.isFinite(Date.parse(resultArtifact.createdAt)) ||
            resultArtifact.mediaType !== "application/vnd.custom-agent-loop.verification-result+json;version=1") {
          throw new Error("Verification result artifact metadata is invalid.");
        }
        if (existing && existing.sha256 !== resultArtifact.sha256) {
          throw new Error(`Artifact id collision for ${resultArtifact.artifactId}.`);
        }
        aggregate.artifacts[resultArtifact.artifactId] = { ...resultArtifact };
      } else if (existing) {
        assertArtifactReference(
          existing,
          "Verification result",
          "application/vnd.custom-agent-loop.verification-result+json;version=1"
        );
      }
    } else if (resultArtifact) {
      if (resultArtifact.artifactId !== `artifact_${resultArtifact.sha256}` ||
          !validDigest(resultArtifact.sha256) || !Number.isSafeInteger(resultArtifact.bytes) ||
          resultArtifact.bytes < 0 || !Number.isFinite(Date.parse(resultArtifact.createdAt)) ||
          resultArtifact.mediaType !== "application/vnd.custom-agent-loop.verification-result+json;version=1") {
        throw new Error("Verification result artifact metadata is invalid.");
      }
      aggregate.artifacts[resultArtifact.artifactId] = { ...resultArtifact };
      proof = { ...proof, resultArtifactId: resultArtifact.artifactId };
    }
    if (!proof.resultArtifactId || !aggregate.artifacts[proof.resultArtifactId]) {
      throw new Error("Verification proof must reference a durable core result artifact.");
    }
    const expectedCommandIds = contract.commands.map((command) => command.id);
    const actualCommandIds = proof.commands.map((command) => command.commandId);
    if (
      actualCommandIds.length !== expectedCommandIds.length ||
      new Set(actualCommandIds).size !== actualCommandIds.length ||
      expectedCommandIds.some((id, index) => actualCommandIds[index] !== id)
    ) {
      throw new Error("Verification proof must contain commands in the approved execution order.");
    }
    for (const [index, command] of proof.commands.entries()) {
      const spec = contract.commands[index];
      assertCommandRecordShape(command, spec, aggregate.context.targetProjectPath);
      if (command.logArtifactId) {
        const log = aggregate.artifacts[command.logArtifactId];
        if (!log) throw new Error(`Verification command ${command.commandId} log artifact is missing.`);
        assertArtifactReference(
          log,
          `Verification command ${command.commandId} log`,
          "application/vnd.custom-agent-loop.verification-log+json;version=1"
        );
      }
    }
    const storedRecords = aggregate.context.verificationRecords
      .filter((record) => record.verificationId === proof.verificationId);
    if (storedRecords.length !== proof.commands.length || storedRecords.some((record, index) =>
      !sameVerificationCommandRecord(record, proof.commands[index])
    )) {
      throw new Error("Verification proof must be assembled from the durable command checkpoints.");
    }
    const recordsPass = proof.commands.every((command) =>
      command.status === "completed" && command.exitCode === 0 && command.signal === null &&
      !command.timedOut && command.processTreeClean === true && Boolean(command.logArtifactId)
    );
    const derivedPass = recordsPass && proof.watcherReliable && !proof.executionError &&
      proof.beforeFingerprint === proof.afterFingerprint &&
      proof.afterFingerprint === contract.baselineFingerprint;
    if (proof.passed !== derivedPass) {
      throw new Error("Verification proof pass/fail does not match the durable command results.");
    }
    // Keep the complete per-round command history in the aggregate.  The
    // current proof is assembled from the durable checkpoints for this
    // verification id, but replacing the whole collection here would erase
    // earlier rounds and make recovery/audit unable to distinguish a fresh
    // execution from a replay.  Replace only this round's records so a
    // retried proof commit remains idempotent while prior rounds stay intact.
    aggregate.context.verificationRecords = [
      ...aggregate.context.verificationRecords.filter(
        (record) => record.verificationId !== proof.verificationId
      ),
      ...proof.commands.map((command) => ({ ...command, args: [...command.args] })),
    ];
    aggregate.context.verificationProof = JSON.parse(JSON.stringify(proof)) as VerificationProof;
    aggregate.context.latestWorkspaceFingerprint = proof.afterFingerprint;
    aggregate.context.verificationElapsedMs = Math.max(
      aggregate.context.verificationElapsedMs,
      proof.elapsedMs ?? 0
    );
    aggregate.context.reviewApprovals = [];
    // A non-zero verification command is ordinary feedback for the next
    // implementation cycle.  Only an untrustworthy execution boundary or a
    // changed baseline invalidates evidence and forces TEST on resume.
    const evidenceInvalid = Boolean(
      proof.executionError ||
      !proof.watcherReliable ||
      proof.beforeFingerprint !== proof.afterFingerprint ||
      proof.beforeFingerprint !== contract.baselineFingerprint
    );
    aggregate.context.verificationInvalidationReason = evidenceInvalid
      ? proof.failureReason ?? "Verification evidence could not be trusted."
      : null;
    aggregate.context.verificationFeedback = [{
      verificationId: proof.verificationId,
      proofId: proof.proofId,
      passed: proof.passed,
      failedCommandIds: proof.commands
        .filter((command) => command.status !== "completed" || command.exitCode !== 0)
        .map((command) => command.commandId),
      diagnostics: proof.commands
        .filter((command) => command.summary.trim().length > 0)
        .map((command) => command.summary.slice(0, 8_000)),
      requirementIds: [...new Set(proof.commands.flatMap((command) =>
        aggregate.context.verificationContract?.commands.find((candidate) => candidate.id === command.commandId)?.requirementIds ?? []
      ))],
      sourceActivationId: proof.testActivationId,
      cycleNumber: aggregate.execution.activeCycleNumber,
      artifactIds: [...new Set([
        ...proof.commands.map((command) => command.logArtifactId).filter((value): value is string => Boolean(value)),
        ...(proof.resultArtifactId ? [proof.resultArtifactId] : []),
      ])].filter((artifactId) => Boolean(aggregate.artifacts[artifactId])).slice(0, 64),
    }, ...aggregate.context.verificationFeedback].slice(0, 20);
    appendEvent(
      aggregate,
      "node.completed",
      proof.passed ? "Core verification passed." : "Core verification failed.",
      { verificationId: proof.verificationId, proofId: proof.proofId, passed: proof.passed },
      recordedAt
    );
    aggregate.updatedAt = recordedAt;
    return aggregate;
  }

  /** Record a fresh core fingerprint immediately before a review/terminal gate. */
  confirmWorkspaceFingerprint(
    source: Readonly<RunAggregate>,
    fingerprint: string,
    recordedAt: string
  ): RunAggregate {
    const aggregate = cloneAggregate(source);
    if (!/^[a-f0-9]{64}$/u.test(fingerprint)) {
      throw new Error("Workspace fingerprint must be a SHA-256 digest.");
    }
    aggregate.context.latestWorkspaceFingerprint = fingerprint;
    aggregate.updatedAt = recordedAt;
    appendEvent(
      aggregate,
      "node.completed",
      "Core confirmed the workspace fingerprint.",
      { fingerprint },
      recordedAt
    );
    return aggregate;
  }

  blockForBudget(
    source: Readonly<RunAggregate>,
    error: WorkflowBudgetError,
    recordedAt: string
  ): RunAggregate {
    const aggregate = cloneAggregate(source);
    aggregate.execution.status = "BLOCKED";
    aggregate.execution.reason = error.message;
    aggregate.execution.lastFailure = {
      kind: "budget",
      message: error.message,
      retryable: false,
      ambiguousMutation: false,
      attemptId: null,
    };
    appendEvent(
      aggregate,
      "run.paused",
      error.message,
      { budget: error.budget },
      recordedAt
    );
    aggregate.updatedAt = recordedAt;
    return aggregate;
  }

  recoverStaleActivation(source: Readonly<RunAggregate>, recordedAt: string): RunAggregate {
    const aggregate = cloneAggregate(source);
    const activationId = aggregate.execution.activeActivationId;
    if (!activationId) return aggregate;
    const execution = aggregate.nodeExecutions[activationId];
    if (!execution || execution.status === "reserved" || execution.status === "waiting_user") {
      return aggregate;
    }
    if (execution.status !== "running") return aggregate;
    if (execution.sideEffect === "workspace_mutation") {
      const node = aggregate.definition.nodes[execution.nodeId];
      if (node?.kind === "verification") {
        const verificationId = `${activationId}_verification`;
        const records = aggregate.context.verificationRecords.filter(
          (record) => record.verificationId === verificationId
        );
        const hasUnknown = records.some(
          (record) => record.status === "running" ||
            (record.status === "completed" && (
              record.completedAt === null ||
              record.processTreeClean !== true
            ))
        );
        if (!hasUnknown && records.every(
          (record) => record.status === "reserved" || record.status === "completed" || record.status === "not_run"
        )) {
          execution.status = "reserved";
          aggregate.execution.status = "RUNNING";
          aggregate.execution.reason = "Recovered verification checkpoints; completed commands will not be replayed.";
          appendEvent(
            aggregate,
            "run.resumed",
            aggregate.execution.reason,
            { replaySafe: true, verificationId, completedCommands: records.filter((record) => record.status === "completed").length },
            recordedAt,
            { nodeId: execution.nodeId, activationId }
          );
          aggregate.updatedAt = recordedAt;
          return aggregate;
        }
      }
      execution.status = "unknown_mutation";
      const message =
        `Mutation activation ${activationId} lost its owner after provider execution began; ` +
        "automatic replay is prohibited.";
      execution.failure = {
        kind: "unknown_mutation",
        message,
        retryable: false,
        ambiguousMutation: true,
        attemptId: execution.attemptIds[execution.attemptIds.length - 1] ?? null,
      };
      aggregate.execution.lastFailure = { ...execution.failure };
      aggregate.execution.status = "BLOCKED";
      aggregate.execution.reason = message;
      appendEvent(
        aggregate,
        "node.failed",
        message,
        { ambiguousMutation: true },
        recordedAt,
        { nodeId: execution.nodeId, activationId, attemptId: execution.failure.attemptId }
      );
    } else {
      execution.status = "reserved";
      aggregate.execution.status = "RUNNING";
      aggregate.execution.reason = "Recovered a stale read-only activation for a bounded retry.";
      appendEvent(
        aggregate,
        "run.resumed",
        aggregate.execution.reason,
        { replaySafe: true },
        recordedAt,
        { nodeId: execution.nodeId, activationId }
      );
    }
    aggregate.updatedAt = recordedAt;
    return aggregate;
  }

  setStatus(
    source: Readonly<RunAggregate>,
    status: Exclude<RunStatus, "SUCCESS">,
    reason: string | null,
    recordedAt: string
  ): RunAggregate {
    // Keep the runtime guard even though the public type excludes SUCCESS;
    // persisted or untyped callers must not be able to forge a successful run.
    const requestedStatus: string = status;
    if (requestedStatus === "SUCCESS") {
      throw new Error("SUCCESS can only be reached through a validated workflow transition.");
    }
    const aggregate = cloneAggregate(source);
    aggregate.execution.status = status;
    aggregate.execution.reason = reason;
    appendEvent(
      aggregate,
      status === "RUNNING" ? "run.resumed" : "run.paused",
      reason ?? `Run status changed to ${status}.`,
      { status },
      recordedAt
    );
    aggregate.updatedAt = recordedAt;
    return aggregate;
  }

  setAccessMode(
    source: Readonly<RunAggregate>,
    accessMode: "ask" | "full_access",
    recordedAt: string
  ): RunAggregate {
    const aggregate = cloneAggregate(source);
    aggregate.context.accessMode = accessMode;
    aggregate.updatedAt = recordedAt;
    return aggregate;
  }
}
