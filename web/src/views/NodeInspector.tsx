import { NODE_TYPES, type AgentNode } from "../../../src/shared/domain";
import { id } from "../api";
import { typeMeta } from "../nodeMeta";
import { BindingEditor } from "../Binding";
import type { GraphInspectorModel } from "./viewModels";

export default function NodeInspector({
  controller,
}: {
  controller: GraphInspectorModel;
}) {
  const {
    draft,
    selected,
    setSelectedNode,
    change,
    updateNode,
    removeNodes,
    connections,
    catalogs,
    target,
    query,
    querying,
  } = controller;
  if (!draft) return null;
  if (!selected) return null;
  return (
    <>
      <div
        className="inspector-type"
        style={{ color: typeMeta[selected.type].color }}
      >
        {typeMeta[selected.type].icon} {typeMeta[selected.type].label} 에이전트
      </div>
      <label>
        노드 이름
        <input
          aria-label="노드 이름"
          value={selected.name}
          onChange={(e) =>
            updateNode((n) => {
              n.name = e.target.value;
            })
          }
        />
      </label>
      <label>
        역할 이름
        <input
          aria-label="역할 이름"
          value={selected.roleName}
          onChange={(e) =>
            updateNode((n) => {
              n.roleName = e.target.value;
            })
          }
        />
      </label>
      <label>
        실행 유형
        <select
          aria-label="실행 유형"
          value={selected.type}
          onChange={(e) =>
            updateNode((n) => {
              n.type = e.target.value as AgentNode["type"];
              if (n.type === "planning")
                n.planning = {
                  requiresApproval: true,
                  optionsCount: 3,
                };
              else delete n.planning;
            })
          }
        >
          {NODE_TYPES.map((t) => (
            <option key={t} value={t}>
              {typeMeta[t].label} · {t}
            </option>
          ))}
        </select>
      </label>
      <label>
        역할 지침
        <textarea
          aria-label="역할 지침"
          rows={5}
          placeholder="이 에이전트의 책임과 작업 지침을 작성하세요."
          value={selected.instructions}
          onChange={(e) =>
            updateNode((n) => {
              n.instructions = e.target.value;
            })
          }
        />
      </label>
      {selected.type === "planning" && (
        <fieldset>
          <legend>계획 승인</legend>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={selected.planning?.requiresApproval !== false}
              onChange={(e) =>
                updateNode((n) => {
                  n.planning = {
                    requiresApproval: e.target.checked,
                    optionsCount: n.planning?.optionsCount ?? 3,
                  };
                })
              }
            />
            사용자가 계획을 승인한 뒤 진행
          </label>
          <label>
            계획 선택지 수
            <input
              aria-label="계획 선택지 수"
              type="number"
              min={1}
              max={20}
              value={selected.planning?.optionsCount ?? 3}
              onChange={(e) =>
                updateNode((n) => {
                  n.planning = {
                    requiresApproval: n.planning?.requiresApproval ?? true,
                    optionsCount: Number(e.target.value),
                  };
                })
              }
            />
          </label>
        </fieldset>
      )}
      <fieldset>
        <legend>다음 단계</legend>
        {(["success", "failure"] as const).map((outcome) => (
          <label key={outcome}>
            {outcome === "success" ? "성공 시" : "실패 시"}
            <select
              aria-label={
                outcome === "success"
                  ? "성공 시 다음 단계"
                  : "실패 시 다음 단계"
              }
              value={
                draft.edges.find(
                  (e) => e.source === selected.id && e.outcome === outcome,
                )?.target ?? ""
              }
              onChange={(e) =>
                change((g) => {
                  g.edges = g.edges.filter(
                    (edge) =>
                      !(
                        edge.source === selected.id && edge.outcome === outcome
                      ),
                  );
                  if (e.target.value)
                    g.edges.push({
                      id: id(),
                      source: selected.id,
                      target: e.target.value,
                      outcome,
                    });
                })
              }
            >
              <option value="">경로 연결 필요</option>
              {draft.nodes.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.name || n.id}
                </option>
              ))}
              <option value="SUCCESS">✓ 완료</option>
              <option value="PAUSED">Ⅱ 일시정지</option>
            </select>
          </label>
        ))}
      </fieldset>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={!selected.binding}
          onChange={(e) =>
            updateNode((n) => {
              if (e.target.checked) delete n.binding;
              else
                n.binding = draft.defaultBinding
                  ? { ...draft.defaultBinding }
                  : { connectionId: "", modelId: "" };
            })
          }
        />
        그래프 기본 연결·모델 사용
      </label>
      {selected.binding ? (
        <BindingEditor
          label="노드 실행 설정"
          binding={selected.binding}
          connections={connections}
          catalogs={catalogs}
          target={target}
          onChange={(b) =>
            updateNode((n) => {
              if (b) n.binding = b;
              else n.binding = { connectionId: "", modelId: "" };
            })
          }
          onQuery={(value) => void query(value)}
          querying={querying}
        />
      ) : (
        <p className="field-hint">
          {draft.defaultBinding?.modelId ??
            "그래프 설정에서 공통 모델을 먼저 선택하세요."}
        </p>
      )}
      <button
        className="button danger full"
        onClick={() => {
          removeNodes([selected.id], []);
          setSelectedNode(null);
        }}
      >
        노드 삭제
      </button>
    </>
  );
}
