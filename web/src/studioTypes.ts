import type { SessionSummary } from "../../src/shared/session_updates";
import { graphDiagnostics } from "../../src/shared/graph_validation";
import type { AgentGraphDocument, LocalConnection, ModelCatalog } from "../../src/shared/domain";
export interface Bootstrap {
  version: string;
  root: string;
  defaultTarget: string;
  graphs: AgentGraphDocument[];
  connections: LocalConnection[];
  catalogs: ModelCatalog[];
  sessions: SessionSummary[];
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
  return graphDiagnostics(g).map(d => d.message);
}
