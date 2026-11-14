/**
 * Sequence layout: every record in one column, top to bottom in the order its
 * passage appears in the paper. The horizontal indent is the record's level in
 * the full map (questions left, then claims, evidence, studies…).
 *
 * Links between rows at most SEQ.loopSpan apart are drawn as loops in a gutter
 * on the left of the column. Links between rows further apart get a reference
 * chip beside each end, joined to its card by a short straight arrow.
 *
 * Each placed row also carries its place in the paper (`u`: page index plus
 * the fraction down that page), so the column can scroll with the PDF.
 */
import { CARD_W, cardHeight, type Positions } from "./layout.ts";
import type { AnchorMap, RecordAnchors } from "./resolve.ts";
import type { EffGraph } from "./graph.ts";
import type { PageBox, TextPos } from "./types.ts";

export const SEQ = {
  indent: 40, // px per map level
  gap: 14, // between rows
  refW: 64, // reference chip width
  refH: 20,
  refGap: 4,
  /** room for the straight arrow (and its name) between a card and its chips */
  arrowLen: 86,
  laneGap: 11,
  /** links spanning at most this many rows are drawn as loops */
  loopSpan: 3,
};

export interface SeqRow {
  id: string;
  index: number;
  level: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** where in the paper (absent: not placed) */
  pos?: TextPos;
  /** paper coordinate: page index + fraction down the page */
  u?: number;
}
export interface SeqLoop {
  id: string;
  subject: string;
  object: string;
  relation: string;
  lane: number;
  laneX: number;
  /** attachment points on the subject's / object's left edge */
  sx: number;
  sy: number;
  tx: number;
  ty: number;
}
export interface SeqRef {
  id: string; // unique id
  edge: string;
  at: string; // row it sits beside
  target: string; // record it stands for
  relation: string;
  dir: "out" | "in"; // out: at → target (at is subject)
  x: number;
  y: number;
  /** the straight arrow between the card's right edge and the chip */
  ax: number;
  ay: number;
}
export interface SequenceLayout {
  rows: SeqRow[];
  byId: Map<string, SeqRow>;
  loops: SeqLoop[];
  refs: SeqRef[];
  /** first row index that has no place in the paper */
  unplacedFrom: number;
  width: number;
  height: number;
}

const cmpPos = (a: TextPos, b: TextPos) => a.page - b.page || a.item - b.item || a.offset - b.offset;

/** Earliest place in the paper a record is anchored (estimated location if nothing else), with its first box. */
export function firstPlace(a: RecordAnchors | undefined): { pos: TextPos; box?: PageBox } | undefined {
  if (!a) return undefined;
  let best: { pos: TextPos; box?: PageBox } | undefined;
  for (const p of a.passages) {
    if (p.kind === "missing") continue;
    p.occurrences.forEach((o, i) => {
      if (!best || cmpPos(o.start, best.pos) < 0) best = { pos: o.start, box: p.boxes[i]?.[0] };
    });
  }
  if (!best && a.estimate?.occurrences[0]) best = { pos: a.estimate.occurrences[0].start, box: a.estimate.boxes[0]?.[0] };
  return best;
}
export const firstPosition = (a: RecordAnchors | undefined) => firstPlace(a)?.pos;

/** Map level of each record: rank of its y in the full layered layout. */
export function mapLevels(positions: Positions): Map<string, number> {
  const ys = [...new Set([...positions.values()].map((p) => Math.round(p.y + p.h / 2)))].sort((a, b) => a - b);
  // rows of a layered layout share a centre line; merge near-identical ones
  const bands: number[] = [];
  for (const y of ys) if (!bands.length || y - bands[bands.length - 1] > 20) bands.push(y);
  const out = new Map<string, number>();
  for (const [id, p] of positions) {
    const c = p.y + p.h / 2;
    let lvl = 0;
    for (let i = 0; i < bands.length; i++) if (Math.abs(bands[i] - c) <= Math.abs(bands[lvl] - c)) lvl = i;
    out.set(id, lvl);
  }
  return out;
}

