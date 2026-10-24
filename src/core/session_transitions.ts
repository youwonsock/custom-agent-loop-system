import {
  AgentNode,
  NodeVisit,
  SessionAction,
  SessionState,
} from "../shared/domain";
import { AppError } from "./errors";
import { transition } from "./graph";
import { advanceConvergence } from "./requirement_ledger";

/** Pure domain transitions. Callers own locks, process lifecycle and persistence. */
export function applyApproval(
  s: SessionState,
  action: SessionAction,
  now = new Date().toISOString(),
): void {
  if (s.processedRequests.includes(action.requestId)) return;
  if (s.status === "RUNNING" || s.status === "RECOVERING")
    throw new AppError(
      409,
      "실행 중인 세션의 계획과 설정을 변경할 수 없습니다.",
    );
  if (["select_plan", "edit_plan", "approve_plan"].includes(action.type)) {
    const pending = s.pendingApproval;
    if (
      !pending ||
      pending.nodeId !== action.nodeId ||
      pending.visitId !== action.visitId
    )
      throw new AppError(
        409,
        "현재 승인 대기 중인 방문과 일치하지 않습니다.",
        "stale_approval",
      );
    const visit = s.visits.find((v) => v.id === pending.visitId)!;
    const plan = visit.plans.find((p) => p.id === action.choiceId);
    if (!plan || plan.revision !== action.expectedRevision)
      throw new AppError(409, "계획 문서 버전이 변경되었습니다.", "stale_plan");
    if (action.type === "edit_plan") {
      if (
        typeof action.body !== "string" ||
        !action.body.trim() ||
        action.body.length > 512_000
      )
        throw new AppError(400, "계획 문서를 입력하세요.");
      plan.body = action.body;
      plan.revision++;
    }
    visit.selectedPlanId = plan.id;
    if (action.type === "approve_plan") {
      s.approvedPlanRef = {
        visitId: visit.id,
        choiceId: plan.id,
        revision: plan.revision,
      };
      visit.status = "succeeded";
      visit.completedAt = now;
      s.pendingApproval = null;
    }
  } else if (action.type === "approve_access") {
    if (
      !s.pendingAccess ||
      s.pendingAccess.nodeId !== action.nodeId ||
      s.pendingAccess.visitId !== action.visitId
    )
      throw new AppError(409, "현재 접근 요청과 일치하지 않습니다.");
    if (action.decision === "full_access") s.accessMode = "full_access";
    else if (action.decision === "allow_requested")
      s.additionalAllowedPaths.push(...s.pendingAccess.paths);
    else throw new AppError(400, "접근 승인 결정을 선택하세요.");
    s.pendingAccess = null;
  } else throw new AppError(400, "지원되지 않는 요청입니다.");
  s.processedRequests.push(action.requestId);
  s.processedRequests = s.processedRequests.slice(-500);
}

export function prepareManualResume(s: SessionState, now = Date.now()): void {
  if (s.currentNodeId === "PAUSED") {
    s.currentNodeId = s.graph.entrypoints.reentry;
    s.activeVisitId = null;
    s.convergence.stagnantCycles = 0;
  }
  if (s.visits.length >= s.visitLimit)
    s.visitLimit +=
      s.settings.maxIterations * Math.max(1, s.graph.nodes.length) * 2;
  if (s.completedIterations >= s.iterationLimit)
    s.iterationLimit += s.settings.maxIterations;
  const active = s.visits.find((v) => v.id === s.activeVisitId);
  if (active && ["paused", "running"].includes(active.status)) {
    active.status = "running";
    active.recoveryCount++;
    active.automaticCycles = 0;
    active.cycleStartedAt = new Date(now).toISOString();
    active.cycleDeadlineAt = new Date(
      now + s.settings.phaseRecoveryBudgetMs,
    ).toISOString();
  }
}

export function advanceVisit(
  s: SessionState,
  node: AgentNode,
  visit: NodeVisit,
): void {
  if (!visit.transitionCommitted) {
    if (node.id === s.graph.entrypoints.cycleCompletion) {
      s.completedIterations++;
      s.convergence = advanceConvergence(
        s.convergence,
        s.requirements,
        s.completedIterations,
      );
    }
    visit.transitionCommitted = true;
  }
  const failed = visit.status === "failed";
  if (
    s.graph.automation &&
    failed &&
    ["test", "review", "approval"].includes(node.type)
  ) {
    const failures = s.visits.filter(
      (v) =>
        v.status === "failed" &&
        v.transitionCommitted &&
        s.graph.nodes.some(
          (n) =>
            n.id === v.nodeId &&
            ["test", "review", "approval"].includes(n.type),
        ),
    ).length;
    s.currentNodeId =
      failures > s.graph.automation.maxRepairCycles
        ? "PAUSED"
        : s.graph.entrypoints.reentry;
    s.statusReason =
      failures > s.graph.automation.maxRepairCycles
        ? `자동 수정 ${s.graph.automation.maxRepairCycles}회 한도를 소진했습니다. 실패 근거를 보존하고 정지했습니다.`
        : `검증 실패를 구현에 전달해 자동 수정합니다 (${failures}/${s.graph.automation.maxRepairCycles}).`;
    s.activeVisitId = null;
    return;
  }
  s.currentNodeId =
    failed &&
    ["review", "approval"].includes(node.type) &&
    s.convergence.stagnantCycles >= 1
      ? s.graph.entrypoints.interrupt
      : transition(s.graph, node.id, failed ? "failure" : "success");
  s.activeVisitId = null;
}

export function stopSession(
  s: SessionState,
  reason = "사용자가 실행을 중지했습니다.",
): void {
  s.status = "STOPPED";
  s.statusReason = reason;
  s.automaticRecovery = null;
  const visit = s.visits.find((v) => v.id === s.activeVisitId);
  if (visit?.status === "running") visit.status = "paused";
}
export function interruptSession(
  s: SessionState,
  message?: string | null,
): void {
  const visit = s.visits.find((v) => v.id === s.activeVisitId);
  if (visit?.status === "running") visit.status = "paused";
  s.automaticRecovery = null;
  s.interruptMessage = message ?? "사용자가 중단 분석을 요청했습니다.";
  s.currentNodeId = s.graph.entrypoints.interrupt;
  s.activeVisitId = null;
}
export function beginResume(s: SessionState): void {
  if (s.status === "SUCCESS")
    throw new AppError(
      409,
      "완료된 세션은 재개할 수 없습니다. 새 세션을 만드세요.",
    );
  if (s.pendingApproval || s.pendingAccess)
    throw new AppError(409, "현재 계획 또는 접근 요청을 먼저 승인하세요.");
  s.status = "RUNNING";
  s.statusReason = "저장된 실행 설정으로 재개하고 있습니다.";
}
