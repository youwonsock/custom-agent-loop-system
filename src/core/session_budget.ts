import {
  ExecutionSettings,
  SessionState,
  SessionBudget,
} from "../shared/domain";
export function createSessionBudget(
  settings: ExecutionSettings,
  now = Date.now(),
  maxCostUsd: number | null = null,
): SessionBudget {
  return {
    startedAt: new Date(now).toISOString(),
    deadlineAt: new Date(now + settings.sessionTimeoutMs).toISOString(),
    maxAttempts: settings.maxSessionAttempts,
    maxCostUsd,
    exhaustedReason: null,
  };
}
export function sessionBudgetReason(
  state: SessionState,
  beforeCall = false,
  now = Date.now(),
): string | null {
  const b = state.executionBudget;
  if (b.exhaustedReason) return b.exhaustedReason;
  if (now >= Date.parse(b.deadlineAt))
    return "전체 실행 시간 예산을 소진했습니다. 자동 복구·수동 재개로 예산을 초기화하지 않습니다.";
  const calls = state.visits.reduce((n, v) => n + v.attempts.length, 0);
  if (calls > b.maxAttempts || (beforeCall && calls >= b.maxAttempts))
    return `전체 네이티브 시도 ${b.maxAttempts}회 예산을 소진했습니다. 보고 보완과 무료 복구 호출도 포함합니다.`;
  return b.maxCostUsd === null ? null : costBudgetReason(state, b.maxCostUsd);
}
function costBudgetReason(state: SessionState, limit: number): string | null {
  const ended = state.visits
    .flatMap((v) => v.attempts)
    .filter((a) => a.endedAt);
  if (ended.some((a) => a.costUsd === undefined))
    return "CLI가 비용을 보고하지 않은 시도가 있어 금액 예산을 확인할 수 없습니다.";
  const spent = ended.reduce((sum, a) => sum + a.costUsd!, 0);
  return spent >= limit
    ? `금액 예산 $${limit}를 소진했습니다 (보고된 비용 $${spent.toFixed(4)}).`
    : null;
}
export function pauseForBudget(state: SessionState, reason: string): void {
  state.executionBudget.exhaustedReason = reason;
  state.status = "PAUSED";
  state.statusReason = reason;
  state.automaticRecovery = null;
  state.pendingApproval = null;
  state.pendingAccess = null;
  const v = state.visits.find((v) => v.id === state.activeVisitId);
  if (v && ["running", "waiting_approval"].includes(v.status))
    v.status = "paused";
}
