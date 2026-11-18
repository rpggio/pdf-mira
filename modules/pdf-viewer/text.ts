/** pdf.js text content → PageText (geometry in PDF user space, y up). */
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import type { PageText, TextItemGeom } from "./types.ts";

async function pageText(page: PDFPageProxy, pageNo: number): Promise<PageText> {
  const tc = await page.getTextContent();
  const items: TextItemGeom[] = [];
  for (const raw of tc.items) {
    if (!("str" in raw)) continue; // marked-content markers get no textDiv
    const [, , c, d, e, f] = raw.transform;
    const h = raw.height || Math.hypot(c, d);
    items.push({ index: items.length, str: raw.str, x: e - page.view[0], y: f - page.view[1], w: raw.width, h });
  }
  return { page: pageNo, width: page.view[2] - page.view[0], height: page.view[3] - page.view[1], items };
}

export async function extractPages(doc: PDFDocumentProxy): Promise<PageText[]> {
  const out: PageText[] = [];
  for (let p = 1; p <= doc.numPages; p++) out.push(await pageText(await doc.getPage(p), p));
  return out;
}
