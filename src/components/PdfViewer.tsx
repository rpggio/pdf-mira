/**
 * Continuous-scroll PDF viewer (pdf.js canvas + text layer), with:
 *  - highlight overlays in PDF user-space boxes
 *  - clickable margin marks in the right margin (PDF → map navigation)
 *  - visible-band reporting (which part of which page is on screen)
 *  - paper positions for scroll sync (`u`: page index + fraction down the page)
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { watchUserScroll, type UserScrollWatch } from "../lib/userScroll.ts";
import { TextLayer, type PDFDocumentProxy, type PDFPageProxy, type RenderTask } from "pdfjs-dist";
import type { PageBox, PageText } from "../lib/types.ts";
import type { VisibleBand } from "../lib/resolve.ts";

export interface Highlight {
  boxes: PageBox[];
  cls: string;
  color?: string;
  label?: string;
}
export interface MarginMark {
  id: string;
  displayKey: string;
  page: number;
  y: number; // PDF user space (top of passage)
  color: string;
  title: string;
  active?: boolean;
}
export interface PdfViewerHandle {
  scrollToBox(box: PageBox): void;
  /** paper position at the sync line */
  paperAt(): number;
  /** scroll so paper position `u` sits at the sync line */
  scrollToPaper(u: number): void;
}

interface Props {
  doc: PDFDocumentProxy;
  pages: PageText[];
  highlights: Highlight[];
  marks: MarginMark[];
  onMarkClick(id: string): void;
  onMarkHover(id: string | null): void;
  onVisible(bands: VisibleBand[]): void;
  /** the reader scrolled the PDF (or changed its zoom): paper position now at the sync line */
  onUserScroll?(u: number): void;
  /** how far down the pane the sync line is */
  syncLine: number;
}

const GAP = 14;
const PAD = 20;
const MARGIN = 70; // right-hand gutter for margin marks (they carry record keys)

