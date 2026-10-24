import { NODE_TYPES, type AgentNode } from "../../../src/shared/domain";
import { id } from "../api";
import { typeMeta } from "../nodeMeta";
import { BindingEditor } from "../Binding";
import type { GraphInspectorModel } from "./viewModels";

export default function GraphInspector({
  controller,
}: {
  controller: GraphInspectorModel;
}) {
  const {
    draft,
    selected,
    selectedNode,
    setSelectedNode,
    graphBusy,
    change,
    updateNode,
    removeNodes,
    connections,
    catalogs,
    target,
    query,
    querying,
    issues,
  } = controller;
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
          <>
            <div
              className="inspector-type"
              style={{ color: typeMeta[selected.type].color }}
            >
              {typeMeta[selected.type].icon} {typeMeta[selected.type].label}{" "}
              에이전트
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
                          e.source === selected.id && e.outcome === outcome,
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
        ) : (
          <>
            <p className="inspector-intro">
              노드를 선택하면 역할과 연결을 편집할 수 있습니다. 공통 모델은 모든
              노드가 기본으로 사용합니다.
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
            <fieldset>
              <legend>자율 실행</legend>
              <label className="checkbox">
                <input
                  type="checkbox"
                  aria-label="자동 수정 루프"
                  checked={Boolean(draft.automation)}
                  onChange={(e) =>
                    change((g) => {
                      if (e.target.checked)
                        g.automation = {
                          maxRepairCycles: 3,
                          nativeApprovalReview: false,
                          browserVerification: true,
                        };
                      else delete g.automation;
                    })
                  }
                />
                검증 실패를 자동 수정한 뒤 다시 검사
              </label>
              {draft.automation && (
                <>
                  <label>
                    자동 수정 횟수
                    <input
                      aria-label="자동 수정 횟수"
                      type="number"
                      min={1}
                      max={20}
                      value={draft.automation.maxRepairCycles}
                      onChange={(e) =>
                        change((g) => {
                          g.automation!.maxRepairCycles = Number(
                            e.target.value,
                          );
                        })
                      }
                    />
                  </label>
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      aria-label="실제 브라우저 검증 필수"
                      checked={Boolean(draft.automation.browserVerification)}
                      onChange={(e) =>
                        change((g) => {
                          g.automation!.browserVerification = e.target.checked;
                        })
                      }
                    />
                    웹 화면의 실제 브라우저 검증 필수
                  </label>
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      aria-label="네이티브 자동 승인 검토"
                      checked={draft.automation.nativeApprovalReview}
                      onChange={(e) =>
                        change((g) => {
                          g.automation!.nativeApprovalReview = e.target.checked;
                        })
                      }
                    />
                    Codex의 명령별 자동 승인 검토 사용
                  </label>
                  <p className="muted">
                    계획 승인은 계획 노드 설정을 따릅니다. 인증·권한·명시적 사람
                    승인은 대기하며, 실패한 검사를 성공으로 바꾸지 않습니다.
                  </p>
                </>
              )}
            </fieldset>
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
                        (n) => key !== "interrupt" || n.type === "interrupt",
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
              {issues.length > 6 && <li>그 외 {issues.length - 6}개 항목</li>}
            </ul>
          )}
        </div>
      </div>
    </aside>
  );
}
