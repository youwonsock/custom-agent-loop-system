import { randomUUID } from "node:crypto";
import {
  AgentGraphDocument,
  AgentNode,
  ExecutionBinding,
  NODE_TYPES,
  Terminal,
} from "../shared/domain";
import { AppError } from "./errors";
export { graphDiagnostics, resolveBinding } from "../shared/graph_validation";

export const safeId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);
const text = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 200_000;
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
function checkBinding(value: unknown): void {
  if (value === undefined) return;
  const b = value as ExecutionBinding;
  if (
    !b ||
    (b.connectionId !== "" && !safeId(b.connectionId)) ||
    !text(b.modelId) ||
    (b.variant !== undefined && !text(b.variant))
  )
    throw new AppError(400, "실행 연결과 모델 설정 형식이 잘못되었습니다.");
}
const cleanBinding = (b: ExecutionBinding): ExecutionBinding => ({
  connectionId: b.connectionId,
  modelId: b.modelId,
  ...(b.variant ? { variant: b.variant } : {}),
});
/** Draft validation deliberately allows missing edges and unresolved references. */
export function validateGraphDocument(input: unknown): AgentGraphDocument {
  const g = input as AgentGraphDocument;
  if (!g || g.version !== 2)
    throw new AppError(
      400,
      "version 2 그래프 문서만 지원합니다. 레거시 형식은 지원하지 않습니다.",
    );
  if (
    !safeId(g.id) ||
    !Number.isSafeInteger(g.revision) ||
    g.revision < 0 ||
    !text(g.name) ||
    !text(g.description) ||
    !Array.isArray(g.nodes) ||
    !Array.isArray(g.edges) ||
    g.nodes.length > 250 ||
    g.edges.length > 500
  )
    throw new AppError(400, "그래프 문서 형식이 잘못되었습니다.");
  if (
    g.automation &&
    (!Number.isInteger(g.automation.maxRepairCycles) ||
      g.automation.maxRepairCycles < 1 ||
      g.automation.maxRepairCycles > 20 ||
      typeof g.automation.nativeApprovalReview !== "boolean" ||
      (g.automation.browserVerification !== undefined &&
        typeof g.automation.browserVerification !== "boolean") ||
      (g.automation.verificationContract !== undefined && typeof g.automation.verificationContract !== "boolean") ||
      (g.automation.authoredNodeTests !== undefined && typeof g.automation.authoredNodeTests !== "boolean") ||
      (g.automation.testSourceGuard !== undefined && typeof g.automation.testSourceGuard !== "boolean") ||
      (g.automation.reserveFinalizationBudget !== undefined && typeof g.automation.reserveFinalizationBudget !== "boolean") ||
      (g.automation.guardOwnedProcesses !== undefined && typeof g.automation.guardOwnedProcesses !== "boolean") ||
      (g.automation.targetScopeGuard !== undefined && typeof g.automation.targetScopeGuard !== "boolean"))
  )
    throw new AppError(
      400,
      "자동 수정 횟수는 1~20이며 네이티브 승인 검토 설정이 필요합니다.",
    );
  const nodeIds = new Set<string>(),
    edgeIds = new Set<string>();
  for (const n of g.nodes) {
    if (
      !n ||
      !safeId(n.id) ||
      ["SUCCESS", "PAUSED"].includes(n.id) ||
      nodeIds.has(n.id) ||
      !NODE_TYPES.includes(n.type) ||
      !text(n.name) ||
      !text(n.roleName) ||
      !text(n.instructions) ||
      !n.position ||
      !finite(n.position.x) ||
      !finite(n.position.y)
    )
      throw new AppError(400, "노드 ID, 실행 유형 또는 속성이 잘못되었습니다.");
    nodeIds.add(n.id);
    checkBinding(n.binding);
    if (
      n.planning &&
      (typeof n.planning.requiresApproval !== "boolean" ||
        !Number.isInteger(n.planning.optionsCount) ||
        n.planning.optionsCount < 1 ||
        n.planning.optionsCount > 20)
    )
      throw new AppError(400, "계획 선택지 수는 1~20이어야 합니다.");
  }
  for (const e of g.edges) {
    if (
      !e ||
      !safeId(e.id) ||
      edgeIds.has(e.id) ||
      !safeId(e.source) ||
      !safeId(e.target) ||
      !["success", "failure"].includes(e.outcome)
    )
      throw new AppError(400, "그래프 연결 형식이 잘못되었습니다.");
    edgeIds.add(e.id);
  }
  if (
    !g.entrypoints ||
    !["start", "reentry", "interrupt", "cycleCompletion"].every(
      (k) =>
        (g.entrypoints as unknown as Record<string, unknown>)[k] === null ||
        safeId((g.entrypoints as unknown as Record<string, unknown>)[k]),
    )
  )
    throw new AppError(400, "실행 진입점 형식이 잘못되었습니다.");
  if (
    !g.viewport ||
    !finite(g.viewport.x) ||
    !finite(g.viewport.y) ||
    !finite(g.viewport.zoom) ||
    g.viewport.zoom <= 0 ||
    g.viewport.zoom > 10
  )
    throw new AppError(400, "화면 배치 정보가 잘못되었습니다.");
  checkBinding(g.defaultBinding);
  // Whitelist fields: imported files cannot smuggle runtime configuration or credentials.
  return structuredClone({
    version: 2,
    id: g.id,
    revision: g.revision,
    name: g.name,
    description: g.description,
    nodes: g.nodes.map((n) => ({
      id: n.id,
      name: n.name,
      roleName: n.roleName,
      type: n.type,
      instructions: n.instructions,
      position: { x: n.position.x, y: n.position.y },
      ...(n.binding ? { binding: cleanBinding(n.binding) } : {}),
      ...(n.planning
        ? {
            planning: {
              requiresApproval: n.planning.requiresApproval,
              optionsCount: n.planning.optionsCount,
            },
          }
        : {}),
    })),
    edges: g.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      outcome: e.outcome,
    })),
    entrypoints: {
      start: g.entrypoints.start,
      reentry: g.entrypoints.reentry,
      interrupt: g.entrypoints.interrupt,
      cycleCompletion: g.entrypoints.cycleCompletion,
    },
    ...(g.defaultBinding
      ? { defaultBinding: cleanBinding(g.defaultBinding) }
      : {}),
    ...(g.automation
      ? {
          automation: {
            maxRepairCycles: g.automation.maxRepairCycles,
            nativeApprovalReview: g.automation.nativeApprovalReview,
            ...(g.automation.browserVerification !== undefined
              ? { browserVerification: g.automation.browserVerification }
              : {}),
            ...(g.automation.verificationContract !== undefined ? { verificationContract: g.automation.verificationContract } : {}),
            ...(g.automation.authoredNodeTests !== undefined ? { authoredNodeTests:g.automation.authoredNodeTests } : {}),
            ...(g.automation.testSourceGuard !== undefined ? {testSourceGuard:g.automation.testSourceGuard} : {}),
            ...(g.automation.reserveFinalizationBudget !== undefined ? {reserveFinalizationBudget:g.automation.reserveFinalizationBudget} : {}),
            ...(g.automation.guardOwnedProcesses !== undefined ? {guardOwnedProcesses:g.automation.guardOwnedProcesses} : {}),
            ...(g.automation.targetScopeGuard !== undefined ? {targetScopeGuard:g.automation.targetScopeGuard} : {}),
          },
        }
      : {}),
    viewport: { x: g.viewport.x, y: g.viewport.y, zoom: g.viewport.zoom },
    updatedAt:
      typeof g.updatedAt === "string" ? g.updatedAt : new Date().toISOString(),
  });
}
export function transition(
  g: AgentGraphDocument,
  nodeId: string,
  outcome: "success" | "failure",
): string | Terminal {
  const edge = g.edges.find(
    (e) => e.source === nodeId && e.outcome === outcome,
  );
  if (!edge) throw new AppError(400, "실행 경로가 누락되었습니다.");
  return edge.target;
}
export function createGraph(
  name = "새 그래프",
  empty = false,
): AgentGraphDocument {
  const nodes: AgentNode[] = empty
    ? []
    : NODE_TYPES.map((type, index) => ({
        id: type,
        name: {
          planning: "계획 수립",
          implementation: "구현",
          test: "테스트",
          review: "QA 검토",
          approval: "최종 승인",
          interrupt: "중단 분석",
        }[type],
        roleName: {
          planning: "Planner",
          implementation: "Builder",
          test: "Tester",
          review: "QA Lead",
          approval: "Reviewer",
          interrupt: "Interrupter",
        }[type],
        type,
        instructions: "",
        position: {
          x: 40 + (index % 3) * 340,
          y: 80 + Math.floor(index / 3) * 260,
        },
        ...(type === "planning"
          ? { planning: { requiresApproval: true, optionsCount: 3 } }
          : {}),
      }));
  const destinations: Record<string, [string, string]> = {
    planning: ["implementation", "interrupt"],
    implementation: ["test", "interrupt"],
    test: ["review", "review"],
    review: ["approval", "implementation"],
    approval: ["SUCCESS", "implementation"],
    interrupt: ["PAUSED", "PAUSED"],
  };
  return {
    version: 2,
    id: randomUUID(),
    revision: 0,
    name,
    description: "",
    nodes,
    edges: empty
      ? []
      : nodes.flatMap((n) =>
          (["success", "failure"] as const).map((outcome, i) => ({
            id: `${n.id}-${outcome}`,
            source: n.id,
            target: destinations[n.id]![i]!,
            outcome,
          })),
        ),
    entrypoints: {
      start: empty ? null : "planning",
      reentry: empty ? null : "implementation",
      interrupt: empty ? null : "interrupt",
      cycleCompletion: empty ? null : "review",
    },
    viewport: { x: 0, y: 0, zoom: 1 },
    updatedAt: new Date().toISOString(),
  };
}

/** Explicit opt-in preset; existing graphs and manual plan gates remain unchanged. */
export function createAutonomousGraph(
  name = "자율 제작·검증 루프",
): AgentGraphDocument {
  const graph = createGraph(name);
  graph.automation = {
    maxRepairCycles: 5,
    nativeApprovalReview: true,
    browserVerification: true,
    verificationContract: true,
    authoredNodeTests: true,
    testSourceGuard: true,
    reserveFinalizationBudget: true,
    guardOwnedProcesses:true,
    targetScopeGuard:true,
  };
  graph.nodes.find((n) => n.type === "planning")!.planning = {
    requiresApproval: false,
    optionsCount: 1,
  };
  graph.edges.find(
    (e) => e.source === "test" && e.outcome === "failure",
  )!.target = "implementation";
  return graph;
}
