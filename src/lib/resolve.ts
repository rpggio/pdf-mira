/**
 * Resolve every record's passages against the PDF, and answer "which records
 * are on screen?" for a set of visible page regions.
 */
import { estimateLocation, figureRefs, matchQuote, occurrenceBoxes, type DocIndex } from "./anchor.ts";
import type { EffEdge, EffGraph, EffNode } from "./graph.ts";
import type { MatchKind, Occurrence, PageBox } from "./types.ts";

export interface PassageView {
  /** "x:<i>" extractor anchor i · "est" estimate */
  key: string;
  quote: string;
  kind: MatchKind;
  origin: "extractor" | "heuristic";
  occurrences: Occurrence[];
  boxes: PageBox[][];
  figRefs: string[];
}

export type AnchorStatus = "grounded" | "approximate" | "unresolved" | "unquoted";

export interface RecordAnchors {
  passages: PassageView[];
  /** heuristic location when no quote resolved */
  estimate?: PassageView;
  status: AnchorStatus;
}

export type AnchorMap = Map<string, RecordAnchors>;

function resolveRecord(idx: DocIndex, rec: EffNode | EffEdge, cache: Map<string, ReturnType<typeof matchQuote>>, estimateText?: string): RecordAnchors {
  const passages: PassageView[] = [];
  const m = (q: string) => {
    let r = cache.get(q);
    if (!r) cache.set(q, (r = matchQuote(idx, q)));
    return r;
  };
  rec.anchors.forEach((q, i) => {
    const r = m(q);
    const key = `x:${i}`;
    passages.push({
      key,
      quote: q,
      kind: r.kind,
      origin: "extractor",
      occurrences: r.occurrences,
      boxes: r.occurrences.map((o) => occurrenceBoxes(idx, o)),
      figRefs: figureRefs(q),
    });
  });
  const anyExact = passages.some((p) => p.kind === "exact");
  const anyApprox = passages.some((p) => p.kind === "approximate");
  const status: AnchorStatus = anyExact ? "grounded" : anyApprox ? "approximate" : passages.length ? "unresolved" : "unquoted";
  let estimate: PassageView | undefined;
  if (!anyExact && !anyApprox && estimateText) {
    const o = estimateLocation(idx, estimateText);
    if (o)
      estimate = {
        key: "est",
        quote: "",
        kind: "estimated",
        origin: "heuristic",
        occurrences: [o],
        boxes: [occurrenceBoxes(idx, o)],
        figRefs: [],
      };
  }
  return { passages, estimate, status };
}

export function resolveAll(idx: DocIndex, eff: EffGraph): AnchorMap {
  const cache = new Map<string, ReturnType<typeof matchQuote>>();
  const out: AnchorMap = new Map();
  for (const n of eff.nodes) out.set(n.id, resolveRecord(idx, n, cache, n.type === "SourceDocument" ? undefined : n.text));
  for (const e of eff.edges) out.set(e.id, resolveRecord(idx, e, cache));
  return out;
}

/** All the boxes of a passage (every occurrence of a repeated quote). */
export function activeBoxes(p: PassageView): PageBox[] {
  return p.boxes.flat();
}

export function recordBoxes(a: RecordAnchors | undefined): { boxes: PageBox[]; estimated: boolean } {
  if (!a) return { boxes: [], estimated: false };
  const boxes = a.passages.filter((p) => p.kind !== "missing").flatMap(activeBoxes);
  if (boxes.length) return { boxes, estimated: false };
  if (a.estimate) return { boxes: activeBoxes(a.estimate), estimated: true };
  return { boxes: [], estimated: false };
}

/** First box in reading order — the scroll target for a record. */
export function primaryBox(a: RecordAnchors | undefined): PageBox | undefined {
  const { boxes } = recordBoxes(a);
  return [...boxes].sort((p, q) => p.page - q.page || q.y1 - p.y1)[0];
}

/** Visible vertical band of one page, PDF user space (y up). */
export interface VisibleBand {
  page: number;
  y0: number;
  y1: number;
  /** fraction of the scroll viewport this page occupies (for weighting) */
  share: number;
}

export type OnScreen = Map<string, "precise" | "estimated">;

/**
 * Records whose passages intersect the visible bands. Heuristics:
 *  - a box counts when ≥ 30% of its height is inside a visible band
 *  - records with no resolved quote use their estimated location (weaker mark)
 *  - an edge with no quote of its own is never "on screen"
 */
export function onScreen(anchors: AnchorMap, bands: VisibleBand[]): OnScreen {
  const out: OnScreen = new Map();
  if (!bands.length) return out;
  const byPage = new Map(bands.map((b) => [b.page, b]));
  for (const [id, a] of anchors) {
    const { boxes, estimated } = recordBoxes(a);
    for (const b of boxes) {
      const v = byPage.get(b.page);
      if (!v) continue;
      const lo = Math.max(v.y0, b.y0);
      const hi = Math.min(v.y1, b.y1);
      if (hi - lo >= 0.3 * (b.y1 - b.y0)) {
        out.set(id, estimated ? "estimated" : "precise");
        break;
      }
    }
  }
  return out;
}
