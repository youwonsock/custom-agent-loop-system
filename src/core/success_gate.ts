import { SessionState } from "../shared/domain";
import { evaluateRequirementCoverage, latestRequirementStatuses } from "./requirement_ledger";
import { acceptedVisit, currentTestProof } from "./verification_evidence";
import { contractProofMissing } from "./verification_contract";
import { sessionBudgetReason } from "./session_budget";

/** Every path to SUCCESS, including recovered snapshots, passes this gate. */
export function successBlockers(state: SessionState): string[] {
  const blockers: string[] = [];
  const budget = sessionBudgetReason(state, false, state.status === "SUCCESS" ? Date.parse(state.updatedAt) : Date.now());
  if (budget) blockers.push(budget);
  const final = state.visits.at(-1);
  if (state.currentNodeId !== "SUCCESS") blockers.push("완료 종단에 도달하지 않았습니다.");
  if (state.pendingApproval || state.pendingAccess || state.activeVisitId)
    blockers.push("미완료 방문 또는 사용자 승인 요청이 남아 있습니다.");
  if (!final || state.graph.nodes.find(n => n.id === final.nodeId)?.type !== "approval" ||
      !acceptedVisit(final) || final.verdict !== "APPROVED" || !final.transitionCommitted ||
      !state.graph.edges.some(e => e.source === final.nodeId && e.outcome === "success" && e.target === "SUCCESS")) {
    blockers.push("최종 승인 역할의 정상 APPROVED와 성공 경로가 필요합니다.");
  }
  const requirements = state.requirements.items;
  const latest = latestRequirementStatuses(state.requirements);
  if (!requirements.length || !final || !evaluateRequirementCoverage(final.output, requirements).allSatisfied ||
      requirements.some(r => latest.get(r.id) !== "SATISFIED"))
    blockers.push("모든 필수 요구사항의 SATISFIED 증거가 필요합니다.");
  if (!final || !currentTestProof(state, final).length)
    blockers.push("현재 구현의 모든 필수 요구사항을 검사한 실제 테스트 PASS 기록이 필요합니다.");
  if (final) {
    const missing = contractProofMissing(state, currentTestProof(state, final));
    if (missing.length) blockers.push(`검증 계약의 성공 기록이 없습니다: ${missing.join(", ")}`);
  }
  return blockers;
}
