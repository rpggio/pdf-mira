import { tsImport } from "tsx/esm/api";

const { PaperStore } = await tsImport("../server/papers.ts", import.meta.url);
const store = new PaperStore();
const requested = process.argv.slice(2);
const ids = requested.length ? [...new Set(requested)] : (await store.list())
  .filter((paper) => paper.arxivId && paper.status === "ready" && paper.artifacts.mira)
  .map((paper) => paper.id);

for (const id of ids) {
  console.log(JSON.stringify({ id, status: "regenerating" }));
  try {
    const paper = await store.regenerate(id);
    console.log(JSON.stringify({ id, status: paper.status, ...paper.provenance?.conversion }));
  } catch (error) {
    console.error(JSON.stringify({ id, status: "failed", code: error.code ?? error.name }));
    process.exitCode = 1;
  }
}
