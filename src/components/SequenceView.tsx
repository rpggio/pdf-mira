/**
 * Sequence view: all records in paper order, indented by map level. Near links
 * loop round the left of the column; far links get a reference chip joined to
 * the card by a straight arrow. The column scrolls with the PDF: scrolling
 * either one moves the other (see `syncMap`). It is a plain scrolling list:
 * it fits the pane's width, so there is no sideways scrolling, and it stops at
 * its first and last record.
 */
import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { EffGraph } from "../lib/graph.ts";
import type { AnchorMap, OnScreen } from "../lib/resolve.ts";
import type { Positions } from "../lib/layout.ts";
import { interp, loopPath, SEQ, sequenceLayout, syncMap } from "../lib/sequence.ts";
import { watchUserScroll, type UserScrollWatch } from "../lib/userScroll.ts";
import { REL_COLOR, TYPE_COLOR } from "../lib/palette.ts";
import { CardBody } from "./Card.tsx";
import type { Selection } from "./GraphPanel.tsx";

/** Where on screen the two views line up: this far down each pane. */
export const SYNC_LINE = 0.3;
const PAD_TOP = 12;
const PAD_BOTTOM = 40;

interface Props {
  eff: EffGraph;
  anchors: AnchorMap;
  positions: Positions;
  pageHeights: number[];
  onScreen: OnScreen;
  selection: Selection;
  hover: string | null;
  onSelect(s: Selection): void;
  onHover(id: string | null): void;
  /** the reader scrolled the column: paper position now at the sync line */
  onUserScroll(u: number): void;
  /** paper position at the PDF's sync line, to line up on first show */
  paperNow(): number | undefined;
}

export interface SequenceHandle {
  /** scroll so paper position `u` sits at the sync line */
  syncTo(u: number): void;
}