/** `pageHeights[i]` is the height of page i+1 (PDF units); needed for `u`. */
export function sequenceLayout(eff: EffGraph, anchors: AnchorMap, positions: Positions, pageHeights: number[] = []): SequenceLayout {
  const levels = mapLevels(positions);
  const order = eff.nodes.map((n, i) => ({ n, i, place: firstPlace(anchors.get(n.id)) }));
  order.sort((a, b) => (a.place && b.place ? cmpPos(a.place.pos, b.place.pos) : a.place ? -1 : b.place ? 1 : a.i - b.i) || a.i - b.i);
  const maxLevel = Math.max(0, ...order.map((o) => levels.get(o.n.id) ?? 0));
  const index = new Map(order.map((o, i) => [o.n.id, i]));

  // which links are loops, which reference chips
  const loopEdges: { e: (typeof eff.edges)[number]; a: number; b: number }[] = [];
  const refsAt = new Map<string, Omit<SeqRef, "x" | "y" | "ax" | "ay">[]>();
  for (const e of eff.edges) {
    const a = index.get(e.subject);
    const b = index.get(e.object);
    if (a == null || b == null || a === b) continue;
    if (Math.abs(a - b) <= SEQ.loopSpan) loopEdges.push({ e, a: Math.min(a, b), b: Math.max(a, b) });
    else {
      const push = (at: string, r: Omit<SeqRef, "x" | "y" | "ax" | "ay">) => refsAt.set(at, [...(refsAt.get(at) ?? []), r]);
      push(e.subject, { id: `ref:${e.id}:s`, edge: e.id, at: e.subject, target: e.object, relation: e.relation, dir: "out" });
      push(e.object, { id: `ref:${e.id}:o`, edge: e.id, at: e.object, target: e.subject, relation: e.relation, dir: "in" });
    }
  }

  // loop lanes: shortest links nearest the cards; a lane is reused once free
  loopEdges.sort((p, q) => p.b - p.a - (q.b - q.a) || p.a - q.a);
  const laneEnds: { a: number; b: number }[][] = [];
  const laneOf = new Map<string, number>();
  for (const { e, a, b } of loopEdges) {
    let lane = laneEnds.findIndex((used) => used.every((u) => b < u.a || a > u.b));
    if (lane < 0) lane = laneEnds.push([]) - 1;
    laneEnds[lane].push({ a, b });
    laneOf.set(e.id, lane);
  }
  const gutter = laneEnds.length ? 8 + laneEnds.length * SEQ.laneGap : 4;
  const refX = gutter + maxLevel * SEQ.indent + CARD_W + SEQ.arrowLen;

  const rows: SeqRow[] = [];
  const refs: SeqRef[] = [];
  let y = 0;
  let unplacedFrom = order.length;
  const step = SEQ.refH + SEQ.refGap;
  order.forEach((o, i) => {
    if (!o.place && unplacedFrom === order.length) {
      unplacedFrom = i;
      y += 34; // room for the "not placed" divider
    }
    const level = levels.get(o.n.id) ?? 0;
    const myRefs = refsAt.get(o.n.id) ?? [];
    const h = cardHeight(o.n.text);
    const x = gutter + level * SEQ.indent;
    let u: number | undefined;
    const box = o.place?.box;
    const ph = box ? pageHeights[box.page - 1] : undefined;
    if (box && ph) u = box.page - 1 + Math.min(1, Math.max(0, (ph - box.y1) / ph));
    rows.push({ id: o.n.id, index: i, level, x, y, w: CARD_W, h, pos: o.place?.pos, u });
    // chips stacked beside the card, centred on it when they fit
    const stackH = myRefs.length * step - SEQ.refGap;
    const top = y + Math.max(0, (h - stackH) / 2);
    myRefs.forEach((r, k) => {
      const ry = top + k * step;
      const cy = ry + SEQ.refH / 2;
      refs.push({ ...r, x: refX, y: ry, ax: x + CARD_W, ay: Math.min(y + h - 6, Math.max(y + 6, cy)) });
    });
    y += Math.max(h, stackH) + SEQ.gap;
  });
  const byId = new Map(rows.map((r) => [r.id, r]));

  // loop attachment points, spread along each card's left edge
  const counts = new Map<string, number>();
  for (const { e } of loopEdges) for (const id of [e.subject, e.object]) counts.set(id, (counts.get(id) ?? 0) + 1);
  const attach = new Map<string, number>();
  const at = (id: string) => {
    const r = byId.get(id)!;
    const k = attach.get(id) ?? 0;
    attach.set(id, k + 1);
    return r.y + (r.h * (k + 1)) / ((counts.get(id) ?? 1) + 1);
  };
  const loops: SeqLoop[] = loopEdges.map(({ e }) => {
    const lane = laneOf.get(e.id)!;
    const s = byId.get(e.subject)!;
    const t = byId.get(e.object)!;
    return { id: e.id, subject: e.subject, object: e.object, relation: e.relation, lane, laneX: gutter - 6 - lane * SEQ.laneGap, sx: s.x, sy: at(e.subject), tx: t.x, ty: at(e.object) };
  });
  const width = refs.length ? refX + SEQ.refW + 6 : gutter + maxLevel * SEQ.indent + CARD_W + 6;
  return { rows, byId, loops, refs, unplacedFrom, width, height: y };
}

