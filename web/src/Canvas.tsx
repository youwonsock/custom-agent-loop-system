import { useCallback, useEffect, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  applyNodeChanges,
  useNodesInitialized,
  useReactFlow,
  type Node,
  type NodeProps,
  type NodeChange,
  type Connection,
  type Edge,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type {
  AgentGraphDocument,
  AgentNode,
  SessionState,
  ExecutionBinding,
  LocalConnection,
} from "../../src/shared/domain";
export const typeMeta = {
  planning: { label: "계획", color: "#a795ff", icon: "◈" },
  implementation: { label: "구현", color: "#78b5ff", icon: "⌘" },
  test: { label: "테스트", color: "#5bd5b4", icon: "✓" },
  review: { label: "검토", color: "#f3c77c", icon: "◎" },
  approval: { label: "승인", color: "#f19ccb", icon: "◇" },
  interrupt: { label: "중단", color: "#ef8f88", icon: "Ⅱ" },
};
type CardData = {
  node: AgentNode;
  binding?: ExecutionBinding;
  connection?: LocalConnection;
  status?: string;
  visitNumber?: number;
  [key: string]: unknown;
};
type FlowNode = Node<CardData, "agent"> | Node<{ label: string }, "terminal">;
function AgentCard({ data, selected }: NodeProps<Node<CardData, "agent">>) {
  const m = typeMeta[data.node.type];
  return (
    <div
      className={`agent-node ${selected ? "selected" : ""}`}
      style={{ "--node-color": m.color } as React.CSSProperties}
      data-testid={`node-${data.node.id}`}
    >
      <Handle type="target" position={Position.Left} id="in" />
      <div className="node-cap">
        <span className="node-icon">{m.icon}</span>
        <span>{m.label}</span>
        {data.status && (
          <span className={`node-status ${data.status}`}>
            {data.status === "waiting_approval"
              ? "승인 대기"
              : data.status === "running"
                ? "실행 중"
                : data.status === "succeeded"
                  ? "완료"
                  : data.status === "failed"
                    ? "반려"
                    : "일시정지"}
          </span>
        )}
      </div>
      <strong className="node-name">
        {data.node.name || "이름 없는 노드"}
      </strong>
      <span className="node-role">{data.node.roleName || "역할 미지정"}</span>
      <div className="node-model">
        <span>◉</span>
        <span title={data.binding?.modelId}>
          {data.binding?.modelId || "모델 미지정"}
        </span>
      </div>
      <div className="port-label success-label">
        성공 <i />
      </div>
      <div className="port-label failure-label">
        실패 <i />
      </div>
      <Handle
        className="success-port"
        type="source"
        position={Position.Right}
        id="success"
        style={{ top: "72%" }}
      />
      <Handle
        className="failure-port"
        type="source"
        position={Position.Right}
        id="failure"
        style={{ top: "91%" }}
      />
      {data.visitNumber && (
        <div className="visit-number">방문 {data.visitNumber}</div>
      )}
    </div>
  );
}
function TerminalCard({
  data,
}: NodeProps<Node<{ label: string }, "terminal">>) {
  return (
    <div
      className={`terminal-node ${data.label === "완료" ? "success" : "paused"}`}
    >
      <Handle type="target" position={Position.Top} id="in" />
      <span>{data.label === "완료" ? "✓" : "Ⅱ"}</span>
      {data.label}
    </div>
  );
}
const nodeTypes = { agent: AgentCard, terminal: TerminalCard };
function FitLifecycle({
  graphId,
  container,
  viewport,
}: {
  graphId: string;
  container: React.RefObject<HTMLDivElement | null>;
  viewport: AgentGraphDocument["viewport"];
}) {
  const initialized = useNodesInitialized(),
    { fitView, setViewport } = useReactFlow();
  const restored = useRef<string | null>(null),
    saved = useRef(viewport);
  saved.current = viewport;
  useEffect(() => {
    if (!initialized || !container.current) return;
    let frame = 0,
      cancelled = false;
    const fit = (restoreSaved = false) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const value = saved.current;
        const apply =
          restoreSaved && (value.x !== 0 || value.y !== 0 || value.zoom !== 1)
            ? setViewport(value)
            : fitView({ padding: 0.15, maxZoom: 1 });
        void apply.then((applied) => {
          if (cancelled) return;
          if (applied) restored.current = graphId;
          else fit(restoreSaved);
        });
      });
    };
    if (restored.current !== graphId) {
      fit(true);
    }
    let firstResize = true;
    const observer = new ResizeObserver(() => {
      if (firstResize) {
        firstResize = false;
        return;
      }
      fit();
    });
    observer.observe(container.current);
    return () => {
      cancelled = true;
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [initialized, graphId, fitView, setViewport, container]);
  return null;
}
export function Canvas({
  graph,
  connections,
  selected,
  onSelect,
  onPosition,
  onConnect,
  onViewport,
  onRemove,
  run,
  readonly = false,
}: {
  graph: AgentGraphDocument;
  connections: LocalConnection[];
  selected: string | null;
  onSelect: (id: string | null) => void;
  onPosition?: (id: string, x: number, y: number) => void;
  onConnect?: (connection: Connection) => void;
  onViewport?: (v: { x: number; y: number; zoom: number }) => void;
  onRemove?: (ids: string[], edges: string[]) => void;
  run?: SessionState;
  readonly?: boolean;
}) {
  const dragging = useRef(false),
    gesture = useRef(false);
  const container = useRef<HTMLDivElement | null>(null);
  const makeNodes = useCallback((): FlowNode[] => {
    const agents = graph.nodes.map((n): FlowNode => {
      const binding = n.binding ?? graph.defaultBinding,
        last = run?.visits.filter((v) => v.nodeId === n.id).at(-1);
      return {
        id: n.id,
        type: "agent",
        position: n.position,
        selected: selected === n.id,
        data: {
          node: n,
          binding,
          connection: connections.find((c) => c.id === binding?.connectionId),
          status: last?.status,
          visitNumber: last?.number,
        },
      };
    });
    const terminal = (
      key: string,
      label: string,
      defaultX: number,
    ): FlowNode => {
      const source = graph.nodes.find((n) =>
        graph.edges.some((e) => e.source === n.id && e.target === key),
      );
      return {
        id: key,
        type: "terminal",
        position: {
          x: (source?.position.x ?? defaultX) + 45,
          y: (source?.position.y ?? 300) + 235,
        },
        draggable: false,
        selectable: false,
        data: { label },
      };
    };
    return [
      ...agents,
      terminal("SUCCESS", "완료", 380),
      terminal("PAUSED", "일시정지", 720),
    ];
  }, [graph, selected, run, connections]);
  const [nodes, setNodes] = useState<FlowNode[]>(makeNodes);
  useEffect(() => {
    if (!dragging.current) setNodes(makeNodes());
  }, [makeNodes]);
  const edges: Edge[] = graph.edges
    .filter(
      (e) =>
        graph.nodes.some((n) => n.id === e.source) &&
        (graph.nodes.some((n) => n.id === e.target) ||
          ["SUCCESS", "PAUSED"].includes(e.target)),
    )
    .map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.outcome,
      targetHandle: "in",
      type: "smoothstep",
      style: {
        stroke: e.outcome === "success" ? "#69bca6" : "#b48498",
        strokeWidth: 1.6,
      },
      label: e.outcome === "success" ? "성공" : "실패",
      labelStyle: { fill: "#a7b5c5", fontSize: 10 },
      labelBgStyle: { fill: "#141e2a" },
      animated: run?.status === "RUNNING" && run.currentNodeId === e.source,
    }));
  return (
    <div
      ref={container}
      className="graph-canvas"
      data-testid="graph-canvas"
      onWheel={() => {
        gesture.current = true;
      }}
      onPointerDown={(event) => {
        const target = event.target as HTMLElement;
        if (
          target.closest(".react-flow__controls") ||
          target.classList.contains("react-flow__pane")
        )
          gesture.current = true;
      }}
    >
      <ReactFlow<FlowNode, Edge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={(changes: NodeChange<FlowNode>[]) =>
          setNodes((values) => applyNodeChanges(changes, values))
        }
        onNodeClick={(_event, node) => {
          if (node.type === "agent") onSelect(node.id);
        }}
        onPaneClick={() => onSelect(null)}
        onNodeDragStart={() => {
          dragging.current = true;
        }}
        onNodeDragStop={(_event, node) => {
          dragging.current = false;
          onPosition?.(node.id, node.position.x, node.position.y);
        }}
        onConnect={onConnect}
        onMoveEnd={(_event, v) => {
          if (gesture.current) onViewport?.(v);
          gesture.current = false;
        }}
        onNodesDelete={(items) =>
          onRemove?.(
            items.filter((n) => n.type === "agent").map((n) => n.id),
            [],
          )
        }
        onEdgesDelete={(items) =>
          onRemove?.(
            [],
            items.map((e) => e.id),
          )
        }
        nodesDraggable={!readonly}
        nodesConnectable={!readonly}
        edgesReconnectable={false}
        deleteKeyCode={readonly ? null : ["Backspace", "Delete"]}
        minZoom={0.25}
        maxZoom={1.8}
        proOptions={{ hideAttribution: false }}
      >
        <FitLifecycle
          graphId={graph.id}
          viewport={graph.viewport}
          container={container}
        />
        <Background color="#293448" gap={24} size={1} />
        <Controls showInteractive={false} />
        <MiniMap
          position="bottom-left"
          style={{ left: 63, bottom: 17 }}
          nodeColor={(node) =>
            node.type === "agent"
              ? typeMeta[(node.data as CardData).node.type].color
              : "#708197"
          }
          maskColor="rgba(12,18,28,.72)"
          pannable
          zoomable
        />
      </ReactFlow>
      {!graph.nodes.length && (
        <div className="canvas-empty">
          <span>◈</span>
          <h2>첫 에이전트를 추가하세요</h2>
          <p>역할을 정하고 성공·실패 경로를 연결해 실행 흐름을 만드세요.</p>
        </div>
      )}
      <div className="canvas-legend">
        <span>
          <i className="dot green" />
          성공 경로
        </span>
        <span>
          <i className="dot rose" />
          실패 경로
        </span>
        <span>드래그로 연결 · 휠로 확대</span>
      </div>
    </div>
  );
}
