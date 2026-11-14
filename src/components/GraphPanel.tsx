import { memo, useEffect, useMemo, useRef } from "react";
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge as FlowEdge,
  type Node as FlowNode,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { EffGraph } from "../lib/graph.ts";
import type { AnchorMap, OnScreen } from "../lib/resolve.ts";
import { layoutGraph, type Positions } from "../lib/layout.ts";
import { adjacency, parentsOf, visibleSet, type Scope } from "../lib/focus.ts";
import { REL_COLOR } from "../lib/palette.ts";
import { CardBody, type CardProps } from "./Card.tsx";

export type Selection = { kind: "node" | "edge"; id: string } | null;

interface Props {
  eff: EffGraph;
  anchors: AnchorMap;
  positions: Positions;
  onScreen: OnScreen;
  selection: Selection;
  hover: string | null;
  scope: Scope;
  markFocus: { id: string } | null;
  onMarkFocusHandled(value: null): void;
  onSelect(s: Selection): void;
  onHover(id: string | null): void;
}

export interface CardData extends Record<string, unknown>, Omit<CardProps, "style"> {}

const Card = memo(function Card({ data }: NodeProps<FlowNode<CardData>>) {
  return (
    <>
      <Handle type="target" position={Position.Top} id="top-t" className="h" />
      <Handle type="source" position={Position.Top} id="top-s" className="h" />
      <CardBody {...data} />
      <Handle type="target" position={Position.Bottom} id="bottom-t" className="h" />
      <Handle type="source" position={Position.Bottom} id="bottom-s" className="h" />
    </>
  );
});

const nodeTypes = { card: Card };

