import type { AgentGraphDocument, LocalConnection, ModelCatalog, SessionState } from "../../src/shared/domain";
export interface Bootstrap {
  version: string;
  root: string;
  defaultTarget: string;
  graphs: AgentGraphDocument[];
  connections: LocalConnection[];
  catalogs: ModelCatalog[];
  sessions: SessionState[];
}
export const statusNames: Record<string, string> = {
  RUNNING: "실행 중",
  RECOVERING: "복구 예약",
  WAITING_USER: "사용자 대기",
  PAUSED: "일시정지",
  STOPPED: "중지됨",
  BLOCKED: "실행 차단",
  SUCCESS: "완료",
  FAILED: "실패",
};
export const pricingNames = { free: "무료 확인", paid: "유료", unknown: "가격 미확인" };
export const stamp = (value: string) =>
  new Date(value).toLocaleString("ko-KR", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
export const fingerprint = (g: AgentGraphDocument) =>
  JSON.stringify({ ...g, revision: 0, updatedAt: "" });
export const backupKey = (root: string, graphId: string) =>
  `agent-graph-draft:${root}:${graphId}`;
export function clientDiagnostics(g: AgentGraphDocument): string[] {
  const errors: string[] = [];
  if (!g.nodes.length) errors.push("노드를 추가하세요.");
  for (const [key, value] of Object.entries(g.entrypoints))
    if (!value || !g.nodes.some((n) => n.id === value))
      errors.push(
        `${({ start: "시작", reentry: "재진입", interrupt: "중단 처리", cycleCompletion: "사이클 완료" } as Record<string, string>)[key]} 노드를 지정하세요.`,
      );
  for (const n of g.nodes) {
    const b = n.binding ?? g.defaultBinding;
    if (!b?.connectionId || !b.modelId)
      errors.push(`${n.name}: 모델을 선택하세요.`);
    for (const result of ["success", "failure"])
      if (
        g.edges.filter((e) => e.source === n.id && e.outcome === result)
          .length !== 1
      )
        errors.push(
          `${n.name}: ${result === "success" ? "성공" : "실패"} 경로를 하나 연결하세요.`,
        );
  }
  if (
    g.entrypoints.interrupt &&
    g.nodes.find((n) => n.id === g.entrypoints.interrupt)?.type !== "interrupt"
  )
    errors.push("중단 처리 노드의 유형은 interrupt여야 합니다.");
  return errors;
}
