import {
  advanceVisit,
  interruptSession,
  prepareManualResume,
  stopSession,
} from "./session_transitions";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import {
  AgentNode,
  AttemptRecord,
  ModelPricing,
  NodeVisit,
  SessionState,
  SessionStatus,
} from "../shared/domain";
import { StudioStore } from "./store";
import { SessionOwnership } from "./session_ownership";
import {
  checkProcessLiveness,
  collectRecoveredChildPids,
  delay,
} from "./resilience";
import {
  claimNextControlRequest,
  completeControlRequest,
  ensureControlQueue,
  getControlQueuePaths,
  recoverClaimedControlRequests,
  ClaimedControlRequest,
} from "./control_queue";
import {
  ProcessSupervisor,
  SupervisorResult,
  terminateProcessTreeBounded,
} from "./process_supervisor";
import { AgentAttemptRunner } from "./agent_attempt_runner";
import { queryModels } from "./catalog";
import { buildInvocation } from "./invocation";
import { buildNodePrompt, buildRecoveryMessage } from "./prompt";
import {
  parseRequirementEvidence,
  retainRequirementEvidence,
} from "./requirement_ledger";
import { Completion } from "./completion";
import { AppError, messageOf } from "./errors";
import { outsidePaths } from "./access_paths";
import { mergeProjectReceipts } from "./verification_evidence";
import { modelPricing } from "./model_pricing";
import { productionHashes } from "./verification_sources";
import { successBlockers } from "./success_gate";
import {
  lockContract,
  contractViolation,
  verificationRunnerProblem,
} from "./verification_contract";
import { deliverableProblem } from "./deliverables";
import {
  prepareVerificationCaptures,
  addCapturedEnvironmentDiagnostics,
} from "./verification_capture";
import { sessionBudgetReason, pauseForBudget } from "./session_budget";
import { stageDeadline, stageBudgetReason } from "./stage_budget";
import { unscopedTerminationEvent } from "./process_command_policy";
import { nodeTestScript } from "./node_test_policy";
import { runPolicy } from "./run_policy";
import {
  TEST_POLICY,
  TEST_FAILED,
  testSources,
  sourceDifference,
  testPolicyEvent,
  failedRegisteredCheck,
  currentVerificationSources,
} from "./test_source_guard";
import { isAuditRole, isReadOnly, isVerifierRole } from "../shared/node_roles";
import { IoUnavailable } from "./program_io_errors";
import {
  AttemptRun,
  Completed,
  Invocation,
  InvocationOptions,
  Stage,
  STOPPED,
  Stopped,
  completed,
  cycleAttempts,
  failedPreparation,
} from "./runtime_steps";
import {
  GateHost,
  attemptFailure,
  evidenceGates,
  judge,
  recoverOrPause,
} from "./runtime_gates";

