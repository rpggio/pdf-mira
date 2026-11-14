/**
 * The graph as the reader shows it: the extractor's records, read-only, with
 * links whose ends are both present and a flag for links no passage states.
 */
import type { MiraEdge, MiraGraph, MiraNode, NodeType } from "./types.ts";

const NODE_PREFIX: Record<NodeType, string> = {
  Question: "QUE",
  Claim: "CLM",
  Evidence: "EVD",
  Study: "STU",
  Protocol: "PRO",
  SourceDocument: "SRC",
  Request: "REQ",
};

export interface EffNode extends MiraNode {
  displayKey: string;
}
export interface EffEdge extends MiraEdge {
  /** no grounding quote, or proposed by consolidation → visibly provisional */
  provisional: boolean;
}
export interface EffGraph {
  nodes: EffNode[];
  edges: EffEdge[];
  byId: Map<string, EffNode>;
}

export function effectiveGraph(g: MiraGraph): EffGraph {
  const counts = new Map<NodeType, number>();
  const nodes: EffNode[] = g.nodes.map((node) => {
    const prefix = NODE_PREFIX[node.type];
    const ordinal = (counts.get(node.type) ?? 0) + 1;
    counts.set(node.type, ordinal);
    const displayKey = `${prefix}-${String(ordinal).padStart(2, "0")}`;
    const titlePrefix = new RegExp(`^\\s*${prefix}\\s+[-–—]\\s+`, "i");
    return { ...node, displayKey, text: node.text.replace(titlePrefix, "") };
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges: EffEdge[] = g.edges
    .filter((e) => byId.has(e.subject) && byId.has(e.object))
    .map((e) => ({ ...e, provisional: e.anchors.length === 0 || !!e.consolidated }));
  return { nodes, edges, byId };
}
