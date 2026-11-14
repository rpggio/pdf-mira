/**
 * Outline: the same records as an indented argument tree —
 * Question ← Claim ← (supporting/opposing Claim | Evidence ← Study → Protocol).
 * Every record appears once at its first position; the rest are listed after.
 */
import { useMemo } from "react";
import type { EffEdge, EffGraph } from "../lib/graph.ts";
import type { OnScreen } from "../lib/resolve.ts";
import { TypeChip } from "./bits.tsx";
import type { Selection } from "./GraphPanel.tsx";

interface Props {
  eff: EffGraph;
  onScreen: OnScreen;
  /** records the current scope shows (others are left out of the tree) */
  include: Set<string>;
  selection: Selection;
  onSelect(s: Selection): void;
  onHover(id: string | null): void;
}

interface Row {
  id: string;
  depth: number;
  via?: EffEdge;
}

/** children of a record in the argument tree: what argues for / grounds it */
function childEdges(eff: EffGraph, id: string): EffEdge[] {
  const n = eff.byId.get(id)!;
  return eff.edges.filter((e) => {
    if (e.object === id && ["addresses", "supports", "opposes", "grounds", "describesActivity", "request_target", "request_for"].includes(e.relation)) return true;
    if (e.subject === id && e.relation === "follows") return true;
    if (n.type === "Evidence" && e.object === id && e.relation === "grounds") return true;
    return false;
  });
}

export function OutlineView({ eff, onScreen, include, selection, onSelect, onHover }: Props) {
  const rows = useMemo(() => {
    const out: Row[] = [];
    const seen = new Set<string>();
    const walk = (id: string, depth: number, via?: EffEdge) => {
      if (seen.has(id)) return;
      seen.add(id);
      out.push({ id, depth, via });
      for (const e of childEdges(eff, id)) walk(e.relation === "follows" ? e.object : e.subject, depth + 1, e);
    };
    const roots = eff.nodes.filter((n) => n.type === "Question");
    for (const r of roots) walk(r.id, 0);
    // claims nobody addresses a question with, then everything else
    for (const n of eff.nodes) if (n.type === "Claim" && !eff.edges.some((e) => e.subject === n.id && (e.relation === "supports" || e.relation === "opposes" || e.relation === "addresses"))) walk(n.id, 0);
    for (const n of eff.nodes) walk(n.id, 0);
    return out.filter((r) => include.has(r.id));
  }, [eff, include]);

  return (
    <div className="outline">
      {rows.map(({ id, depth, via }) => {
        const n = eff.byId.get(id)!;
        const on = onScreen.get(id);
        const sel = selection?.kind === "node" && selection.id === id;
        return (
          <div
            key={id}
            className={`orow ${sel ? "selected" : ""} ${on ? "onscreen-" + on : sel ? "" : "dim"}`}
            data-rec={id}
            style={{ paddingLeft: 10 + depth * 18 }}
            title={on === "precise" ? "Its passage is on screen" : on === "estimated" ? "Its estimated location is on screen" : undefined}
            onClick={() => onSelect({ kind: "node", id })}
            onMouseEnter={() => onHover(id)}
            onMouseLeave={() => onHover(null)}
          >
            {via && (
              <span
                className={`via rel-${via.relation} ${via.provisional ? "provisional" : ""}`}
                title={via.provisional ? "Inferred relation — no passage states it" : "Grounded relation"}
                onClick={(ev) => {
                  ev.stopPropagation();
                  onSelect({ kind: "edge", id: via.id });
                }}
              >
                {via.relation}
              </span>
            )}
            <TypeChip type={n.type} />
            <span className="otext">{n.text}</span>
            <span className="rec-id">{n.displayKey}</span>
          </div>
        );
      })}
    </div>
  );
}