export interface RuntimeHooks {
  onState?: (state: SessionState) => void;
  onLog?: (visitId: string, attemptId: string, text: string) => void;
}
export { outsidePaths } from "./access_paths";
export { classifyFailure } from "./runtime_gates";
export class GraphRuntime implements GateHost {
  state!: SessionState;
  private owner!: SessionOwnership;
  private abort = new AbortController();
  private stopRequested = false;
  private activePid: number | null = null;
  readonly pricing = new Map<string, ModelPricing>();
  constructor(
    private readonly store: StudioStore,
    private readonly sessionId: string,
    private readonly hooks: RuntimeHooks = {},
  ) {}
  cancelPreflight(): void {
    this.abort.abort(new Error("세션 제어 요청"));
  }
  async save(): Promise<void> {
    await this.store.writeSession(this.state);
    this.hooks.onState?.(structuredClone(this.state));
  }
  controls() {
    return getControlQueuePaths(this.store.sessionDir(this.sessionId));
  }
  async finishControl(request: ClaimedControlRequest): Promise<void> {
    if (request.request.type === "STOP") {
      stopSession(this.state);
      this.stopRequested = true;
    } else interruptSession(this.state, request.request.message);
    await this.save();
    await completeControlRequest(
      this.controls(),
      request,
      "completed",
      this.state.statusReason ?? "중단 분석으로 전환했습니다.",
    );
  }
  private async poll(): Promise<boolean> {
    const request = await claimNextControlRequest(this.controls());
    if (request) {
      await this.finishControl(request);
      return true;
    }
    const budget = sessionBudgetReason(this.state);
    if (budget) {
      await this.budgetStop(budget);
      return true;
    }
    return false;
  }
  async budgetStop(reason: string): Promise<void> {
    pauseForBudget(this.state, reason);
    this.stopRequested = true;
    await this.save();
  }
  /** The one place this class sets a session status. */
  async settle(status: SessionStatus, reason: string | null): Promise<void> {
    this.state.status = status;
    this.state.statusReason = reason;
    await this.save();
  }
  async stageStop(reason: string, visit: NodeVisit): Promise<void> {
    this.state.automaticRecovery = null;
    visit.status = "paused";
    this.stopRequested = true;
    await this.settle("PAUSED", reason);
  }
  verificationFailure(node: AgentNode, reason: string): Completion {
    const verdict = node.type === "test" ? "FAIL" : "REJECTED";
    return {
      valid: true,
      reason,
      failureKind: null,
      output: `[ORCHESTRATOR_VERIFICATION_FAILURE]\n${reason}\nVERDICT: ${verdict}\n[PHASE_DONE]`,
      verdict,
      plans: [],
      researchBlocked: false,
      environmentBlocked: null,
    };
  }
  async contractStop(): Promise<boolean> {
    const reason = await contractViolation(this.state);
    if (!reason) return false;
    this.state.automaticRecovery = null;
    this.stopRequested = true;
    const visit = this.state.visits.find(
      (v) => v.id === this.state.activeVisitId,
    );
    if (visit) visit.status = "paused";
    await this.settle("BLOCKED", reason);
    return true;
  }
  outside(text: string, intentRoots: string[] = []): string[] {
    return outsidePaths(text, [
      this.state.targetProjectPath,
      ...this.state.additionalAllowedPaths,
      ...intentRoots,
    ]).filter(
      (file) =>
        path.resolve(file) !== path.resolve(__dirname, "../server/cli.js"),
    );
  }
  async run(mode: "start" | "manual" | "automatic" = "start"): Promise<void> {
    this.state = await this.store.readSession(this.sessionId);
    const automaticRecoveryVisitId =
      mode === "automatic" && this.state.automaticRecovery
        ? this.state.activeVisitId
        : null;
    const settings = this.state.settings;
    this.owner = new SessionOwnership({
      sessionDir: this.store.sessionDir(this.sessionId),
      ownerLockFileName: "owner.lock",
      leaseFileName: "lease.json",
      heartbeatIntervalMs: settings.heartbeatIntervalMs,
      leaseTtlMs: settings.leaseTtlMs,
    });
    const acquired = await this.owner.acquire();
    const budgetTimer = this.state.executionBudget
      ? setTimeout(
          () => this.abort.abort(new Error("전체 실행 시간 예산 소진")),
          Math.max(
            1,
            Date.parse(this.state.executionBudget.deadlineAt) - Date.now(),
          ),
        )
      : undefined;
    budgetTimer?.unref();
    try {
      await ensureControlQueue(this.controls());
      await recoverClaimedControlRequests(this.controls());
      if (
        acquired.recoveredStaleOwner &&
        !(await this.recoverStaleOwner(acquired.previousLease))
      )
        return;
      if (mode === "manual") prepareManualResume(this.state);
      this.state.automaticRecovery = null;
      await this.settle(
        "RUNNING",
        "실행 연결과 모델 목록을 확인하고 있습니다.",
      );
      if ((await this.poll()) && this.stopRequested) return;
      if (await this.contractStop()) return;
      if (!(await this.recheckModels())) return;
      this.abort = new AbortController();
      if (!(await this.renewAutomaticRecovery(automaticRecoveryVisitId)))
        return;
      this.state.statusReason = null;
      await this.save();
      await this.visitLoop();
    } catch (error) {
      await this.runFailed(error);
    } finally {
      clearTimeout(budgetTimer);
      this.abort.abort();
      await this.owner.release();
    }
  }
  /** Clear what a dead worker left behind; false once the session had to stop. */
  private async recoverStaleOwner(
    previousLease: Parameters<typeof collectRecoveredChildPids>[0],
  ): Promise<boolean> {
    const activeAttempt = this.state.visits
      .find((v) => v.id === this.state.activeVisitId)
      ?.attempts.at(-1);
    for (const pid of collectRecoveredChildPids(
      previousLease,
      activeAttempt?.pid,
    )) {
      if (
        checkProcessLiveness(pid) !== "dead" &&
        (await terminateProcessTreeBounded(
          pid,
          this.state.settings.killTimeoutMs,
        )) !== "dead"
      ) {
        await this.settle(
          "BLOCKED",
          "이전 자식 프로세스 종료를 확인할 수 없습니다.",
        );
        return false;
      }
    }
    if (activeAttempt?.status === "running") {
      activeAttempt.status = "interrupted";
      activeAttempt.failureKind = "worker_crash";
      activeAttempt.message =
        "이전 워커 종료 후 남은 자식 프로세스를 정리했습니다.";
      activeAttempt.endedAt = new Date().toISOString();
      activeAttempt.pid = null;
    }
    return true;
  }
  /** Only bindings referenced by this immutable run are queried; no CLI scan.
   * False once the session had to stop. */
  private async recheckModels(): Promise<boolean> {
    for (const connection of this.state.connections) {
      // Interrupt cancels metadata lookup as well as coding. Recheck the same
      // connection with a fresh signal before executing its interrupt node.
      while (true) {
        const catalog = await queryModels(
          connection,
          this.state.targetProjectPath,
          {
            signal: this.abort.signal,
            onPid: (pid) => {
              this.activePid = pid;
              this.owner.setChildPid(pid);
            },
          },
        );
        await this.store.cacheCatalog(catalog);
        if (await this.poll()) {
          if (this.stopRequested) return false;
          if (this.abort.signal.aborted) {
            this.abort = new AbortController();
            continue;
          }
        }
        const assigned = Object.values(this.state.bindings).filter(
          (b) => b.connectionId === connection.id,
        );
        if (
          catalog.status !== "ready" ||
          assigned.some(
            (b) =>
              !catalog.models.some(
                (m) =>
                  m.id === b.modelId &&
                  (!b.variant || m.variants.includes(b.variant)),
              ),
          )
        ) {
          await this.settle(
            "WAITING_USER",
            `[${this.state.graph.nodes.find((n) => n.id === this.state.currentNodeId)?.name ?? "모델 조회"} · ${connection.label}] ${catalog.error ?? "선택한 모델 또는 추론 강도를 조회할 수 없습니다. CLI의 모델 권한과 설정을 확인하고 재개하세요."}`,
          );
          return false;
        }
        for (const [nodeId, binding] of Object.entries(this.state.bindings)) {
          if (binding.connectionId !== connection.id) continue;
          const model = catalog.models.find((m) => m.id === binding.modelId)!;
          this.pricing.set(nodeId, model.pricing ?? modelPricing());
        }
        break;
      }
    }
    return true;
  }
  /** An automatic resume must still be free and gets a fresh recovery budget. */
  private async renewAutomaticRecovery(
    visitId: string | null,
  ): Promise<boolean> {
    if (!visitId || this.state.activeVisitId !== visitId) return true;
    if (this.pricing.get(this.state.currentNodeId ?? "")?.status !== "free") {
      await this.settle(
        "PAUSED",
        "자동 복구 전에 무료 모델임을 다시 확인하지 못했습니다. 추가 모델 호출 없이 정지했습니다.",
      );
      return false;
    }
    const visit = this.state.visits.find((v) => v.id === visitId)!;
    // Scheduler latency and metadata lookup must not consume the next attempt's budget.
    visit.cycleStartedAt = new Date().toISOString();
    visit.cycleDeadlineAt = new Date(
      Date.now() + this.state.settings.phaseRecoveryBudgetMs,
    ).toISOString();
    return true;
  }
  private async visitLoop(): Promise<void> {
    while (this.state.status === "RUNNING" && !this.stopRequested) {
      if ((await this.poll()) && this.stopRequested) return;
      if (await this.contractStop()) return;
      const id = this.state.currentNodeId;
      if (id === "SUCCESS" || id === "PAUSED") return this.finishRun(id);
      const node = this.state.graph.nodes.find((n) => n.id === id);
      if (!node) throw new Error("실행 노드를 찾을 수 없습니다.");
      let visit = this.state.visits.find(
        (v) => v.id === this.state.activeVisitId,
      );
      if (visit?.nodeId !== node.id) visit = undefined;
      if (visit && ["succeeded", "failed"].includes(visit.status)) {
        await this.advance(node, visit);
        continue;
      }
      visit ??= await this.openVisit(node);
      if (!visit || !(await this.readyToExecute(node, visit))) return;
      const outcome = await this.execute(node, visit);
      if (this.state.status !== "RUNNING") return;
      if (this.state.activeVisitId !== visit.id) continue; // interrupt control changed traversal
      if (outcome.step === "stopped") continue;
      if (!(await this.applyCompletion(node, visit, outcome.completion)))
        return;
    }
  }
  /** The terminal decision: SUCCESS has to prove itself again, or the run pauses. */
  private async finishRun(id: "SUCCESS" | "PAUSED"): Promise<void> {
    const blockers = id === "SUCCESS" ? successBlockers(this.state) : [];
    if (id === "SUCCESS") {
      const problem = await deliverableProblem(this.state);
      if (problem) blockers.push(problem);
    }
    const reason = blockers.length
      ? `성공 조건 미충족: ${blockers.join(" ")} 수정·테스트·최종 승인을 다시 수행하도록 수동 재개하세요.`
      : id === "SUCCESS"
        ? "모든 필수 요구사항, 실제 테스트 실행 증거와 최종 승인을 확인했습니다."
        : (this.state.statusReason ??
          "중단 분석을 완료했습니다. 계획과 근거를 검토한 뒤 재개하세요.");
    if (blockers.length) {
      this.state.currentNodeId = "PAUSED";
      this.state.automaticRecovery = null;
    }
    this.state.activeVisitId = null;
    await this.settle(blockers.length ? "PAUSED" : id, reason);
  }
  /** Start the node's next visit, or undefined once the run budget paused the session. */
  private async openVisit(node: AgentNode): Promise<NodeVisit | undefined> {
    if (
      this.state.visits.length >= this.state.visitLimit ||
      (this.state.completedIterations >= this.state.iterationLimit &&
        node.id === this.state.graph.entrypoints.reentry)
    ) {
      await this.settle(
        "PAUSED",
        "노드 방문 또는 반복 실행 예산을 소진했습니다. 그래프와 미해결 요구사항을 검토한 뒤 수동 재개하세요.",
      );
      return undefined;
    }
    const now = new Date().toISOString();
    const visit: NodeVisit = {
      id: randomUUID(),
      nodeId: node.id,
      number: this.state.visits.filter((v) => v.nodeId === node.id).length + 1,
      status: "running",
      startedAt: now,
      completedAt: null,
      attempts: [],
      output: "",
      verdict: null,
      plans: [],
      selectedPlanId: null,
      cycleStartedAt: now,
      cycleDeadlineAt: new Date(
        Date.now() + this.state.settings.phaseRecoveryBudgetMs,
      ).toISOString(),
      recoveryCount: 0,
      transitionCommitted: false,
      automaticCycles: 0,
    };
    this.state.visits.push(visit);
    this.state.activeVisitId = visit.id;
    await this.save();
    return visit;
  }
  /** Approvals this visit still waits on; false once the session stopped for one. */
  private async readyToExecute(
    node: AgentNode,
    visit: NodeVisit,
  ): Promise<boolean> {
    if (visit.status === "waiting_approval") {
      await this.settle(
        "WAITING_USER",
        "이 방문의 계획 선택과 승인이 필요합니다.",
      );
      return false;
    }
    if (visit.status === "paused") visit.status = "running";
    if (
      runPolicy(this.state.graph).reserveFinalizationBudget &&
      !visit.stageDeadlineAt
    ) {
      const end = stageDeadline(this.state, node, visit);
      if (end !== undefined) {
        visit.stageDeadlineAt = new Date(end).toISOString();
        await this.save();
      }
    }
    if (isReadOnly(node.type) || this.state.accessMode !== "ask") return true;
    const ref = this.state.approvedPlanRef;
    const approved = ref
      ? (this.state.visits
          .find((v) => v.id === ref.visitId)
          ?.plans.find((p) => p.id === ref.choiceId)?.body ?? "")
      : "";
    const extra = this.outside(
      `${this.state.goal}\n${approved}\n${node.instructions}`,
    );
    if (!extra.length) return true;
    this.state.pendingAccess = {
      paths: extra,
      nodeId: node.id,
      visitId: visit.id,
    };
    await this.settle(
      "WAITING_USER",
      "프로젝트 밖의 경로에 대한 접근 승인이 필요합니다.",
    );
    return false;
  }
  /** Record an accepted completion and move on; false once it needs the operator. */
  private async applyCompletion(
    node: AgentNode,
    visit: NodeVisit,
    completion: Completion,
  ): Promise<boolean> {
    visit.output =
      completion.output +
      (completion.reason ? `\n\n[ORCHESTRATOR] ${completion.reason}` : "");
    visit.verdict = completion.verdict;
    if (completion.researchBlocked) {
      visit.status = "paused";
      await this.settle(
        "WAITING_USER",
        "필요한 인터넷 조사 기능을 CLI에서 설정한 뒤 재개하세요.",
      );
      return false;
    }
    if (node.type === "planning") {
      visit.plans = completion.plans;
      await this.store.savePlans(this.state.id, visit.id, visit.plans);
      if (node.planning?.requiresApproval !== false) {
        visit.status = "waiting_approval";
        this.state.pendingApproval = { nodeId: node.id, visitId: visit.id };
        await this.settle(
          "WAITING_USER",
          "생성한 계획을 검토하고 선택·승인하세요.",
        );
        return false;
      }
      const plan = visit.plans[0]!;
      visit.selectedPlanId = plan.id;
      this.state.approvedPlanRef = {
        visitId: visit.id,
        choiceId: plan.id,
        revision: plan.revision,
      };
    }
    visit.status = ["FAIL", "REJECTED"].includes(completion.verdict ?? "")
      ? "failed"
      : "succeeded";
    visit.completedAt = new Date().toISOString();
    this.recordEvidence(node, visit);
    await this.advance(node, visit);
    return true;
  }
  private async runFailed(error: unknown): Promise<void> {
    if (error instanceof AppError && error.code === "stale_session") {
      // A newer controller decision owns the persisted state; never overwrite it.
      this.state = await this.store.readSession(this.sessionId);
      return;
    }
    const budget = sessionBudgetReason(this.state);
    if (
      budget &&
      (!this.activePid || checkProcessLiveness(this.activePid) === "dead")
    ) {
      await this.budgetStop(budget);
      return;
    }
    await this.settle(
      this.activePid && checkProcessLiveness(this.activePid) !== "dead"
        ? "BLOCKED"
        : "FAILED",
      messageOf(error),
    );
  }
  private recordEvidence(node: AgentNode, visit: NodeVisit): void {
    const ids = new Set(this.state.requirements.items.map((r) => r.id));
    const evidence = parseRequirementEvidence(visit.output)
      .filter((r) => ids.has(r.requirementId))
      .map((r) => ({
        ...r,
        stageId: node.id,
        role: node.roleName,
        attemptId: visit.attempts.at(-1)?.id ?? null,
        recordedAt: new Date().toISOString(),
      }));
    this.state.requirements.evidence = retainRequirementEvidence([
      ...this.state.requirements.evidence,
      ...evidence,
    ]);
  }
  private async advance(node: AgentNode, visit: NodeVisit): Promise<void> {
    advanceVisit(this.state, node, visit);
    await this.save();
  }
  /**
   * Stop the session at this visit. Each caller states its side effects:
   * the halt paths differ in whether they cancel scheduled recovery and
   * whether the visit can be resumed in place.
   */
  async halt(
    visit: NodeVisit,
    status: SessionStatus,
    reason: string,
    effects: { pauseVisit: boolean; clearRecovery: boolean },
  ): Promise<Stopped> {
    if (effects.clearRecovery) this.state.automaticRecovery = null;
    if (effects.pauseVisit) visit.status = "paused";
    await this.settle(status, reason);
    return STOPPED;
  }
  /** Run one node visit to a completion, or until the session stopped. */
  private async execute(
    node: AgentNode,
    visit: NodeVisit,
  ): Promise<Stopped | Completed> {
    const preflight = await this.preflight(node, visit);
    if (preflight.step !== "ready") return preflight;
    const stage = this.stage(node, visit, preflight.sourceInputs);
    const runner = new AgentAttemptRunner({
      maxAttempts: stage.normalLimit,
      retryBackoffMs: this.state.settings.retryBackoffMs,
    });
    let reconnectUsed = cycleAttempts(visit).some((a) => a.reconnectUsed),
      nextResume: string | undefined;
    let recoveryMessage: string | undefined;
    for (;;) {
      if (await this.attemptGuards(stage)) return STOPPED;
      const normal = cycleAttempts(visit).filter(
        (a) => a.mode === "standard",
      ).length;
      const extra = cycleAttempts(visit).filter(
        (a) => a.mode === "completion_recovery",
      ).length;
      const completionRecovery = normal >= stage.normalLimit;
      if (
        Date.now() >= stage.deadline ||
        (completionRecovery && extra >= stage.completionLimit)
      ) {
        await recoverOrPause(
          this,
          node,
          visit,
          "단계 복구 예산 또는 attempt 한도를 소진했습니다.",
        );
        return STOPPED;
      }
      const id = randomUUID();
      let invocation: Invocation;
      try {
        invocation = await buildInvocation(
          stage.connection,
          stage.binding,
          node,
          this.invocationOptions(stage, id, recoveryMessage, nextResume),
        );
      } catch (error) {
        if (!(error instanceof IoUnavailable)) throw error;
        return this.halt(visit, "BLOCKED", messageOf(error), {
          pauseVisit: true,
          clearRecovery: false,
        });
      }
      if (await this.poll()) return STOPPED; // Includes bounded native config preflight time.
      const attempt = this.newAttempt(
        stage,
        id,
        completionRecovery,
        nextResume,
      );
      visit.attempts.push(attempt);
      await this.save();
      const run = await this.supervise(stage, attempt, invocation);
      await this.recordOutcome(stage, run);
      const gated = await evidenceGates(this, stage, run);
      if (gated.step !== "undecided") return gated;
      const judged = await judge(this, stage, run);
      if (judged.step !== "undecided") return judged;
      const failure = await attemptFailure(this, stage, run);
      if (!failure) return STOPPED;
      const { result } = run;
      recoveryMessage = buildRecoveryMessage(
        failure.kind,
        failure.message,
        result.assistantText,
        result.events,
        node.type,
        stage.policy.testSourceGuard,
      );
      const decision = runner.decideRetry({
        failure,
        attemptNumber: normal + 1,
        budgetRemainingMs: stage.deadline - Date.now(),
        cliSessionId: result.cliSessionId,
        reconnectUsed,
      });
      if (decision.retry && !completionRecovery) {
        nextResume = decision.reconnect
          ? (result.cliSessionId ?? undefined)
          : undefined;
        reconnectUsed ||= decision.reconnect;
        attempt.status = "retry_wait";
        attempt.message = `${failure.message} (${decision.delayMs}ms 후 재시도)`;
        await this.save();
        const retryAt = Date.now() + decision.delayMs;
        while (Date.now() < retryAt) {
          if (await this.poll()) return STOPPED;
          await delay(Math.min(100, Math.max(1, retryAt - Date.now())));
        }
      } else if (
        !completionRecovery &&
        failure.kind === "incomplete_response" &&
        result.exitCode === 0 &&
        stage.completionLimit > 0
      ) {
        nextResume = undefined;
      } else {
        await recoverOrPause(this, node, visit, failure.message);
        return STOPPED;
      }
    }
  }
  /** Gates that need no CLI call; also snapshots the sources a test role must not change. */
  private async preflight(
    node: AgentNode,
    visit: NodeVisit,
  ): Promise<
    | Stopped
    | Completed
    | { step: "ready"; sourceInputs: Record<string, string> | null }
  > {
    const policy = runPolicy(this.state.graph),
      sourceGuard = policy.testSourceGuard;
    if (sourceGuard && isAuditRole(node.type)) {
      const expected = currentVerificationSources(this.state, visit);
      if (!expected)
        return completed(
          this.verificationFailure(
            node,
            "현재 테스트 역할의 고정 소스 snapshot이 없습니다. 구현과 전체 테스트를 다시 수행해야 합니다.",
          ),
        );
      const changed = await this.sourceChanges(expected);
      if (changed.length)
        return completed(
          this.verificationFailure(
            node,
            `테스트 이후 소스가 변경되어 증거를 무효화했습니다: ${changed.join(", ")}. 구현과 모든 등록 검사를 다시 수행해야 합니다.`,
          ),
        );
    }
    if (
      policy.verificationContract &&
      node.type === "test" &&
      this.state.verificationContract?.status !== "locked"
    ) {
      try {
        this.state.verificationContract = await lockContract(
          this.state,
          "implementation",
        );
        await this.save();
      } catch (error) {
        return completed(
          failedPreparation(
            `검증 계약 준비 실패: ${messageOf(error)}`,
            `검증 계약 준비 실패: ${messageOf(error)}\n구현 역할에서 .agent-graph/verification.json과 인수 검사를 준비하세요.`,
          ),
        );
      }
    }
    if (node.type === "test") {
      const problem = await verificationRunnerProblem(this.state);
      if (problem)
        return completed(
          failedPreparation(
            problem,
            `검증 runner 준비 실패: ${problem}\n구현 역할에서 필수 runner를 수정한 뒤 다시 검증하세요.`,
          ),
        );
    }
    if (isVerifierRole(node.type)) {
      const problem = await deliverableProblem(this.state);
      if (problem) return completed(this.verificationFailure(node, problem));
    }
    // Audit roles under the source guard are compared with the test role's snapshot.
    const watchReadOnly =
      isReadOnly(node.type) && !(sourceGuard && isAuditRole(node.type));
    if (!policy.automated || (node.type !== "test" && !watchReadOnly))
      return { step: "ready", sourceInputs: null };
    try {
      return {
        step: "ready",
        sourceInputs:
          sourceGuard || watchReadOnly
            ? await testSources(this.state.targetProjectPath)
            : await productionHashes(this.state.targetProjectPath),
      };
    } catch (error) {
      return this.halt(
        visit,
        "WAITING_USER",
        `검증 전 소스 읽기가 차단됐습니다. 경로·권한을 확인하세요: ${messageOf(error)}`,
        { pauseVisit: true, clearRecovery: false },
      );
    }
  }
  private stage(
    node: AgentNode,
    visit: NodeVisit,
    sourceInputs: Record<string, string> | null,
  ): Stage {
    const s = this.state.settings,
      binding = this.state.bindings[node.id]!,
      connection = this.state.connections.find(
        (c) => c.id === binding.connectionId,
      )!,
      policy = runPolicy(this.state.graph, connection);
    return {
      node,
      visit,
      binding,
      connection,
      policy,
      sourceInputs,
      deadline: Math.min(
        Date.parse(visit.cycleDeadlineAt),
        policy.reserveFinalizationBudget && visit.stageDeadlineAt
          ? Date.parse(visit.stageDeadlineAt)
          : Infinity,
      ),
      normalLimit: node.type === "interrupt" ? 1 : s.maxAgentAttempts,
      completionLimit: ["planning", "interrupt"].includes(node.type)
        ? 0
        : s.maxCompletionRecoveryAttempts,
    };
  }
  /** Controls, contract and budgets checked before every CLI call; true once stopped. */
  private async attemptGuards({ node, visit }: Stage): Promise<boolean> {
    if (await this.poll()) return true;
    if (await this.contractStop()) return true;
    const budget = sessionBudgetReason(this.state, true);
    if (budget) {
      await this.budgetStop(budget);
      return true;
    }
    const stageReason = stageBudgetReason(this.state, node, visit, true);
    if (stageReason) {
      await this.stageStop(stageReason, visit);
      return true;
    }
    return false;
  }
  private sessionDeadline(): number {
    return this.state.executionBudget
      ? Date.parse(this.state.executionBudget.deadlineAt)
      : Infinity;
  }
  private scopeRoots(): string[] {
    return [this.state.targetProjectPath, ...this.state.additionalAllowedPaths];
  }
  private invocationOptions(
    { node, visit, connection, policy, deadline }: Stage,
    id: string,
    recoveryMessage: string | undefined,
    nextResume: string | undefined,
  ): InvocationOptions {
    const contract = this.state.verificationContract;
    return {
      prompt: buildNodePrompt(this.state, node, visit, recoveryMessage),
      cwd: this.state.targetProjectPath,
      fullAccess: this.state.accessMode === "full_access",
      allowedPaths: this.state.additionalAllowedPaths,
      nativeApprovalReview: policy.nativeApprovalReview,
      localHttpAccess: policy.localHttpAccess,
      testSourcesReadOnly: policy.testSourceGuard && node.type === "test",
      guardOwnedProcesses: policy.guardOwnedProcesses,
      ...(policy.kiloScopeGuard ? { scopeRoots: this.scopeRoots() } : {}),
      ...(policy.kiloProgramIo
        ? {
            programIoGuard: {
              directory: path.join(
                this.store.visitDir(this.state.id, visit.id),
                `${id}-io`,
              ),
              providerHome: path.join(
                this.store.sessionDir(this.state.id),
                "provider-home",
              ),
              protectedFiles: [
                ".agent-graph/verification.json",
                ...(contract?.manifest?.protectedFiles ?? []),
              ],
              expiresAt: Math.min(deadline, this.sessionDeadline()),
            },
          }
        : {}),
      ...(contract?.manifest?.nodeTests
        ? {
            verificationAliases: {
              [nodeTestScript(contract.manifest.nodeTests)]:
                contract.manifest.checks.find(
                  (c) => c.id === contract.manifest!.nodeTests!.suiteCheckId,
                )!.command,
            },
          }
        : {}),
      ...(policy.verificationContract && contract?.status === "locked"
        ? {
            verificationCommands: contract.manifest!.checks.map(
              (c) => c.command,
            ),
          }
        : {}),
      // A repeated write-schema failure on this CLI selects the bounded Kilo fallback.
      disableWrite: this.state.visits.some(
        (v) =>
          this.state.bindings[v.nodeId]?.connectionId === connection.id &&
          v.attempts.some(
            (a) =>
              a.failureKind === "tool_arguments" &&
              /for the "write" tool/.test(a.message ?? ""),
          ),
      ),
      ...(nextResume ? { resumeId: nextResume } : {}),
    };
  }
  private newAttempt(
    { node, visit, binding, deadline }: Stage,
    id: string,
    completionRecovery: boolean,
    nextResume: string | undefined,
  ): AttemptRecord {
    return {
      id,
      number: visit.attempts.length + 1,
      status: "running",
      startedAt: new Date().toISOString(),
      endedAt: null,
      pid: null,
      cliSessionId: null,
      reconnectUsed: Boolean(nextResume),
      mode: completionRecovery ? "completion_recovery" : "standard",
      failureKind: null,
      message: null,
      logPath: path.join(
        this.store.visitDir(this.state.id, visit.id),
        `${id}.log`,
      ),
      lastProgressAt: null,
      activity: "initial_transport",
      deadlineAt: new Date(
        Math.min(
          Date.now() + this.state.settings.phaseTimeoutMs,
          deadline,
          this.sessionDeadline(),
        ),
      ).toISOString(),
      requestedModelId: binding.modelId,
      actualModelId: null,
      pricing: this.pricing.get(node.id) ?? modelPricing(),
      assistantTextBytes: 0,
      maxTokens: 0,
    };
  }
  /** Run the CLI under the supervisor; guard callbacks report into the returned run. */
  private async supervise(
    { node, visit, policy, sourceInputs, deadline }: Stage,
    attempt: AttemptRecord,
    invocation: Invocation,
  ): Promise<AttemptRun> {
    const s = this.state.settings,
      sourceGuard = policy.testSourceGuard;
    const run: Omit<AttemptRun, "result"> = {
      attempt,
      policyReason: null,
      sourceChanges: [],
      captures: [],
    };
    let progressWrites = Promise.resolve(),
      lastPersist = 0;
    const registered =
      this.state.verificationContract?.manifest?.checks.map((c) => c.command) ??
      [];
    if (sourceGuard && node.type === "test")
      run.captures = await prepareVerificationCaptures(
        this.state.targetProjectPath,
        registered,
      );
    const result = await new ProcessSupervisor().run({
      ...invocation,
      cwd: this.state.targetProjectPath,
      cols: process.platform === "win32" ? 2000 : 100000,
      rows: 40,
      useConpty: process.platform === "win32",
      transportTimeoutMs: s.transportTimeoutMs,
      idleTimeoutMs: s.idleTimeoutMs,
      toolTimeoutMs: s.toolTimeoutMs,
      phaseTimeoutMs: Math.min(
        s.phaseTimeoutMs,
        Math.max(1, deadline - Date.now()),
      ),
      absoluteDeadlineAtMs: Math.min(deadline, this.sessionDeadline()),
      terminationGraceMs: s.terminationGraceMs,
      killTimeoutMs: s.killTimeoutMs,
      maxInMemoryOutputBytes: s.maxInMemoryOutputBytes,
      rawLogPath: attempt.logPath,
      interactionWhitelist: [],
      destructivePrompts: [
        "Delete",
        "Destroy",
        "git reset --hard",
        "Drop database",
      ],
      sensitiveValues: Object.entries(process.env)
        .filter(
          ([key, value]) =>
            /key|token|secret|password/i.test(key) &&
            value &&
            value.length >= 4,
        )
        .map(([, value]) => value!)
        .concat(
          invocation.programIoPolicy
            ? [invocation.programIoPolicy.privateKey]
            : [],
        ),
      pollControl: () => claimNextControlRequest(this.controls()),
      ...(policy.kiloScopeGuard ? { scopeRoots: this.scopeRoots() } : {}),
      ...(policy.guardOwnedProcesses
        ? {
            eventPolicy: (event: Record<string, unknown>) => {
              run.policyReason = unscopedTerminationEvent(event);
              return run.policyReason;
            },
          }
        : {}),
      // Spread last: the frozen test role's policy also covers process ownership.
      ...(sourceGuard && node.type === "test" && sourceInputs
        ? {
            sourcesGuarded: true,
            pollPolicy: async () => {
              try {
                run.sourceChanges = sourceDifference(
                  sourceInputs,
                  await testSources(this.state.targetProjectPath),
                );
              } catch (error) {
                run.sourceChanges = [
                  `소스 snapshot 읽기 실패: ${messageOf(error)}`,
                ];
              }
              if (run.sourceChanges.length)
                run.policyReason = `${TEST_POLICY} 테스트 역할의 소스 변경을 즉시 중단했습니다: ${run.sourceChanges.join(", ")}. 구현 역할에서 수정한 뒤 모든 등록 검사를 새로 실행해야 합니다.`;
              return run.policyReason;
            },
            eventPolicy: (
              event: Record<string, unknown>,
              evidence: SupervisorResult["evidence"],
            ) => {
              run.policyReason ??=
                unscopedTerminationEvent(event) ?? testPolicyEvent(event);
              const failed = failedRegisteredCheck(
                evidence.commands,
                this.state.targetProjectPath,
                registered,
              );
              if (!run.policyReason && failed) {
                const part = event.part as
                    | { state?: { output?: unknown; error?: unknown } }
                    | undefined,
                  item = event.item as
                    { aggregated_output?: unknown } | undefined;
                const output =
                  part?.state?.output ??
                  part?.state?.error ??
                  item?.aggregated_output;
                const text = typeof output === "string" ? output : "";
                run.policyReason = `${TEST_FAILED} 등록 검사 실패: ${failed.command} (exit ${failed.exitCode ?? "unknown"}). 테스트 역할은 제품이나 테스트를 수정하지 않습니다. 구현에서 원인을 고친 뒤 전체 검사를 다시 실행하세요.\n${text.length > 6000 ? text.slice(0, 2000) + "\n...\n" + text.slice(-4000) : text}`;
              }
              return run.policyReason;
            },
          }
        : {}),
      onOutput: (text) => this.hooks.onLog?.(visit.id, attempt.id, text),
      onProgress: (progress) => {
        const activityChanged = attempt.activity !== progress.activity;
        const spendChanged =
          attempt.assistantTextBytes !== progress.assistantTextBytes ||
          attempt.maxTokens !== progress.maxTokens;
        attempt.pid = progress.childPid;
        attempt.cliSessionId = progress.cliSessionId;
        this.activePid = progress.childPid;
        this.owner.setChildPid(progress.childPid);
        attempt.lastProgressAt = progress.lastProgressAt;
        attempt.activity = progress.activity;
        attempt.deadlineAt = progress.deadlineAt;
        attempt.assistantTextBytes = progress.assistantTextBytes;
        attempt.maxTokens = progress.maxTokens;
        if (Date.now() - lastPersist > 250 || activityChanged || spendChanged) {
          lastPersist = Date.now();
          progressWrites = progressWrites.then(() => this.save());
        }
      },
    });
    await progressWrites;
    return Object.assign(run, { result });
  }
  /** Copy the supervisor's evidence onto the attempt and the visit's receipts. */
  private async recordOutcome(
    { node, visit, policy }: Stage,
    { attempt, result, captures }: AttemptRun,
  ): Promise<void> {
    const orphaned = result.outcome === "orphaned_process";
    if (!orphaned)
      await addCapturedEnvironmentDiagnostics(
        result.evidence.commands,
        captures,
        path.join(
          this.store.visitDir(this.state.id, visit.id),
          `${attempt.id}-captures`,
        ),
      );
    this.activePid = orphaned ? result.pid : null;
    this.owner.setChildPid(this.activePid);
    attempt.status = result.outcome;
    attempt.endedAt = result.endedAt;
    attempt.pid = this.activePid;
    attempt.cliSessionId = result.cliSessionId;
    attempt.actualModelId = result.evidence.actualModelId;
    attempt.commands = result.evidence.commands;
    attempt.readFiles = result.evidence.readFiles;
    attempt.scopeAudit = result.evidence.scopeAudit;
    attempt.programIoAudit = result.evidence.programIoAudit;
    attempt.fileMutation = result.evidence.fileMutation;
    if (
      result.evidence.fileMutation &&
      !(policy.testSourceGuard && node.type === "test")
    ) {
      visit.verifiedCommands = [];
      delete visit.nodeTestProof;
    }
    if (isVerifierRole(node.type))
      visit.verifiedCommands = mergeProjectReceipts(
        this.state.targetProjectPath,
        visit.verifiedCommands,
        result.evidence.commands,
      );
    attempt.assistantTextBytes = result.evidence.assistantTextBytes;
    attempt.maxTokens = result.evidence.maxTokens;
  }
  /**
   * Evidence checks between the CLI exit and completion parsing. `undefined`
   * continues; null means the session stopped; a Completion ends the stage.
   */
  async sourceChanges(expected: Record<string, string>): Promise<string[]> {
    try {
      return sourceDifference(
        expected,
        await testSources(this.state.targetProjectPath),
      );
    } catch (error) {
      return [`소스 snapshot 읽기 실패: ${messageOf(error)}`];
    }
  }
}
