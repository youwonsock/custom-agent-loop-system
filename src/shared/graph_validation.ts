import type {
  AgentGraphDocument,
  AgentNode,
  ExecutionBinding,
  GraphDiagnostic,
} from "./domain";
import { successPathDiagnostics } from "./graph_success";

export function resolveBinding(
  g: AgentGraphDocument,
  n: AgentNode,
): ExecutionBinding | undefined {
  return n.binding ?? g.defaultBinding;
}
export function graphDiagnostics(
  g: AgentGraphDocument,
  requireBindings = true,
): GraphDiagnostic[] {
  const out: GraphDiagnostic[] = [],
    ids = new Set(g.nodes.map((n) => n.id));
  const add = (code: string, message: string, nodeId?: string) =>
    out.push({ code, message, ...(nodeId ? { nodeId } : {}) });
  if (!g.name.trim()) add("name", "그래프 이름을 입력하세요.");
  if (!g.nodes.length) add("empty", "실행할 노드를 추가하세요.");
  for (const [key, value] of Object.entries(g.entrypoints))
    if (!value || !ids.has(value))
      add("entrypoint", `${key} 실행 지점을 지정하세요.`);
  if (
    g.entrypoints.interrupt &&
    g.nodes.find((n) => n.id === g.entrypoints.interrupt)?.type !== "interrupt"
  )
    add(
      "interrupt",
      "중단 처리 지점은 interrupt 유형이어야 합니다.",
      g.entrypoints.interrupt,
    );
  for (const n of g.nodes) {
    if (!n.name.trim() || !n.roleName.trim())
      add("node_name", "노드와 역할 이름을 입력하세요.", n.id);
    const binding = resolveBinding(g, n);
    if (requireBindings && (!binding?.connectionId || !binding.modelId.trim()))
      add("binding", "조회된 모델과 실행 연결을 선택하세요.", n.id);
    for (const outcome of ["success", "failure"] as const) {
      const edges = g.edges.filter(
        (e) => e.source === n.id && e.outcome === outcome,
      );
      if (edges.length !== 1)
        add(
          "edge_count",
          `${n.name}의 ${outcome === "success" ? "성공" : "실패"} 경로를 하나 지정하세요.`,
          n.id,
        );
    }
  }
  for (const e of g.edges)
    if (
      !ids.has(e.source) ||
      (!ids.has(e.target) && !["SUCCESS", "PAUSED"].includes(e.target))
    )
      add(
        "dangling",
        "존재하지 않는 노드를 참조하는 연결이 있습니다.",
        e.source,
      );
  const exits = new Set<string>(["SUCCESS", "PAUSED"]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const n of g.nodes)
      if (
        !exits.has(n.id) &&
        g.edges.some((e) => e.source === n.id && exits.has(e.target))
      ) {
        exits.add(n.id);
        changed = true;
      }
  }
  for (const n of g.nodes)
    if (!exits.has(n.id))
      add(
        "trapped_cycle",
        "완료 또는 일시정지로 나갈 수 있는 경로가 없습니다.",
        n.id,
      );
  const reachable = new Set<string>();
  const walk = (id: string | null) => {
    if (!id || reachable.has(id)) return;
    reachable.add(id);
    for (const e of g.edges.filter((e) => e.source === id)) walk(e.target);
  };
  walk(g.entrypoints.start);
  walk(g.entrypoints.interrupt);
  walk(g.entrypoints.reentry);
  for (const n of g.nodes)
    if (!reachable.has(n.id))
      add("unreachable", "어떤 실행 진입점에서도 도달할 수 없습니다.", n.id);
  out.push(...successPathDiagnostics(g));
  return out;
}
