import { t } from "../i18n";
import {
  NODE_TYPES,
  type AgentGraphDocument,
} from "../../../src/shared/domain";
import { api } from "../api";
import { typeMeta } from "../nodeMeta";
import { backupKey } from "../studioTypes";
import type { GraphsViewModel } from "./viewModels";
import { Canvas } from "../Canvas";
import GraphInspector from "./GraphInspector";
import RunComposer from "./RunComposer";

export default function GraphsView({
  controller,
}: {
  controller: GraphsViewModel;
}) {
  const {
    boot,
    setDraft,
    view,
    setGraphs,
    connections,
    setError,
    attempt,
    draft,
    draftRef,
    dirty,
    saveStatus,
    conflict,
    graphBusy,
    past,
    future,
    selectedNode,
    setSelectedNode,
    installDraft,
    change,
    undo,
    redo,
    newGraph,
    copyGraph,
    exportGraph,
    removeNodes,
    addNode,
    connect,
  } = controller;

  if (!boot) return null;
  return (
    <>
      {view === "graphs" && draft && (
        <>
          <div className="page-heading">
            <div>
              <span className="eyebrow">AGENT WORKFLOW</span>
              <input
                aria-label={t("그래프 이름")}
                className="graph-title"
                disabled={graphBusy}
                value={draft.name}
                onChange={(e) =>
                  change((g) => {
                    g.name = e.target.value;
                  })
                }
              />
              <p>{t("역할을 정의하고 에이전트의 다음 단계를 연결하세요.")}</p>
            </div>
            <div className="heading-actions">
              <span className={`save-status ${conflict ? "conflict" : ""}`}>
                <i className="dot" />
                {conflict || saveStatus === t("저장 실패")
                  ? saveStatus
                  : dirty.current
                    ? saveStatus === t("저장됨")
                      ? t("저장 대기")
                      : saveStatus
                    : t("저장됨")}
              </span>
              <button
                className="button subtle"
                onClick={() => void attempt(copyGraph)}
              >
                {t("복제")}
              </button>
              <button
                className="button subtle"
                onClick={() => void attempt(exportGraph)}
              >
                {t("내보내기")}
              </button>
              <button
                className="button danger subtle"
                onClick={() => {
                  if (
                    confirm(
                      t(
                        "이 그래프를 삭제할까요? 실행 기록의 snapshot은 보존됩니다.",
                      ),
                    )
                  )
                    void attempt(async () => {
                      await api(`/graphs/${draft.id}`, "DELETE", {
                        expectedRevision: draft.revision,
                      });
                      if (boot)
                        localStorage.removeItem(backupKey(boot.root, draft.id));
                      dirty.current = false;
                      draftRef.current = null;
                      const values = await api<AgentGraphDocument[]>("/graphs");
                      setGraphs(values);
                      if (values[0]) installDraft(values[0], false);
                      else setDraft(null);
                    });
                }}
              >
                {t("삭제")}
              </button>
            </div>
          </div>
          {conflict && (
            <div className="conflict-banner">
              <p>
                {t(
                  "다른 창에서 그래프를 변경했습니다. 현재 초안은 보존되어 있습니다.",
                )}
              </p>
              <button
                className="button small"
                onClick={() => void attempt(copyGraph)}
              >
                {t("새 그래프로 저장")}
              </button>
              <button
                className="button subtle small"
                onClick={() =>
                  void attempt(async () => {
                    localStorage.removeItem(backupKey(boot.root, draft.id));
                    installDraft(await api(`/graphs/${draft.id}`), false);
                    setError("");
                  })
                }
              >
                {t("서버 버전 다시 읽기")}
              </button>
            </div>
          )}
          <div
            className="editor-workspace"
            inert={graphBusy}
            aria-busy={graphBusy}
          >
            <section className="canvas-column">
              <div className="canvas-toolbar">
                <div className="node-add-buttons">
                  {NODE_TYPES.map((type) => (
                    <button
                      key={type}
                      title={t("{0} 노드 추가", typeMeta[type].label)}
                      onClick={() => addNode(type)}
                      style={
                        {
                          "--node-color": typeMeta[type].color,
                        } as React.CSSProperties
                      }
                    >
                      <span>{typeMeta[type].icon}</span>
                      {typeMeta[type].label}
                      <i>＋</i>
                    </button>
                  ))}
                </div>
                <div className="history-buttons">
                  <button
                    aria-label={t("실행 취소")}
                    title={t("실행 취소")}
                    disabled={!past.current.length}
                    onClick={undo}
                  >
                    ↶
                  </button>
                  <button
                    aria-label={t("재실행")}
                    title={t("재실행")}
                    disabled={!future.current.length}
                    onClick={redo}
                  >
                    ↷
                  </button>
                </div>
              </div>
              <Canvas
                key={draft.id}
                graph={draft}
                connections={connections}
                selected={selectedNode}
                onSelect={setSelectedNode}
                onPosition={(nodeId, x, y) =>
                  change((g) => {
                    const n = g.nodes.find((n) => n.id === nodeId);
                    if (n) n.position = { x, y };
                  })
                }
                onConnect={connect}
                onViewport={(viewport) => {
                  if (draftRef.current?.id !== draft.id) return;
                  change((g) => {
                    g.viewport = viewport;
                  }, false);
                }}
                onRemove={removeNodes}
              />
              <div className="canvas-bottom">
                <span>
                  {draft.nodes.length}
                  {t("개 노드 ")}
                  <i>·</i> {draft.edges.length}
                  {t("개 연결")}
                </span>
                <button
                  className="text-button"
                  onClick={() => void attempt(() => newGraph(true))}
                >
                  {t("빈 그래프 만들기")}
                </button>
              </div>
            </section>
            <GraphInspector controller={controller} />
          </div>
          <RunComposer controller={controller} />
        </>
      )}
      {view === "graphs" && !draft && (
        <div className="empty-state">
          <span>◈</span>
          <h2>{t("첫 그래프를 만들어보세요")}</h2>
          <p>{t("계획부터 승인까지, 원하는 에이전트 흐름을 구성하세요.")}</p>
          <button
            className="button primary"
            onClick={() => void attempt(() => newGraph())}
          >
            {t("새 그래프 만들기")}
          </button>
        </div>
      )}
    </>
  );
}
