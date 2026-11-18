import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { openPdf, type OpenPdfTask, type PdfDocument } from "../../modules/pdf-viewer/index.ts";
import { buildIndex, type DocIndex } from "../lib/anchor.ts";
import { parseGraphFile } from "../lib/parse.ts";
import { activeBoxes, onScreen as computeOnScreen, primaryBox, recordBoxes, resolveAll, type VisibleBand } from "../lib/resolve.ts";
import { layoutGraph, type Positions } from "../lib/layout.ts";
import { effectiveGraph } from "../lib/graph.ts";
import { addExtraGraph, extraGraphs, type GraphSource, type PaperSource } from "../lib/store.ts";
import type { MiraGraph, NodeType, PageBox } from "../lib/types.ts";
import { TYPE_COLOR, TYPE_LABEL, REL_COLOR } from "../lib/palette.ts";
import { PdfViewer, type Highlight, type MarginMark, type PdfViewerHandle } from "./PdfViewer.tsx";
import { GraphPanel, type Selection } from "./GraphPanel.tsx";
import { sameOnScreen, visibleSet, type Scope } from "../lib/focus.ts";
import { HelpDrawer } from "./HelpDrawer.tsx";
import { SequenceView, SYNC_LINE, type SequenceHandle } from "./SequenceView.tsx";
import { OutlineView } from "./OutlineView.tsx";
import { Connectors } from "./Connectors.tsx";

interface Loaded {
  doc: PdfDocument;
  idx: DocIndex;
  graphs: (MiraGraph & { source: GraphSource })[];
}

async function loadGraph(src: GraphSource, i: number): Promise<MiraGraph & { source: GraphSource }> {
  const json = src.json ?? (await (await fetch(src.url!)).json());
  const g = parseGraphFile(src.file.split("/").pop()!, json, `${i}:${src.file}`);
  return { ...g, label: src.label ?? g.label, provenance: src.provenance, source: src };
}

export function Reader({ paper, onBack }: { paper: PaperSource; onBack(): void }) {
  const [state, setState] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let dead = false;
    let loading: OpenPdfTask | undefined;
    (async () => {
      try {
        loading = openPdf(paper.pdfBytes ? { bytes: paper.pdfBytes } : { url: paper.pdfUrl! });
        const doc = await loading.promise;
        if (dead) return;
        const idx = buildIndex(doc.pages);
        const srcs = [...paper.graphs, ...(await extraGraphs(paper.id))];
        const graphs = [];
        for (const [i, s] of srcs.entries()) {
          try {
            graphs.push(await loadGraph(s, i));
          } catch (e) {
            console.warn("graph failed", s.file, e);
          }
        }
        if (!dead) setState({ doc, idx, graphs });
      } catch (e) {
        if (!dead) setError(String(e));
      }
    })();
    return () => {
      dead = true;
      void loading?.destroy().catch((e) => console.warn("PDF cleanup failed", e));
    };
  }, [paper]);

  if (error)
    return (
      <div className="center-msg">
        <p>Could not open this paper: {error}</p>
        <button onClick={onBack}>Back</button>
        {paper.arxivPage && <p><a href={paper.arxivPage} target="_blank" rel="noopener noreferrer">Open on arXiv</a></p>}
      </div>
    );
  if (!state) return <div className="center-msg">Reading the PDF and placing the graph…</div>;
  return <ReaderLoaded paper={paper} loaded={state} setLoaded={setState} onBack={onBack} />;
}

