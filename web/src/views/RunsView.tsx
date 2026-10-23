import { api } from "../api";
import { statusNames, stamp } from "../studioTypes";
import type { StudioController } from "../hooks/useStudioController";
import { Canvas } from "../Canvas";
import { lazy } from "react";
const Markdown = lazy(() => import("../components/Markdown"));
import PlanReview from "./PlanReview";
import LogPanel from "./LogPanel";

export default function RunsView({ controller }: { controller: StudioController }) {
  const {
    view,
    setView,
    sessions,
    setSessions,
    attempt,
    selectedNode,
    setSelectedNode,
    selectedRun,
    setSelectedRun,
    actionBusy,
    interruptText,
    setInterruptText,
    run,
    act,
  } = controller;

  return <>
    {view === "runs" && (
      <div className="runs-page">
        <div className="page-heading">
          <div>
            <span className="eyebrow">EXECUTION HISTORY</span>
            <h1>실행 기록</h1>
            <p>저장된 그래프 snapshot과 노드별 진행 상황을 확인하세요.</p>
          </div>
          {run && (
            <span className={`status-pill ${run.status}`}>
              {statusNames[run.status]}
            </span>
          )}
        </div>
        {sessions.length === 0 ? (
          <div className="empty-state">
            <span>▷</span>
            <h2>실행한 그래프가 없습니다</h2>
            <p>그래프에 모델을 지정하고 목표를 입력해 시작하세요.</p>
            <button
              className="button primary"
              onClick={() => setView("graphs")}
            >
              그래프 편집으로 이동
            </button>
          </div>
        ) : (
          <>
            <div className="run-picker">
              <select
                aria-label="실행 세션"
                value={selectedRun ?? ""}
                onChange={(e) => setSelectedRun(e.target.value || null)}
              >
                <option value="">실행을 선택하세요</option>
                {sessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.graph.name} · {statusNames[s.status]} ·{" "}
                    {stamp(s.createdAt)}
                  </option>
                ))}
              </select>
              {run && (
                <div className="run-actions">
                  <button
                    className="button subtle small"
                    disabled={
                      actionBusy ||
                      ["RUNNING", "SUCCESS"].includes(run.status) ||
                      !!run.pendingApproval ||
                      !!run.pendingAccess
                    }
                    onClick={() => void act({ type: "resume" })}
                  >
                    재개
                  </button>
                  <button
                    className="button subtle small"
                    disabled={
                      actionBusy ||
                      ["STOPPED", "SUCCESS"].includes(run.status)
                    }
                    onClick={() => void act({ type: "stop" })}
                  >
                    중지
                  </button>
                  <button
                    className="text-button danger"
                    disabled={["RUNNING", "RECOVERING"].includes(
                      run.status,
                    )}
                    onClick={() => {
                      if (confirm("이 실행 기록을 삭제할까요?"))
                        void attempt(async () => {
                          await api(`/sessions/${run.id}`, "DELETE");
                          setSessions((values) =>
                            values.filter((s) => s.id !== run.id),
                          );
                          setSelectedRun(null);
                        });
                    }}
                  >
                    기록 삭제
                  </button>
                </div>
              )}
            </div>
            {run && (
              <>
                <div className="run-summary">
                  <div>
                    <span>목표</span>
                    <p>{run.goal}</p>
                  </div>
                  <div>
                    <span>대상 프로젝트</span>
                    <code>{run.targetProjectPath}</code>
                  </div>
                  <div>
                    <span>진행</span>
                    <strong>
                      {run.visits.length}회 방문 <i>·</i>{" "}
                      {run.completedIterations}회 사이클
                    </strong>
                    <small>
                      graph rev {run.graph.revision} · 모델 설정 고정
                    </small>
                  </div>
                </div>
                {run.statusReason && (
                  <div className="run-reason">
                    {run.statusReason}
                    {run.automaticRecovery && (
                      <small>
                        재시도 예정 {stamp(run.automaticRecovery.resumeAt)}
                      </small>
                    )}
                  </div>
                )}
                {run.pendingAccess && (
                  <section className="panel access-request">
                    <h2>외부 경로 접근 승인</h2>
                    <ul>
                      {run.pendingAccess.paths.map((p) => (
                        <li key={p}>
                          <code>{p}</code>
                        </li>
                      ))}
                    </ul>
                    <button
                      className="button primary"
                      disabled={actionBusy}
                      onClick={() =>
                        void act({
                          type: "approve_access",
                          nodeId: run.pendingAccess!.nodeId,
                          visitId: run.pendingAccess!.visitId,
                          decision: "allow_requested",
                        })
                      }
                    >
                      요청한 경로만 승인
                    </button>
                    <button
                      className="button subtle"
                      disabled={actionBusy}
                      onClick={() =>
                        void act({
                          type: "approve_access",
                          nodeId: run.pendingAccess!.nodeId,
                          visitId: run.pendingAccess!.visitId,
                          decision: "full_access",
                        })
                      }
                    >
                      전체 접근 허용
                    </button>
                  </section>
                )}
                <PlanReview controller={controller} />
                <div className="run-details">
                  <section className="run-canvas">
                    <Canvas
                      key={run.id}
                      graph={run.graph}
                      connections={run.connections}
                      selected={selectedNode}
                      onSelect={setSelectedNode}
                      run={run}
                      readonly
                    />
                  </section>
                  <aside className="panel visit-panel">
                    <h2>노드 방문 기록</h2>
                    {run.visits.length === 0 ? (
                      <p className="field-hint">
                        모델 목록을 확인한 뒤 첫 노드를 시작합니다.
                      </p>
                    ) : (
                      run.visits
                        .slice()
                        .reverse()
                        .map((v) => (
                          <details
                            key={v.id}
                            open={v.id === run.activeVisitId}
                          >
                            <summary>
                              <i className={`visit-dot ${v.status}`} />
                              <span>
                                {run.graph.nodes.find(
                                  (n) => n.id === v.nodeId,
                                )?.name ?? v.nodeId}
                                <small>
                                  방문 {v.number} · {v.attempts.length}회
                                  시도
                                </small>
                              </span>
                              <b>
                                {v.verdict ??
                                  (v.status === "waiting_approval"
                                    ? "승인 대기"
                                    : v.status === "running"
                                      ? "실행 중"
                                      : v.status === "succeeded"
                                        ? "완료"
                                        : v.status === "failed"
                                          ? "반려"
                                          : "정지")}
                              </b>
                            </summary>
                            {v.attempts.map((a) => (
                              <div className="attempt-detail" key={a.id}>
                                <span>
                                  시도 {a.number} · {a.status}
                                </span>
                                <code title={a.requestedModelId}>
                                  {a.requestedModelId}
                                </code>
                                {a.actualModelId && (
                                  <small>
                                    실제 모델: {a.actualModelId}
                                  </small>
                                )}
                                {a.lastProgressAt && (
                                  <small>
                                    최근 진행 {stamp(a.lastProgressAt)}
                                  </small>
                                )}
                                {a.message && <p>{a.message}</p>}
                              </div>
                            ))}
                            {v.output && (
                              <details className="output-details">
                                <summary>응답과 검증 근거</summary>
                                <div className="markdown">
                                  <Markdown>
                                    {v.output}
                                  </Markdown>
                                </div>
                              </details>
                            )}
                          </details>
                        ))
                    )}
                  </aside>
                </div>
                <LogPanel controller={controller} />
                <section className="panel interrupt-panel">
                  <label>
                    중단 분석 요청
                    <input
                      aria-label="중단 메시지"
                      value={interruptText}
                      onChange={(e) => setInterruptText(e.target.value)}
                      placeholder="현재 작업을 중단하고 분석할 내용을 입력하세요."
                    />
                  </label>
                  <button
                    className="button subtle"
                    disabled={actionBusy || run.status === "SUCCESS"}
                    onClick={() =>
                      void act({
                        type: "interrupt",
                        message: interruptText,
                      })
                    }
                  >
                    중단 노드로 전환
                  </button>
                </section>
              </>
            )}
          </>
        )}
      </div>
    )}

  </>;
}
