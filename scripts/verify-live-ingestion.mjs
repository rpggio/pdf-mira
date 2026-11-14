// Uses the real acquisition/extraction services. Provide OPENROUTER_API_KEY in
// the server environment. Stores the captured paper normally.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tsImport } from "tsx/esm/api";

const arxiv = process.argv.slice(2).find((arg) => arg !== "--") ?? "2501.11120v1";
const { PaperStore } = await tsImport("../server/papers.ts", import.meta.url);
const { parseGraphFile } = await tsImport("../src/lib/parse.ts", import.meta.url);
const store = new PaperStore();
let timer;
try {
  assert.ok(process.env.OPENROUTER_API_KEY, "Set OPENROUTER_API_KEY in the server environment.");
  const submitted = await store.submit(arxiv);
  console.log("Captured", submitted.id, submitted.status);
  let lastStage;
  timer = setInterval(async () => {
    const paper = await store.get(submitted.id);
    if (paper && paper.stage !== lastStage) { lastStage = paper.stage; console.log("Stage", paper.stage); }
  }, 2000);
  await store.idle();
  const paper = await store.get(submitted.id);
  assert.equal(paper.status, "ready", `${paper.error?.code}: ${paper.error?.message}`);
  assert.ok(paper.arxivId && paper.artifacts.mira);
  assert.ok((await readFile(join(store.dir(paper.id), "paper.md"))).length);
  assert.equal(paper.graphs[0].label, "MIRA-extraction");
  const json = JSON.parse(await readFile(join(store.dir(paper.id), "paper.mira.jsonld"), "utf8"));
  const graph = parseGraphFile("paper.mira.jsonld", json);
  assert.equal(graph.warnings.length, 0); assert.ok(graph.nodes.length > 0);
  const reused = await store.submit(paper.id);
  assert.equal(reused.updatedAt, paper.updatedAt);
  console.log("PASS live import, default MIRA-extraction map, reader validation and cache reuse", JSON.stringify({ id: paper.id,
    nodes: graph.nodes.length, edges: graph.edges.length, converter: paper.provenance.conversion.converterVersion, model: paper.provenance.conversion.model }));
} catch (e) {
  // Only our sanitized API/validation messages are printed, never raw provider errors.
  console.error("Live verification failed:", e instanceof Error ? e.message : "unknown error");
  process.exitCode = 1;
} finally { clearInterval(timer); }