function Inner(p: Props) {
  const { eff, anchors, positions, onScreen, selection, hover, scope } = p;
  const rf = useReactFlow();

  const adj = useMemo(() => adjacency(eff), [eff]);
  const parents = useMemo(() => parentsOf(eff), [eff]);
  const visible = useMemo(
    () => visibleSet(eff, onScreen, selection, scope, adj, parents).ids,
    [eff, onScreen, selection, scope, adj, parents],
  );

  // On screen: a compact layered layout of just the visible records, shifted
  // so records that were already on the canvas stay (on average) where they were.
  const prevLocal = useRef<Positions>(new Map());
  const shown: Positions = useMemo(() => {
    if (scope === "full") return positions;
    const sub = {
      nodes: eff.nodes.filter((n) => visible.has(n.id)),
      edges: eff.edges.filter((e) => visible.has(e.subject) && visible.has(e.object)),
    };
    const L = layoutGraph(sub);
    const prev = prevLocal.current;
    let dx = 0;
    let dy = 0;
    let k = 0;
    for (const [id, p] of L) {
      const q = prev.get(id);
      if (q) {
        dx += q.x - p.x;
        dy += q.y - p.y;
        k++;
      }
    }
    if (k) for (const [id, p] of L) L.set(id, { ...p, x: p.x + dx / k, y: p.y + dy / k });
    prevLocal.current = L;
    return L;
  }, [scope, positions, eff, visible]);

  const related = useMemo(() => {
    const r = new Set<string>();
    if (selection?.kind === "node") for (const nb of adj.get(selection.id) ?? []) r.add(nb);
    return r;
  }, [selection, adj]);

  // React Flow hides a node (visibility: hidden) whenever it receives a new node
  // object without a measured size, until it re-measures it. Rebuilding every
  // node on each hover made all cards blink, and the hovered card dropped out
  // from under the pointer (an enter/leave loop). So: reuse the previous object
  // when nothing about the card changed, and carry the measured size over.
  const prevNodes = useRef(new Map<string, FlowNode<CardData>>());
  const nodes: FlowNode<CardData>[] = useMemo(() => {
    const next = new Map<string, FlowNode<CardData>>();
    const out = eff.nodes
      .filter((n) => visible.has(n.id))
      .map((n) => {
        const pos = shown.get(n.id) ?? { x: 0, y: 0, w: 232, h: 80 };
        const isSel = selection?.kind === "node" && selection.id === n.id;
        const on = onScreen.get(n.id);
        const data: CardData = {
          node: n,
          on,
          dim: !on && !isSel && hover !== n.id,
          selected: isSel,
          related: related.has(n.id),
          hovered: hover === n.id,
        };
        const old = prevNodes.current.get(n.id);
        const same =
          old &&
          old.position.x === pos.x &&
          old.position.y === pos.y &&
          old.style?.width === pos.w &&
          (Object.keys(data) as (keyof CardData)[]).every((k) => old.data[k] === data[k]);
        const node: FlowNode<CardData> = same
          ? old
          : {
              id: n.id,
              type: "card",
              position: { x: pos.x, y: pos.y },
              style: { width: pos.w },
              measured: rf.getInternalNode(n.id)?.measured,
              data,
            };
        next.set(n.id, node);
        return node;
      });
    prevNodes.current = next;
    return out;
  }, [eff, visible, shown, adj, anchors, onScreen, selection, related, hover, rf]);

  const edges: FlowEdge[] = useMemo(
    () =>
      eff.edges
        .filter((e) => visible.has(e.subject) && visible.has(e.object))
        .map((e) => {
          const s = shown.get(e.subject);
          const o = shown.get(e.object);
          const up = !s || !o || s.y >= o.y;
          const color = REL_COLOR[e.relation] ?? "#777";
          const isSel = selection?.kind === "edge" && selection.id === e.id;
          const touches = selection?.kind === "node" && (selection.id === e.subject || selection.id === e.object);
          const on = onScreen.get(e.id);
          const live = onScreen.has(e.subject) || onScreen.has(e.object);
          const dim = !on && !isSel && !touches && hover !== e.id && (!onScreen.has(e.subject) || !onScreen.has(e.object));
          return {
            id: e.id,
            source: e.subject,
            target: e.object,
            sourceHandle: up ? "top-s" : "bottom-s",
            targetHandle: up ? "bottom-t" : "top-t",
            // named when it touches a record on screen or in hand
            label: isSel || touches || live || hover === e.id ? e.relation + (e.provisional ? " (inferred)" : "") : undefined,
            labelStyle: { fill: color, fontWeight: 600, fontSize: 11 },
            labelBgStyle: { fill: "var(--panel)" },
            className: [e.provisional && "provisional", isSel && "sel", dim && "dim"].filter(Boolean).join(" "),
            style: { stroke: color, strokeWidth: isSel ? 3.2 : touches ? 2.4 : 1.6 },
            markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
            interactionWidth: 14,
          };
        }),
    [eff, visible, shown, selection, onScreen, hover],
  );

  // Full keeps the whole layout, but frames only cards with passages in view.
  const frameIds = useMemo(
    () => [...visible].filter((id) => scope !== "full" || onScreen.has(id)),
    [visible, scope, onScreen],
  );
  const frameKey = JSON.stringify([scope, frameIds]);
  const lastFrame = useRef<{ key: string; layout: Positions } | null>(null);
  const { markFocus, onMarkFocusHandled } = p;
  useEffect(() => {
    const centerId = scope === "full" && markFocus && positions.has(markFocus.id) ? markFocus.id : null;
    if (!centerId && lastFrame.current?.key === frameKey && lastFrame.current.layout === positions) return;

    const ids = centerId ? [centerId] : frameIds;
    let tries = 0;
    let timer = 0;
    const frame = () => {
      const measured = ids.every((id) => rf.getInternalNode(id)?.measured?.width);
      if (!measured && tries++ < 30) {
        timer = window.setTimeout(frame, 40);
        return;
      }
      lastFrame.current = { key: frameKey, layout: positions };
      if (centerId) {
        const node = rf.getInternalNode(centerId);
        if (node?.measured.width && node.measured.height) {
          const { x, y } = node.internals.positionAbsolute;
          void rf.setCenter(x + node.measured.width / 2, y + node.measured.height / 2, {
            zoom: rf.getZoom(),
            duration: 380,
          });
        }
        onMarkFocusHandled(null);
      } else if (ids.length) {
        void rf.fitView({ nodes: ids.map((id) => ({ id })), duration: 380, padding: 0.16, maxZoom: 1.05 });
      }
    };
    timer = window.setTimeout(frame, 30);
    return () => clearTimeout(timer);
  }, [frameKey, frameIds, positions, scope, markFocus, onMarkFocusHandled, rf]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodeClick={(_, n) => p.onSelect({ kind: "node", id: n.id })}
      onEdgeClick={(_, e) => p.onSelect({ kind: "edge", id: e.id })}
      onPaneClick={() => p.onSelect(null)}
      onNodeMouseEnter={(_, n) => p.onHover(n.id)}
      onNodeMouseLeave={() => p.onHover(null)}
      onEdgeMouseEnter={(_, e) => p.onHover(e.id)}
      onEdgeMouseLeave={() => p.onHover(null)}
      nodesConnectable={false}
      nodesDraggable={false}
      minZoom={scope === "full" ? 0.01 : 0.15}
      maxZoom={2}
      proOptions={{ hideAttribution: true }}
      fitView
    >
      <Background gap={24} size={1} color="var(--grid)" />
      <Controls showInteractive={false} position="bottom-left" />
    </ReactFlow>
  );
}

export function GraphPanel(p: Props) {
  return (
    <ReactFlowProvider>
      <Inner {...p} />
    </ReactFlowProvider>
  );
}