/** Rounded loop: out of the subject's left side, along its lane, back into the object's left side. */
export function loopPath(l: Pick<SeqLoop, "sx" | "sy" | "tx" | "ty" | "laneX">, r = 9): string {
  const { sx, sy, tx, ty, laneX: L } = l;
  const d = ty > sy ? 1 : -1;
  const rr = Math.min(r, Math.abs(ty - sy) / 2, Math.abs(sx - L), Math.abs(tx - L));
  const hs = Math.sign(L - sx) || -1;
  const ht = Math.sign(L - tx) || -1;
  return [`M ${sx} ${sy}`, `H ${L - hs * rr}`, `Q ${L} ${sy} ${L} ${sy + d * rr}`, `V ${ty - d * rr}`, `Q ${L} ${ty} ${L - ht * rr} ${ty}`, `H ${tx}`].join(" ");
}

/* --------------------------------------------------------------- scroll sync */

/**
 * A monotone, continuous mapping between paper position `u` and the column's
 * `y`. Rows are already in reading order, so the k-th smallest `u` is paired
 * with the k-th row; rows that share a place in the paper are merged into one
 * point. Between points the mapping is linear, so scrolling either side moves
 * the other smoothly and never jumps.
 */
export interface SyncMap {
  u: number[];
  y: number[];
}
export function syncMap(L: SequenceLayout, pages: number): SyncMap {
  const placed = L.rows.filter((r) => r.u != null);
  const us = placed.map((r) => r.u!).sort((a, b) => a - b);
  const ys = placed.map((r) => r.y + Math.min(r.h / 2, 24));
  const U: number[] = [];
  const Y: number[] = [];
  for (let i = 0; i < us.length; ) {
    let j = i;
    while (j + 1 < us.length && us[j + 1] - us[i] < 0.004) j++;
    const n = j - i + 1;
    U.push(us.slice(i, j + 1).reduce((a, b) => a + b, 0) / n);
    Y.push(ys.slice(i, j + 1).reduce((a, b) => a + b, 0) / n);
    i = j + 1;
  }
  if (!U.length || U[0] > 0.004) {
    U.unshift(0);
    Y.unshift(0);
  }
  const end = placed.length ? placed[placed.length - 1].y + placed[placed.length - 1].h + SEQ.gap : 0;
  if (U[U.length - 1] < pages - 0.004) {
    U.push(pages);
    Y.push(Math.max(end, Y[Y.length - 1] + 1));
  }
  return { u: U, y: Y };
}

/** Piecewise-linear lookup, clamped at both ends. */
export function interp(xs: number[], ys: number[], x: number): number {
  if (!xs.length) return 0;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
  let lo = 0;
  let hi = xs.length - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (xs[m] <= x) lo = m;
    else hi = m;
  }
  const t = xs[hi] === xs[lo] ? 0 : (x - xs[lo]) / (xs[hi] - xs[lo]);
  return ys[lo] + t * (ys[hi] - ys[lo]);
}
