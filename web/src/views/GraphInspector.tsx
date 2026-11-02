import { t } from "../i18n";
import GraphSettings from "./GraphSettings";
import NodeInspector from "./NodeInspector";
import type { GraphInspectorModel } from "./viewModels";

export default function GraphInspector({
  controller,
}: {
  controller: GraphInspectorModel;
}) {
  const { draft, selected, selectedNode, setSelectedNode, graphBusy, issues } =
    controller;
  if (!draft) return null;
  return (
    <aside className="inspector">
      <div className="inspector-heading">
        <span>{selected ? t("노드 속성") : t("그래프 설정")}</span>
        <select
          className="compact-node-select"
          disabled={graphBusy}
          aria-label={t("노드 선택")}
          value={selectedNode ?? ""}
          onChange={(e) => setSelectedNode(e.target.value || null)}
        >
          <option value="">{t("그래프 설정")}</option>
          {draft.nodes.map((n) => (
            <option key={n.id} value={n.id}>
              {n.name}
            </option>
          ))}
        </select>
        {selected && (
          <button
            aria-label={t("노드 선택 해제")}
            onClick={() => setSelectedNode(null)}
          >
            ×
          </button>
        )}
      </div>
      <div className="inspector-body">
        {selected ? (
          <NodeInspector controller={controller} />
        ) : (
          <GraphSettings controller={controller} />
        )}
        <div
          className={`validation-box ${issues.length ? "pending" : "valid"}`}
        >
          <strong>
            {issues.length
              ? t("{0}개 설정 확인 필요", issues.length)
              : t("✓ 실행 설정 준비됨")}
          </strong>
          {issues.length > 0 && (
            <ul>
              {issues.slice(0, 6).map((issue, index) => (
                <li key={index}>{issue}</li>
              ))}
              {issues.length > 6 && (
                <li>
                  {t("그 외 ")}
                  {issues.length - 6}
                  {t("개 항목")}
                </li>
              )}
            </ul>
          )}
        </div>
      </div>
    </aside>
  );
}
