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

const MAP = "samples/papers/c2FtcGxlOnJhaW4tZ2FyZGVucw/paper.mira.jsonld";

describe("rain gardens sample (four pages, two columns, running header and footer)", async () => {
  const { pages, idx } = await load("rain-gardens");
  const g = parseGraphFile("paper.mira.jsonld", JSON.parse(readFileSync(MAP, "utf8")));

  it("has a multi-page PDF and parses every record", () => {
    expect(pages.length).toBeGreaterThan(3);
    expect(g.nodes.length).toBe(33);
    expect(g.edges.length).toBe(33);
    expect(g.warnings).toEqual([]);
  });

  it("detects the running header and footer as furniture", () => {
    expect(furniture(pages).size).toBeGreaterThanOrEqual(2);
  });

  it("resolves anchors with the intended tiers", () => {
    const report: Record<string, string> = {};
    for (const n of g.nodes)
      n.anchors.forEach((q, i) => {
        const m = matchQuote(idx, q);
        report[`${n.id}#${i}`] = `${m.kind}${m.occurrences.length > 1 ? "×" + m.occurrences.length : ""}`;
      });
    for (const e of g.edges) e.anchors.forEach((q, i) => (report[`${e.id}#${i}`] = matchQuote(idx, q).kind));
    // a sentence that runs across a page break, the footer and the next page's header
    expect(report["p5#0"]).toBe("exact");
    // a paraphrased quote over a hyphenated line break ("al-most") matches approximately
    expect(report["ev5#0"]).toBe("approximate");
    // a quotation that appears twice, in the results and the conclusion
    expect(report["c1#0"]).toBe("exact×2");
    // the only quote that is not in the paper
    const bad = Object.entries(report).filter(([, v]) => v === "missing").map(([k]) => k);
    expect(bad).toEqual(["q4#0"]);
  });

  it("the cross-page sentence is found whole", () => {
    const p5 = g.nodes.find((n) => n.id === "p5")!;
    const o = matchQuote(idx, p5.anchors[0]).occurrences[0];
    expect([o.start.page, o.end.page]).toEqual([1, 2]);
  });

  it("approximate window is tight and spans the hyphenated line break", () => {
    const ev5 = g.nodes.find((n) => n.id === "ev5")!;
    const m = matchQuote(idx, ev5.anchors[0]);
    const text = occurrenceText(idx, m.occurrences[0]);
    expect(text.startsWith("The planted plots absorbed")).toBe(true);
    expect(text.endsWith("only after about twenty minutes")).toBe(true);
  });

  it("estimates locations for unquoted records", () => {
    const c11 = g.nodes.find((n) => n.id === "c11")!;
    expect(c11.anchors).toEqual([]);
    const o = estimateLocation(idx, c11.text)!;
    expect(o).not.toBeNull();
    expect(o.start.page).toBe(3);
  });

  it("locates evidence in a two-column PDF", () => {
    const ev1 = g.nodes.find((n) => n.id === "ev1")!;
    expect(ev1.anchors).toEqual(["Planted plots released 18 liters less runoff per hour than bare plots."]);
    expect(matchQuote(idx, ev1.anchors[0]).kind).toBe("exact");
  });

  it("matches across line-end hyphenation and preserves compound words", () => {
    expect(matchQuote(idx, "whose soil was dry before the test").kind).toBe("exact");
    expect(matchQuote(idx, "grasses and deep-rooted flowers").kind).toBe("exact");
    expect(matchQuote(idx, "four deep-rooted flowers").kind).toBe("exact");
  });
});
