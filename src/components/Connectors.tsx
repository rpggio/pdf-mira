/**
 * A dashed line from the margin mark(s) of the record under the pointer (or
 * else the selected one) to its card (map, sequence) or row (outline), when
 * both are on screen.
 * Both ends are found in the DOM by `data-rec`; the lines are redrawn every
 * frame, writing to the SVG only when something moved.
 */
import { useEffect, useRef } from "react";

interface Props {
  /** the element the overlay covers; must contain both panes */
  root: React.RefObject<HTMLElement | null>;
  /** the record whose lines are drawn: under the pointer, else selected */
  active: string | null;
  hidden?: boolean;
}

export function Connectors({ root, active, hidden }: Props) {
  const svg = useRef<SVGSVGElement>(null);
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    if (hidden) {
      if (svg.current) svg.current.innerHTML = "";
      return;
    }
    let raf = 0;
    let last = "";
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const r = root.current;
      const s = svg.current;
      if (!r || !s) return;
      const pdf = r.querySelector(".pdf-scroll");
      const side = r.querySelector(".graph-area");
      if (!pdf || !side) return;
      const rr = r.getBoundingClientRect();
      const pr = pdf.getBoundingClientRect();
      const sr = side.getBoundingClientRect();
      const cards = new Map<string, DOMRect>();
      for (const el of side.querySelectorAll<HTMLElement>("[data-rec]")) {
        const id = el.dataset.rec!;
        if (cards.has(id)) continue;
        const b = el.getBoundingClientRect();
        const cy = b.top + Math.min(b.height / 2, 14);
        if (cy < sr.top + 2 || cy > sr.bottom - 2 || b.left < sr.left - 1 || b.left > sr.right - 8) continue;
        cards.set(id, b);
      }
      let out = "";
      for (const el of pdf.querySelectorAll<HTMLElement>(".mark[data-rec]")) {
        const id = el.dataset.rec!;
        if (id !== activeRef.current) continue;
        const c = cards.get(id);
        if (!c) continue;
        const m = el.getBoundingClientRect();
        const my = m.top + m.height / 2;
        if (my < pr.top + 2 || my > pr.bottom - 2 || m.right > pr.right) continue;
        const x1 = m.right - rr.left + 2;
        const y1 = my - rr.top;
        const x2 = c.left - rr.left - 2;
        const y2 = c.top + Math.min(c.height / 2, 14) - rr.top;
        if (x2 <= x1) continue;
        const color = el.style.getPropertyValue("--mark").trim() || "#888";
        const k = Math.max(30, (x2 - x1) * 0.45);
        out += `<path class="conn" stroke="${color}" d="M${x1.toFixed(1)} ${y1.toFixed(1)} C${(x1 + k).toFixed(1)} ${y1.toFixed(1)} ${(x2 - k).toFixed(1)} ${y2.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}"/>`;
      }
      if (out !== last) {
        last = out;
        s.innerHTML = out;
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [root, hidden]);

  return <svg ref={svg} className="connectors" aria-hidden="true" />;
}
