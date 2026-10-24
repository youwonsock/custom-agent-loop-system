import { isNewerSession, mergeSessions, sessionSummary } from "../../../src/shared/session_updates";
import { useEffect, useRef, useState } from "react";
import { type SessionState, type SessionAction } from "../../../src/shared/domain";
import { api, id } from "../api";
import type { StudioData } from "./useStudioData";
import type { GraphEditor } from "./useGraphEditor";

export function useRunController(data: Pick<StudioData, "view" | "setView" | "sessions" | "setSessions" | "target" | "goal" | "setNotice" | "setError" | "attempt">, graph: Pick<GraphEditor, "flush">) {
  const {
    view,
    setView,
    sessions,
    setSessions,
    target,
    goal,
    setNotice,
    attempt,
  } = data;
  const {
    flush,
  } = graph;
  const [accessMode, setAccessMode] = useState<"ask" | "full_access">("ask"),
    [maxIterations, setMaxIterations] = useState(20), [starting, setStarting] = useState(false),
    [sessionMinutes,setSessionMinutes] = useState(60), [maxSessionAttempts,setMaxSessionAttempts] = useState(24),
    [selectedRun, setSelectedRun] = useState<string | null>(null);
  const [run, setRun] = useState<SessionState | undefined>();
  const [log, setLog] = useState(""),
    logOffset = useRef(0),
    logKey = useRef(""),
    logRef = useRef<HTMLPreElement | null>(null),
    logBottom = useRef(true);
  const [planText, setPlanText] = useState(""),
    [planEditing, setPlanEditing] = useState(false),
    [planChoice, setPlanChoice] = useState<number | null>(null),
    [actionBusy, setActionBusy] = useState(false);
  const [interruptText, setInterruptText] = useState("");
  const start = async () => {
    if (starting) return;
    setStarting(true);
    await attempt(async () => {
      const graph = await flush();
      if (!graph) return;
      const state = await api<SessionState>("/sessions", "POST", {
        requestId: id(),
        graphId: graph.id,
        expectedRevision: graph.revision,
        goal,
        targetProjectPath: target,
        accessMode,
        settings: { maxIterations, sessionTimeoutMs: sessionMinutes*60000, maxSessionAttempts },
      });
      setSessions(values => mergeSessions(values, [sessionSummary(state)]));
      setRun(state);
      setSelectedRun(state.id);
      setView("runs");
      setNotice("저장된 그래프와 연결 설정으로 실행을 시작했습니다.");
    });
    setStarting(false);
  };
  const summary = sessions.find(s => s.id === selectedRun);
  useEffect(() => {
    if (!summary) { setRun(undefined); return; }
    const controller = new AbortController();
    void api<SessionState>(`/sessions/${summary.id}`, "GET", undefined, controller.signal)
      .then(next => { if (!controller.signal.aborted) setRun(current => !current || current.id !== next.id || isNewerSession(next, current) ? next : current); })
      .catch(e => { if (!controller.signal.aborted) data.setError(e.message); });
    return () => controller.abort();
  }, [selectedRun, summary?.revision, summary?.updatedAt]);
  const visit =
      run?.visits.find((v) => v.id === run.activeVisitId) ?? run?.visits.at(-1),
    pendingVisit = run?.pendingApproval
      ? run.visits.find((v) => v.id === run.pendingApproval!.visitId)
      : undefined;
  const plan =
    pendingVisit?.plans.find(
      (p) => p.id === (planChoice ?? pendingVisit.selectedPlanId),
    ) ?? pendingVisit?.plans[0];
  useEffect(() => {
    setPlanChoice(null);
    setPlanEditing(false);
    setPlanText("");
  }, [selectedRun, pendingVisit?.id]);
  useEffect(() => {
    if (plan && !planEditing) setPlanText(plan.body);
  }, [plan, planEditing]);
  useEffect(() => {
    if (view !== "runs" || !selectedRun) return;
    const controller = new AbortController();
    let alive = true,
      busy = false;
    logOffset.current = 0;
    logKey.current = "";
    setLog("");
    const tick = async () => {
      if (busy) return;
      busy = true;
      try {
        const data = await api<{
          text: string;
          offset: number;
          visitId?: string;
          attemptId?: string;
        }>(`/sessions/${selectedRun}/logs?offset=${logOffset.current}`, "GET", undefined, controller.signal);
        if (!alive) return;
        const key = `${data.visitId}:${data.attemptId}`;
        if (logKey.current && logKey.current !== key) {
          logOffset.current = 0;
          logKey.current = key;
          setLog("");
          return;
        }
        logKey.current = key;
        logOffset.current = data.offset;
        if (data.text) setLog((value) => (value + data.text).slice(-300_000));
      } catch {
        /* a new attempt may not have created its log yet */
      } finally {
        busy = false;
      }
    };
    void tick();
    const timer = setInterval(() => {
      void tick();
    }, 700);
    return () => {
      alive = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [view, selectedRun]);
  useEffect(() => {
    if (logBottom.current && logRef.current)
      logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);
  const act = async (action: Omit<SessionAction, "requestId">) => {
    if (!run || actionBusy) return;
    setActionBusy(true);
    await attempt(async () => {
      const next = await api<SessionState>(
        `/sessions/${run.id}/actions`,
        "POST",
        { ...action, requestId: id() },
      );
      setSessions(values => mergeSessions(values, [sessionSummary(next)]));
      setRun(current => !current || current.id !== next.id || isNewerSession(next, current) ? next : current);
      if (action.type === "edit_plan") {
        setPlanEditing(false);
        setNotice("계획 문서를 저장했습니다. 저장된 문서를 승인하세요.");
      }
    });
    setActionBusy(false);
  };

  return {
    accessMode,
    setAccessMode,
    maxIterations,
    setMaxIterations,
    sessionMinutes,setSessionMinutes,maxSessionAttempts,setMaxSessionAttempts,
    starting,
    selectedRun,
    setSelectedRun,
    log,
    logRef,
    logBottom,
    planText,
    setPlanText,
    planEditing,
    setPlanEditing,
    planChoice,
    setPlanChoice,
    actionBusy,
    interruptText,
    setInterruptText,
    start,
    run: run?.id === selectedRun ? run : undefined,
    visit,
    pendingVisit,
    plan,
    act,
  };
}
export type RunController = ReturnType<typeof useRunController>;
