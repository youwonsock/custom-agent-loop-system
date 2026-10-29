import type { AgentGraphDocument, LocalConnection } from "./domain";
import { resolveBinding } from "./graph_validation";

/** What this host can enforce beyond each CLI's own sandbox. */
export interface IsolationSupport {
  platform: string;
  /** Kilo tool programs can run in the prepared Apple container VM. */
  programIoVm: boolean;
}

/**
 * Plain-language limits of the program I/O guard for a graph on this host.
 * The guard confines only Kilo tool programs; other CLIs keep their native
 * sandbox, and an unprepared VM runtime stops Kilo nodes before any model call.
 */
export function isolationNotes(
  graph: Pick<AgentGraphDocument, "automation" | "nodes" | "defaultBinding">,
  connections: Pick<LocalConnection, "id" | "label" | "type">[],
  support: IsolationSupport,
): string[] {
  if (!graph.automation?.programIoGuard) return [];
  const bound = graph.nodes
    .map((n) => resolveBinding(graph as AgentGraphDocument, n)?.connectionId)
    .map((id) => connections.find((c) => c.id === id))
    .filter((c): c is (typeof connections)[number] => !!c);
  const notes: string[] = [];
  if (bound.some((c) => c.type === "kilo") && !support.programIoVm)
    notes.push(
      support.platform === "darwin"
        ? "Kilo VM 격리 런타임이 준비되지 않아 Kilo 노드는 모델 호출 전에 BLOCKED로 정지합니다. npm run sandbox:prepare로 준비하세요 (Apple Silicon macOS 26, Apple container 1.6.0)."
        : "이 운영체제는 Kilo VM 격리를 지원하지 않아 Kilo 노드는 모델 호출 전에 BLOCKED로 정지합니다. VM 격리는 Apple Silicon macOS 26에서만 지원합니다.",
    );
  const others = [
    ...new Set(bound.filter((c) => c.type !== "kilo").map((c) => c.label)),
  ];
  if (others.length)
    notes.push(
      `${others.join(", ")}: 프로그램 내부 I/O 격리는 Kilo에만 적용됩니다. 이 연결의 명령은 해당 CLI의 네이티브 샌드박스와 권한 설정으로만 제한됩니다.`,
    );
  return notes;
}
