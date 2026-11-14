// Dump a PDF's text per page (pdf.js item order) — used to author/check fixtures.
import { readFileSync } from "node:fs";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
const data = new Uint8Array(readFileSync(process.argv[2]));
const doc = await getDocument({ data, useSystemFonts: true }).promise;
for (let p = 1; p <= doc.numPages; p++) {
  const tc = await (await doc.getPage(p)).getTextContent();
  let s = "";
  for (const it of tc.items) s += it.str + (it.hasEOL ? "\n" : "");
  console.log(`\n===== PAGE ${p} =====\n` + s);
}
