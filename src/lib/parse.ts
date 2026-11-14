/**
 * Loaders for the MIRA-extraction artifacts:
 *   - <name>.mira.jsonld   canonical MIRA JSON-LD (anchors are `Item`s referenced
 *                          from a record's `description`)
 *   - <name>.graph.json    the extractor's working graph (nodes/edges with `anchor`)
 *   - the web app's /api/extract response (same nodes/edges shape)
 *
 * Anything unusable is reported in `warnings`, never dropped silently.
 * Multiple passages per record are accepted (`anchor` as array, or `anchors`).
 */
import { NODE_TYPES, RELATIONS, type MiraEdge, type MiraGraph, type MiraNode, type NodeType, type PaperInfo } from "./types.ts";

const NODE_SET = new Set<string>(NODE_TYPES);
const REL_SET = new Set<string>(RELATIONS);

const arr = <T>(v: T | T[] | undefined | null): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);
/** "mira:Claim" / "https://…#Claim" → "Claim" */
const local = (t: string) => t.replace(/^.*[#/:]/, "");
const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));

function quotesFrom(v: unknown): string[] {
  return arr(v as string | string[])
    .map((q) => str(q).trim())
    .filter(Boolean);
}

export function parseGraphFile(fileName: string, json: unknown, graphId?: string): MiraGraph {
  if (!json || typeof json !== "object") throw new Error(`${fileName}: not a JSON object`);
  const o = json as Record<string, unknown>;
  if (Array.isArray(o["@graph"])) return parseJsonLd(fileName, o, graphId);
  if (Array.isArray(o.nodes)) return parseWorkingGraph(fileName, o, graphId);
  throw new Error(`${fileName}: neither MIRA JSON-LD (@graph) nor an extractor graph (nodes/edges)`);
}

function baseLabel(fileName: string) {
  return fileName.replace(/\.(mira\.jsonld|graph\.json|jsonld|json)$/i, "");
}

/* ----------------------------------------------------------- working graph */

function parseWorkingGraph(fileName: string, o: Record<string, unknown>, graphId?: string): MiraGraph {
  const warnings: string[] = [];
  const nodes: MiraNode[] = [];
  const seen = new Set<string>();
  for (const raw of arr(o.nodes as Record<string, unknown>[])) {
    const id = str(raw?.id);
    const type = str(raw?.type) as NodeType;
    if (!id || !NODE_SET.has(type)) {
      warnings.push(`node skipped (${id || "no id"}): unknown class "${type}"`);
      continue;
    }
    if (seen.has(id)) {
      warnings.push(`duplicate node id ${id} — later copy skipped`);
      continue;
    }
    seen.add(id);
    nodes.push({
      id,
      type,
      text: str(raw.text).trim(),
      description: str(raw.description).trim() || undefined,
      doi: str(raw.doi) || undefined,
      url: str(raw.url) || undefined,
      anchors: [...quotesFrom(raw.anchor), ...quotesFrom(raw.anchors)],
    });
  }
  const edges: MiraEdge[] = [];
  arr(o.edges as Record<string, unknown>[]).forEach((raw, i) => {
    const e: MiraEdge = {
      id: str(raw?.id) || `e${i}`,
      relation: str(raw?.relation),
      subject: str(raw?.subject),
      object: str(raw?.object),
      anchors: [...quotesFrom(raw?.anchor), ...quotesFrom(raw?.anchors)],
      consolidated: raw?.consolidated === true || undefined,
    };
    const problem = edgeProblem(e, seen);
    if (problem) warnings.push(problem);
    else edges.push(e);
  });
  const dropped = o.dropped as Record<string, unknown[]> | undefined;
  if (dropped) {
    const n = arr(dropped.nodes).length + arr(dropped.danglingEdges).length + arr(dropped.ungrammaticalEdges).length;
    if (n) warnings.push(`extractor itself dropped ${n} record(s) — see its report`);
  }
  const flakes = arr(o.flakes);
  if (flakes.length) warnings.push(`extractor reported ${flakes.length} failed piece(s): this extraction is partial`);
  return {
    id: graphId ?? baseLabel(fileName),
    label: baseLabel(fileName),
    origin: { file: fileName, format: "extractedText" in o ? "extract-response" : "graph-json" },
    paper: cleanPaper(o.paper),
    nodes,
    edges,
    warnings,
  };
}

