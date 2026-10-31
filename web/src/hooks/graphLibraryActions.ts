import { flushSync } from "react-dom";
import type { AgentGraphDocument } from "../../../src/shared/domain";
import { api } from "../api";
import { backupKey } from "../studioTypes";
import type { GraphDraft } from "./useGraphDraft";
import type { StudioData } from "./useStudioData";

/** Moves between saved graphs; each action finishes the current save first. */
export function graphLibraryActions(
  {
    boot,
    setView,
    setNotice,
    refreshGraphs,
  }: Pick<StudioData, "boot" | "setView" | "setNotice" | "refreshGraphs">,
  {
    draftRef,
    dirty,
    conflictRef,
    setConflict,
    setGraphBusy,
    graphBusyRef,
    installDraft,
    flush,
  }: GraphDraft,
) {
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
  const newGraph = (empty = false, autonomous = false) =>
    graphAction(async () => {
      await flush();
      const g = await api<AgentGraphDocument>("/graphs", "POST", {
        name: empty
          ? "새 빈 그래프"
          : autonomous
            ? "자율 제작·검증 루프"
            : "새 상호검증 루프",
        empty,
        ...(autonomous ? { template: "autonomous" } : {}),
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
  return {
    graphAction,
    selectGraph,
    newGraph,
    copyGraph,
    importGraph,
    exportGraph,
  };
}
