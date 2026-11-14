/**
 * Internal model. A MIRA graph as the reader works with it — normalized from
 * whichever extractor artifact was loaded (.mira.jsonld or .graph.json).
 */

export const NODE_TYPES = ["Question", "Claim", "Evidence", "Study", "Protocol", "SourceDocument", "Request"] as const;
export type NodeType = (typeof NODE_TYPES)[number];

export const RELATIONS = [
  "addresses",
  "supports",
  "opposes",
  "describesActivity",
  "grounds",
  "follows",
  "request_for",
  "request_target",
] as const;
export type Relation = (typeof RELATIONS)[number];

/** Legal subject → object classes per relation (the extractor's grammar). */
export const GRAMMAR: Record<Relation, { subject: NodeType[]; object: NodeType[] }> = {
  addresses: { subject: ["Claim"], object: ["Question"] },
  supports: { subject: ["Evidence", "Claim"], object: ["Claim"] },
  opposes: { subject: ["Evidence", "Claim"], object: ["Claim"] },
  describesActivity: { subject: ["SourceDocument"], object: ["Study"] },
  grounds: { subject: ["Study"], object: ["Evidence"] },
  follows: { subject: ["Study"], object: ["Protocol"] },
  request_for: { subject: ["Request"], object: ["Study"] },
  request_target: { subject: ["Request"], object: ["Claim"] },
};

export interface MiraNode {
  id: string;
  type: NodeType;
  /** the AI reconstruction (a generalized statement — not the authors' words) */
  text: string;
  description?: string;
  doi?: string;
  url?: string;
  /** verbatim grounding quotes ("author statements"), possibly several */
  anchors: string[];
}

export interface MiraEdge {
  id: string;
  relation: Relation | string;
  subject: string;
  object: string;
  anchors: string[];
  /** proposed by a consolidation pass rather than read from one passage */
  consolidated?: boolean;
}

export interface PaperInfo {
  title?: string;
  doi?: string;
  authors?: { name: string; orcid?: string }[];
}

export interface MiraGraph {
  /** stable id for this graph within its paper */
  id: string;
  label: string;
  /** where it came from: file name + detected format */
  origin: { file: string; format: "mira-jsonld" | "graph-json" | "extract-response" };
  /** honest provenance note shown in the UI (e.g. "hand-authored fixture") */
  provenance?: string;
  paper?: PaperInfo;
  nodes: MiraNode[];
  edges: MiraEdge[];
  /** what the loader could not use, with reasons (never silently dropped) */
  warnings: string[];
}

/* ------------------------------------------------------------------ PDF text */

export interface TextItemGeom {
  /** index among the page's text items (== pdf.js TextLayer textDivs index) */
  index: number;
  str: string;
  /** PDF user-space box: x, y = bottom-left baseline origin */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PageText {
  page: number; // 1-based
  width: number;
  height: number;
  items: TextItemGeom[];
}

/** A position inside a page's text: item index + char offset within item.str */
export interface TextPos {
  page: number;
  item: number;
  offset: number;
}

/* ------------------------------------------------------------------ anchors */

/**
 * How a quote was found:
 *  exact       — verbatim once whitespace/hyphenation/ligatures are normalized
 *  approximate — best token-overlap window; wording differs from the PDF
 *  estimated   — no quote at all; location guessed from the node text
 *  missing     — not found
 */
export type MatchKind = "exact" | "approximate" | "estimated" | "missing";

export interface Occurrence {
  start: TextPos;
  /** exclusive */
  end: TextPos;
  /** 0..1 confidence (1 for exact) */
  score: number;
}

/** Coarse box used for visibility tests and scroll targets (PDF user space). */
export interface PageBox {
  page: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** text item + char range this box covers (lets the viewer measure it exactly) */
  item?: number;
  a?: number;
  b?: number;
}
