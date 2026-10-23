import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { Connection } from "@xyflow/react";
import { type AgentGraphDocument, type AgentNode } from "../../../src/shared/domain";
import { api, ApiError, id } from "../api";
import { typeMeta } from "../nodeMeta";
import { backupKey, fingerprint, clientDiagnostics } from "../studioTypes";
import type { StudioData } from "./useStudioData";

export function useGraphEditor(data: Pick<StudioData, "boot" | "view" | "setView" | "setGraphs" | "setNotice" | "setError" | "refreshGraphs">) {
  const {
    boot,
    view,
    setView,
    setGraphs,
    setNotice,
    setError,
    refreshGraphs,
  } = data;
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
  const goalRef = useRef<HTMLTextAreaElement | null>(null),
    importRef = useRef<HTMLInputElement | null>(null);
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
    if (boot?.graphs[0]) installDraft(boot.graphs[0], true, boot.root);
  }, [boot, installDraft]);
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
  const selected = draft?.nodes.find((n) => n.id === selectedNode),
    issues = draft ? clientDiagnostics(draft) : [];
  const updateNode = (fn: (n: AgentNode) => void) =>
    change((g) => {
      const n = g.nodes.find((n) => n.id === selectedNode);
      if (n) fn(n);
    });

  return {
    draft,
    setDraft,
    draftRef,
    dirty,
    saveStatus,
    conflict,
    conflictRef,
    setConflict,
    graphBusy,
    past,
    future,
    selectedNode,
    setSelectedNode,
    goalRef,
    importRef,
    installDraft,
    change,
    saveLatest,
    flush,
    undo,
    redo,
    graphAction,
    selectGraph,
    newGraph,
    copyGraph,
    importGraph,
    exportGraph,
    removeNodes,
    addNode,
    connect,
    selected,
    issues,
    updateNode,
  };
}
export type GraphEditor = ReturnType<typeof useGraphEditor>;
