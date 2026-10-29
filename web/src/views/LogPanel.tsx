import type { LogPanelModel } from "./viewModels";

export default function LogPanel({
  controller,
}: {
  controller: LogPanelModel;
}) {
  const { log, logRef, logBottom, run, visit } = controller;
  if (!run) return null;

  return (
    <>
      <section className="panel log-panel">
        <div className="log-heading">
          <h2>
            실행 로그{" "}
            <span>{visit ? `방문 ${visit.number}` : "실행 준비"}</span>
          </h2>
          <span className="live-label">
            <i className="dot green" />
            {run.status === "RUNNING" ? "LIVE" : "기록"}
          </span>
        </div>
        <pre
          ref={logRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            logBottom.current =
              el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          }}
        >
          {log || "CLI 출력이 도착하면 여기에 표시됩니다."}
        </pre>
      </section>
    </>
  );
}
