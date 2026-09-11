import { createHash } from "node:crypto";
import type { NodeOutcome, RunAggregate } from "../domain/run-aggregate";
import type { TaskExecutionResult } from "../domain/task-result";
import type { AgentTaskRunner } from "./agent-task-runner";
import type { NodeExecutionContext } from "./node-execution-context";
import type { ProjectionPort } from "./ports/projection";
import type { RunRepositoryPort } from "./ports/run-repository";
import type { RunControlCommandPort } from "./ports/control-command";
import { RunReducer, WorkflowBudgetError } from "./run-reducer";
import { TaskInputAssembler } from "./task-input-assembler";
import { TransitionRouter } from "./transition-router";
import { VerificationRunner } from "./verification-runner";
import { VerificationContractService } from "./verification-contract-service";
import { candidateNeedsVerificationApproval } from "../domain/verification";
import { resolveVerificationActivationScope } from "../domain/verification-activation-scope";

export interface WorkflowRunnerClock {
  now(): string;
  delay(milliseconds: number): Promise<void>;
}

export interface WorkflowRunnerIds {
  activation(runId: string, sequence: number): string;
  attempt(activationId: string, sequence: number): string;
  request(activationId: string): string;
}

const DEFAULT_CLOCK: WorkflowRunnerClock = {
  now: () => new Date().toISOString(),
  delay: (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, Math.max(0, milliseconds))),
};

const DEFAULT_IDS: WorkflowRunnerIds = {
  activation: (_runId, sequence) =>
    `activation_${String(sequence).padStart(8, "0")}`,
  attempt: (activationId, sequence) =>
    `attempt_${activationId}_${String(sequence).padStart(3, "0")}`,
  request: (activationId) => `request_${activationId}`,
};

const NOOP_CONTROLS: RunControlCommandPort = {
  enqueue: async () => {
    throw new Error("Run control commands are not configured.");
  },
  recover: async () => undefined,
  claim: async () => null,
  complete: async () => undefined,
};

function verificationActivationIds(aggregate: Readonly<RunAggregate>): {
  implementationActivationId: string | null;
  testActivationId: string | null;
} {
  const activeId = aggregate.execution.activeActivationId;
  const scope = activeId
    ? resolveVerificationActivationScope(aggregate, activeId)
    : null;
  return {
    implementationActivationId: scope?.implementationActivationId ?? null,
    testActivationId: scope?.testActivationId ?? null,
  };
}

/**
 * Return the logical progress position within one implementation cycle.
 * `workflowStepsConsumed` is a global budget counter and therefore increases
 * on every retry/cycle; using it for convergence would make every later
 * observation look like progress and would permanently bypass the stall
 * interrupt.  The shortest path from the configured cycle start gives a
 * stable stage rank while still supporting custom v2 definitions.
 */
function convergenceStage(
  aggregate: Readonly<RunAggregate>,
  nodeId: string
): number {
  const start = aggregate.definition.cyclePolicy.startNodeId;
  const distances = new Map<string, number>([[start, 0]]);
  const pending = [start];
  while (pending.length > 0) {
    const current = pending.shift()!;
    const distance = distances.get(current)!;
    for (const target of Object.values(aggregate.definition.transitions[current] ?? {})) {
      if (!aggregate.definition.nodes[target] || distances.has(target)) continue;
      distances.set(target, distance + 1);
      pending.push(target);
    }
  }
  return distances.get(nodeId) ?? 0;
}

export interface WorkflowRunnerOptions {
  maxStepsPerInvocation?: number;
}

export class WorkflowRunner {
  constructor(
    private readonly repository: RunRepositoryPort,
    private readonly reducer: RunReducer,
    private readonly router: TransitionRouter,
    private readonly taskRunner: AgentTaskRunner,
    private readonly inputAssembler: TaskInputAssembler,
    private readonly projection: ProjectionPort,
    private readonly clock: WorkflowRunnerClock = DEFAULT_CLOCK,
    private readonly ids: WorkflowRunnerIds = DEFAULT_IDS,
    private readonly controls: RunControlCommandPort = NOOP_CONTROLS,
    private readonly verificationRunner?: VerificationRunner,
    private readonly verificationContracts?: VerificationContractService
  ) {}

