import { AgentGraphDocument, GraphDiagnostic } from "./domain";

/** Shared by the editor and execution API; runtime still checks actual evidence. */
export function successPathDiagnostics(
  g: AgentGraphDocument,
): GraphDiagnostic[] {
  const out: GraphDiagnostic[] = [];
  const add = (code: string, message: string, nodeId?: string) =>
    out.push({ code, message, ...(nodeId ? { nodeId } : {}) });
  for (const e of g.edges.filter((e) => e.target === "SUCCESS")) {
    if (
      e.outcome !== "success" ||
      g.nodes.find((n) => n.id === e.source)?.type !== "approval"
    )
      add(
        "unsafe_success",
        "완료(SUCCESS)는 최종 승인 노드의 성공 경로로만 연결하세요.",
        e.source,
      );
  }
  // Structural bypass detection. A test node's actual PASS, receipts and freshness
  // are checked again by the runtime, including after a failure edge or recovery.
  const withoutTest = new Set<string>();
  const walkWithoutTest = (id: string | null): void => {
    if (
      !id ||
      withoutTest.has(id) ||
      g.nodes.find((n) => n.id === id)?.type === "test"
    )
      return;
    withoutTest.add(id);
    for (const e of g.edges.filter((e) => e.source === id))
      walkWithoutTest(e.target);
  };
  for (const id of [
    g.entrypoints.start,
    g.entrypoints.reentry,
    g.entrypoints.interrupt,
  ])
    walkWithoutTest(id);
  if (withoutTest.has("SUCCESS"))
    add(
      "test_bypass",
      "실행·재진입·중단 경로에서 테스트를 건너뛰고 완료할 수 없습니다.",
    );
  return out;
}
