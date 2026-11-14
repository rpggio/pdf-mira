/**
 * Anchoring: extracted quote ↔ PDF location.
 *
 * The document is flattened into a "skeleton" — lowercase letters and digits
 * only, diacritics and ligatures decomposed — with every skeleton char mapped
 * back to (page, text item, char offset). Matching on the skeleton makes the
 * usual PDF damage irrelevant: whitespace and line breaks, end-of-line
 * hyphenation ("retriev-\nability"), real hyphens broken across lines
 * ("peer-to-\npeer"), curly vs straight quotes, ﬁ/ﬂ ligatures, and item
 * boundaries that pdf.js emits with no separating space.
 *
 * Tiers (see MatchKind): exact skeleton match → approximate token-window match
 * → (for records with no quote) estimated location from the node's own text.
 * Every occurrence of a repeated quotation is kept so the reader can choose.
 */
import type { Occurrence, PageBox, PageText, TextPos } from "./types.ts";

export interface DocIndex {
  pages: PageText[];
  skel: string;
  skPage: Int32Array;
  skItem: Int32Array;
  skOff: Int32Array;
  /** word tokens: [skelStart, skelEnd) */
  tokStart: Int32Array;
  tokEnd: Int32Array;
  tokText: string[];
  /** inverse document frequency per token text, over ~40-token blocks */
  idf: Map<string, number>;
  /** skeleton index where the reference list starts (heuristic), or skel.length */
  refsStart: number;
  /** tokens that were joined across a line-final hyphen ("self-⏎reports") */
  hyphenJoined: Set<string>;
}