export const PdfViewer = forwardRef<PdfViewerHandle, Props>(function PdfViewer(
  { doc, pages, highlights, marks, onMarkClick, onMarkHover, onVisible, onUserScroll, syncLine },
  ref,
) {
  const scroller = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [zoom, setZoom] = useState(1);
  const [current, setCurrent] = useState(1);

  useLayoutEffect(() => {
    const el = scroller.current!;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const maxW = Math.max(...pages.map((p) => p.width));
  const scale = Math.max(0.3, ((width - PAD * 2 - MARGIN) / maxW) * zoom);
  const tops = useMemo(() => {
    const t: number[] = [];
    let y = PAD;
    for (const p of pages) {
      t.push(y);
      y += p.height * scale + GAP;
    }
    t.push(y);
    return t;
  }, [pages, scale]);

  const report = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const top = el.scrollTop;
    const bottom = top + el.clientHeight;
    const bands: VisibleBand[] = [];
    let best = 0;
    let bestShare = 0;
    pages.forEach((p, i) => {
      const pt = tops[i];
      const pb = pt + p.height * scale;
      const lo = Math.max(top, pt);
      const hi = Math.min(bottom, pb);
      if (hi <= lo) return;
      const share = (hi - lo) / el.clientHeight;
      bands.push({ page: p.page, y1: p.height - (lo - pt) / scale, y0: p.height - (hi - pt) / scale, share });
      if (share > bestShare) {
        bestShare = share;
        best = p.page;
      }
    });
    if (best) setCurrent(best);
    onVisible(bands);
  }, [pages, tops, scale, onVisible]);

  useEffect(() => {
    // report on every scroll event (cheap); the reader debounces until it settles
    const el = scroller.current!;
    el.addEventListener("scroll", report, { passive: true });
    report();
    return () => el.removeEventListener("scroll", report);
  }, [report]);

  // paper position u ↔ content y
  const yToU = useCallback(
    (y: number) => {
      let i = 0;
      while (i < pages.length - 1 && tops[i + 1] <= y) i++;
      return i + Math.min(1, Math.max(0, (y - tops[i]) / (pages[i].height * scale)));
    },
    [pages, tops, scale],
  );
  const uToY = useCallback(
    (u: number) => {
      const i = Math.min(pages.length - 1, Math.max(0, Math.floor(u)));
      return tops[i] + Math.min(1, Math.max(0, u - i)) * pages[i].height * scale;
    },
    [pages, tops, scale],
  );
  const paperAt = useCallback(() => {
    const el = scroller.current!;
    return yToU(el.scrollTop + el.clientHeight * syncLine);
  }, [yToU, syncLine]);

  const watch = useRef<UserScrollWatch | null>(null);
  const onUser = useRef(onUserScroll);
  onUser.current = onUserScroll;
  useEffect(() => {
    const w = watchUserScroll(scroller.current!, () => onUser.current?.(paperAt()));
    watch.current = w;
    return () => w.stop();
  }, [paperAt]);

  // keep the reading position when zooming or resizing, then tell the other view
  const prevScale = useRef(scale);
  useLayoutEffect(() => {
    const el = scroller.current!;
    const r = scale / prevScale.current;
    if (r !== 1) {
      watch.current?.quiet();
      el.scrollTop = el.scrollTop * r;
      onUser.current?.(paperAt());
    }
    prevScale.current = scale;
  }, [scale, paperAt]);

  useImperativeHandle(
    ref,
    () => ({
      scrollToBox(box) {
        const el = scroller.current;
        const i = pages.findIndex((p) => p.page === box.page);
        if (!el || i < 0) return;
        const y = tops[i] + (pages[i].height - box.y1) * scale;
        const visible = y > el.scrollTop + 40 && y < el.scrollTop + el.clientHeight - 80;
        if (!visible) {
          const top = Math.max(0, y - el.clientHeight * 0.28);
          // long jumps are instant (smooth scrolling across pages is slow and easily interrupted)
          el.scrollTo({ top, behavior: Math.abs(top - el.scrollTop) > el.clientHeight * 1.5 ? "auto" : "smooth" });
        }
      },
      paperAt,
      scrollToPaper(u) {
        const el = scroller.current;
        if (!el) return;
        watch.current?.quiet();
        el.scrollTop = uToY(u) - el.clientHeight * syncLine;
      },
    }),
    [pages, tops, scale, paperAt, uToY, syncLine],
  );

  const byPage = useMemo(() => {
    const m = new Map<number, { h: Highlight; boxes: PageBox[] }[]>();
    for (const h of highlights) {
      const per = new Map<number, PageBox[]>();
      for (const b of h.boxes) {
        if (!per.has(b.page)) per.set(b.page, []);
        per.get(b.page)!.push(b);
      }
      for (const [p, boxes] of per) {
        if (!m.has(p)) m.set(p, []);
        m.get(p)!.push({ h, boxes });
      }
    }
    return m;
  }, [highlights]);

  const marksByPage = useMemo(() => {
    const m = new Map<number, MarginMark[]>();
    for (const mk of marks) {
      if (!m.has(mk.page)) m.set(mk.page, []);
      m.get(mk.page)!.push(mk);
    }
    return m;
  }, [marks]);

  return (
    <div className="pdf-wrap">
      <div className="pdf-toolbar">
        <span className="pdf-page-ind">
          Page {current} / {pages.length}
        </span>
        <span className="spacer" />
        <button className="icon" title="Zoom out" onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.15).toFixed(2)))}>
          −
        </button>
        <button className="ghost small" title="Fit width" onClick={() => setZoom(1)}>
          {Math.round(zoom * 100)}%
        </button>
        <button className="icon" title="Zoom in" onClick={() => setZoom((z) => Math.min(3, +(z + 0.15).toFixed(2)))}>
          +
        </button>
      </div>
      <div className="pdf-scroll" ref={scroller}>
        <div className="pdf-content" style={{ height: tops[tops.length - 1] + PAD, width: maxW * scale + MARGIN + PAD * 2, ["--margin" as string]: `${MARGIN}px` }}>
          {pages.map((p, i) => (
            <PageView
              key={p.page}
              doc={doc}
              page={p}
              scale={scale}
              top={tops[i]}
              left={PAD}
              scroller={scroller}
              highlights={byPage.get(p.page) ?? []}
              marks={marksByPage.get(p.page) ?? []}
              onMarkClick={onMarkClick}
              onMarkHover={onMarkHover}
            />
          ))}
        </div>
      </div>
    </div>
  );
});

interface PageProps {
  doc: PDFDocumentProxy;
  page: PageText;
  scale: number;
  top: number;
  left: number;
  scroller: React.RefObject<HTMLDivElement | null>;
  highlights: { h: Highlight; boxes: PageBox[] }[];
  marks: MarginMark[];
  onMarkClick(id: string): void;
  onMarkHover(id: string | null): void;
}

