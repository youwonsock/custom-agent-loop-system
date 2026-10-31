import type { Connection } from "@xyflow/react";
import type { AgentNode } from "../../../src/shared/domain";
import { defaultNode } from "../../../src/shared/graph_defaults";
import { id } from "../api";
import { typeMeta } from "../nodeMeta";
import type { GraphDraft } from "./useGraphDraft";

export function graphNodeActions({
  change,
  selectedNode,
  setSelectedNode,
}: GraphDraft) {
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
      g.nodes.push(
        defaultNode({
          id: nodeId,
          type,
          name: `새 ${typeMeta[type].label} 노드`,
          roleName: typeMeta[type].label,
          index: g.nodes.length,
          left: 80,
          columnWidth: 320,
        }),
      );
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
  const updateNode = (fn: (n: AgentNode) => void) =>
    change((g) => {
      const n = g.nodes.find((n) => n.id === selectedNode);
      if (n) fn(n);
    });
  return { removeNodes, addNode, connect, updateNode };
}
