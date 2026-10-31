import { useRef } from "react";
import { isolationNotes } from "../../../src/shared/isolation";
import { clientDiagnostics } from "../studioTypes";
import { graphLibraryActions } from "./graphLibraryActions";
import { graphNodeActions } from "./graphNodeActions";
import { useGraphDraft } from "./useGraphDraft";
import type { StudioData } from "./useStudioData";

export function useGraphEditor(
  data: Pick<
    StudioData,
    | "boot"
    | "view"
    | "setView"
    | "setGraphs"
    | "setNotice"
    | "setError"
    | "refreshGraphs"
    | "connections"
  >,
) {
  const { boot, connections } = data;
  const graph = useGraphDraft(data);
  const { draft, selectedNode } = graph;
  const goalRef = useRef<HTMLTextAreaElement | null>(null),
    importRef = useRef<HTMLInputElement | null>(null);
  const selected = draft?.nodes.find((n) => n.id === selectedNode),
    issues = draft ? clientDiagnostics(draft) : [],
    isolation =
      draft && boot?.isolation
        ? isolationNotes(draft, connections, boot.isolation)
        : [];
  return {
    ...graph,
    ...graphLibraryActions(data, graph),
    ...graphNodeActions(graph),
    goalRef,
    importRef,
    selected,
    issues,
    isolation,
  };
}
export type GraphEditor = ReturnType<typeof useGraphEditor>;
