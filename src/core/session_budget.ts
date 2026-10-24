import { ExecutionSettings, SessionState, SessionBudget } from "../shared/domain";
export function createSessionBudget(settings: ExecutionSettings, now=Date.now()): SessionBudget {
  return { startedAt:new Date(now).toISOString(),deadlineAt:new Date(now+(settings.sessionTimeoutMs??3600000)).toISOString(),maxAttempts:settings.maxSessionAttempts??24,exhaustedReason:null };
}
export function sessionBudgetReason(state: SessionState, beforeCall=false, now=Date.now()): string|null {
  const b=state.executionBudget;
  if(!b)return null; // Historical v3 snapshots keep their original policy.
  if(b.exhaustedReason)return b.exhaustedReason;
  if(now>=Date.parse(b.deadlineAt))return "전체 실행 시간 예산을 소진했습니다. 자동 복구·수동 재개로 예산을 초기화하지 않습니다.";
  const calls=state.visits.reduce((n,v)=>n+v.attempts.length,0);
  if(calls>b.maxAttempts || (beforeCall&&calls>=b.maxAttempts))return `전체 네이티브 시도 ${b.maxAttempts}회 예산을 소진했습니다. 보고 보완과 무료 복구 호출도 포함합니다.`;
  return null;
}
export function pauseForBudget(state: SessionState, reason: string): void {
  if(state.executionBudget)state.executionBudget.exhaustedReason=reason;
  state.status="PAUSED";state.statusReason=reason;state.automaticRecovery=null;state.pendingApproval=null;state.pendingAccess=null;
  const v=state.visits.find(v=>v.id===state.activeVisitId);if(v && ["running","waiting_approval"].includes(v.status))v.status="paused";
}
