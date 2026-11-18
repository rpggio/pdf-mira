import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readPdfPages } from "../modules/pdf-viewer/node.ts";
import { buildIndex } from "../src/lib/anchor.ts";
import { parseGraphFile } from "../src/lib/parse.ts";
import { effectiveGraph } from "../src/lib/graph.ts";
import { resolveAll } from "../src/lib/resolve.ts";
import { layoutGraph } from "../src/lib/layout.ts";
import { firstPosition, interp, SEQ, sequenceLayout, syncMap } from "../src/lib/sequence.ts";
import { adjacency, childrenOf, parentsOf, visibleSet, FEW_ON_SCREEN } from "../src/lib/focus.ts";

describe("sequence layout (rain-gardens)", async () => {
  const data = new Uint8Array(readFileSync("samples/papers/c2FtcGxlOnJhaW4tZ2FyZGVucw/paper.pdf"));
  const idx = buildIndex(await readPdfPages(data));
  const g = parseGraphFile("paper.mira.jsonld", JSON.parse(readFileSync("samples/papers/c2FtcGxlOnJhaW4tZ2FyZGVucw/paper.mira.jsonld", "utf8")));
  const eff = effectiveGraph(g);
  const anchors = resolveAll(idx, eff);
  const L = sequenceLayout(eff, anchors, layoutGraph({ nodes: eff.nodes, edges: eff.edges }));

  it("lists every record once, in paper order", () => {
    expect(L.rows.map((r) => r.id).sort()).toEqual(eff.nodes.map((n) => n.id).sort());
    const placed = L.rows.slice(0, L.unplacedFrom).map((r) => r.pos!);
    for (let i = 1; i < placed.length; i++) {
      const [a, b] = [placed[i - 1], placed[i]];
      expect(a.page < b.page || (a.page === b.page && (a.item < b.item || (a.item === b.item && a.offset <= b.offset)))).toBe(true);
    }
    for (const r of L.rows.slice(L.unplacedFrom)) expect(firstPosition(anchors.get(r.id))).toBeUndefined();
  });

  it("rows never overlap and indent by map level", () => {
    for (let i = 1; i < L.rows.length; i++) expect(L.rows[i].y).toBeGreaterThanOrEqual(L.rows[i - 1].y + L.rows[i - 1].h);
    const x0 = L.rows.find((r) => r.level === 0)!.x;
    for (const r of L.rows) expect(r.x - x0).toBe(r.level * SEQ.indent);
    const q = L.rows.find((r) => r.id === "q1")!;
    const ev = L.rows.find((r) => r.id === "ev1")!;
    expect(q.level).toBeLessThan(ev.level);
  });

  it("near links loop on the left in lanes that never share a stretch; far links become chips at both ends", () => {
    const byLane = new Map<number, [number, number][]>();
    const minX = Math.min(...L.rows.map((r) => r.x));
    for (const l of L.loops) {
      const a = L.byId.get(l.subject)!.index;
      const b = L.byId.get(l.object)!.index;
      expect(Math.abs(a - b)).toBeLessThanOrEqual(SEQ.loopSpan);
      expect(l.laneX).toBeLessThan(minX);
      const span: [number, number] = [Math.min(a, b), Math.max(a, b)];
      for (const s of byLane.get(l.lane) ?? []) expect(span[1] < s[0] || span[0] > s[1]).toBe(true);
      byLane.set(l.lane, [...(byLane.get(l.lane) ?? []), span]);
    }
    const far = eff.edges.filter((e) => Math.abs(L.byId.get(e.subject)!.index - L.byId.get(e.object)!.index) > SEQ.loopSpan);
    expect(L.refs.length).toBe(far.length * 2);
    expect(L.loops.length + far.length).toBe(eff.edges.filter((e) => e.subject !== e.object).length);
    // every chip's arrow starts on its card's right edge
    for (const r of L.refs) {
      const row = L.byId.get(r.at)!;
      expect(r.ax).toBe(row.x + row.w);
      expect(r.ay).toBeGreaterThanOrEqual(row.y);
      expect(r.ay).toBeLessThanOrEqual(row.y + row.h);
    }
  });

  it("scroll sync maps paper position to the column monotonically, both ways", () => {
    const pages = idx.pages.length;
    const L2 = sequenceLayout(eff, anchors, layoutGraph({ nodes: eff.nodes, edges: eff.edges }), idx.pages.map((p) => p.height));
    const M = syncMap(L2, pages);
    for (let i = 1; i < M.u.length; i++) {
      expect(M.u[i]).toBeGreaterThan(M.u[i - 1]);
      expect(M.y[i]).toBeGreaterThan(M.y[i - 1]);
    }
    expect(M.u[0]).toBe(0);
    expect(M.u[M.u.length - 1]).toBe(pages);
    let prev = -1;
    for (let u = 0; u <= pages; u += 0.01) {
      const y = interp(M.u, M.y, u);
      expect(y).toBeGreaterThanOrEqual(prev);
      expect(interp(M.y, M.u, y)).toBeCloseTo(u, 6);
      prev = y;
    }
  });

  it("on-screen scope adds immediate children only when 3 or fewer records are on screen", () => {
    const kids = childrenOf(parentsOf(eff));
    const withKids = eff.nodes.filter((n) => kids.get(n.id)!.size > 0).map((n) => n.id);
    const few = new Map(withKids.slice(0, FEW_ON_SCREEN).map((id) => [id, "precise" as const]));
    const v = visibleSet(eff, few, null, "onscreen").ids;
    for (const id of few.keys()) for (const c of kids.get(id)!) expect(v.has(c)).toBe(true);
    const many = new Map(withKids.slice(0, FEW_ON_SCREEN + 1).map((id) => [id, "precise" as const]));
    const vm = visibleSet(eff, many, null, "onscreen").ids;
    const allKids = [...many.keys()].flatMap((id) => [...kids.get(id)!]);
    expect(allKids.every((id) => vm.has(id))).toBe(false);
  });

  it("keeps a real connection visible for records with neighbors", () => {
    const adj = adjacency(eff);
    const base = eff.nodes.filter((n) => n.type === "Question" || n.type === "Claim");
    const onScreen = new Map(base.map((n) => [n.id, "precise" as const]));
    for (const records of [onScreen, new Map()]) {
      const { ids } = visibleSet(eff, records, null, "onscreen");
      for (const id of ids) {
        const neighbors = adj.get(id)!;
        if (neighbors.size) expect([...neighbors].some((neighbor) => ids.has(neighbor))).toBe(true);
      }
    }
  });

  it("a selected record shows every record it connects to", () => {
    const hub = [...adjacency(eff)].sort((a, b) => b[1].size - a[1].size)[0];
    const v = visibleSet(eff, new Map(), { kind: "node", id: hub[0] }, "onscreen").ids;
    expect(hub[1].size).toBeGreaterThanOrEqual(6);
    for (const nb of hub[1]) expect(v.has(nb)).toBe(true);
  });
});