function cleanPaper(p: unknown): PaperInfo | undefined {
  if (!p || typeof p !== "object") return undefined;
  const r = p as Record<string, unknown>;
  return {
    title: str(r.title) || undefined,
    doi: str(r.doi) || undefined,
    authors: arr(r.authors as { name: string; orcid?: string }[]).filter((a) => a && a.name),
  };
}

function edgeProblem(e: MiraEdge, ids: Set<string>): string | null {
  if (!REL_SET.has(e.relation)) return `edge ${e.id} skipped: unknown relation "${e.relation}"`;
  if (!ids.has(e.subject) || !ids.has(e.object)) return `edge ${e.id} (${e.relation}) skipped: dangling endpoint`;
  return null;
}

/* ----------------------------------------------------------------- JSON-LD */

function parseJsonLd(fileName: string, o: Record<string, unknown>, graphId?: string): MiraGraph {
  const warnings: string[] = [];
  const graph = o["@graph"] as Record<string, unknown>[];
  const items = new Map<string, string>();
  const accounts = new Map<string, string>();
  for (const g of graph) {
    const types = arr(g["@type"] as string | string[]).map(local);
    if (types.includes("Item")) items.set(str(g["@id"]), str(g.content));
    if (types.includes("UserAccount")) accounts.set(str(g["@id"]), str(g.accountName));
  }
  const nodes: MiraNode[] = [];
  const ids = new Set<string>();
  const rels: Record<string, unknown>[] = [];
  let paper: PaperInfo | undefined;

  for (const g of graph) {
    const types = arr(g["@type"] as string | string[]).map(local);
    if (types.includes("RelationInstance")) {
      rels.push(g);
      continue;
    }
    const cls = types.find((t) => NODE_SET.has(t)) as NodeType | undefined;
    if (!cls) continue;
    const id = str(g["@id"]);
    const content = str(g.content);
    const title = str(g.title) || content.split(/\n\n/)[0];
    // the extractor puts a free-text description after a blank line in `content`
    const extra = content.startsWith(title) ? content.slice(title.length).trim() : "";
    const anchors: string[] = [];
    for (const ref of arr(g.description as string | string[])) {
      const r = str(ref);
      if (items.has(r)) anchors.push(items.get(r)!.trim());
      else if (r && !r.includes(":")) anchors.push(r.trim());
      else if (r) warnings.push(`${id}: anchor ${r} not found among Items`);
    }
    nodes.push({
      id,
      type: cls,
      text: title.trim(),
      description: extra || undefined,
      doi: cls === "SourceDocument" && id.includes("doi.org/") ? id.replace(/^.*doi\.org\//, "") : undefined,
      url: cls === "SourceDocument" && /^https?:/.test(id) ? id : undefined,
      anchors: anchors.filter(Boolean),
    });
    ids.add(id);
    if (cls === "SourceDocument" && !paper && arr(g.creator as string | string[]).some((c) => accounts.has(str(c)) && !str(c).endsWith(":agent"))) {
      paper = {
        title: title.trim(),
        doi: id.includes("doi.org/") ? id.replace(/^.*doi\.org\//, "") : undefined,
        authors: arr(g.creator as string | string[])
          .map((c) => ({ name: accounts.get(str(c)) ?? "", orcid: str(c).includes("orcid.org") ? str(c).replace(/^.*orcid\.org\//, "") : undefined }))
          .filter((a) => a.name),
      };
    }
  }
  const edges: MiraEdge[] = [];
  for (const g of rels) {
    const types = arr(g["@type"] as string | string[]).map(local);
    const relation = types.find((t) => REL_SET.has(t)) ?? types.find((t) => t !== "RelationInstance" && !t.startsWith("_rel_")) ?? "";
    const anchors = arr(g.description as string | string[])
      .map((r) => items.get(str(r)) ?? "")
      .filter(Boolean);
    const e: MiraEdge = { id: str(g["@id"]), relation, subject: str(g.source), object: str(g.destination), anchors };
    const problem = edgeProblem(e, ids);
    if (problem) warnings.push(problem);
    else edges.push(e);
  }
  return {
    id: graphId ?? baseLabel(fileName),
    label: baseLabel(fileName),
    origin: { file: fileName, format: "mira-jsonld" },
    paper,
    nodes,
    edges,
    warnings,
  };
}
