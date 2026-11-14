// Typeset a sample text file as a two-column, hyphenated PDF
// (exercises column order + hyphenation in anchoring). Uses headless Chrome.
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const [src, out] = process.argv.slice(2);
const lines = readFileSync(src, "utf8").trim().split(/\n\s*\n/);
const title = lines.shift().trim();
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
// Join hard-wrapped source paragraphs, preserving compound words.
const paras = lines.map((p) => p.replace(/-\n/g, "-").replace(/\s*\n\s*/g, " ").trim());
const body = paras
  .map((p) => {
    const m = p.match(/^((?:\d+\.\s*)?[A-Z][a-z ]+\.)\s(.*)$/);
    return m ? `<p><b>${esc(m[1])}</b> ${esc(m[2])}</p>` : `<p>${esc(p)}</p>`;
  })
  .join("\n");
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><style>
@page { size: Letter; margin: 0.9in 0.8in; }
body { font: 10.5pt/1.42 Georgia, serif; color: #111; }
h1 { font-size: 17pt; text-align: center; margin: 0 0 4pt; }
.by { text-align: center; font-style: italic; margin-bottom: 18pt; }
.cols { column-count: 2; column-gap: 0.32in; text-align: justify; hyphens: auto; }
p { margin: 0 0 7pt; }
</style><h1>${esc(title)}</h1><div class="by">Fictional study</div>
<div class="cols">${body}</div></html>`;
const dir = mkdtempSync(join(tmpdir(), "mira-pdf-"));
writeFileSync(join(dir, "in.html"), html);
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
execFileSync(chrome, [
  "--headless=new", "--disable-gpu", "--no-pdf-header-footer",
  `--print-to-pdf=${out}`, `file://${join(dir, "in.html")}`,
], { stdio: "inherit" });
console.log("wrote", out);