  async runUntilBoundary(
    runId: string,
    options: WorkflowRunnerOptions = {}
  ): Promise<RunAggregate> {
    const maxSteps = options.maxStepsPerInvocation ?? Number.MAX_SAFE_INTEGER;
    let completedSteps = 0;
    let aggregate = await this.repository.load(runId);
    await this.controls.recover(runId);
    while (aggregate.execution.status === "RUNNING" && completedSteps < maxSteps) {
      const control = await this.controls.claim(runId);
      if (control) {
        try {
          if (!aggregate.processedRequestIds.includes(control.requestId)) {
            const controlled = this.reducer.applyBoundaryControl(
              aggregate,
              control.requestId,
              control.type,
              control.message,
              this.clock.now(),
              true
            );
            aggregate = await this.commit(controlled, aggregate);
            await this.projection.update(aggregate);
          }
          await this.controls.complete(
            control,
            "completed",
            `Run control '${control.type}' was applied at a workflow boundary.`
          );
        } catch (error) {
          try {
            await this.controls.complete(
              control,
              "failed",
              error instanceof Error ? error.message : String(error)
            );
          } catch (completionError) {
            // A failed ACK is part of the control transaction. Preserve both
            // the command application failure and the completion failure so a
            // caller can repair the queue instead of observing a false success.
            throw new AggregateError(
              [error, completionError],
              `Run control '${control.type}' failed and its ACK could not be written.`
            );
          }
          throw error;
        }
        if (aggregate.execution.status !== "RUNNING") return aggregate;
        continue;
      }
      if (!aggregate.execution.activeActivationId) {
        try {
          const activationId = this.ids.activation(
            aggregate.runId,
            Object.keys(aggregate.nodeExecutions).length + 1
          );
          const reserved = this.reducer.reserveNode(aggregate, activationId, this.clock.now());
          aggregate = await this.commit(reserved, aggregate);
        } catch (error) {
          if (!(error instanceof WorkflowBudgetError)) throw error;
          const blocked = this.reducer.blockForBudget(aggregate, error, this.clock.now());
          aggregate = await this.commit(blocked, aggregate);
          await this.projection.update(aggregate);
          return aggregate;
        }
      }
      const activationId = aggregate.execution.activeActivationId!;
      const execution = aggregate.nodeExecutions[activationId];
      const node = aggregate.definition.nodes[execution.nodeId];
      if (node.kind === "human_gate") {
        if (execution.status === "reserved") {
          const context: NodeExecutionContext = {
            aggregate,
            node,
            activationId,
            attemptId: "",
            attemptNumber: 0,
          };
          const input = await this.inputAssembler.assemble(context);
          const waiting = this.reducer.requestHumanInput(
            aggregate,
            input.value,
            this.clock.now()
          );
          aggregate = await this.commit(waiting, aggregate);
          await this.projection.update(aggregate);
          return aggregate;
        }
        const response = aggregate.context.humanResponses[node.id];
        if (!response) {
          throw new Error(`Human gate ${node.id} is active without a recorded response.`);
        }
        const route = this.router.route(aggregate.definition, node.id, response.signal);
        const result: TaskExecutionResult = {
          status: "succeeded",
          signal: response.signal,
          output: null,
          effects: [],
          artifacts: [],
          failure: null,
          pendingInput: null,
        };
        const outcome: NodeOutcome = {
          nodeId: node.id,
          activationId,
          result,
          targetId: route.targetId,
          terminalStatus: route.terminalStatus,
          effects: [],
          completedAt: this.clock.now(),
        };
        const completed = this.reducer.completeNode(aggregate, outcome);
        aggregate = await this.commit(completed, aggregate);
        completedSteps += 1;
        await this.projection.update(aggregate);
        continue;
      }

      if (node.kind === "verification") {
        if (!this.verificationRunner) {
          // A verification activation has no task attempt to complete.  Mark
          // the reserved activation as an explicit preflight boundary so a
          // missing core runtime cannot be represented as a normal task
          // failure (or leave a reserved node that recovery might replay).
          aggregate = await this.commitVerificationPreflightFailure(
            aggregate,
            node.id,
            activationId,
            new Error("Verification runtime is not configured.")
          );
          return aggregate;
        }
        const selectedDraft = aggregate.context.selectedVerificationDraft;
        const commands = selectedDraft?.commands ?? node.commands ?? [];
        if (commands.length === 0) {
          throw new Error(`Verification node ${node.id} has no commands.`);
        }
        if (!aggregate.context.verificationContract) {
          // The verification command and its policy are approved together with
          // the plan.  VERIFY must never manufacture an implicit contract at
          // execution time: doing so would turn an unapproved command set
          // into an authorized workspace operation.  Persist the invariant
          // failure at the checkpoint so recovery cannot replay the node.
          aggregate = await this.commitVerificationPreflightFailure(
            aggregate,
            node.id,
            activationId,
            new Error("Verification contract was not approved with the selected plan.")
          );
          return aggregate;
        } else {
          const activeContract = aggregate.context.verificationContract;
          const desiredDraft = selectedDraft ?? {
            commands,
            totalTimeoutMs: activeContract.totalTimeoutMs,
            protectedPaths: activeContract.protectedPaths,
            testRoots: activeContract.testRoots,
            allowedNewTestRoots: activeContract.allowedNewTestRoots,
            generatedOutputPaths: activeContract.generatedOutputPaths,
          };
          const criteriaChanges = aggregate.context.verificationCriteriaChanges ?? [];
          const policyChanged = criteriaChanges.length > 0 || JSON.stringify({
            commands: desiredDraft.commands,
            totalTimeoutMs: desiredDraft.totalTimeoutMs ?? activeContract.totalTimeoutMs,
            protectedPaths: desiredDraft.protectedPaths ?? activeContract.protectedPaths,
            testRoots: desiredDraft.testRoots ?? activeContract.testRoots,
            allowedNewTestRoots: desiredDraft.allowedNewTestRoots ?? activeContract.allowedNewTestRoots,
            generatedOutputPaths: desiredDraft.generatedOutputPaths ?? activeContract.generatedOutputPaths,
          }) !== JSON.stringify({
            commands: activeContract.commands,
            totalTimeoutMs: activeContract.totalTimeoutMs,
            protectedPaths: activeContract.protectedPaths,
            testRoots: activeContract.testRoots,
            allowedNewTestRoots: activeContract.allowedNewTestRoots,
            generatedOutputPaths: activeContract.generatedOutputPaths,
          });
          let currentFingerprint;
          try {
            currentFingerprint = await this.verificationRunner.currentFingerprint(
              activeContract,
              aggregate.context.targetProjectPath,
              aggregate.context.additionalAllowedPaths
            );
          } catch (error) {
            aggregate = await this.commitVerificationPreflightFailure(
              aggregate,
              node.id,
              activationId,
              error
            );
            return aggregate;
          }
          if (
            (currentFingerprint.digest !== activeContract.baselineFingerprint || policyChanged) &&
            !aggregate.context.verificationCandidate
          ) {
            if (this.verificationContracts) {
              let preparedCandidate;
              try {
                preparedCandidate = await this.verificationContracts.candidate({
                  contract: activeContract,
                  projectRoot: aggregate.context.targetProjectPath,
                  additionalRoots: aggregate.context.additionalAllowedPaths,
                  baselinePaths: activeContract.baselinePaths,
                  baselineFileHashes: activeContract.baselineFileHashes,
                  baselineFileModes: activeContract.baselineFileModes,
                  proposedDraft: policyChanged ? desiredDraft : undefined,
                });
              } catch (error) {
                aggregate = await this.commitVerificationPreflightFailure(
                  aggregate,
                  node.id,
                  activationId,
                  error
                );
                return aggregate;
              }
              const candidate = preparedCandidate.candidate;
              if (criteriaChanges.length > 0 || candidateNeedsVerificationApproval(
                aggregate.context.verificationContract,
                candidate,
                aggregate.context.targetProjectPath
              )) {
                const waiting = this.reducer.requestVerificationApproval(
                  aggregate,
                  candidate,
                  this.clock.now(),
                  "Verification criteria or protected files changed. Review and approve the proposed verification contract.",
                  preparedCandidate.diff,
                  preparedCandidate.baseline
                );
                aggregate = await this.commit(waiting, aggregate);
                await this.projection.update(aggregate);
                return aggregate;
              }
              // New tests under an already-approved test root are explicitly
              // allowed by the contract.  Capture their baseline and rerun
              // verification without manufacturing a new approval request.
              aggregate = await this.commit(
                this.reducer.adoptVerificationBaseline(
                  aggregate,
                  candidate,
                  this.clock.now(),
                  preparedCandidate.baseline
                ),
                aggregate
              );
            } else {
              const candidate = this.verificationRunner.buildApprovalCandidate(
                activeContract,
                currentFingerprint,
                policyChanged ? desiredDraft : undefined
              );
              candidate.baselineFingerprint = currentFingerprint.digest;
              const waiting = this.reducer.requestVerificationApproval(
                aggregate,
                candidate,
                this.clock.now()
              );
              aggregate = await this.commit(waiting, aggregate);
              await this.projection.update(aggregate);
              return aggregate;
            }
          }
        }
        const verificationId = `${activationId}_verification`;
        if (execution.status === "reserved") {
          aggregate = await this.commit(
            this.reducer.startVerification(aggregate, activationId, this.clock.now()),
            aggregate
          );
        }
        const { implementationActivationId, testActivationId } = verificationActivationIds(aggregate);
        const result = await this.verificationRunner.run(
          aggregate.context.verificationContract!,
          {
            runId,
            verificationId,
            projectRoot: aggregate.context.targetProjectPath,
            additionalRoots: aggregate.context.additionalAllowedPaths,
            implementationActivationId,
            testActivationId,
            existingRecords: aggregate.context.verificationRecords,
            elapsedMs: aggregate.context.verificationElapsedMs,
            pollControl: async () => {
              return this.controls.claim(runId);
            },
            onRecord: async (record, logArtifact) => {
              aggregate = await this.commit(
                this.reducer.recordVerificationCommand(aggregate, record, this.clock.now(), logArtifact),
                aggregate
              );
            },
          }
        );
          aggregate = await this.commit(
            this.reducer.recordVerificationProof(
              aggregate,
              result.proof,
              this.clock.now(),
              result.resultArtifact
            ),
            aggregate
          );
        if (result.control) {
          const controlled = this.reducer.applyBoundaryControl(
            aggregate,
            result.control.requestId,
            result.control.type,
            result.control.message,
            this.clock.now(),
            true
          );
          aggregate = await this.commit(controlled, aggregate);
          await this.controls.complete(
            {
              ...result.control,
            },
            "completed",
            `Run control '${result.control.type}' was applied after verification cleanup.`
          );
          await this.projection.update(aggregate);
          if (aggregate.execution.status !== "RUNNING") return aggregate;
          continue;
        }
        const verificationResult: TaskExecutionResult = result.proof.executionError
          ? {
              status: "failed",
              signal: "error",
              output: null,
              effects: [],
              artifacts: [],
              failure: {
                kind: "unknown_mutation",
                message: result.proof.failureReason ?? "Verification execution failed with an unknown result.",
                retryable: false,
                ambiguousMutation: true,
                attemptId: null,
              },
              pendingInput: null,
            }
          : {
              status: "succeeded",
              signal: result.proof.passed ? "pass" : "fail",
              output: null,
              effects: [],
              artifacts: [],
              failure: null,
              pendingInput: null,
            };
        aggregate = await this.commitTaskResult(
          aggregate,
          node.id,
          activationId,
          verificationResult
        );
        completedSteps += 1;
        await this.projection.update(aggregate);
        continue;
      }

      // Human and verification nodes returned above; the remaining compiled
      // variant is therefore a task and carries non-optional task/agent IDs.
      const task = aggregate.definition.tasks[node.taskId];
      const agent = aggregate.definition.agents[node.agentId];
      const attemptNumber = execution.attemptIds.length + 1;
      if (attemptNumber > task.retryPolicy.maxAttempts) {
        const exhausted = this.retryExhaustedResult(
          execution.attemptIds[execution.attemptIds.length - 1] ?? null
        );
        aggregate = await this.commitTaskResult(aggregate, node.id, activationId, exhausted);
        completedSteps += 1;
        await this.projection.update(aggregate);
        continue;
      }
      const attemptId = this.ids.attempt(activationId, attemptNumber);
      const started = this.reducer.startAttempt(
        aggregate,
        activationId,
        attemptId,
        this.clock.now()
      );
      aggregate = await this.commit(started, aggregate);
      const context: NodeExecutionContext = {
        aggregate,
        node,
        activationId,
        attemptId,
        attemptNumber,
      };
      let result: TaskExecutionResult;
      try {
        result = await this.taskRunner.run(context, agent, task);
      } catch (error) {
        result = {
          status: "failed",
          signal: "error",
          output: null,
          effects: [],
          artifacts: [],
          failure: {
            kind: "internal",
            message: error instanceof Error ? error.message : String(error),
            retryable: false,
            ambiguousMutation: task.sideEffect === "workspace_mutation",
            attemptId,
          },
          pendingInput: null,
        };
      }
      if (result.status === "waiting_user" && result.pendingInput) {
        const waiting = this.reducer.requestTaskHumanInput(
          aggregate,
          result,
          this.clock.now()
        );
        aggregate = await this.commit(waiting, aggregate);
        await this.projection.update(aggregate);
        return aggregate;
      }
      if (
        result.status === "failed" &&
        result.failure?.retryable &&
        !result.failure.ambiguousMutation &&
        attemptNumber < task.retryPolicy.maxAttempts
      ) {
        const retryRecorded = this.reducer.recordRetryableFailure(
          aggregate,
          activationId,
          result,
          this.clock.now()
        );
        aggregate = await this.commit(retryRecorded, aggregate);
        const delay = task.retryPolicy.backoffMs[
          Math.min(attemptNumber - 1, Math.max(0, task.retryPolicy.backoffMs.length - 1))
        ] ?? 0;
        await this.projection.update(aggregate);
        if (delay > 0) await this.clock.delay(delay);
        continue;
      }
      aggregate = await this.commitTaskResult(
        aggregate,
        node.id,
        activationId,
        result
      );
      if (result.failure?.controlCommand) {
        await this.controls.complete(
          result.failure.controlCommand,
          "completed",
          `Run control '${result.failure.controlCommand.type}' was applied after provider termination.`
        );
      }
      completedSteps += 1;
      await this.projection.update(aggregate);
    }
    return aggregate;
  }

