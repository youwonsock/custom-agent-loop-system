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
        <span>{selected ? "노드 속성" : "그래프 설정"}</span>
        <select
          className="compact-node-select"
          disabled={graphBusy}
          aria-label="노드 선택"
          value={selectedNode ?? ""}
          onChange={(e) => setSelectedNode(e.target.value || null)}
        >
          <option value="">그래프 설정</option>
          {draft.nodes.map((n) => (
            <option key={n.id} value={n.id}>
              {n.name}
            </option>
          ))}
        </select>
        {selected && (
          <button
            aria-label="노드 선택 해제"
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
              ? `${issues.length}개 설정 확인 필요`
              : "✓ 실행 설정 준비됨"}
          </strong>
          {issues.length > 0 && (
            <ul>
              {issues.slice(0, 6).map((issue, index) => (
                <li key={index}>{issue}</li>
              ))}
              {issues.length > 6 && <li>그 외 {issues.length - 6}개 항목</li>}
            </ul>
          )}
        </div>
      </div>
    </aside>
  );
}
