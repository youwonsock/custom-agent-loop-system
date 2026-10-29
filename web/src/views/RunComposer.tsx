import type { RunComposerModel } from "./viewModels";

export default function RunComposer({
  controller,
}: {
  controller: RunComposerModel;
}) {
  const {
    goalRef,
    goal,
    setGoal,
    target,
    setTarget,
    browse,
    directoryBusy,
    accessMode,
    setAccessMode,
    maxIterations,
    setMaxIterations,
    sessionMinutes,
    setSessionMinutes,
    maxSessionAttempts,
    setMaxSessionAttempts,
    starting,
    start,
    issues,
    isolation,
    conflict,
    connections,
    setView,
  } = controller;
  return (
    <section className="run-composer">
      <div className="composer-main">
        {connections.length === 0 && (
          <div className="first-run" aria-label="처음 실행 안내">
            <strong>처음 실행하기</strong>
            <ol>
              <li>
                CLI 연결에서 설치·인증한 Codex·Claude Code·OpenCode·Kilo 실행
                파일을 등록합니다.
              </li>
              <li>
                대상 프로젝트로 모델을 조회합니다. 조회에 성공한 모델만 선택할
                수 있습니다.
              </li>
              <li>
                그래프 설정에서 공통 연결과 모델을 고른 뒤 목표를 입력하고
                실행합니다.
              </li>
            </ol>
            <button
              className="button primary small"
              onClick={() => setView("connections")}
            >
              연결 등록 화면 열기
            </button>
          </div>
        )}
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
        {isolation.length > 0 && (
          <ul className="isolation-notes" aria-label="격리 보장 범위">
            {isolation.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        )}
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
        <label>
          전체 시간 (분)
          <input
            aria-label="전체 시간 예산"
            type="number"
            min={1}
            max={10080}
            value={sessionMinutes}
            onChange={(e) => setSessionMinutes(Number(e.target.value))}
          />
        </label>
        <label>
          전체 에이전트 시도
          <input
            aria-label="전체 에이전트 시도 한도"
            title="CLI 실행 단위이며 내부 모델 턴 수와 다릅니다"
            type="number"
            min={1}
            max={10000}
            value={maxSessionAttempts}
            onChange={(e) => setMaxSessionAttempts(Number(e.target.value))}
          />
        </label>
        <button
          className="button primary run-button"
          disabled={starting || !goal.trim() || issues.length > 0 || conflict}
          onClick={() => void start()}
        >
          {starting ? "실행 준비 중…" : "▷ 그래프 실행"}
        </button>
      </div>
    </section>
  );
}
