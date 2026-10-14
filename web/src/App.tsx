import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Connection } from "@xyflow/react";
import {
  NODE_TYPES,
  SERVICE_TYPES,
  type AgentGraphDocument,
  type AgentNode,
  type LocalConnection,
  type ModelCatalog,
  type SessionState,
  type SessionAction,
  type StudioEvent,
} from "../../src/shared/domain";
import { api, ApiError, id } from "./api";
import { Canvas, typeMeta } from "./Canvas";
import { BindingEditor } from "./Binding";

interface Bootstrap {
  version: string;
  root: string;
  defaultTarget: string;
  graphs: AgentGraphDocument[];
  connections: LocalConnection[];
  catalogs: ModelCatalog[];
  sessions: SessionState[];
}
const statusNames: Record<string, string> = {
  RUNNING: "실행 중",
  RECOVERING: "복구 예약",
  WAITING_USER: "사용자 대기",
  PAUSED: "일시정지",
  STOPPED: "중지됨",
  BLOCKED: "실행 차단",
  SUCCESS: "완료",
  FAILED: "실패",
};
const stamp = (value: string) =>
  new Date(value).toLocaleString("ko-KR", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
const fingerprint = (g: AgentGraphDocument) =>
  JSON.stringify({ ...g, revision: 0, updatedAt: "" });
const backupKey = (root: string, graphId: string) =>
  `agent-graph-draft:${root}:${graphId}`;
function clientDiagnostics(g: AgentGraphDocument): string[] {
  const errors: string[] = [];
  if (!g.nodes.length) errors.push("노드를 추가하세요.");
  for (const [key, value] of Object.entries(g.entrypoints))
    if (!value || !g.nodes.some((n) => n.id === value))
      errors.push(
        `${({ start: "시작", reentry: "재진입", interrupt: "중단 처리", cycleCompletion: "사이클 완료" } as Record<string, string>)[key]} 노드를 지정하세요.`,
      );
  for (const n of g.nodes) {
    const b = n.binding ?? g.defaultBinding;
    if (!b?.connectionId || !b.modelId)
      errors.push(`${n.name}: 모델을 선택하세요.`);
    for (const result of ["success", "failure"])
      if (
        g.edges.filter((e) => e.source === n.id && e.outcome === result)
          .length !== 1
      )
        errors.push(
          `${n.name}: ${result === "success" ? "성공" : "실패"} 경로를 하나 연결하세요.`,
        );
  }
  if (
    g.entrypoints.interrupt &&
    g.nodes.find((n) => n.id === g.entrypoints.interrupt)?.type !== "interrupt"
  )
    errors.push("중단 처리 노드의 유형은 interrupt여야 합니다.");
  return errors;
}
export function App() {
  const [boot, setBoot] = useState<Bootstrap | null>(null),
    [loadError, setLoadError] = useState(""),
    [view, setView] = useState<"graphs" | "connections" | "runs">("graphs");
  const [graphs, setGraphs] = useState<AgentGraphDocument[]>([]),
    [connections, setConnections] = useState<LocalConnection[]>([]),
    [catalogs, setCatalogs] = useState<ModelCatalog[]>([]),
    [sessions, setSessions] = useState<SessionState[]>([]);
  const [draft, setDraft] = useState<AgentGraphDocument | null>(null),
    draftRef = useRef<AgentGraphDocument | null>(null),
    dirty = useRef(false),
    [saveStatus, setSaveStatus] = useState("저장됨"),
    [conflict, setConflict] = useState(false),
    conflictRef = useRef(false),
    saving = useRef<Promise<AgentGraphDocument | null> | null>(null);
  const [graphBusy, setGraphBusy] = useState(false),
    graphBusyRef = useRef(false);
  const past = useRef<AgentGraphDocument[]>([]),
    future = useRef<AgentGraphDocument[]>([]),
    [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [target, setTarget] = useState(""),
    [goal, setGoal] = useState(""),
    [accessMode, setAccessMode] = useState<"ask" | "full_access">("ask"),
    [maxIterations, setMaxIterations] = useState(20),
    [starting, setStarting] = useState(false);
  const [notice, setNotice] = useState(""),
    [error, setError] = useState(""),
    [querying, setQuerying] = useState<string | null>(null),
    [selectedRun, setSelectedRun] = useState<string | null>(null);
  const [connectionForm, setConnectionForm] = useState<LocalConnection>({
      id: id(),
      label: "",
      type: "codex",
      binary: "codex",
    }),
    [connectionBusy, setConnectionBusy] = useState(false);
  const [directory, setDirectory] = useState<{
      path: string;
      parent: string;
      directories: string[];
    } | null>(null),
    [directoryBusy, setDirectoryBusy] = useState(false);
  const [log, setLog] = useState(""),
    logOffset = useRef(0),
    logKey = useRef(""),
    logRef = useRef<HTMLPreElement | null>(null),
    logBottom = useRef(true);
  const [planText, setPlanText] = useState(""),
    [planEditing, setPlanEditing] = useState(false),
    [planChoice, setPlanChoice] = useState<number | null>(null),
    [actionBusy, setActionBusy] = useState(false);
  const goalRef = useRef<HTMLTextAreaElement | null>(null),
    importRef = useRef<HTMLInputElement | null>(null);
  const [interruptText, setInterruptText] = useState("");
  const installDraft = useCallback(
    (g: AgentGraphDocument, restore = true, root?: string) => {
      let next = structuredClone(g),
        restored = false,
        hasConflict = false;
      const dataRoot = root ?? boot?.root;
      if (restore && dataRoot) {
        try {
          const cached = JSON.parse(
            localStorage.getItem(backupKey(dataRoot, g.id)) ?? "null",
          ) as AgentGraphDocument | null;
          if (
            cached?.version === 2 &&
            cached.id === g.id &&
            fingerprint(cached) !== fingerprint(g)
          ) {
            next = cached;
            restored = true;
            hasConflict = cached.revision !== g.revision;
          }
        } catch {
          /* unusable local backup is ignored */
        }
      }
      draftRef.current = next;
      dirty.current = restored;
      setDraft(next);
      past.current = [];
      future.current = [];
      setSelectedNode(null);
      setConflict(hasConflict);
      conflictRef.current = hasConflict;
      setSaveStatus(
        hasConflict ? "저장 충돌" : restored ? "초안 복원됨" : "저장됨",
      );
    },
    [boot?.root],
  );
  useEffect(() => {
    let alive = true;
    void api<Bootstrap>("/bootstrap")
      .then((data) => {
        if (!alive) return;
        setBoot(data);
        setGraphs(data.graphs);
        setConnections(data.connections);
        setCatalogs(data.catalogs);
        setSessions(data.sessions);
        setTarget(
          localStorage.getItem(`agent-graph-target:${data.root}`) ??
            data.defaultTarget,
        );
        if (data.graphs[0]) installDraft(data.graphs[0], true, data.root);
        const savedGoal = localStorage.getItem(`agent-graph-goal:${data.root}`);
        if (savedGoal) setGoal(savedGoal);
      })
      .catch((e) => setLoadError(e.message));
    return () => {
      alive = false;
    };
  }, []);
  const refreshGraphs = useCallback(async () => {
    setGraphs(await api<AgentGraphDocument[]>("/graphs"));
  }, []);
  useEffect(() => {
    if (!boot) return;
    const source = new EventSource("/api/events");
    source.onmessage = (event) => {
      const data = JSON.parse(event.data) as StudioEvent;
      if (data.type === "session" && data.data) {
        const state = data.data as SessionState;
        setSessions((values) =>
          [state, ...values.filter((v) => v.id !== state.id)].sort((a, b) =>
            b.createdAt.localeCompare(a.createdAt),
          ),
        );
      } else if (data.type === "graphs") void refreshGraphs();
      else if (data.type === "connections")
        void api<LocalConnection[]>("/connections").then(setConnections);
    };
    source.addEventListener("ready", () => {
      void api<SessionState[]>("/sessions")
        .then(setSessions)
        .catch(() => {});
    });
    return () => source.close();
  }, [boot, refreshGraphs]);
  const change = useCallback(
    (mutate: (g: AgentGraphDocument) => void, remember = true) => {
      const current = draftRef.current;
      if (!current || graphBusyRef.current) return;
      const next = structuredClone(current);
      mutate(next);
      if (fingerprint(next) === fingerprint(current)) return;
      if (remember) {
        past.current = [...past.current, current].slice(-100);
        future.current = [];
      }
      draftRef.current = next;
      dirty.current = true;
      setDraft(next);
      setSaveStatus(conflictRef.current ? "저장 충돌" : "저장 대기");
      if (boot)
        try {
          localStorage.setItem(
            backupKey(boot.root, next.id),
            JSON.stringify(next),
          );
        } catch {
          setError(
            "브라우저 초안 저장 공간이 부족합니다. 서버 저장 상태를 확인하세요.",
          );
        }
    },
    [boot],
  );
  const saveLatest =
    useCallback(async (): Promise<AgentGraphDocument | null> => {
      if (saving.current) await saving.current;
      if (conflictRef.current)
        throw new ApiError("저장 충돌을 먼저 해결하세요.", 409);
      if (!dirty.current) return draftRef.current;
      const sent = draftRef.current;
      if (!sent) return null;
      setSaveStatus("저장 중…");
      const promise = api<AgentGraphDocument>(`/graphs/${sent.id}`, "PUT", {
        document: sent,
        expectedRevision: sent.revision,
      })
        .then((saved) => {
          setGraphs((values) => [
            saved,
            ...values.filter((g) => g.id !== saved.id),
          ]);
          if (draftRef.current?.id === sent.id) {
            const unchanged =
              fingerprint(draftRef.current) === fingerprint(sent);
            const next = {
              ...draftRef.current,
              revision: saved.revision,
              updatedAt: saved.updatedAt,
            };
            draftRef.current = next;
            dirty.current = !unchanged;
            setDraft(next);
            setSaveStatus(unchanged ? "저장됨" : "저장 대기");
            if (boot) {
              if (unchanged)
                localStorage.removeItem(backupKey(boot.root, sent.id));
              else
                localStorage.setItem(
                  backupKey(boot.root, sent.id),
                  JSON.stringify(next),
                );
            }
          }
          return saved;
        })
        .catch((e) => {
          setSaveStatus(e.status === 409 ? "저장 충돌" : "저장 실패");
          if (e.status === 409) {
            conflictRef.current = true;
            setConflict(true);
          }
          setError(e.message);
          throw e;
        });
      saving.current = promise;
      try {
        return await promise;
      } finally {
        saving.current = null;
      }
    }, [boot]);
  useEffect(() => {
    if (!draft || !dirty.current || conflict) return;
    const timer = setTimeout(() => {
      void saveLatest().catch(() => {});
    }, 500);
    return () => clearTimeout(timer);
  }, [draft, conflict, saveLatest]);
  const flush = async () => {
    for (let i = 0; i < 10; i++) {
      await saveLatest();
      if (!dirty.current) return draftRef.current;
    }
    throw new Error("저장이 완료될 때까지 잠시 기다려주세요.");
  };
  const undo = () => {
    const current = draftRef.current,
      value = past.current.pop();
    if (!current || !value) return;
    future.current.push(current);
    change(
      (g) =>
        Object.assign(g, {
          ...value,
          revision: current.revision,
          updatedAt: current.updatedAt,
        }),
      false,
    );
  };
  const redo = () => {
    const current = draftRef.current,
      value = future.current.pop();
    if (!current || !value) return;
    past.current.push(current);
    change(
      (g) =>
        Object.assign(g, {
          ...value,
          revision: current.revision,
          updatedAt: current.updatedAt,
        }),
      false,
    );
  };
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if (
        view !== "graphs" ||
        !(e.ctrlKey || e.metaKey) ||
        ["INPUT", "TEXTAREA", "SELECT"].includes(
          (e.target as HTMLElement).tagName,
        )
      )
        return;
      if (e.key.toLowerCase() === "z") {
        e.preventDefault();
        e.shiftKey ? redo() : undo();
      } else if (e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  });
  useEffect(() => {
    if (boot) localStorage.setItem(`agent-graph-goal:${boot.root}`, goal);
  }, [goal, boot]);
  useEffect(() => {
    if (boot && target)
      localStorage.setItem(`agent-graph-target:${boot.root}`, target);
  }, [target, boot]);
  const attempt = async (task: () => Promise<unknown>) => {
    setError("");
    setNotice("");
    try {
      await task();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const graphAction = async (task: () => Promise<void>) => {
    if (graphBusyRef.current) return;
    graphBusyRef.current = true;
    flushSync(() => setGraphBusy(true));
    try {
      await task();
    } finally {
      graphBusyRef.current = false;
      setGraphBusy(false);
    }
  };
  const selectGraph = (g: AgentGraphDocument) =>
    graphAction(async () => {
      if (draftRef.current?.id !== g.id) await flush();
      installDraft(await api<AgentGraphDocument>(`/graphs/${g.id}`));
      setView("graphs");
    });
  const newGraph = (empty = false) =>
    graphAction(async () => {
      await flush();
      const g = await api<AgentGraphDocument>("/graphs", "POST", {
        name: empty ? "새 빈 그래프" : "새 상호검증 루프",
        empty,
      });
      await refreshGraphs();
      installDraft(g, false);
      setView("graphs");
      setNotice("새 그래프를 만들었습니다. 역할과 모델을 설정하세요.");
    });
  const copyGraph = () =>
    graphAction(async () => {
      const current = draftRef.current;
      if (!current) return;
      const copy = await api<AgentGraphDocument>("/graphs", "POST", {
        document: { ...current, name: `${current.name} 복사본` },
      });
      if (boot) localStorage.removeItem(backupKey(boot.root, current.id));
      dirty.current = false;
      conflictRef.current = false;
      setConflict(false);
      await refreshGraphs();
      installDraft(copy, false);
      setNotice("초안을 새 그래프로 저장했습니다.");
    });
  const importGraph = (file: File) =>
    graphAction(async () => {
      await flush();
      const imported = await api<AgentGraphDocument>(
        "/graphs/import",
        "POST",
        JSON.parse(await file.text()),
      );
      await refreshGraphs();
      installDraft(imported, false);
      setView("graphs");
      setNotice("새 ID로 그래프를 가져왔습니다. 로컬 연결을 확인하세요.");
    });
  const exportGraph = async () => {
    const g = await flush();
    if (!g) return;
    const blob = new Blob([JSON.stringify(g, null, 2)], {
        type: "application/json",
      }),
      url = URL.createObjectURL(blob),
      anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `graph-${g.id}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };
  const removeNodes = (ids: string[], edges: string[]) =>
    change((g) => {
      g.nodes = g.nodes.filter((n) => !ids.includes(n.id));
      g.edges = g.edges.filter(
        (e) =>
          !ids.includes(e.source) &&
          !ids.includes(e.target) &&
          !edges.includes(e.id),
      );
      for (const key of Object.keys(g.entrypoints) as Array<
        keyof typeof g.entrypoints
      >)
        if (ids.includes(g.entrypoints[key] ?? "")) g.entrypoints[key] = null;
    });
  const addNode = (type: AgentNode["type"]) => {
    const nodeId = id();
    change((g) => {
      const index = g.nodes.length;
      g.nodes.push({
        id: nodeId,
        name: `새 ${typeMeta[type].label} 노드`,
        roleName: typeMeta[type].label,
        type,
        instructions: "",
        position: {
          x: 80 + (index % 3) * 320,
          y: 80 + Math.floor(index / 3) * 260,
        },
        ...(type === "planning"
          ? { planning: { requiresApproval: true, optionsCount: 3 } }
          : {}),
      });
      if (!g.entrypoints.start) g.entrypoints.start = nodeId;
      if (!g.entrypoints.reentry) g.entrypoints.reentry = nodeId;
      if (!g.entrypoints.cycleCompletion)
        g.entrypoints.cycleCompletion = nodeId;
      if (type === "interrupt" && !g.entrypoints.interrupt)
        g.entrypoints.interrupt = nodeId;
    });
    setSelectedNode(nodeId);
  };
  const connect = (c: Connection) => {
    if (
      !c.source ||
      !c.target ||
      !["success", "failure"].includes(c.sourceHandle ?? "")
    )
      return;
    change((g) => {
      g.edges = g.edges.filter(
        (e) => !(e.source === c.source && e.outcome === c.sourceHandle),
      );
      g.edges.push({
        id: id(),
        source: c.source!,
        target: c.target!,
        outcome: c.sourceHandle as "success" | "failure",
      });
    });
  };
  const query = async (connectionId: string) => {
    if (querying) return;
    setQuerying(connectionId);
    setError("");
    try {
      const value = await api<ModelCatalog>(
        `/connections/${connectionId}/models/query`,
        "POST",
        { targetProjectPath: target },
      );
      setCatalogs((values) => [
        ...values.filter(
          (c) =>
            !(
              c.connectionId === value.connectionId &&
              c.targetProjectPath === value.targetProjectPath
            ),
        ),
        value,
      ]);
      setTarget(value.targetProjectPath);
      if (value.error) setError(value.error);
      else
        setNotice(
          `${value.models.length}개 모델을 조회했습니다. 사용할 모델을 선택하세요.`,
        );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setQuerying(null);
    }
  };
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
        settings: { maxIterations },
      });
      setSessions((values) => [
        state,
        ...values.filter((s) => s.id !== state.id),
      ]);
      setSelectedRun(state.id);
      setView("runs");
      setNotice("저장된 그래프와 연결 설정으로 실행을 시작했습니다.");
    });
    setStarting(false);
  };
  const run = sessions.find((s) => s.id === selectedRun),
    visit =
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
        }>(`/sessions/${selectedRun}/logs?offset=${logOffset.current}`);
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
      setSessions((values) => [
        next,
        ...values.filter((s) => s.id !== next.id),
      ]);
      if (action.type === "edit_plan") {
        setPlanEditing(false);
        setNotice("계획 문서를 저장했습니다. 저장된 문서를 승인하세요.");
      }
    });
    setActionBusy(false);
  };
  const browse = async (value = target) => {
    setDirectoryBusy(true);
    await attempt(async () =>
      setDirectory(await api(`/directories?path=${encodeURIComponent(value)}`)),
    );
    setDirectoryBusy(false);
  };
  const selected = draft?.nodes.find((n) => n.id === selectedNode),
    issues = draft ? clientDiagnostics(draft) : [];
  const updateNode = (fn: (n: AgentNode) => void) =>
    change((g) => {
      const n = g.nodes.find((n) => n.id === selectedNode);
      if (n) fn(n);
    });
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
        {view === "connections" && (
          <div className="page-scroll">
            <div className="page-heading">
              <div>
                <span className="eyebrow">LOCAL SERVICES</span>
                <h1>내 CLI 연결</h1>
                <p>
                  설치하고 인증한 서비스를 등록하세요. 모델은 해당 CLI에서
                  조회합니다.
                </p>
              </div>
              <span className="count-pill">{connections.length}개 연결</span>
            </div>
            <div className="connections-layout">
              <section className="panel connection-form">
                <h2>
                  {connections.some((c) => c.id === connectionForm.id)
                    ? "연결 수정"
                    : "로컬 서비스 등록"}
                </h2>
                <label>
                  표시 이름
                  <input
                    aria-label="연결 이름"
                    value={connectionForm.label}
                    onChange={(e) =>
                      setConnectionForm((c) => ({
                        ...c,
                        label: e.target.value,
                      }))
                    }
                    placeholder="예: 내 Codex"
                  />
                </label>
                <label>
                  CLI 종류
                  <select
                    aria-label="CLI 종류"
                    value={connectionForm.type}
                    onChange={(e) =>
                      setConnectionForm((c) => ({
                        ...c,
                        type: e.target.value as LocalConnection["type"],
                        binary: e.target.value,
                      }))
                    }
                  >
                    {SERVICE_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t === "claude"
                          ? "Claude Code"
                          : t === "codex"
                            ? "Codex"
                            : t === "opencode"
                              ? "OpenCode"
                              : "Kilo"}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  실행 파일
                  <input
                    aria-label="CLI 실행 파일"
                    value={connectionForm.binary}
                    onChange={(e) =>
                      setConnectionForm((c) => ({
                        ...c,
                        binary: e.target.value,
                      }))
                    }
                    placeholder="codex 또는 실행 파일의 절대경로"
                  />
                </label>
                <label>
                  조회 대상 프로젝트
                  <input
                    aria-label="모델 조회 프로젝트"
                    value={target}
                    onChange={(e) => setTarget(e.target.value)}
                  />
                </label>
                <p className="field-hint">
                  인증과 MCP·스킬·훅은 CLI에서 설정합니다. 앱은 API 키를
                  요청하거나 저장하지 않습니다.
                </p>
                <button
                  className="button primary full"
                  disabled={
                    connectionBusy ||
                    !connectionForm.label.trim() ||
                    !connectionForm.binary.trim()
                  }
                  onClick={() => {
                    setConnectionBusy(true);
                    void attempt(async () => {
                      const c = await api<LocalConnection>(
                        "/connections",
                        "POST",
                        connectionForm,
                      );
                      setConnections((values) => [
                        ...values.filter((v) => v.id !== c.id),
                        c,
                      ]);
                      setConnectionForm({
                        id: id(),
                        label: "",
                        type: "codex",
                        binary: "codex",
                      });
                      await query(c.id);
                    }).finally(() => setConnectionBusy(false));
                  }}
                >
                  {connectionBusy ? "연결 확인 중…" : "등록하고 모델 조회"}
                </button>
                <button
                  className="button subtle full"
                  onClick={() =>
                    setConnectionForm({
                      id: id(),
                      label: "",
                      type: "codex",
                      binary: "codex",
                    })
                  }
                >
                  입력 초기화
                </button>
              </section>
              <div className="connection-cards">
                {connections.length === 0 && (
                  <div className="panel empty-connection">
                    <span>◉</span>
                    <h2>연결된 CLI가 없습니다</h2>
                    <p>
                      로컬 서비스를 직접 등록하면 조회된 모델을
                      <br />
                      그래프와 노드에 지정할 수 있습니다.
                    </p>
                  </div>
                )}
                {connections.map((c) => {
                  const cat = [...catalogs]
                    .reverse()
                    .find(
                      (v) =>
                        v.connectionId === c.id &&
                        v.targetProjectPath === target &&
                        v.binary === c.binary,
                    );
                  return (
                    <article key={c.id} className="panel connection-card">
                      <div className="connection-card-head">
                        <div className={`service-symbol ${c.type}`}>
                          {c.type === "codex"
                            ? "⌘"
                            : c.type === "claude"
                              ? "✳"
                              : "◈"}
                        </div>
                        <div>
                          <h2>{c.label}</h2>
                          <span>{c.type}</span>
                        </div>
                        <span
                          className={`status-pill ${cat?.status === "ready" ? "SUCCESS" : "WAITING_USER"}`}
                        >
                          {querying === c.id
                            ? "조회 중"
                            : cat?.status === "ready"
                              ? "모델 조회 완료"
                              : "조회 필요"}
                        </span>
                      </div>
                      <code className="binary-path">{c.binary}</code>
                      {cat?.error && <p className="field-error">{cat.error}</p>}
                      <div className="model-tags">
                        {cat?.models.slice(0, 8).map((m) => (
                          <span key={m.id} title={m.id}>
                            {m.label}
                          </span>
                        ))}
                        {cat && cat.models.length > 8 && (
                          <span>+{cat.models.length - 8}</span>
                        )}
                      </div>
                      <div className="card-actions">
                        <span>
                          {cat?.queriedAt
                            ? stamp(cat.queriedAt)
                            : "조회된 모델만 선택할 수 있습니다."}
                        </span>
                        <button
                          className="button subtle small"
                          disabled={querying === c.id}
                          onClick={() => void query(c.id)}
                        >
                          모델 다시 조회
                        </button>
                        <button
                          className="text-button"
                          onClick={() => setConnectionForm(c)}
                        >
                          수정
                        </button>
                        <button
                          className="text-button danger"
                          onClick={() => {
                            if (
                              confirm(
                                `${c.label} 연결을 삭제할까요? 그래프의 연결 참조를 다시 지정해야 합니다.`,
                              )
                            )
                              void attempt(async () => {
                                await api(`/connections/${c.id}`, "DELETE");
                                setConnections((values) =>
                                  values.filter((v) => v.id !== c.id),
                                );
                              });
                          }}
                        >
                          삭제
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            </div>
          </div>
        )}
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
                    {pendingVisit && plan && (
                      <section className="panel plan-review">
                        <div className="plan-review-head">
                          <div>
                            <span className="eyebrow">PLAN APPROVAL</span>
                            <h2>계획을 검토하고 승인하세요</h2>
                            <p>
                              {
                                run.graph.nodes.find(
                                  (n) => n.id === pendingVisit.nodeId,
                                )?.name
                              }{" "}
                              · 방문 {pendingVisit.number} · 문서 rev{" "}
                              {plan.revision}
                            </p>
                          </div>
                          <div>
                            <button
                              className="button subtle"
                              onClick={() => {
                                setPlanEditing(!planEditing);
                                setPlanText(plan.body);
                              }}
                            >
                              {planEditing ? "편집 취소" : "문서 수정"}
                            </button>
                            {planEditing ? (
                              <button
                                className="button primary"
                                disabled={actionBusy || !planText.trim()}
                                onClick={() =>
                                  void act({
                                    type: "edit_plan",
                                    nodeId: pendingVisit.nodeId,
                                    visitId: pendingVisit.id,
                                    choiceId: plan.id,
                                    expectedRevision: plan.revision,
                                    body: planText,
                                  })
                                }
                              >
                                문서 저장
                              </button>
                            ) : (
                              <button
                                className="button primary"
                                disabled={actionBusy}
                                onClick={() =>
                                  void act({
                                    type: "approve_plan",
                                    nodeId: pendingVisit.nodeId,
                                    visitId: pendingVisit.id,
                                    choiceId: plan.id,
                                    expectedRevision: plan.revision,
                                  })
                                }
                              >
                                {actionBusy
                                  ? "처리 중…"
                                  : "이 계획 승인 후 계속"}
                              </button>
                            )}
                          </div>
                        </div>
                        <div className="plan-tabs">
                          {pendingVisit.plans.map((p) => (
                            <button
                              className={p.id === plan.id ? "active" : ""}
                              key={p.id}
                              onClick={() => {
                                setPlanChoice(p.id);
                                setPlanEditing(false);
                              }}
                            >
                              선택지 {p.id} · {p.title}
                            </button>
                          ))}
                        </div>
                        {planEditing ? (
                          <textarea
                            className="plan-editor"
                            aria-label="계획 문서"
                            value={planText}
                            onChange={(e) => setPlanText(e.target.value)}
                          />
                        ) : (
                          <div className="markdown">
                            <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>
                              {plan.body}
                            </ReactMarkdown>
                          </div>
                        )}
                      </section>
                    )}
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
                                      <ReactMarkdown
                                        remarkPlugins={[remarkGfm]}
                                        skipHtml
                                      >
                                        {v.output}
                                      </ReactMarkdown>
                                    </div>
                                  </details>
                                )}
                              </details>
                            ))
                        )}
                      </aside>
                    </div>
                    <section className="panel log-panel">
                      <div className="log-heading">
                        <h2>
                          실행 로그{" "}
                          <span>
                            {visit ? `방문 ${visit.number}` : "실행 준비"}
                          </span>
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
                            el.scrollHeight - el.scrollTop - el.clientHeight <
                            40;
                        }}
                      >
                        {log || "CLI 출력이 도착하면 여기에 표시됩니다."}
                      </pre>
                    </section>
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
      </div>
      {directory && (
        <div className="modal-backdrop">
          <section
            className="directory-modal"
            role="dialog"
            aria-label="프로젝트 폴더 선택"
          >
            <div>
              <h2>프로젝트 폴더 선택</h2>
              <button
                aria-label="폴더 선택 닫기"
                onClick={() => setDirectory(null)}
              >
                ×
              </button>
            </div>
            <code>{directory.path}</code>
            <button
              className="directory-entry"
              disabled={directoryBusy || directory.parent === directory.path}
              onClick={() => void browse(directory.parent)}
            >
              ↥ 상위 폴더
            </button>
            <div className="directory-list">
              {directory.directories.map((name) => (
                <button
                  key={name}
                  className="directory-entry"
                  onClick={() =>
                    void browse(
                      `${directory.path.replace(/[\\/]$/, "")}/${name}`,
                    )
                  }
                >
                  ▣ {name} <span>›</span>
                </button>
              ))}
              {!directory.directories.length && (
                <p className="field-hint">하위 폴더가 없습니다.</p>
              )}
            </div>
            <button
              className="button primary full"
              onClick={() => {
                setTarget(directory.path);
                setDirectory(null);
                setNotice(
                  "대상 프로젝트를 선택했습니다. 이 프로젝트에서 모델을 다시 조회하세요.",
                );
              }}
            >
              이 폴더 사용
            </button>
          </section>
        </div>
      )}
    </div>
  );
}
