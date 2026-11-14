/**
 * Argument layout: a layered (dagre) layout over the WHOLE graph, computed once
 * per graph so positions are stable while the reader expands or narrows the
 * visible neighborhood. Questions sit on top, then claims, the evidence below
 * them, then studies, protocols and sources — i.e. layout edges run from the
 * thing argued-for down to what argues for it.
 */
import dagre from "@dagrejs/dagre";
import type { NodeType } from "./types.ts";

export const CARD_W = 210;
const LINE = 16;

export function cardHeight(text: string): number {
  const chars = Math.max(1, text.length);
  const lines = Math.min(5, Math.ceil(chars / 30));
  return 30 + lines * LINE + 8;
}

/** Edges whose layout direction is subject → object (method hangs below the study). */
const DOWNWARD = new Set(["follows"]);

const RANK_HINT: Record<NodeType, number> = {
  Question: 0,
  Claim: 1,
  Request: 1,
  Evidence: 2,
  Study: 3,
  Protocol: 4,
  SourceDocument: 4,
};

export interface LayoutInput {
  nodes: { id: string; type: NodeType; text: string }[];
  edges: { subject: string; object: string; relation: string }[];
}

export type Positions = Map<string, { x: number; y: number; w: number; h: number }>;

export function layoutGraph(input: LayoutInput): Positions {
  const g = new dagre.graphlib.Graph({ multigraph: true });
  g.setGraph({ rankdir: "TB", nodesep: 22, ranksep: 58, edgesep: 12, marginx: 20, marginy: 20, ranker: "network-simplex" });
  g.setDefaultEdgeLabel(() => ({}));
  const types = new Map(input.nodes.map((n) => [n.id, n.type]));
  for (const n of input.nodes) g.setNode(n.id, { width: CARD_W, height: cardHeight(n.text) });
  input.edges.forEach((e, i) => {
    if (!types.has(e.subject) || !types.has(e.object)) return;
    const [from, to] = DOWNWARD.has(e.relation) ? [e.subject, e.object] : [e.object, e.subject];
    // claim→claim support between the same rank: keep the supported claim above
    const minlen = Math.max(1, RANK_HINT[types.get(to)!] - RANK_HINT[types.get(from)!]) || 1;
    g.setEdge(from, to, { minlen, weight: e.relation === "supports" || e.relation === "addresses" ? 2 : 1 }, `e${i}`);
  });
  dagre.layout(g);
  const out: Positions = new Map();
  for (const n of input.nodes) {
    const d = g.node(n.id) as { x: number; y: number; width: number; height: number };
    out.set(n.id, { x: d.x - d.width / 2, y: d.y - d.height / 2, w: d.width, h: d.height });
  }
  return out;
}
