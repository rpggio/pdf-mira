// Dump a PDF's text per page (pdf.js item order) — used to author/check fixtures.
import { readFileSync } from "node:fs";
import { readPdfLines } from "../modules/pdf-viewer/node.ts";

const pages = await readPdfLines(new Uint8Array(readFileSync(process.argv[2])));
for (const [index, text] of pages.entries()) {
  console.log(`\n===== PAGE ${index + 1} =====\n` + text);
}
