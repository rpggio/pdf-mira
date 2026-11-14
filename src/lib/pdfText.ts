/** pdf.js text content → PageText (geometry in PDF user space, y up). */
import type { PageText, TextItemGeom } from "./types.ts";

interface PdfDocLike {
  numPages: number;
  getPage(n: number): Promise<PdfPageLike>;
}
interface PdfPageLike {
  view: number[];
  getTextContent(): Promise<{ items: unknown[] }>;
}
interface RawItem {
  str?: string;
  transform: number[];
  width: number;
  height: number;
}

export async function pageText(page: PdfPageLike, pageNo: number): Promise<PageText> {
  const tc = await page.getTextContent();
  const items: TextItemGeom[] = [];
  for (const raw of tc.items as RawItem[]) {
    if (raw.str === undefined) continue; // marked-content markers get no textDiv
    const [, , c, d, e, f] = raw.transform;
    const h = raw.height || Math.hypot(c, d);
    items.push({ index: items.length, str: raw.str, x: e - page.view[0], y: f - page.view[1], w: raw.width, h });
  }
  return { page: pageNo, width: page.view[2] - page.view[0], height: page.view[3] - page.view[1], items };
}

export async function extractPages(doc: PdfDocLike): Promise<PageText[]> {
  const out: PageText[] = [];
  for (let p = 1; p <= doc.numPages; p++) out.push(await pageText(await doc.getPage(p), p));
  return out;
}
