// The fixture tools run in Node, where pdf.js provides a separate build.
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { extractPages } from "./text.ts";

export async function readPdfPages(data: Uint8Array) {
  const loading = getDocument({ data, useSystemFonts: true, verbosity: 0 });
  try {
    return await extractPages(await loading.promise);
  } finally {
    await loading.destroy();
  }
}

export async function readPdfLines(data: Uint8Array): Promise<string[]> {
  const loading = getDocument({ data, useSystemFonts: true });
  try {
    const doc = await loading.promise;
    const pages: string[] = [];
    for (let page = 1; page <= doc.numPages; page++) {
      const { items } = await (await doc.getPage(page)).getTextContent();
      pages.push(items.map((item) => "str" in item ? item.str + (item.hasEOL ? "\n" : "") : "").join(""));
    }
    return pages;
  } finally {
    await loading.destroy();
  }
}