export const SequenceView = memo(
  forwardRef<SequenceHandle, Props>(function SequenceView(p, ref) {
    const { eff, anchors, positions, pageHeights, onScreen, selection, hover } = p;
    const L = useMemo(() => sequenceLayout(eff, anchors, positions, pageHeights), [eff, anchors, positions, pageHeights]);
    const M = useMemo(() => syncMap(L, pageHeights.length), [L, pageHeights.length]);
    const scroller = useRef<HTMLDivElement>(null);
    const watch = useRef<UserScrollWatch | null>(null);
    const [W, setW] = useState(0);
    const zoom = W ? Math.min(1, (W - 4) / L.width) : 1;

    useLayoutEffect(() => {
      const el = scroller.current!;
      const ro = new ResizeObserver(() => setW(el.clientWidth));
      ro.observe(el);
      setW(el.clientWidth);
      return () => ro.disconnect();
    }, []);

    // layout y ↔ scrollTop
    const yAtLine = useCallback(() => {
      const el = scroller.current!;
      return (el.scrollTop + el.clientHeight * SYNC_LINE - PAD_TOP) / zoom;
    }, [zoom]);
    const setYAtLine = useCallback(
      (y: number, smooth = false) => {
        const el = scroller.current;
        if (!el) return;
        watch.current?.quiet();
        const top = y * zoom + PAD_TOP - el.clientHeight * SYNC_LINE;
        el.scrollTo({ top, behavior: smooth ? "smooth" : "auto" });
      },
      [zoom],
    );

    const onUser = useRef(p.onUserScroll);
    onUser.current = p.onUserScroll;
    useEffect(() => {
      const el = scroller.current!;
      watch.current = watchUserScroll(el, () => onUser.current(interp(M.y, M.u, yAtLine())));
      return () => watch.current?.stop();
    }, [M, yAtLine]);

    useImperativeHandle(ref, () => ({ syncTo: (u) => setYAtLine(interp(M.u, M.y, u)) }), [M, setYAtLine]);

    // line up with the PDF when shown, and again when the column's size changes
    const paperNow = useRef(p.paperNow);
    paperNow.current = p.paperNow;
    useLayoutEffect(() => {
      if (!W) return;
      const u = paperNow.current();
      if (u != null) setYAtLine(interp(M.u, M.y, u));
    }, [W, M, setYAtLine]);

    // a selection made elsewhere (a margin mark, a chip): bring its row into view
    const selRow = selection?.kind === "node" ? L.byId.get(selection.id) : undefined;
    useEffect(() => {
      const el = scroller.current;
      if (!el || !selRow) return;
      const top = selRow.y * zoom + PAD_TOP;
      const bottom = (selRow.y + selRow.h) * zoom + PAD_TOP;
      if (top < el.scrollTop || bottom > el.scrollTop + el.clientHeight) setYAtLine(selRow.y + selRow.h / 2, true);
    }, [selRow]); // eslint-disable-line react-hooks/exhaustive-deps

    const selNodes = useMemo(() => {
      const s = new Set<string>();
      if (selection?.kind === "node") s.add(selection.id);
      if (selection?.kind === "edge") {
        const e = eff.edges.find((x) => x.id === selection.id);
        if (e) s.add(e.subject).add(e.object);
      }
      return s;
    }, [selection, eff]);
    const edgeById = useMemo(() => new Map(eff.edges.map((e) => [e.id, e])), [eff]);

    const jump = (id: string) => {
      const r = L.byId.get(id);
      if (r) setYAtLine(r.y + r.h / 2, true);
      p.onSelect({ kind: "node", id });
    };

    const linkState = (id: string, subject: string, object: string) => {
      const isSel = selection?.kind === "edge" && selection.id === id;
      const touches = selNodes.has(subject) || selNodes.has(object);
      const live = onScreen.has(subject) || onScreen.has(object);
      return { isSel, touches, named: isSel || touches || hover === id, dim: !isSel && !touches && !live && hover !== id };
    };
    const linkProps = (id: string) => ({
      onClick: (ev: React.MouseEvent) => {
        ev.stopPropagation();
        p.onSelect({ kind: "edge", id });
      },
      onMouseEnter: () => p.onHover(id),
      onMouseLeave: () => p.onHover(null),
    });

    return (
      <div className="seq-scroll" ref={scroller} tabIndex={0} onClick={() => p.onSelect(null)}>
        <div className="seq-sizer" style={{ height: L.height * zoom + PAD_TOP + PAD_BOTTOM }}>
          <div className="seq-canvas" style={{ width: L.width, height: L.height, top: PAD_TOP, transform: `scale(${zoom})` }}>
            <svg className="seq-links" width={L.width} height={L.height}>
              <defs>
                {[...new Set(eff.edges.map((e) => REL_COLOR[e.relation] ?? "#777"))].map((c) => (
                  <marker key={c} id={`seq-arrow-${c.slice(1)}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                    <path d="M0,0 L10,5 L0,10 z" fill={c} />
                  </marker>
                ))}
              </defs>
              {L.loops.map((l) => {
                const e = edgeById.get(l.id)!;
                const color = REL_COLOR[l.relation] ?? "#777";
                const s = linkState(l.id, l.subject, l.object);
                const d = loopPath(l);
                return (
                  <g key={l.id} className={["seq-link", e.provisional && "provisional", s.dim && "dim"].filter(Boolean).join(" ")} {...linkProps(l.id)}>
                    <title>{`${eff.byId.get(l.subject)!.displayKey} ${l.relation} ${eff.byId.get(l.object)!.displayKey}${e.provisional ? " (inferred)" : ""}`}</title>
                    <path className="hit" d={d} />
                    <path d={d} stroke={color} strokeWidth={s.isSel ? 3 : s.touches ? 2.2 : 1.5} markerEnd={`url(#seq-arrow-${color.slice(1)})`} />
                    {s.named && (
                      <text className="seq-label" x={l.laneX + 4} y={(l.sy + l.ty) / 2 + 3} fill={color}>
                        {l.relation + (e.provisional ? " (inferred)" : "")}
                      </text>
                    )}
                  </g>
                );
              })}
              {L.refs.map((r) => {
                const e = edgeById.get(r.edge)!;
                const color = REL_COLOR[r.relation] ?? "#777";
                const s = linkState(r.edge, r.at, r.at);
                const cy = r.y + SEQ.refH / 2;
                // out: card → chip; in: chip → card
                const [x1, y1, x2, y2] = r.dir === "out" ? [r.ax, r.ay, r.x - 1, cy] : [r.x - 1, cy, r.ax + 1, r.ay];
                const d = `M ${x1} ${y1} L ${x2} ${y2}`;
                return (
                  <g key={r.id} className={["seq-link", e.provisional && "provisional", s.dim && "dim"].filter(Boolean).join(" ")} {...linkProps(r.edge)}>
                    <title>{`${eff.byId.get(e.subject)!.displayKey} ${r.relation} ${eff.byId.get(e.object)!.displayKey}${e.provisional ? " (inferred)" : ""}`}</title>
                    <path className="hit" d={d} />
                    <path d={d} stroke={color} strokeWidth={s.isSel ? 3 : s.touches ? 2.2 : 1.5} markerEnd={`url(#seq-arrow-${color.slice(1)})`} />
                    <text className="seq-label small" x={(r.ax + r.x) / 2} y={(r.ay + cy) / 2 - 4} fill={color} textAnchor="middle">
                      {r.relation}
                    </text>
                  </g>
                );
              })}
            </svg>
            {L.rows.map((r) => {
              const on = onScreen.get(r.id);
              return (
                <div
                  key={r.id}
                  className="seq-row"
                  style={{ left: r.x, top: r.y, width: r.w, height: r.h }}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    p.onSelect({ kind: "node", id: r.id });
                  }}
                  onMouseEnter={() => p.onHover(r.id)}
                  onMouseLeave={() => p.onHover(null)}
                >
                  <CardBody
                    node={eff.byId.get(r.id)!}
                    on={on}
                    dim={false}
                    selected={selection?.kind === "node" && selection.id === r.id}
                    related={false}
                    hovered={hover === r.id}
                    style={{ height: "100%" }}
                  />
                </div>
              );
            })}
            {L.refs.map((r) => {
              const t = eff.byId.get(r.target)!;
              const e = edgeById.get(r.edge)!;
              return (
                <button
                  key={r.id}
                  className="seq-ref"
                  style={{ left: r.x, top: r.y, width: SEQ.refW, ["--type" as string]: TYPE_COLOR[t.type] }}
                  title={`${eff.byId.get(e.subject)!.displayKey} ${r.relation} ${eff.byId.get(e.object)!.displayKey}. ${t.displayKey} is far away in the paper: click to go there.`}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    jump(r.target);
                  }}
                >
                  {t.displayKey}
                </button>
              );
            })}
            {L.unplacedFrom < L.rows.length && (
              <div className="seq-divider" style={{ top: L.rows[L.unplacedFrom].y - 28 }}>
                Not placed in the paper
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }),
);
