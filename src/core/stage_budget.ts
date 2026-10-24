import { AgentNode, NodeVisit, SessionState } from "../shared/domain";

/** Optional on new presets. Whole-session deadline is never extended. */
export function stageDeadline(state:SessionState,node:AgentNode,visit:NodeVisit):number|undefined{
  if(!state.graph.automation?.reserveFinalizationBudget||!state.executionBudget)return undefined;
  const end=Date.parse(state.executionBudget.deadlineAt),total=end-Date.parse(state.executionBudget.startedAt);
  const reserve={planning:.5,implementation:.3,test:.1,review:.05,approval:0,interrupt:0}[node.type];
  const cap={planning:.15,implementation:.6,test:.25,review:.1,approval:1,interrupt:.05}[node.type];
  return Math.min(end-total*reserve,Date.parse(visit.startedAt)+total*cap);
}
export function stageBudgetReason(state:SessionState,node:AgentNode,visit:NodeVisit,beforeCall=false,now=Date.now()):string|null{
  if(!state.graph.automation?.reserveFinalizationBudget||!state.executionBudget)return null;
  const deadline=visit.stageDeadlineAt?Date.parse(visit.stageDeadlineAt):stageDeadline(state,node,visit);
  if(deadline===undefined)return null;
  if(now>=deadline)return `${node.name} 단계의 고정 시간 예산을 소진했습니다. 후속 검증·검토·승인 시간을 보존하며 자동 복구로 이 단계의 마감을 초기화하지 않습니다.`;
  const slots={planning:5,implementation:4,test:2,review:1,approval:0,interrupt:0}[node.type];
  const reserve=Math.min(slots,Math.floor(state.executionBudget!.maxAttempts/4));
  const used=state.visits.reduce((n,v)=>n+v.attempts.length,0);
  if(beforeCall&&reserve&&used>=state.executionBudget!.maxAttempts-reserve)return `${node.name} 단계의 호출 한도에 도달했습니다. 후속 검증·검토·승인용 ${reserve}회 호출을 보존합니다.`;
  return null;
}
