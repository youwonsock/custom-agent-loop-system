import { useCallback, useEffect, useState } from "react";
import {
  type AgentGraphDocument,
  type LocalConnection,
  type ModelCatalog,
  type SessionState,
  type StudioEvent,
} from "../../../src/shared/domain";
import { api } from "../api";
import { type Bootstrap } from "../studioTypes";

export function useStudioData() {
  const [boot, setBoot] = useState<Bootstrap | null>(null),
    [loadError, setLoadError] = useState(""),
    [view, setView] = useState<"graphs" | "connections" | "runs">("graphs");
  const [graphs, setGraphs] = useState<AgentGraphDocument[]>([]),
    [connections, setConnections] = useState<LocalConnection[]>([]),
    [catalogs, setCatalogs] = useState<ModelCatalog[]>([]),
    [sessions, setSessions] = useState<SessionState[]>([]);
  const [target,setTarget] = useState(""), [goal,setGoal] = useState("");
  const [notice,setNotice] = useState(""), [error,setError] = useState("");
  const [directory, setDirectory] = useState<{
      path: string;
      parent: string;
      directories: string[];
    } | null>(null),
    [directoryBusy, setDirectoryBusy] = useState(false);
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
  const browse = async (value = target) => {
    setDirectoryBusy(true);
    await attempt(async () =>
      setDirectory(await api(`/directories?path=${encodeURIComponent(value)}`)),
    );
    setDirectoryBusy(false);
  };

  return {
    boot,
    loadError,
    view,
    setView,
    graphs,
    setGraphs,
    connections,
    setConnections,
    catalogs,
    setCatalogs,
    sessions,
    setSessions,
    target,
    setTarget,
    goal,
    setGoal,
    notice,
    setNotice,
    error,
    setError,
    directory,
    setDirectory,
    directoryBusy,
    setDirectoryBusy,
    refreshGraphs,
    attempt,
    browse,
  };
}
export type StudioData = ReturnType<typeof useStudioData>;
