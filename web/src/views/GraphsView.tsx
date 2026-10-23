import { NODE_TYPES, type AgentGraphDocument, type AgentNode } from "../../../src/shared/domain";
import { api, id } from "../api";
import { typeMeta } from "../nodeMeta";
import { backupKey } from "../studioTypes";
import type { StudioController } from "../hooks/useStudioController";
import { Canvas } from "../Canvas";
import { BindingEditor } from "../Binding";

export default function GraphsView({ controller }: { controller: StudioController }) {
  const {
    boot,
    setDraft,
    view,
    setGraphs,
    connections,
    catalogs,
    target,
    setTarget,
    goal,
    setGoal,
    setError,
    directoryBusy,
    attempt,
    browse,
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
    goalRef,
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
    selected,
    issues,
    updateNode,
    querying,
    query,
    accessMode,
    setAccessMode,
    maxIterations,
    setMaxIterations,
    starting,
    start,
  } = controller;

  if (!boot) return null;
  return <>
    {view === "graphs" && draft && (
      <>
        <div className="page-heading">
          <div>
            <span className="eyebrow">AGENT WORKFLOW</span>
            <input
              aria-label="그래프 이름"
              className="graph-title"
              disabled={graphBusy}
              value={draft.name}
              onChange={(e) =>
                change((g) => {
                  g.name = e.target.value;
                })
              }
            />
            <p>역할을 정의하고 에이전트의 다음 단계를 연결하세요.</p>
          </div>
          <div className="heading-actions">
            <span className={`save-status ${conflict ? "conflict" : ""}`}>
              <i className="dot" />
              {conflict || saveStatus === "저장 실패"
                ? saveStatus
                : dirty.current
                  ? saveStatus === "저장됨"
                    ? "저장 대기"
                    : saveStatus
                  : "저장됨"}
            </span>
            <button
              className="button subtle"
              onClick={() => void attempt(copyGraph)}
            >
              복제
            </button>
            <button
              className="button subtle"
              onClick={() => void attempt(exportGraph)}
            >
              내보내기
            </button>
            <button
              className="button danger subtle"
              onClick={() => {
                if (
                  confirm(
                    "이 그래프를 삭제할까요? 실행 기록의 snapshot은 보존됩니다.",
                  )
                )
                  void attempt(async () => {
                    await api(`/graphs/${draft.id}`, "DELETE", {
                      expectedRevision: draft.revision,
                    });
                    if (boot)
                      localStorage.removeItem(
                        backupKey(boot.root, draft.id),
                      );
                    dirty.current = false;
                    draftRef.current = null;
                    const values =
                      await api<AgentGraphDocument[]>("/graphs");
                    setGraphs(values);
                    if (values[0]) installDraft(values[0], false);
                    else setDraft(null);
                  });
              }}
            >
              삭제
            </button>
          </div>
        </div>
        {conflict && (
          <div className="conflict-banner">
            <p>
              다른 창에서 그래프를 변경했습니다. 현재 초안은 보존되어
              있습니다.
            </p>
            <button
              className="button small"
              onClick={() => void attempt(copyGraph)}
            >
              새 그래프로 저장
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
              서버 버전 다시 읽기
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
                {NODE_TYPES.map((t) => (
                  <button
                    key={t}
                    title={`${typeMeta[t].label} 노드 추가`}
                    onClick={() => addNode(t)}
                    style={
                      {
                        "--node-color": typeMeta[t].color,
                      } as React.CSSProperties
                    }
                  >
                    <span>{typeMeta[t].icon}</span>
                    {typeMeta[t].label}
                    <i>＋</i>
                  </button>
                ))}
              </div>
              <div className="history-buttons">
                <button
                  aria-label="실행 취소"
                  title="실행 취소"
                  disabled={!past.current.length}
                  onClick={undo}
                >
                  ↶
                </button>
                <button
                  aria-label="재실행"
                  title="재실행"
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
                {draft.nodes.length}개 노드 <i>·</i> {draft.edges.length}개
                연결
              </span>
              <button
                className="text-button"
                onClick={() => void attempt(() => newGraph(true))}
              >
                빈 그래프 만들기
              </button>
            </div>
          </section>
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
                <>
                  <div
                    className="inspector-type"
                    style={{ color: typeMeta[selected.type].color }}
                  >
                    {typeMeta[selected.type].icon}{" "}
                    {typeMeta[selected.type].label} 에이전트
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
                          checked={
                            selected.planning?.requiresApproval !== false
                          }
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
                                requiresApproval:
                                  n.planning?.requiresApproval ?? true,
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
                              (e) =>
                                e.source === selected.id &&
                                e.outcome === outcome,
                            )?.target ?? ""
                          }
                          onChange={(e) =>
                            change((g) => {
                              g.edges = g.edges.filter(
                                (edge) =>
                                  !(
                                    edge.source === selected.id &&
                                    edge.outcome === outcome
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
                          else
                            n.binding = { connectionId: "", modelId: "" };
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
              ) : (
                <>
                  <p className="inspector-intro">
                    노드를 선택하면 역할과 연결을 편집할 수 있습니다. 공통
                    모델은 모든 노드가 기본으로 사용합니다.
                  </p>
                  <label>
                    그래프 설명
                    <textarea
                      aria-label="그래프 설명"
                      rows={3}
                      value={draft.description}
                      onChange={(e) =>
                        change((g) => {
                          g.description = e.target.value;
                        })
                      }
                      placeholder="이 그래프의 목적을 적어주세요."
                    />
                  </label>
                  <BindingEditor
                    label="기본 실행 설정"
                    binding={draft.defaultBinding}
                    connections={connections}
                    catalogs={catalogs}
                    target={target}
                    onChange={(b) =>
                      change((g) => {
                        if (b) g.defaultBinding = b;
                        else delete g.defaultBinding;
                      })
                    }
                    onQuery={(value) => void query(value)}
                    querying={querying}
                  />
                  <fieldset>
                    <legend>실행 지점</legend>
                    {(
                      Object.keys(draft.entrypoints) as Array<
                        keyof typeof draft.entrypoints
                      >
                    ).map((key) => (
                      <label key={key}>
                        {
                          {
                            start: "시작",
                            reentry: "재진입",
                            interrupt: "중단 처리",
                            cycleCompletion: "사이클 완료",
                          }[key]
                        }
                        <select
                          aria-label={`${key} 실행 지점`}
                          value={draft.entrypoints[key] ?? ""}
                          onChange={(e) =>
                            change((g) => {
                              g.entrypoints[key] = e.target.value || null;
                            })
                          }
                        >
                          <option value="">노드 선택</option>
                          {draft.nodes
                            .filter(
                              (n) =>
                                key !== "interrupt" ||
                                n.type === "interrupt",
                            )
                            .map((n) => (
                              <option key={n.id} value={n.id}>
                                {n.name || n.id}
                              </option>
                            ))}
                        </select>
                      </label>
                    ))}
                  </fieldset>
                </>
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
                    {issues.length > 6 && (
                      <li>그 외 {issues.length - 6}개 항목</li>
                    )}
                  </ul>
                )}
              </div>
            </div>
          </aside>
        </div>
        <section className="run-composer">
          <div className="composer-main">
            <label>
              실행 목표
              <textarea
                ref={goalRef}
                aria-label="실행 목표"
                rows={2}
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                placeholder="이 그래프로 달성할 목표를 입력하세요. 예: 검색 필터를 구현하고 테스트해줘"
              />
            </label>
            <div className="target-row">
              <span>⌂</span>
              <input
                aria-label="대상 프로젝트"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                placeholder="대상 프로젝트의 절대경로"
              />
              <button
                className="button subtle small"
                onClick={() => void browse()}
                disabled={directoryBusy}
              >
                폴더 선택
              </button>
            </div>
          </div>
          <div className="composer-options">
            <label>
              접근 모드
              <select
                aria-label="접근 모드"
                value={accessMode}
                onChange={(e) =>
                  setAccessMode(e.target.value as "ask" | "full_access")
                }
              >
                <option value="ask">필요할 때 승인</option>
                <option value="full_access">전체 접근 허용</option>
              </select>
            </label>
            <label>
              반복 한도
              <input
                aria-label="반복 한도"
                type="number"
                min={1}
                max={1000}
                value={maxIterations}
                onChange={(e) => setMaxIterations(Number(e.target.value))}
              />
            </label>
            <button
              className="button primary run-button"
              disabled={
                starting || !goal.trim() || issues.length > 0 || conflict
              }
              onClick={() => void start()}
            >
              {starting ? "실행 준비 중…" : "▷ 그래프 실행"}
            </button>
          </div>
        </section>
      </>
    )}
    {view === "graphs" && !draft && (
      <div className="empty-state">
        <span>◈</span>
        <h2>첫 그래프를 만들어보세요</h2>
        <p>계획부터 승인까지, 원하는 에이전트 흐름을 구성하세요.</p>
        <button
          className="button primary"
          onClick={() => void attempt(() => newGraph())}
        >
          새 그래프 만들기
        </button>
      </div>
    )}

  </>;
}
