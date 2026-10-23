import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { AgentNode, AttemptRecord, ModelPricing, NodeVisit, SessionState } from "../shared/domain";
import { StudioStore } from "./store";
import {
  SessionOwnership,
  checkProcessLiveness,
  collectRecoveredChildPids,
  claimNextControlRequest,
  completeControlRequest,
  ensureControlQueue,
  getControlQueuePaths,
  recoverClaimedControlRequests,
  delay,
  AttemptFailure,
  ClaimedControlRequest,
} from "./resilience";
import {
  ProcessSupervisor,
  SupervisorResult,
  terminateProcessTreeBounded,
} from "./process_supervisor";
import { AgentAttemptRunner } from "./agent_attempt_runner";
import { queryModels } from "./catalog";
import { buildInvocation, isReadOnly } from "./invocation";
import { buildNodePrompt, buildRecoveryMessage } from "./prompt";
import { transition } from "./graph";
import {
  parseRequirementEvidence,
  retainRequirementEvidence,
  advanceConvergence,
} from "./requirement_ledger";
import { validateCompletion, Completion } from "./completion";
import { messageOf } from "./errors";
import { outsidePaths } from "./access_paths";
import { currentTestProof, mergeReceipts } from "./verification_evidence";
import { modelPricing } from "./model_pricing";
import { successBlockers } from "./success_gate";