  private async commitTaskResult(
    aggregate: RunAggregate,
    nodeId: string,
    activationId: string,
    result: TaskExecutionResult
  ): Promise<RunAggregate> {
    let current = aggregate;
    let targetId: string | null = null;
    let terminalStatus: RunAggregate["execution"]["status"] | null = null;
    let transitionSignal = result.signal;
    if (result.status === "succeeded" && result.signal) {
      const reviewNode = nodeId === current.definition.applicationPolicy.verificationNodeId ||
        nodeId === current.definition.applicationPolicy.qaNodeId ||
        nodeId === current.definition.applicationPolicy.completionApprovalNodeId;
      if (reviewNode) {
        const failedCommandIds = current.context.verificationProof?.commands
          .filter((command) => command.status !== "completed" || command.exitCode !== 0)
          .map((command) => command.commandId) ?? [];
        // Evidence is append-only so the reducer can audit every claim.  For
        // convergence, however, only the newest observation for each
        // requirement is authoritative; an old failed cycle must not keep a
        // later satisfied requirement marked as unresolved.
        const latestEvidence = new Map<string, (typeof current.context.requirementEvidence)[number]>();
        for (const item of current.context.requirementEvidence) {
          latestEvidence.set(item.requirementId, item);
        }
        // The reducer applies effects only after the transition has been
        // validated. Build the observation from the same effects so a review
        // cannot be judged against stale requirement evidence or findings.
        for (const effect of result.effects) {
          if (effect.type !== "add_requirement_evidence") continue;
          for (const item of effect.evidence) {
            latestEvidence.set(item.requirementId, {
              activationId,
              requirementId: item.requirementId,
              status: item.status,
              evidence: item.evidence,
              artifactIds: [...(item.artifactIds ?? [])],
            });
          }
        }
        const unsatisfiedRequirementIds = current.context.requirements
          .filter((requirement) => latestEvidence.get(requirement.id)?.status !== "satisfied")
          .map((requirement) => requirement.id);
        const unresolvedFindingIds = new Set(
          current.context.findings
            .filter((finding) => finding.status === "open")
            .map((finding) => finding.id)
        );
        for (const effect of result.effects) {
          if (effect.type === "record_findings") {
            for (const finding of effect.findings) {
              unresolvedFindingIds.add(
                `finding_${createHash("sha256").update(`${effect.source}:${finding.trim()}`).digest("hex").slice(0, 16)}`
              );
            }
          }
          if (effect.type === "record_review_approval") {
            for (const findingId of effect.resolvedFindingIds) unresolvedFindingIds.delete(findingId);
          }
        }
        // A rejected QA/master review creates a deterministic core finding in
        // recordReviewFeedback below. Include that finding in this same
        // observation so convergence compares the actual post-review state;
        // otherwise the next cycle would appear to regress merely because the
        // rejection finding was persisted after the observation.
        if (
          result.signal === "rejected" &&
          (nodeId === current.definition.applicationPolicy.qaNodeId ||
            nodeId === current.definition.applicationPolicy.completionApprovalNodeId)
        ) {
          const reviewStage = nodeId === current.definition.applicationPolicy.qaNodeId ? "qa" : "master";
          const reviewText = (result.output?.summary ?? "Review rejected the current implementation.").trim();
          if (reviewText) {
            unresolvedFindingIds.add(
              `finding_${createHash("sha256").update(`${reviewStage}:${reviewText}`).digest("hex").slice(0, 16)}`
            );
          }
        }
        current = await this.commit(
          this.reducer.recordConvergence(
            current,
            {
              contractHash: current.context.verificationContract?.contractHash ?? null,
              reachedStep: convergenceStage(current, nodeId),
              failedCommandIds,
              unsatisfiedRequirementIds,
              unresolvedFindingIds: [...unresolvedFindingIds],
            },
            this.clock.now()
          ),
          current
        );
      }
      // Resolve the provider's declared route first.  This route is used for
      // the normal fingerprint check before a core-owned convergence stop can
      // redirect the completed review.  The redirect signal is minted by the
      // core and cannot be supplied by a provider result.
      const normalRoute = this.router.route(current.definition, nodeId, result.signal);
      if ((nodeId === current.definition.applicationPolicy.qaNodeId ||
           nodeId === current.definition.applicationPolicy.completionApprovalNodeId) &&
          result.signal === "rejected") {
        current = await this.commit(
          this.reducer.recordReviewFeedback(
            current,
            nodeId === current.definition.applicationPolicy.qaNodeId ? "qa" : "master",
            activationId,
            result.output?.summary ?? "Review rejected the current implementation.",
            [],
            this.clock.now(),
            [
              ...result.artifacts.map((artifact) => artifact.artifactId),
              ...(result.output?.artifactId ? [result.output.artifactId] : []),
            ],
            result.artifacts
          ),
          current
        );
      }
      targetId = normalRoute.targetId;
      terminalStatus = normalRoute.terminalStatus;
      if (
        (targetId === current.definition.applicationPolicy.qaNodeId ||
          targetId === current.definition.applicationPolicy.completionApprovalNodeId) &&
        current.context.verificationProof &&
        this.verificationRunner
      ) {
        try {
          const fingerprint = await this.verificationRunner.currentFingerprint(
            current.context.verificationContract!,
            current.context.targetProjectPath,
            current.context.additionalAllowedPaths
          );
          if (fingerprint.digest !== current.context.verificationProof.afterFingerprint) {
            const paused = this.reducer.pauseForVerificationInvalidation(
              current,
              "Workspace fingerprint changed before review; verification evidence was invalidated.",
              this.clock.now()
            );
            return this.commit(paused, current);
          }
          current = await this.commit(
            this.reducer.confirmWorkspaceFingerprint(current, fingerprint.digest, this.clock.now()),
            current
          );
        } catch (error) {
          const paused = this.reducer.pauseForVerificationInvalidation(
            current,
            `Workspace fingerprint could not be confirmed before review: ${error instanceof Error ? error.message : String(error)}`,
            this.clock.now()
          );
          return this.commit(paused, current);
        }
      }
      if (reviewNode && current.context.convergence.stagnantCycles >= 2) {
        transitionSignal = "convergence_stalled";
        const stalledRoute = this.router.route(current.definition, nodeId, transitionSignal);
        targetId = stalledRoute.targetId;
        terminalStatus = stalledRoute.terminalStatus;
      }
      if (terminalStatus === "SUCCESS" && current.context.verificationProof && this.verificationRunner) {
        try {
          const fingerprint = await this.verificationRunner.currentFingerprint(
            current.context.verificationContract!,
            current.context.targetProjectPath,
            current.context.additionalAllowedPaths
          );
          if (fingerprint.digest !== current.context.verificationProof.afterFingerprint) {
            const paused = this.reducer.pauseForVerificationInvalidation(
              current,
              "Workspace fingerprint changed before the success commit; verification evidence was invalidated.",
              this.clock.now()
            );
            return this.commit(paused, current);
          }
          current = await this.commit(
            this.reducer.confirmWorkspaceFingerprint(current, fingerprint.digest, this.clock.now()),
            current
          );
        } catch (error) {
          const paused = this.reducer.pauseForVerificationInvalidation(
            current,
            `Workspace fingerprint could not be confirmed before success: ${error instanceof Error ? error.message : String(error)}`,
            this.clock.now()
          );
          return this.commit(paused, current);
        }
      }
    } else if (result.failure) {
      if (result.failure.kind === "stopped") {
        targetId = "STOPPED";
        terminalStatus = "STOPPED";
      } else if (result.failure.kind === "interrupted") {
        targetId = current.definition.applicationPolicy.interruptNodeId;
      } else if (
        result.failure.ambiguousMutation ||
        ["security", "budget", "unknown_mutation"].includes(result.failure.kind)
      ) {
        targetId = aggregate.definition.applicationPolicy.blockedTerminalId;
        terminalStatus = "BLOCKED";
      } else if (nodeId === current.definition.applicationPolicy.interruptNodeId) {
        const paused = current.definition.terminals.find(
          (terminal) => terminal.status === "paused"
        );
        targetId = paused?.id ?? null;
        terminalStatus = "PAUSED";
      } else {
        targetId = aggregate.definition.applicationPolicy.interruptNodeId;
      }
    }
      const outcomeResult = transitionSignal === result.signal
        ? result
        : { ...result, signal: transitionSignal };
      const outcome: NodeOutcome = {
        nodeId,
        activationId,
        result: outcomeResult,
        targetId,
        terminalStatus,
        effects: outcomeResult.effects,
      completedAt: this.clock.now(),
    };
    return this.commit(this.reducer.completeNode(current, outcome), current);
  }

  private retryExhaustedResult(attemptId: string | null): TaskExecutionResult {
    return {
      status: "failed",
      signal: "error",
      output: null,
      effects: [],
      artifacts: [],
      failure: {
        kind: "provider",
        message: "Task retry policy was exhausted.",
        retryable: false,
        ambiguousMutation: false,
        attemptId,
      },
      pendingInput: null,
    };
  }

  private commit(
    candidate: RunAggregate,
    previous: RunAggregate
  ): Promise<RunAggregate> {
    return this.repository.commit(
      candidate,
      previous.revision,
      previous.fencingEpoch
    );
  }

  private async commitVerificationPreflightFailure(
    aggregate: RunAggregate,
    nodeId: string,
    activationId: string,
    error: unknown
  ): Promise<RunAggregate> {
    const reason = `Verification preflight failed for ${nodeId}: ${error instanceof Error ? error.message : String(error)}`;
    const blocked = this.reducer.recordVerificationPreflightFailure(
      aggregate,
      activationId,
      reason,
      this.clock.now()
    );
    const committed = await this.commit(blocked, aggregate);
    await this.projection.update(committed);
    return committed;
  }
}
