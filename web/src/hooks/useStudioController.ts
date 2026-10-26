import { useStudioData } from "./useStudioData";
import { useGraphEditor } from "./useGraphEditor";
import { useConnections } from "./useConnections";
import { useRunController } from "./useRunController";

// Controllers remain mounted when lazy views change, preserving drafts and approvals.
export function useStudioController() {
  const data = useStudioData();
  const graph = useGraphEditor(data);
  const connections = useConnections(data);
  const runs = useRunController(data, graph);
  return {
    ...data,
    ...graph,
    ...connections,
    ...runs,
  };
}