const COMBINING = /[̀-ͯ]/g;
/** char → its skeleton chars (may be "" or several) */
export function skelChars(ch: string): string {
  const d = ch.normalize("NFKD").replace(COMBINING, "").toLowerCase();
  let out = "";
  for (const c of d) if (/[\p{L}\p{N}]/u.test(c)) out += c;
  return out;
}
export function skeleton(s: string): string {
  let out = "";
  for (const ch of s) out += skelChars(ch);
  return out;
}
/** word tokens of free text, skeletonized */
export function tokens(s: string): string[] {
  return s
    .normalize("NFKD")
    .replace(COMBINING, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/**
 * Running headers/footers ("page furniture") interrupt quotes that cross a page
 * break. An item is furniture when it sits in the top/bottom band of its page
 * and its digit-stripped text recurs in that band on another page (or it is a
 * bare page number).
 */
export function furniture(pages: PageText[]): Set<string> {
  const BAND = 0.075;
  const key = (s: string) => skeleton(s.replace(/\d+/g, ""));
  const inBand = (pg: PageText, y: number) => y > pg.height * (1 - BAND) || y < pg.height * BAND;
  const count = new Map<string, Set<number>>();
  for (const pg of pages)
    for (const it of pg.items) {
      if (!inBand(pg, it.y)) continue;
      const k = key(it.str);
      if (!k) continue;
      if (!count.has(k)) count.set(k, new Set());
      count.get(k)!.add(pg.page);
    }
  const out = new Set<string>();
  for (const pg of pages)
    for (const it of pg.items) {
      if (!inBand(pg, it.y) || !it.str.trim()) continue;
      const k = key(it.str);
      if ((!k && /^\s*\d+\s*$/.test(it.str)) || (k && (count.get(k)?.size ?? 0) >= 2)) out.add(`${pg.page}:${it.index}`);
    }
  return out;
}

export function buildIndex(pages: PageText[]): DocIndex {
  const skip = furniture(pages);
  let skel = "";
  const P: number[] = [];
  const I: number[] = [];
  const O: number[] = [];
  const ts: number[] = [];
  const te: number[] = [];
  const tt: string[] = [];
  let cur = "";
  let curStart = -1;
  let joined = false;
  const hyphenJoined = new Set<string>();
  const flush = () => {
    if (cur) {
      ts.push(curStart);
      te.push(skel.length);
      tt.push(cur);
      if (joined) hyphenJoined.add(cur);
    }
    cur = "";
    curStart = -1;
    joined = false;
  };
  for (const pg of pages) {
    for (const it of pg.items) {
      if (skip.has(`${pg.page}:${it.index}`)) continue;
      let off = 0;
      for (const ch of it.str) {
        const sk = skelChars(ch);
        if (!sk) {
          // a line-final hyphen keeps the word open across the line break
          if (!(ch === "-" && off + 1 === it.str.length)) flush();
          else joined = true;
        } else {
          if (curStart < 0) curStart = skel.length;
          for (const c of sk) {
            skel += c;
            P.push(pg.page);
            I.push(it.index);
            O.push(off);
          }
          cur += sk;
        }
        off += ch.length;
      }
      // item boundaries are word boundaries unless the line ends in a hyphen
      if (!/-$/.test(it.str)) flush();
    }
    flush();
  }
  // idf over fixed blocks of tokens
  const BLOCK = 40;
  const df = new Map<string, number>();
  const nBlocks = Math.max(1, Math.ceil(tt.length / BLOCK));
  for (let b = 0; b < nBlocks; b++) {
    const seen = new Set(tt.slice(b * BLOCK, (b + 1) * BLOCK));
    for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const idf = new Map<string, number>();
  for (const [t, n] of df) idf.set(t, Math.log(1 + nBlocks / n));

  const idx: DocIndex = {
    pages,
    skel,
    skPage: Int32Array.from(P),
    skItem: Int32Array.from(I),
    skOff: Int32Array.from(O),
    tokStart: Int32Array.from(ts),
    tokEnd: Int32Array.from(te),
    tokText: tt,
    idf,
    refsStart: skel.length,
    hyphenJoined,
  };
  idx.refsStart = findReferencesStart(idx);
  return idx;
}

/** Last "References"/"Bibliography" heading in the second half of the paper. */
function findReferencesStart(idx: DocIndex): number {
  let best = idx.skel.length;
  for (const pg of idx.pages) {
    for (const it of pg.items) {
      const t = it.str.trim().toLowerCase();
      if (/^(references|bibliography|literature cited|works cited)$/.test(t)) {
        const pos = posToSkel(idx, { page: pg.page, item: it.index, offset: 0 });
        if (pos > idx.skel.length * 0.4) best = pos;
      }
    }
  }
  return best;
}

function posToSkel(idx: DocIndex, p: TextPos): number {
  // binary search on (page, item, offset)
  let lo = 0;
  let hi = idx.skel.length;
  const key = (i: number) => idx.skPage[i] * 1e9 + idx.skItem[i] * 1e4 + idx.skOff[i];
  const k = p.page * 1e9 + p.item * 1e4 + p.offset;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (key(mid) < k) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function skelPos(idx: DocIndex, i: number, end = false): TextPos {
  if (end) {
    const j = Math.max(0, i - 1);
    return { page: idx.skPage[j], item: idx.skItem[j], offset: idx.skOff[j] + 1 };
  }
  return { page: idx.skPage[i], item: idx.skItem[i], offset: idx.skOff[i] };
}

function occ(idx: DocIndex, s: number, e: number, score: number): Occurrence {
  return { start: skelPos(idx, s), end: skelPos(idx, e, true), score };
}

/* ---------------------------------------------------------------- matching */

export interface QuoteMatch {
  kind: "exact" | "approximate" | "missing";
  occurrences: Occurrence[];
}

export function matchQuote(idx: DocIndex, quote: string): QuoteMatch {
  const q = skeleton(quote);
  if (q.length < 4) return { kind: "missing", occurrences: [] };
  const found: Occurrence[] = [];
  for (let at = idx.skel.indexOf(q); at !== -1; at = idx.skel.indexOf(q, at + 1)) {
    found.push(occ(idx, at, at + q.length, 1));
    if (found.length > 50) break;
  }
  if (found.length) return { kind: "exact", occurrences: found };
  const approx = bestWindow(idx, tokens(quote), { slack: 1.35, min: 0.6, minHits: 3, skipRefs: false });
  if (approx) return { kind: "approximate", occurrences: [approx] };
  return { kind: "missing", occurrences: [] };
}

const STOP = new Set(
  "a an the of in on at to for from by with and or but is are was were be been being this that these those it its as than then which who whom whose what when where how why not no can could may might will would should do does did has have had we our they their there here such into over under between across more most less very also only both each any all".split(
    " ",
  ),
);

/**
 * The block of document tokens that best covers the wanted tokens (idf-weighted,
 * multiset). Returns null under `min` coverage. Window = slack × |wanted|.
 */
export function bestWindow(
  idx: DocIndex,
  wanted: string[],
  o: { slack: number; min: number; minHits: number; skipRefs: boolean; dropStop?: boolean },
): Occurrence | null {
  // "self-reports" in a quote vs "self-⏎reports" joined into one token in the PDF
  const merged: string[] = [];
  for (let i = 0; i < wanted.length; i++) {
    const j = wanted[i] + (wanted[i + 1] ?? "");
    if (i + 1 < wanted.length && idx.hyphenJoined.has(j)) {
      merged.push(j);
      i++;
    } else merged.push(wanted[i]);
  }
  const words = o.dropStop ? merged.filter((w) => !STOP.has(w) && w.length > 1) : merged;
  if (words.length < o.minHits) return null;
  const weight = (w: string) => idx.idf.get(w) ?? Math.log(1 + idx.tokText.length / 40) + 1; // unseen = rare
  const need = new Map<string, number>();
  for (const w of words) need.set(w, (need.get(w) ?? 0) + 1);
  let total = 0;
  for (const [w, n] of need) total += weight(w) * n;
  const win = Math.max(words.length + 2, Math.ceil(words.length * o.slack));
  const T = idx.tokText;
  let best: { s: number; e: number; score: number; rank: number } | null = null;
  for (let i = 0; i < T.length; i++) {
    if (!need.has(T[i])) continue;
    if (o.skipRefs && idx.tokStart[i] >= idx.refsStart) break;
    const got = new Map<string, number>();
    let sc = 0;
    let hits = 0;
    let last = i;
    for (let j = i; j < Math.min(T.length, i + win); j++) {
      const w = T[j];
      const n = need.get(w);
      if (!n) continue;
      const g = got.get(w) ?? 0;
      if (g < n) {
        got.set(w, g + 1);
        sc += weight(w);
        hits++;
        last = j;
      }
    }
    const score = sc / total;
    // prefer the tightest window among equally good ones
    const rank = score - 0.003 * (last - i);
    if (hits >= o.minHits && score >= o.min && (!best || rank > best.rank)) best = { s: i, e: last, score, rank };
  }
  if (!best) return null;
  return occ(idx, idx.tokStart[best.s], idx.tokEnd[best.e], best.score);
}

/** Guess where an unquoted record is discussed, from its own (paraphrased) text. */
export function estimateLocation(idx: DocIndex, text: string): Occurrence | null {
  const w = tokens(text);
  return bestWindow(idx, w, { slack: 3, min: 0.5, minHits: 3, skipRefs: true, dropStop: true });
}

/* ---------------------------------------------------------------- geometry */

/** Per-item boxes covering an occurrence (PDF user space, y up). */
export function occurrenceBoxes(idx: DocIndex, o: Occurrence): PageBox[] {
  const out: PageBox[] = [];
  for (const pg of idx.pages) {
    if (pg.page < o.start.page || pg.page > o.end.page) continue;
    for (const it of pg.items) {
      const before = pg.page === o.start.page && it.index < o.start.item;
      const after = pg.page === o.end.page && it.index > o.end.item;
      if (before || after || !it.str.length) continue;
      const a = pg.page === o.start.page && it.index === o.start.item ? o.start.offset : 0;
      const b = pg.page === o.end.page && it.index === o.end.item ? o.end.offset : it.str.length;
      if (b <= a) continue;
      const len = it.str.length;
      out.push({
        page: pg.page,
        x0: it.x + (it.w * a) / len,
        x1: it.x + (it.w * b) / len,
        y0: it.y - it.h * 0.22,
        y1: it.y + it.h * 0.88,
        item: it.index,
        a,
        b,
      });
    }
  }
  return out;
}

/** The plain text of an occurrence (for showing approximate matches). */
export function occurrenceText(idx: DocIndex, o: Occurrence): string {
  let s = "";
  for (const pg of idx.pages) {
    if (pg.page < o.start.page || pg.page > o.end.page) continue;
    for (const it of pg.items) {
      if (pg.page === o.start.page && it.index < o.start.item) continue;
      if (pg.page === o.end.page && it.index > o.end.item) continue;
      const a = pg.page === o.start.page && it.index === o.start.item ? o.start.offset : 0;
      const b = pg.page === o.end.page && it.index === o.end.item ? o.end.offset : it.str.length;
      let piece = it.str.slice(a, b);
      if (/-$/.test(piece) && b === it.str.length) piece = piece.slice(0, -1) + "­";
      s += piece + (b === it.str.length ? " " : "");
    }
  }
  return s.replace(/­ /g, "").replace(/\s+/g, " ").trim();
}

/** A text position → skeleton-free context: the sentence around an occurrence. */
export function expandContext(idx: DocIndex, o: Occurrence, chars = 260): { before: string; after: string } {
  const flat: { page: number; item: number; s: string }[] = [];
  for (const pg of idx.pages) for (const it of pg.items) flat.push({ page: pg.page, item: it.index, s: it.str });
  const at = (p: TextPos) => flat.findIndex((f) => f.page === p.page && f.item === p.item);
  const si = at(o.start);
  const ei = at(o.end);
  let before = flat[si]?.s.slice(0, o.start.offset) ?? "";
  for (let i = si - 1; i >= 0 && before.length < chars; i--) before = flat[i].s + " " + before;
  let after = flat[ei]?.s.slice(o.end.offset) ?? "";
  for (let i = ei + 1; i < flat.length && after.length < chars; i++) after += " " + flat[i].s;
  const clean = (s: string) => s.replace(/-\s+(?=[a-z])/g, "").replace(/\s+/g, " ");
  return { before: "…" + clean(before).slice(-chars), after: clean(after).slice(0, chars) + "…" };
}

/** Does this quote or text cite a figure/table? Returns e.g. ["Table 1", "Fig. 2"]. */
export function figureRefs(s: string): string[] {
  const out = new Set<string>();
  for (const m of s.matchAll(/\b(fig(?:ure)?s?\.?|table|panel)\s*(\d+[a-z]?)/gi)) {
    const kind = /^t/i.test(m[1]) ? "Table" : /^p/i.test(m[1]) ? "Panel" : "Figure";
    out.add(`${kind} ${m[2]}`);
  }
  return [...out];
}
