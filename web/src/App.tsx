import { lazy, Suspense } from "react";
import { useStudioController } from "./hooks/useStudioController";
import { ViewBoundary } from "./components/ViewBoundary";
import DirectoryDialog from "./views/DirectoryDialog";
const GraphsView = lazy(() => import("./views/GraphsView"));
const ConnectionsView = lazy(() => import("./views/ConnectionsView"));
const RunsView = lazy(() => import("./views/RunsView"));
export function App() {
  const controller = useStudioController();
  const {
    boot,
    loadError,
    view,
    setView,
    graphs,
    sessions,
    notice,
    setNotice,
    error,
    setError,
    attempt,
    draft,
    importRef,
    selectGraph,
    newGraph,
    importGraph,
  } = controller;
  if (!boot)
    return (
      <div className="boot-screen">
        <div className="brand-mark">◈</div>
        <h1>Agent Graph Studio</h1>
        <p>{loadError || "로컬 작업 공간을 여는 중…"}</p>
        {loadError && (
          <button className="button" onClick={() => location.reload()}>
            다시 연결
          </button>
        )}
      </div>
    );
  return (
    <div className="studio">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">◈</div>
          <div>
            <strong>Agent Graph</strong>
            <span>
              STUDIO <i>4.0</i>
            </span>
          </div>
        </div>
        <div className="workspace-label">
          <i className="dot green" /> 로컬 작업 공간
        </div>
        <nav className="main-nav">
          {(
            [
              ["graphs", "◈", "그래프 편집"],
              ["connections", "◉", "CLI 연결"],
              ["runs", "▷", "실행 기록"],
            ] as const
          ).map(([key, icon, label]) => (
            <button
              key={key}
              className={view === key ? "active" : ""}
              onClick={() => {
                setView(key);
                setError("");
              }}
            >
              <span>{icon}</span>
              {label}
              {key === "runs" && sessions.length > 0 && (
                <b>{sessions.length}</b>
              )}
            </button>
          ))}
        </nav>
        <div className="library-heading">
          <span>그래프 라이브러리</span>
          <button
            aria-label="새 그래프"
            title="새 그래프"
            onClick={() => void attempt(() => newGraph())}
          >
            ＋
          </button>
        </div>
        <div className="graph-list">
          {graphs.map((g) => (
            <div
              key={g.id}
              className={`graph-list-item ${draft?.id === g.id ? "active" : ""}`}
            >
              <button
                className="graph-select"
                aria-label={g.name || "이름 없는 그래프"}
                onClick={() => void attempt(() => selectGraph(g))}
              >
                <span className="graph-glyph">⌘</span>
                <span>
                  <strong>{g.name || "이름 없는 그래프"}</strong>
                  <small>
                    {g.nodes.length}개 에이전트 · rev {g.revision}
                  </small>
                </span>
              </button>
            </div>
          ))}
        </div>
        <button
          className="sidebar-import"
          onClick={() => importRef.current?.click()}
        >
          ↥ 그래프 가져오기
        </button>
        <input
          ref={importRef}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void attempt(() => importGraph(file));
            e.target.value = "";
          }}
        />
        <div className="sidebar-footer">
          <span>LOCAL FIRST</span>
          <p>
            실행은 내 컴퓨터에서
            <br />
            모델은 연결한 CLI에서
          </p>
          <small title={boot.root}>{boot.root}</small>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            작업 공간 <span>/</span>{" "}
            {view === "graphs"
              ? "그래프"
              : view === "connections"
                ? "로컬 서비스"
                : "세션"}
            {view === "graphs" && draft && (
              <>
                <span>/</span>
                <strong>{draft.name || "이름 없는 그래프"}</strong>
              </>
            )}
          </div>
          <div className="server-badge">
            <i className="dot green" />
            로컬 서버 연결됨
          </div>
        </header>
        <div className="mobile-library">
          <select
            aria-label="그래프 선택"
            value={draft?.id ?? ""}
            onChange={(e) => {
              const g = graphs.find((g) => g.id === e.target.value);
              if (g) void attempt(() => selectGraph(g));
            }}
          >
            <option value="">그래프 선택</option>
            {graphs.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name || "이름 없는 그래프"}
              </option>
            ))}
          </select>
          <button
            className="button subtle small"
            aria-label="모바일 새 그래프"
            onClick={() => void attempt(() => newGraph())}
          >
            ＋
          </button>
          <button
            className="button subtle small"
            aria-label="모바일 그래프 가져오기"
            onClick={() => importRef.current?.click()}
          >
            ↥
          </button>
        </div>
        {(error || notice) && (
          <div
            className={`message-banner ${error ? "error" : "notice"}`}
            role={error ? "alert" : "status"}
          >
            <span>{error ? "!" : "✓"}</span>
            <p>{error || notice}</p>
            <button
              aria-label="알림 닫기"
              onClick={() => {
                setError("");
                setNotice("");
              }}
            >
              ×
            </button>
          </div>
        )}
        <ViewBoundary key={view}>
          <Suspense fallback={<div className="empty-state" role="status">화면을 불러오는 중…</div>}>
            {view === "graphs" && <GraphsView controller={controller} />}
            {view === "connections" && <ConnectionsView controller={controller} />}
            {view === "runs" && <RunsView controller={controller} />}
          </Suspense>
        </ViewBoundary>
      </div>
      <DirectoryDialog controller={controller} />
    </div>
  );
}