function ReaderLoaded({ paper, loaded, setLoaded, onBack }: { paper: PaperSource; loaded: Loaded; setLoaded(l: Loaded): void; onBack(): void }) {
  const { doc, idx, graphs } = loaded;
  const { pages } = doc;
  const [gid, setGid] = useState(graphs[0]?.id ?? "");
  const graph = graphs.find((g) => g.id === gid) ?? graphs[0];
  const [selection, setSelection] = useState<Selection>(null);
  const [markFocus, setMarkFocus] = useState<{ graphId: string; id: string } | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [scope, setScope] = useState<Scope>("full");
  const [view, setView] = useState<View>("graph");
  const [help, setHelp] = useState(false);
  const [showMarks, setShowMarks] = useState(true);
  const [bands, setBands] = useState<VisibleBand[]>([]);
  const [split, setSplit] = useState(() => Number(safeGet("pdf-mira:split")) || 0.52);
  const viewer = useRef<PdfViewerHandle>(null);
  const seq = useRef<SequenceHandle>(null);
  const readerRef = useRef<HTMLDivElement>(null);

  // switching maps starts afresh
  useEffect(() => {
    setSelection(null);
  }, [graph?.id]);

  useEffect(() => {
    setMarkFocus(null);
  }, [graph?.id, view, scope]);

  const eff = useMemo(() => (graph ? effectiveGraph(graph) : { nodes: [], edges: [], byId: new Map() }), [graph]);
  const anchors = useMemo(() => resolveAll(idx, eff), [idx, eff]);
  // one layered layout per map, so positions never change while reading
  const positions: Positions = useMemo(() => layoutGraph({ nodes: eff.nodes, edges: eff.edges }), [eff]);
  const pageHeights = useMemo(() => pages.map((p) => p.height), [pages]);


  // Scroll → visible bands, debounced until the PDF position settles (also a
  // natural throttle). Held while the pointer is on the graph, so a card never
  // moves out from under a click; released when the pointer leaves.
  const pendingBands = useRef<VisibleBand[] | null>(null);
  const bandTimer = useRef(0);
  const holdGraph = useRef(false);
  const flushBands = useCallback(() => {
    if (holdGraph.current || !pendingBands.current) return;
    const b = pendingBands.current;
    pendingBands.current = null;
    setBands(b);
  }, []);
  const onVisible = useCallback(
    (b: VisibleBand[]) => {
      pendingBands.current = b;
      clearTimeout(bandTimer.current);
      bandTimer.current = window.setTimeout(flushBands, BAND_SETTLE_MS);
    },
    [flushBands],
  );
  useEffect(() => () => clearTimeout(bandTimer.current), []);

  const lastOnScreen = useRef<ReturnType<typeof computeOnScreen>>(new Map());
  const onScreen = useMemo(() => {
    const next = computeOnScreen(anchors, bands);
    if (sameOnScreen(next, lastOnScreen.current)) return lastOnScreen.current;
    lastOnScreen.current = next;
    return next;
  }, [anchors, bands]);
  const shownIds = useMemo(() => visibleSet(eff, onScreen, selection, scope), [eff, onScreen, selection, scope]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select, [contenteditable]")) return;
      if (e.key === "?") setHelp((h) => !h);
      if (e.key === "Escape") setHelp(false);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);

  /* ------------------------------------------------------------ actions */
  const goto = useCallback((box: PageBox | undefined) => box && viewer.current?.scrollToBox(box), []);
  const select = useCallback(
    (s: Selection, scroll = true) => {
      setSelection(s);
      if (s && scroll) goto(primaryBox(anchors.get(s.id)));
    },
    [anchors, goto],
  );

  // Sequence: the two panes scroll together. Only the reader's own scrolling
  // is passed across, so neither side ever chases the other.
  const onPdfUserScroll = useCallback((u: number) => seq.current?.syncTo(u), []);
  const onSeqUserScroll = useCallback((u: number) => viewer.current?.scrollToPaper(u), []);
  const paperNow = useCallback(() => viewer.current?.paperAt(), []);

  /* --------------------------------------------------------- PDF overlays */
  const highlights = useMemo(() => {
    const hs: Highlight[] = [];
    const add = (id: string, strength: "base" | "sel" | "hover") => {
      const a = anchors.get(id);
      if (!a) return;
      const n = eff.byId.get(id);
      const color = n ? TYPE_COLOR[n.type as NodeType] : REL_COLOR[eff.edges.find((e) => e.id === id)?.relation ?? ""] ?? "#888";
      for (const p of a.passages) {
        if (p.kind === "missing") continue;
        if (p.occurrences.length > 1) {
          p.boxes.forEach((bx, i) =>
            hs.push({
              boxes: bx,
              cls: `${strength} ${p.kind} repeated`,
              color,
              label: strength === "sel" ? `${i + 1}/${p.occurrences.length}` : undefined,
            }),
          );
        } else hs.push({ boxes: activeBoxes(p), cls: `${strength} ${p.kind}`, color });
      }
      if (a.estimate && !a.passages.some((p) => p.kind !== "missing"))
        hs.push({ boxes: a.estimate.boxes[0], cls: `${strength} estimated`, color, label: strength === "sel" ? "estimated location" : undefined });
    };
    // One overlay per record: selection changes its strength, never its color.
    const emphasized = new Set(hover ? [hover] : []);
    if (selection?.kind === "edge") {
      const edge = eff.edges.find((e) => e.id === selection.id);
      if (edge) {
        emphasized.add(edge.subject);
        emphasized.add(edge.object);
      }
    }
    for (const n of eff.nodes) {
      add(n.id, selection?.id === n.id ? "sel" : emphasized.has(n.id) ? "hover" : "base");
    }
    if (selection?.kind === "edge") add(selection.id, "sel");
    if (hover && hover !== selection?.id && !eff.byId.has(hover)) add(hover, "hover");
    return hs;
  }, [selection, hover, anchors, eff]);

  const marks = useMemo(() => {
    if (!showMarks) return [] as MarginMark[];
    const ms: MarginMark[] = [];
    for (const n of eff.nodes) {
      const { boxes, estimated } = recordBoxes(anchors.get(n.id));
      const seenPages = new Set<number>();
      for (const b of boxes) {
        if (seenPages.has(b.page)) continue;
        seenPages.add(b.page);
        ms.push({
          id: n.id,
          displayKey: n.displayKey,
          page: b.page,
          y: b.y1,
          color: TYPE_COLOR[n.type],
          title: `${TYPE_LABEL[n.type]}${estimated ? " (estimated location)" : ""}: ${n.text}`,
          active: selection?.id === n.id,
        });
      }
    }
    return ms;
  }, [showMarks, eff, anchors, selection]);

  /* ---------------------------------------------------------- graph files */
  const addGraphFiles = async (files: FileList | null) => {
    if (!files) return;
    const added: (MiraGraph & { source: GraphSource })[] = [];
    for (const f of Array.from(files)) {
      try {
        const json = JSON.parse(await f.text());
        const src: GraphSource = { file: f.name, label: f.name, provenance: "Loaded from a local file", json };
        added.push(await loadGraph(src, graphs.length + added.length));
        await addExtraGraph(paper.id, src);
      } catch (e) {
        alert(`${f.name}: ${e}`);
      }
    }
    if (added.length) {
      setLoaded({ ...loaded, graphs: [...graphs, ...added] });
      setGid(added[0].id);
    }
  };

  // Quote-matching problems are a property of the map file, not something a
  // reader acts on: report them to the developer console only.
  useEffect(() => {
    const rows: { id: string; text: string; problem: string; quote: string }[] = [];
    for (const [id, a] of anchors) {
      const rec = eff.byId.get(id);
      const text = rec?.text ?? id;
      for (const p of a.passages) {
        if (p.kind === "missing") rows.push({ id, text, problem: "not found in PDF", quote: p.quote });
        else if (p.kind === "approximate") rows.push({ id, text, problem: `approximate (${Math.round((p.occurrences[0]?.score ?? 0) * 100)}%)`, quote: p.quote });
      }
      if (rec && !a.passages.length) rows.push({ id, text, problem: "no quote in graph", quote: "" });
    }
    if (rows.length || graph?.warnings.length) {
      console.groupCollapsed(`[pdf-mira] ${graph?.label}: ${rows.length} quote-matching issue(s), ${graph?.warnings.length ?? 0} loader warning(s)`);
      if (rows.length) console.table(rows);
      for (const w of graph?.warnings ?? []) console.debug("loader:", w);
      console.groupEnd();
    }
  }, [anchors, eff, graph]);
  const startDrag = (e: React.PointerEvent) => {
    const W = window.innerWidth;
    const move = (ev: PointerEvent) => setSplit(Math.min(0.75, Math.max(0.3, ev.clientX / W)));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setSplit((s) => (safeSet("pdf-mira:split", String(s)), s));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    e.preventDefault();
  };

  if (!graph)
    return (
      <div className="center-msg">
        <p>No graph could be loaded for this paper.</p>
        <label className="button">
          Load a graph file
          <input type="file" accept=".json,.jsonld" multiple hidden onChange={(e) => addGraphFiles(e.target.files)} />
        </label>
        <button onClick={onBack}>Back</button>
      </div>
    );

  return (
    <div className="reader" ref={readerRef} style={{ gridTemplateColumns: `${split * 100}% 6px 1fr` }}>
      <div className="pane pdf-pane">
        <div className="pane-head">
          <button className="ghost small" onClick={onBack} title="Back to library">
            ← Library
          </button>
          <span className="doc-title" title={paper.title}>
            {paper.title}
          </span>
          <label className="toggle" title="Colored marks in the margin for every grounded record; click one to select it">
            <input type="checkbox" checked={showMarks} onChange={(e) => setShowMarks(e.target.checked)} /> margin marks
          </label>
        </div>
        <PdfViewer
          ref={viewer}
          doc={doc}
          pages={pages}
          highlights={highlights}
          marks={marks}
          onMarkClick={(id) => {
            select({ kind: "node", id }, false);
            if (view === "graph" && scope === "full") {
              clearTimeout(bandTimer.current);
              flushBands();
              setMarkFocus({ graphId: graph.id, id });
            }
          }}
          onMarkHover={setHover}
          onVisible={onVisible}
          onUserScroll={view === "sequence" ? onPdfUserScroll : undefined}
          syncLine={SYNC_LINE}
        />
      </div>
      <div className="divider" onPointerDown={startDrag} title="Drag to resize" />
      <div className="pane side-pane">
        <div className="pane-head">
          <select className="graph-select" value={graph.id} onChange={(e) => setGid(e.target.value)} title={graph.provenance ? `Graphs of this paper. This one: ${graph.provenance}` : "Graphs of this paper"}>
            {graphs.map((g) => (
              <option key={g.id} value={g.id}>
                {g.label} ({g.nodes.length})
              </option>
            ))}
          </select>
          <label className="ghost small button" title="Add another graph file (.mira.jsonld or .graph.json) for this paper">
            + graph
            <input type="file" accept=".json,.jsonld" multiple hidden onChange={(e) => addGraphFiles(e.target.files)} />
          </label>
          <span className="spacer" />
          <div className="seg" role="radiogroup" aria-label="How to show them">
            {(
              [
                ["graph", "Graph", "Cards joined by arrows, laid out by the argument"],
                ["outline", "Outline", "An indented list under each question"],
                ["sequence", "Sequence", "Every record in the order it appears in the paper"],
              ] as const
            ).map(([m, l, t]) => (
              <button key={m} role="radio" aria-checked={view === m} className={view === m ? "on" : ""} title={t} onClick={() => setView(m)}>
                {l}
              </button>
            ))}
          </div>
          <div
            className={`seg ${view === "sequence" ? "disabled" : ""}`}
            role="radiogroup"
            aria-label="Which records"
            title={view === "sequence" ? "Sequence always shows every record" : undefined}
          >
            {(
              [
                ["onscreen", "On screen", "The records on screen, with what they argue for (faded)"],
                ["full", "Full", "Every record in full color"],
              ] as const
            ).map(([m, l, t]) => (
              <button key={m} role="radio" aria-checked={scope === m} className={scope === m && view !== "sequence" ? "on" : ""} title={view === "sequence" ? undefined : t} disabled={view === "sequence"} onClick={() => setScope(m)}>
                {l}
              </button>
            ))}
          </div>
          <button className={`help-btn ${help ? "on" : ""}`} onClick={() => setHelp((h) => !h)} title="Quick help (press ?)" aria-expanded={help}>
            <span className="help-q">?</span> Help
          </button>
        </div>
        <div
          className={view !== "sequence" && scope === "onscreen" ? "graph-area scope-onscreen" : "graph-area"}
          onPointerEnter={() => (holdGraph.current = true)}
          onPointerLeave={() => {
            holdGraph.current = false;
            flushBands();
          }}
        >
          {view === "sequence" ? (
            <SequenceView
              ref={seq}
              eff={eff}
              anchors={anchors}
              positions={positions}
              pageHeights={pageHeights}
              onScreen={onScreen}
              selection={selection}
              hover={hover}
              onSelect={select}
              onHover={setHover}
              onUserScroll={onSeqUserScroll}
              paperNow={paperNow}
            />
          ) : view === "outline" ? (
            <OutlineView eff={eff} include={shownIds.ids} onScreen={onScreen} selection={selection} onSelect={(s) => select(s)} onHover={setHover} />
          ) : (
            <GraphPanel
              eff={eff}
              anchors={anchors}
              positions={positions}
              onScreen={onScreen}
              selection={selection}
              hover={hover}
              scope={scope}
              markFocus={markFocus?.graphId === graph.id ? markFocus : null}
              onMarkFocusHandled={setMarkFocus}
              onSelect={(s) => select(s)}
              onHover={setHover}
            />
          )}
          {view !== "sequence" && shownIds.overview && (
            <div className="graph-hud">
              <span className="small muted">Nothing on this part of the page is in the graph, so its questions and claims are shown.</span>
            </div>
          )}
        </div>
        {help && <HelpDrawer onClose={() => setHelp(false)} />}
      </div>
      {showMarks && <Connectors root={readerRef} active={hover ?? (selection?.kind === "node" ? selection.id : null)} hidden={help} />}
    </div>
  );
}

const BAND_SETTLE_MS = 220;
type View = "graph" | "outline" | "sequence";

function safeGet(k: string) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function safeSet(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* ignore */
  }
}
