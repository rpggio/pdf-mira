/**
 * Which records the graph (and outline) show, for the two scopes:
 *
 *  full      — every record in the full layout.
 *  onscreen  — the records whose passages are on screen, plus their ancestors
 *              (what they argue for, up to the questions) shown faded, plus the
 *              selection and everything linked to it. With FEW_ON_SCREEN or fewer
 *              on screen, their immediate children (what argues for them) too.
 */
import type { EffGraph } from "./graph.ts";
import type { OnScreen } from "./resolve.ts";

export type Scope = "onscreen" | "full";
export type FocusSelection = { kind: "node" | "edge"; id: string } | null;

/** Argument parents: what a record argues for or hangs under (layout "up"). */
export function parentsOf(eff: EffGraph): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  for (const n of eff.nodes) m.set(n.id, new Set());
  for (const e of eff.edges) {
    if (!eff.byId.has(e.subject) || !eff.byId.has(e.object)) continue;
    if (e.relation === "follows") m.get(e.object)!.add(e.subject); // protocol hangs under its study
    else m.get(e.subject)!.add(e.object); // evidence → claim → question, study → evidence
  }
  return m;
}

export function ancestors(parents: Map<string, Set<string>>, start: Iterable<string>): Set<string> {
  const out = new Set<string>();
  const stack = [...start];
  while (stack.length) {
    const id = stack.pop()!;
    for (const p of parents.get(id) ?? []) {
      if (!out.has(p)) {
        out.add(p);
        stack.push(p);
      }
    }
  }
  return out;
}

export function adjacency(eff: EffGraph): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  for (const n of eff.nodes) m.set(n.id, new Set());
  for (const e of eff.edges) {
    m.get(e.subject)?.add(e.object);
    m.get(e.object)?.add(e.subject);
  }
  return m;
}

/** at or below this many records on screen, their immediate children are shown too */
export const FEW_ON_SCREEN = 3;

/** Argument children: the inverse of `parentsOf` (what argues for / hangs under a record). */
export function childrenOf(parents: Map<string, Set<string>>): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  for (const id of parents.keys()) m.set(id, new Set());
  for (const [id, ps] of parents) for (const p of ps) m.get(p)?.add(id);
  return m;
}

export interface VisibleSet {
  ids: Set<string>;
  /** why nothing anchored is shown (on-screen scope, nothing on screen) */
  overview: boolean;
}

export function visibleSet(
  eff: EffGraph,
  onScreen: OnScreen,
  selection: FocusSelection,
  scope: Scope,
  adj = adjacency(eff),
  parents = parentsOf(eff),
): VisibleSet {
  if (scope === "full") return { ids: new Set(eff.nodes.map((n) => n.id)), overview: false };
  const base = new Set<string>();
  for (const [id] of onScreen) if (eff.byId.has(id)) base.add(id);
  const sel = new Set<string>();
  if (selection?.kind === "node" && eff.byId.has(selection.id)) sel.add(selection.id);
  if (selection?.kind === "edge") {
    const e = eff.edges.find((x) => x.id === selection.id);
    if (e) sel.add(e.subject).add(e.object);
  }
  const v = new Set<string>([...base, ...sel]);
  // few records on screen: show what argues for them as well
  if (base.size <= FEW_ON_SCREEN) {
    const kids = childrenOf(parents);
    for (const id of base) for (const c of kids.get(id) ?? []) v.add(c);
  }
  // a selected record: everything it connects to
  if (selection?.kind === "node") for (const nb of adj.get(selection.id) ?? []) v.add(nb);
  let overview = false;
  if (!v.size) {
    overview = true;
    for (const n of eff.nodes) if (n.type === "Question" || n.type === "Claim") v.add(n.id);
  }
  for (const a of ancestors(parents, [...base, ...sel])) v.add(a);
  // A visible conclusion should retain a real connection even if its support
  // falls outside the current PDF viewport.
  for (const id of [...v]) {
    const neighbors = [...(adj.get(id) ?? [])];
    if (neighbors.some((neighbor) => v.has(neighbor))) continue;
    const support = neighbors.find((neighbor) => {
      const type = eff.byId.get(neighbor)?.type;
      return type === "Claim" || type === "Evidence";
    }) ?? neighbors[0];
    if (support !== undefined) v.add(support);
  }
  return { ids: v, overview };
}

/** Same on-screen map content → keep the old reference (skips needless redraws). */
export function sameOnScreen(a: OnScreen, b: OnScreen): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}
