import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { buildIndex, estimateLocation, matchQuote, occurrenceText, furniture } from "../src/lib/anchor.ts";
import { extractPages } from "../src/lib/pdfText.ts";
import { parseGraphFile } from "../src/lib/parse.ts";

async function load(dir: string) {
  const data = new Uint8Array(readFileSync(`samples/papers/${Buffer.from(`sample:${dir}`).toString("base64url")}/paper.pdf`));
  const doc = await getDocument({ data, useSystemFonts: true, verbosity: 0 }).promise;
  const pages = await extractPages(doc as never);
  return { pages, idx: buildIndex(pages) };
}

describe("trial-detection fixture", async () => {
  const { pages, idx } = await load("trial-detection");
  const g = parseGraphFile("paper.mira.jsonld", JSON.parse(readFileSync("samples/papers/c2FtcGxlOnRyaWFsLWRldGVjdGlvbg/paper.mira.jsonld", "utf8")));

  it("parses every record", () => {
    expect(g.nodes.length).toBe(43);
    expect(g.edges.length).toBe(43);
    expect(g.warnings).toEqual([]);
  });

  it("detects running footers as furniture", () => {
    const f = furniture(pages);
    expect(f.size).toBeGreaterThanOrEqual(8);
  });

  it("resolves anchors with the intended tiers", () => {
    const report: Record<string, string> = {};
    for (const n of g.nodes)
      n.anchors.forEach((q, i) => {
        const m = matchQuote(idx, q);
        report[`${n.id}#${i}`] = `${m.kind}${m.occurrences.length > 1 ? "×" + m.occurrences.length : ""}`;
      });
    for (const e of g.edges) e.anchors.forEach((q, i) => (report[`${e.id}#${i}`] = matchQuote(idx, q).kind));
    console.log(report);
    // cross-page quote across the running footer
    expect(report["c14#0"]).toBe("exact");
    expect(report["c14#0"]).toBe("exact");
    // hyphenated line break "self-\nreports" in a paraphrased quote → approximate
    expect(report["c12#0"]).toBe("approximate");
    // lost χ glyph → approximate
    expect(report["p2#0"]).toBe("approximate");
    // repeated quotation
    expect(report["ev5#0"]).toBe("exact×2");
    const bad = Object.entries(report).filter(([, v]) => v === "missing").map(([k]) => k);
    expect(bad).toEqual([]);
  });

  it("approximate window is tight and spans the hyphenated line break", () => {
    const c12 = g.nodes.find((n) => n.id === "c12")!;
    const m = matchQuote(idx, c12.anchors[0]);
    const text = occurrenceText(idx, m.occurrences[0]);
    expect(text.startsWith("a new way of estimating")).toBe(true);
    expect(text).toContain("self-reports".replace("-", ""));
  });

  it("estimates locations for unquoted records", () => {
    const c11 = g.nodes.find((n) => n.id === "c11")!;
    const o = estimateLocation(idx, c11.text)!;
    expect(o).not.toBeNull();
    console.log("c11 →", o.start.page, occurrenceText(idx, o));
    expect(o.start.page).toBe(5);
  });
});

describe("rain garden sample", async () => {
  const { idx } = await load("rain-gardens");
  const g = parseGraphFile("paper.mira.jsonld", JSON.parse(readFileSync("samples/papers/c2FtcGxlOnJhaW4tZ2FyZGVucw/paper.mira.jsonld", "utf8")));

  it("loads JSON-LD with Item anchors and locates the evidence in a two-column PDF", () => {
    expect(g.nodes.length).toBe(3);
    expect(g.edges.length).toBe(2);
    const evidence = g.nodes.find((n) => n.id === "evidence")!;
    expect(evidence.anchors).toEqual(["Planted plots released 18 liters less runoff per hour than bare plots."]);
    expect(matchQuote(idx, evidence.anchors[0]).kind).toBe("exact");
  });

  it("reports a quote absent from the paper as missing", () => {
    const question = g.nodes.find((n) => n.id === "question")!;
    expect(matchQuote(idx, question.anchors[0]).kind).toBe("missing");
  });

  it("matches across line-end hyphenation and preserves compound words", () => {
    expect(matchQuote(idx, "whose soil was dry before the test").kind).toBe("exact");
    expect(matchQuote(idx, "grasses and deep-rooted flowers").kind).toBe("exact");
  });
});