export interface RuntimeHooks {
  onState?: (state: SessionState) => void;
  onLog?: (visitId: string, attemptId: string, text: string) => void;
}
export function classifyFailure(
  result: SupervisorResult,
  completion: Pick<Completion, "reason" | "failureKind">,
): AttemptFailure {
  const preserved =
    result.failureKind &&
    !["process_exit", "incomplete_response"].includes(result.failureKind);
  const diagnostic =
    result.diagnostics.terminalError ??
    (result.exitCode !== 0 || result.timedOut ? result.diagnostics.plainError : null);
  const kind =
    result.outcome === "orphaned_process"
      ? "orphaned_process"
      : result.cancelled
        ? "cancelled"
        : preserved
          ? result.failureKind!
          : result.timedOut
            ? "phase_timeout"
            : diagnostic
              ? diagnostic.kind
              : result.exitCode !== 0 || result.outcome !== "succeeded"
                ? "process_exit"
                : (completion.failureKind ?? "incomplete_response");
  const detail =
    !preserved && diagnostic
      ? diagnostic.message
      : (completion.reason ?? result.failureMessage);
  let message =
    kind === "auth"
      ? `CLI 인증이 필요합니다. 해당 CLI에서 로그인한 뒤 재개하세요.${diagnostic ? ` (${diagnostic.message})` : ""}`
      : kind === "model_unavailable"
        ? `CLI에서 선택한 모델을 실행할 수 없습니다. 모델 권한과 설정을 확인하세요.${diagnostic ? ` (${diagnostic.message})` : ""}`
        : (detail ?? `CLI 실패 (${result.exitCode})`);
  if (preserved && result.timedOut && diagnostic && diagnostic.kind !== "process_exit")
    message += `\nLast observed CLI error: ${diagnostic.message}`;
  return {
    kind,
    message,
    retryable: ![
      "auth",
      "model_unavailable",
      "permission",
      "role_violation",
      "orphaned_process",
      "cancelled",
    ].includes(kind) && !["auth", "permission", "model_unavailable"].includes(diagnostic?.kind ?? ""),
    occurredAt: new Date().toISOString(),
    attemptId: null,
    role: null,
    phase: null,
    exitCode: result.exitCode,
    cliSessionId: result.cliSessionId,
  };
}
export { outsidePaths } from "./access_paths";
export class GraphRuntime {
  private state!: SessionState;
  private owner!: SessionOwnership;
  private abort = new AbortController();
  private stopRequested = false;
  private activePid: number | null = null;
  private readonly pricing = new Map<string, ModelPricing>();
  constructor(
    private readonly store: StudioStore,
    private readonly sessionId: string,
    private readonly hooks: RuntimeHooks = {},
  ) {}
  cancelPreflight(): void {
    this.abort.abort(new Error("세션 제어 요청"));
  }
  private async save(): Promise<void> {
    await this.store.writeSession(this.state);
    this.hooks.onState?.(structuredClone(this.state));
  }
  private controls() {
    return getControlQueuePaths(this.store.sessionDir(this.sessionId));
  }
  private async finishControl(request: ClaimedControlRequest): Promise<void> {
    if (request.request.type === "STOP") {
      this.state.status = "STOPPED";
      this.state.statusReason = "사용자가 실행을 중지했습니다.";
      this.state.automaticRecovery = null;
      const visit = this.state.visits.find(
        (v) => v.id === this.state.activeVisitId,
      );
      if (visit && visit.status === "running") visit.status = "paused";
      this.stopRequested = true;
    } else {
      const visit = this.state.visits.find(
        (v) => v.id === this.state.activeVisitId,
      );
      if (visit && visit.status === "running") visit.status = "paused";
      this.state.interruptMessage =
        request.request.message ?? "사용자가 중단 분석을 요청했습니다.";
      this.state.currentNodeId = this.state.graph.entrypoints.interrupt;
      this.state.activeVisitId = null;
    }
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
    if (!request) return false;
    await this.finishControl(request);
    return true;
  }
  async run(mode: "start" | "manual" | "automatic" = "start"): Promise<void> {
    this.state = await this.store.readSession(this.sessionId);
    const automaticRecoveryVisitId = mode === "automatic" && this.state.automaticRecovery
      ? this.state.activeVisitId : null;
    const settings = this.state.settings;
    this.owner = new SessionOwnership({
      sessionDir: this.store.sessionDir(this.sessionId),
      ownerLockFileName: "owner.lock",
      leaseFileName: "lease.json",
      heartbeatIntervalMs: settings.heartbeatIntervalMs,
      leaseTtlMs: settings.leaseTtlMs,
    });
    const acquired = await this.owner.acquire();
    try {
      await ensureControlQueue(this.controls());
      await recoverClaimedControlRequests(this.controls());
      if (acquired.recoveredStaleOwner) {
        const activeAttempt = this.state.visits
          .find((v) => v.id === this.state.activeVisitId)
          ?.attempts.at(-1);
        for (const pid of collectRecoveredChildPids(
          acquired.previousLease,
          activeAttempt?.pid,
        )) {
          if (
            checkProcessLiveness(pid) !== "dead" &&
            (await terminateProcessTreeBounded(pid, settings.killTimeoutMs)) !==
              "dead"
          ) {
            this.state.status = "BLOCKED";
            this.state.statusReason =
              "이전 자식 프로세스 종료를 확인할 수 없습니다.";
            await this.save();
            return;
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
      }
      if (mode === "manual") {
        if (this.state.currentNodeId === "PAUSED") {
          this.state.currentNodeId = this.state.graph.entrypoints.reentry;
          this.state.activeVisitId = null;
          this.state.convergence.stagnantCycles = 0;
        }
        if (this.state.visits.length >= this.state.visitLimit)
          this.state.visitLimit +=
            settings.maxIterations *
            Math.max(1, this.state.graph.nodes.length) *
            2;
        if (this.state.completedIterations >= this.state.iterationLimit)
          this.state.iterationLimit += settings.maxIterations;
        const active = this.state.visits.find(
          (v) => v.id === this.state.activeVisitId,
        );
        if (active && ["paused", "running"].includes(active.status)) {
          active.status = "running";
          active.recoveryCount++;
          active.automaticCycles = 0;
          active.cycleStartedAt = new Date().toISOString();
          active.cycleDeadlineAt = new Date(
            Date.now() + settings.phaseRecoveryBudgetMs,
          ).toISOString();
        }
      }
      this.state.status = "RUNNING";
      this.state.statusReason = "실행 연결과 모델 목록을 확인하고 있습니다.";
      this.state.automaticRecovery = null;
      await this.save();
      if ((await this.poll()) && this.stopRequested) return;
      // Only bindings referenced by this immutable run are queried; no CLI scan.
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
            if (this.stopRequested) return;
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
            this.state.status = "WAITING_USER";
            this.state.statusReason = `[${this.state.graph.nodes.find((n) => n.id === this.state.currentNodeId)?.name ?? "모델 조회"} · ${connection.label}] ${catalog.error ?? "선택한 모델 또는 추론 강도를 조회할 수 없습니다. CLI의 모델 권한과 설정을 확인하고 재개하세요."}`;
            await this.save();
            return;
          }
          for (const [nodeId, binding] of Object.entries(this.state.bindings)) {
            if (binding.connectionId !== connection.id) continue;
            const model = catalog.models.find(m => m.id === binding.modelId)!;
            this.pricing.set(nodeId, model.pricing ?? modelPricing());
          }
          break;
        }
      }
      this.abort = new AbortController();
      if (automaticRecoveryVisitId && this.state.activeVisitId === automaticRecoveryVisitId) {
        if (this.pricing.get(this.state.currentNodeId ?? "")?.status !== "free") {
          this.state.status = "PAUSED";
          this.state.statusReason = "자동 복구 전에 무료 모델임을 다시 확인하지 못했습니다. 추가 모델 호출 없이 정지했습니다.";
          await this.save();
          return;
        }
        const visit = this.state.visits.find(v => v.id === automaticRecoveryVisitId)!;
        // Scheduler latency and metadata lookup must not consume the next attempt's budget.
        visit.cycleStartedAt = new Date().toISOString();
        visit.cycleDeadlineAt = new Date(Date.now() + settings.phaseRecoveryBudgetMs).toISOString();
      }
      this.state.statusReason = null;
      await this.save();
      while (this.state.status === "RUNNING" && !this.stopRequested) {
        if (await this.poll()) {
          if (this.stopRequested) return;
        }
        const id = this.state.currentNodeId;
        if (id === "SUCCESS" || id === "PAUSED") {
          const blockers = id === "SUCCESS" ? successBlockers(this.state) : [];
          this.state.status = blockers.length ? "PAUSED" : id;
          this.state.statusReason =
            blockers.length
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
          await this.save();
          return;
        }
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
        if (!visit) {
          if (
            this.state.visits.length >= this.state.visitLimit ||
            (this.state.completedIterations >= this.state.iterationLimit &&
              node.id === this.state.graph.entrypoints.reentry)
          ) {
            this.state.status = "PAUSED";
            this.state.statusReason =
              "노드 방문 또는 반복 실행 예산을 소진했습니다. 그래프와 미해결 요구사항을 검토한 뒤 수동 재개하세요.";
            await this.save();
            return;
          }
          const now = new Date().toISOString();
          visit = {
            id: randomUUID(),
            nodeId: node.id,
            number:
              this.state.visits.filter((v) => v.nodeId === node.id).length + 1,
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
              Date.now() + settings.phaseRecoveryBudgetMs,
            ).toISOString(),
            recoveryCount: 0,
            transitionCommitted: false,
            automaticCycles: 0,
          };
          this.state.visits.push(visit);
          this.state.activeVisitId = visit.id;
          await this.save();
        }
        if (visit.status === "waiting_approval") {
          this.state.status = "WAITING_USER";
          this.state.statusReason = "이 방문의 계획 선택과 승인이 필요합니다.";
          await this.save();
          return;
        }
        if (visit.status === "paused") visit.status = "running";
        if (!isReadOnly(node.type) && this.state.accessMode === "ask") {
          const ref = this.state.approvedPlanRef;
          const approved = ref
            ? (this.state.visits
                .find((v) => v.id === ref.visitId)
                ?.plans.find((p) => p.id === ref.choiceId)?.body ?? "")
            : "";
          const extra = outsidePaths(
            `${this.state.goal}\n${approved}\n${node.instructions}`,
            [
              this.state.targetProjectPath,
              ...this.state.additionalAllowedPaths,
            ],
          );
          if (extra.length) {
            this.state.pendingAccess = {
              paths: extra,
              nodeId: node.id,
              visitId: visit.id,
            };
            this.state.status = "WAITING_USER";
            this.state.statusReason =
              "프로젝트 밖의 경로에 대한 접근 승인이 필요합니다.";
            await this.save();
            return;
          }
        }
        const completion = await this.execute(node, visit);
        if (this.state.status !== "RUNNING") return;
        if (this.state.activeVisitId !== visit.id) continue; // interrupt control changed traversal
        if (!completion) continue;
        visit.output = completion.output + (completion.reason ? `\n\n[ORCHESTRATOR] ${completion.reason}` : "");
        visit.verdict = completion.verdict;
        if (completion.researchBlocked) {
          visit.status = "paused";
          this.state.status = "WAITING_USER";
          this.state.statusReason =
            "필요한 인터넷 조사 기능을 CLI에서 설정한 뒤 재개하세요.";
          await this.save();
          return;
        }
        if (node.type === "planning") {
          visit.plans = completion.plans;
          await this.store.savePlans(this.state.id, visit.id, visit.plans);
          if (node.planning?.requiresApproval !== false) {
            visit.status = "waiting_approval";
            this.state.pendingApproval = { nodeId: node.id, visitId: visit.id };
            this.state.status = "WAITING_USER";
            this.state.statusReason = "생성한 계획을 검토하고 선택·승인하세요.";
            await this.save();
            return;
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
      }
    } catch (error) {
      this.state.status =
        this.activePid && checkProcessLiveness(this.activePid) !== "dead"
          ? "BLOCKED"
          : "FAILED";
      this.state.statusReason = messageOf(error);
      await this.save();
    } finally {
      this.abort.abort();
      await this.owner.release();
    }
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
    if (!visit.transitionCommitted) {
      if (node.id === this.state.graph.entrypoints.cycleCompletion) {
        this.state.completedIterations++;
        this.state.convergence = advanceConvergence(
          this.state.convergence,
          this.state.requirements,
          this.state.completedIterations,
        );
      }
      visit.transitionCommitted = true;
    }
    const failed = visit.status === "failed";
    this.state.currentNodeId =
      failed &&
      ["review", "approval"].includes(node.type) &&
      this.state.convergence.stagnantCycles >= 1
        ? this.state.graph.entrypoints.interrupt
        : transition(this.state.graph, node.id, failed ? "failure" : "success");
    this.state.activeVisitId = null;
    await this.save();
  }
  private async execute(
    node: AgentNode,
    visit: NodeVisit,
  ): Promise<Completion | null> {
    const s = this.state.settings,
      binding = this.state.bindings[node.id]!,
      connection = this.state.connections.find(
        (c) => c.id === binding.connectionId,
      )!;
    const contextMessage = (message: string) =>
      `[${node.name} · ${connection.label}] ${message}`;
    const deadline = Date.parse(visit.cycleDeadlineAt),
      cycleAttempts = () =>
        visit.attempts.filter(
          (a) => Date.parse(a.startedAt) >= Date.parse(visit.cycleStartedAt),
        );
    const normalLimit = node.type === "interrupt" ? 1 : s.maxAgentAttempts;
    const completionLimit = ["planning", "interrupt"].includes(node.type)
      ? 0
      : s.maxCompletionRecoveryAttempts;
    const runner = new AgentAttemptRunner({
      maxAttempts: normalLimit,
      retryBackoffMs: s.retryBackoffMs,
    });
    let reconnectUsed = cycleAttempts().some((a) => a.reconnectUsed),
      nextResume: string | undefined;
    let recoveryMessage: string | undefined;
    for (;;) {
      if (await this.poll()) {
        return null;
      }
      const normal = cycleAttempts().filter(
        (a) => a.mode === "standard",
      ).length;
      const extra = cycleAttempts().filter(
        (a) => a.mode === "completion_recovery",
      ).length;
      const completionRecovery = normal >= normalLimit;
      if (
        Date.now() >= deadline ||
        (completionRecovery && extra >= completionLimit)
      ) {
        await this.exhausted(
          node,
          visit,
          "단계 복구 예산 또는 attempt 한도를 소진했습니다.",
        );
        return null;
      }
      const invocation = await buildInvocation(connection, binding, node, {
        prompt: buildNodePrompt(this.state, node, visit, recoveryMessage),
        cwd: this.state.targetProjectPath,
        fullAccess: this.state.accessMode === "full_access",
        allowedPaths: this.state.additionalAllowedPaths,
        ...(nextResume ? { resumeId: nextResume } : {}),
      });
      const id = randomUUID(),
        logPath = path.join(
          this.store.visitDir(this.state.id, visit.id),
          `${id}.log`,
        );
      const attempt: AttemptRecord = {
        id,
        number: visit.attempts.length + 1,
        status: "running",
        startedAt: new Date().toISOString(),
        endedAt: null as string | null,
        pid: null as number | null,
        cliSessionId: null as string | null,
        reconnectUsed: Boolean(nextResume),
        mode: completionRecovery
          ? ("completion_recovery" as const)
          : ("standard" as const),
        failureKind: null as string | null,
        message: null as string | null,
        logPath,
        lastProgressAt: null as string | null,
        activity: "initial_transport",
        deadlineAt: new Date(
          Math.min(Date.now() + s.phaseTimeoutMs, deadline),
        ).toISOString(),
        requestedModelId: binding.modelId,
        actualModelId: null as string | null,
        pricing: this.pricing.get(node.id) ?? modelPricing(),
        assistantTextBytes: 0,
        maxTokens: 0,
      };
      visit.attempts.push(attempt);
      await this.save();
      let progressWrites = Promise.resolve(),
        lastPersist = 0;
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
        absoluteDeadlineAtMs: deadline,
        terminationGraceMs: s.terminationGraceMs,
        killTimeoutMs: s.killTimeoutMs,
        maxInMemoryOutputBytes: s.maxInMemoryOutputBytes,
        rawLogPath: logPath,
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
          .map(([, value]) => value!),
        pollControl: () => claimNextControlRequest(this.controls()),
        onOutput: (text) => this.hooks.onLog?.(visit.id, id, text),
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
          if (
            Date.now() - lastPersist > 250 ||
            activityChanged ||
            spendChanged
          ) {
            lastPersist = Date.now();
            progressWrites = progressWrites.then(() => this.save());
          }
        },
      });
      await progressWrites;
      const orphaned = result.outcome === "orphaned_process";
      this.activePid = orphaned ? result.pid : null;
      this.owner.setChildPid(this.activePid);
      attempt.status = result.outcome;
      attempt.endedAt = result.endedAt;
      attempt.pid = this.activePid;
      attempt.cliSessionId = result.cliSessionId;
      attempt.actualModelId = result.evidence.actualModelId;
      attempt.commands = result.evidence.commands;
      attempt.fileMutation = result.evidence.fileMutation;
      if (result.evidence.fileMutation) visit.verifiedCommands = [];
      if (node.type === "test") visit.verifiedCommands = mergeReceipts(visit.verifiedCommands, result.evidence.commands);
      attempt.assistantTextBytes = result.evidence.assistantTextBytes;
      attempt.maxTokens = result.evidence.maxTokens;
      if (orphaned) {
        attempt.failureKind = "orphaned_process";
        attempt.message = contextMessage(
          result.failureMessage ?? "CLI 프로세스 종료를 확인할 수 없습니다.",
        );
        this.state.status = "BLOCKED";
        this.state.statusReason = attempt.message;
        visit.status = "paused";
        await this.save();
        if (result.controlRequest)
          await completeControlRequest(
            this.controls(),
            result.controlRequest,
            "failed",
            "자식 프로세스 종료를 확인하지 못해 실행을 차단했습니다.",
          );
        return null;
      }
      if (result.controlRequest) {
        await this.finishControl(result.controlRequest);
        return null;
      }
      const completion = validateCompletion(
        node,
        result,
        this.state.goal,
        this.state.requirements.items,
        visit.verifiedCommands ?? result.evidence.commands,
        currentTestProof(this.state, visit),
      );
      if (completion.environmentBlocked) {
        visit.output = completion.output;
        visit.verdict = "BLOCKED";
        visit.status = "paused";
        this.state.status = "WAITING_USER";
        this.state.statusReason = completion.environmentBlocked;
        attempt.message = completion.environmentBlocked;
        await this.save();
        return null;
      }
      if (completion.valid) {
        attempt.completionAccepted = !completion.researchBlocked;
        await this.save();
        return completion;
      }
      const failure = classifyFailure(result, completion);
      failure.message = contextMessage(failure.message);
      failure.attemptId = id;
      failure.role = node.roleName;
      failure.phase = node.type;
      attempt.status = failure.kind;
      attempt.failureKind = failure.kind;
      attempt.message = failure.message;
      visit.output = completion.output;
      await this.save();
      if (failure.kind === "orphaned_process") {
        this.state.status = "BLOCKED";
        this.state.statusReason = failure.message;
        await this.save();
        return null;
      }
      if (!failure.retryable) {
        this.state.status = "WAITING_USER";
        this.state.statusReason = failure.message;
        visit.status = "paused";
        await this.save();
        return null;
      }
      const providerFailure = result.diagnostics.terminalError ?? result.diagnostics.plainError;
      if (
        (failure.kind === "quota_exhausted" || providerFailure?.kind === "quota_exhausted") &&
        attempt.pricing?.status !== "free"
      ) {
        visit.status = "paused";
        this.state.status = "PAUSED";
        this.state.statusReason = `${failure.message} ${attempt.pricing?.status === "paid" ? "유료" : "가격 미확인"} 모델의 공급자 사용 한도에 도달해 추가 호출 없이 정지했습니다.`;
        await this.save();
        return null;
      }
      recoveryMessage = buildRecoveryMessage(failure.kind, failure.message, result.assistantText, result.events);
      const decision = runner.decideRetry({
        failure,
        attemptNumber: normal + 1,
        budgetRemainingMs: deadline - Date.now(),
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
          if (await this.poll()) return null;
          await delay(Math.min(100, Math.max(1, retryAt - Date.now())));
        }
      } else if (
        !completionRecovery &&
        failure.kind === "incomplete_response" &&
        result.exitCode === 0 &&
        completionLimit > 0
      ) {
        nextResume = undefined;
      } else {
        await this.exhausted(node, visit, failure.message);
        return null;
      }
    }
  }
  private async exhausted(
    node: AgentNode,
    visit: NodeVisit,
    reason: string,
  ): Promise<void> {
    const s = this.state.settings,
      pricing = this.pricing.get(node.id) ?? modelPricing();
    if (
      pricing.status === "free" &&
      node.type !== "interrupt" &&
      visit.automaticCycles < s.maxAutomaticRecoveryCycles
    ) {
      const delayMs =
        s.automaticRecoveryBackoffMs[
          Math.min(
            visit.automaticCycles,
            s.automaticRecoveryBackoffMs.length - 1,
          )
        ]!;
      visit.automaticCycles++;
      visit.status = "paused";
      this.state.automaticRecovery = {
        count: visit.automaticCycles,
        resumeAt: new Date(Date.now() + delayMs).toISOString(),
      };
      visit.cycleStartedAt = new Date().toISOString();
      visit.cycleDeadlineAt = new Date(
        Date.now() + delayMs + s.phaseRecoveryBudgetMs,
      ).toISOString();
      this.state.status = "RECOVERING";
      this.state.statusReason = `${reason} 무료로 확인된 모델이므로 자동 복구 ${visit.automaticCycles}/${s.maxAutomaticRecoveryCycles}회를 예약했습니다. 재개 전에 무료 여부를 다시 확인합니다.`;
    } else {
      visit.status = "paused";
      this.state.status = "PAUSED";
      this.state.automaticRecovery = null;
      this.state.statusReason = `${reason} ${pricing.status === "free" ? "무료 모델의 자동 복구 한도 또는 중단 처리 제한에 도달했습니다." : `${pricing.status === "paid" ? "유료" : "가격 미확인"} 모델이므로 추가 자동 복구를 중지했습니다.`} 확인 후 수동 재개하세요.`;
    }
    await this.save();
  }
}
