import { t } from "./i18n";
import type { SessionSummary } from "../../src/shared/session_updates";
import { graphDiagnostics } from "../../src/shared/graph_validation";
import type { IsolationSupport } from "../../src/shared/isolation";
import type {
  AgentGraphDocument,
  LocalConnection,
  ModelCatalog,
} from "../../src/shared/domain";
export interface Bootstrap {
  version: string;
  root: string;
  defaultTarget: string;
  isolation: IsolationSupport;
  graphs: AgentGraphDocument[];
  connections: LocalConnection[];
  catalogs: ModelCatalog[];
  sessions: SessionSummary[];
}
export const statusNames: Record<string, string> = {
  RUNNING: t("실행 중"),
  RECOVERING: t("복구 예약"),
  WAITING_USER: t("사용자 대기"),
  PAUSED: t("일시정지"),
  STOPPED: t("중지됨"),
  BLOCKED: t("실행 차단"),
  SUCCESS: t("완료"),
  FAILED: t("실패"),
};
export const pricingNames = {
  free: t("무료 확인"),
  paid: t("유료"),
  unknown: t("가격 미확인"),
};
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
  return graphDiagnostics(g).map((d) => d.message);
}