function PageView({ doc, page, scale, top, left, scroller, highlights, marks, onMarkClick, onMarkHover }: PageProps) {
  const el = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const textEl = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  const [textDivs, setTextDivs] = useState<HTMLElement[] | null>(null);
  const W = page.width * scale;
  const H = page.height * scale;

  useEffect(() => {
    const io = new IntersectionObserver(([e]) => setNear(e.isIntersecting), { root: scroller.current, rootMargin: "120% 0px" });
    io.observe(el.current!);
    return () => io.disconnect();
  }, [scroller]);

  useEffect(() => {
    if (!near) return;
    let task: RenderTask | null = null;
    let tl: TextLayer | null = null;
    let dead = false;
    (async () => {
      const pg: PDFPageProxy = await doc.getPage(page.page);
      if (dead) return;
      const vp = pg.getViewport({ scale });
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      const c = canvas.current!;
      c.width = Math.floor(vp.width * dpr);
      c.height = Math.floor(vp.height * dpr);
      c.style.width = `${vp.width}px`;
      c.style.height = `${vp.height}px`;
      task = pg.render({ canvas: c, viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined });
      await task.promise.catch(() => {});
      if (dead) return;
      const t = textEl.current!;
      t.replaceChildren();
      tl = new TextLayer({ textContentSource: pg.streamTextContent(), container: t, viewport: vp });
      await tl.render().catch(() => {});
      if (!dead) setTextDivs(tl.textDivs.slice());
    })();
    return () => {
      dead = true;
      task?.cancel();
      tl?.cancel();
      setTextDivs(null);
    };
  }, [near, doc, page.page, scale]);

  // exact geometry from the rendered text layer (falls back to proportional boxes)
  const [exact, setExact] = useState<Map<string, { left: number; top: number; width: number; height: number }>>(new Map());
  const wanted = useMemo(() => {
    const ks = new Map<string, PageBox>();
    for (const { boxes } of highlights) for (const b of boxes) if (b.item != null) ks.set(`${b.item}:${b.a}:${b.b}`, b);
    return ks;
  }, [highlights]);
  useLayoutEffect(() => {
    if (!textDivs || !el.current) return;
    const origin = el.current.getBoundingClientRect();
    const m = new Map<string, { left: number; top: number; width: number; height: number }>();
    const range = document.createRange();
    for (const [k, b] of wanted) {
      const node = textDivs[b.item!]?.firstChild;
      if (!node || node.nodeType !== Node.TEXT_NODE) continue;
      const len = node.textContent?.length ?? 0;
      try {
        range.setStart(node, Math.min(b.a ?? 0, len));
        range.setEnd(node, Math.min(b.b ?? len, len));
      } catch {
        continue;
      }
      const r = range.getBoundingClientRect();
      if (r.width < 1) continue;
      // keep the PDF-derived vertical extent (text-layer spans have font-box heights)
      const prop = toCss(b);
      m.set(k, { left: r.left - origin.left - 1, top: prop.top, width: r.width + 2, height: prop.height });
    }
    setExact(m);
  }, [textDivs, wanted]); // eslint-disable-line react-hooks/exhaustive-deps

  function toCss(b: PageBox) {
    return {
    left: b.x0 * scale - 1,
    top: (page.height - b.y1) * scale - 1,
    width: Math.max(2, (b.x1 - b.x0) * scale + 2),
    height: Math.max(2, (b.y1 - b.y0) * scale + 2),
    };
  }
  const css = (b: PageBox) => (b.item != null && exact.get(`${b.item}:${b.a}:${b.b}`)) || toCss(b);

  return (
    <div
      className="pdf-page"
      data-page={page.page}
      ref={el}
      style={{ top, left, width: W, height: H, ["--total-scale-factor" as string]: scale, ["--scale-round-x" as string]: "1px", ["--scale-round-y" as string]: "1px" }}
    >
      <canvas ref={canvas} />
      <div className="hl-layer">
        {highlights.map(({ h, boxes }, i) => (
          <div key={i} className={`hl-group ${h.cls}`} style={h.color ? ({ ["--hl" as string]: h.color } as React.CSSProperties) : undefined}>
            {boxes.map((b, j) => (
              <div key={j} className="hl" style={css(b)} />
            ))}
            {h.label && boxes[0] && (
              <span className="hl-label" style={{ right: 4, top: (page.height - boxes[0].y1) * scale }}>
                {h.label}
              </span>
            )}
          </div>
        ))}
      </div>
      <div className="textLayer" ref={textEl} />
      <div className="margin-marks">
        {stackMarks(marks, page.height, scale).map(({ m, top }) => (
          <button
            key={m.id}
            data-rec={m.id}
            aria-pressed={!!m.active}
            className={`mark ${m.active ? "active" : ""}`}
            style={{ top, ["--mark" as string]: m.color } as React.CSSProperties}
            title={m.title}
            onClick={() => onMarkClick(m.id)}
            onMouseEnter={() => onMarkHover(m.id)}
            onMouseLeave={() => onMarkHover(null)}
          >
            {m.displayKey}
          </button>
        ))}
      </div>
      {!near && <div className="page-ph">{page.page}</div>}
    </div>
  );
}

/** Marks sit at their passage; ones that would overlap are pushed down just enough to stay readable. */
const MARK_H = 23;
function stackMarks(marks: MarginMark[], pageHeight: number, scale: number) {
  const out = marks.map((m) => ({ m, top: (pageHeight - m.y) * scale })).sort((a, b) => a.top - b.top);
  for (let i = 1; i < out.length; i++) out[i].top = Math.max(out[i].top, out[i - 1].top + MARK_H);
  return out;
}
