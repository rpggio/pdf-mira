import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { hostname } from "node:os";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { PaperStore, storageKey, type Adapters } from "../server/papers.ts";
import { ApiError, fetchMarkdown, fetchMetadata, normalizeArxiv } from "../server/arxiv.ts";
import { convertMarkdown, validateMira } from "../server/converter.ts";
import { paperApi } from "../server/api.ts";
import { parseGraphFile } from "../src/lib/parse.ts";
import { paperSource, sortPapers, type PaperRecord } from "../src/lib/papers.ts";

const mira = { "@graph": [
  { "@id": "q1", "@type": "Question", content: "What persists?" },
  { "@id": "c1", "@type": "Claim", content: "Content persists.", description: ["quote1"] },
  { "@id": "r1", "@type": ["RelationInstance", "addresses"], source: "c1", destination: "q1" },
  { "@id": "quote1", "@type": "Item", content: "Content persists." },
] };
const roots: string[] = [];
const close: (() => Promise<void>)[] = [];
afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); await Promise.all(close.splice(0).map((f) => f())); await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });
async function setup(overrides: Partial<Adapters> = {}) {
  const root = await mkdtemp(join(tmpdir(), "mira-ingest-")); roots.push(root);
  const adapters = {
    metadata: vi.fn(async (id: string) => ({ id: /v\d+$/.test(id) ? id : `${id}v2`, title: "Paper", authors: "Author", abstract: "Original abstract", descriptor: { summary: "Original abstract", category: { "@_term": "cs.DS" } }, metadataUrl: "https://export.arxiv.org/api/query" })),
    markdown: vi.fn(async () => ({ text: "Content persists. [1]\n\n## References\n[1] Prior work.", url: "https://arxiv2md.org/api/markdown" })),
    convert: vi.fn(async () => ({ jsonld: mira, provenance: { arxivId: "2501.11120v2", inputSha256: "hash", converterVersion: "test-1", model: "test-model", convertedAt: new Date().toISOString() } })),
    ...overrides,
  };
  return { store: new PaperStore(root, adapters), adapters, root };
}
async function serve(store: PaperStore) {
  const api = paperApi(store);
  const server = createServer((req, res) => void api(req, res, () => { res.statusCode = 404; res.end(); }));
  await new Promise<void>((r, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", r); });
  close.push(() => new Promise<void>((r, reject) => { server.close((e) => e ? reject(e) : r()); server.closeAllConnections(); }));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

describe("arXiv identity and acquisition", () => {
  it("accepts versioned, unversioned and legacy IDs and only arXiv URLs", () => {
    expect(normalizeArxiv(" https://arxiv.org/pdf/hep-th/9901001v3.pdf?download=1 ")).toBe("hep-th/9901001v3");
    expect(normalizeArxiv("arXiv:2501.11120")).toBe("2501.11120");
    for (const input of ["../secret", "https://evil.org/abs/2501.11120", "2501.11120v0", "https://arxiv.org@evil.org/abs/2501.11120", null]) expect(() => normalizeArxiv(input)).toThrow(ApiError);
    expect(storageKey("hep-th/9901001v3")).not.toContain("/");
  });
  it("resolves the exact version and retains the descriptor, including extensions", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('<feed><entry><id>http://arxiv.org/abs/2501.11120v2</id><title>A paper</title><summary>Authors abstract</summary><author><name>Alice</name></author><arxiv:doi>10/example</arxiv:doi></entry></feed>')));
    const data = await fetchMetadata("2501.11120");
    expect(data.id).toBe("2501.11120v2"); expect(data.descriptor["arxiv:doi"]).toBe("10/example"); expect(data.abstract).toBe("Authors abstract");
  });
  it("retains references/citations and reports missing HTML explicitly", async () => {
    const fetcher = vi.fn(async () => new Response("# Paper\n" + "Text [1]. ".repeat(20) + "## References\n[1] Work")); vi.stubGlobal("fetch", fetcher);
    expect((await fetchMarkdown("2501.11120v2")).text).toContain("References");
    const url = fetcher.mock.calls[0] as unknown as [string];
    expect(url[0]).toContain("remove_refs=false&remove_citations=false");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no HTML", { status: 404 })));
    await expect(fetchMarkdown("2501.11120v2")).rejects.toMatchObject({ code: "NO_USABLE_HTML", retryable: false });
  });
});

describe("durable ingestion", () => {
  it("reuses stored results and prevents duplicate jobs across store instances", async () => {
    const { store, adapters, root } = await setup(); const other = new PaperStore(root, adapters);
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? other : store).submit("2501.11120")));
    await Promise.all([store.idle(), other.idle()]);
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(adapters.convert).toHaveBeenCalledTimes(1);
    const p = await store.submit("https://arxiv.org/abs/2501.11120v2");
    expect(p.status).toBe("ready"); expect(p.abstract).toBe(p.descriptor.summary);
    expect(adapters.convert).toHaveBeenCalledTimes(1);
    expect(await readFile(join(store.dir(p.id), "paper.md"), "utf8")).toContain("References");
    expect(await readFile(join(store.dir(p.id), "processing.log"), "utf8")).toContain('"event":"ready"');
  });
  it("holds one filesystem job lock across independent Node processes", async () => {
    const { root, store } = await setup();
    const worker = `
      import { appendFile } from "node:fs/promises";
      import { join } from "node:path";
      const { PaperStore } = await import(process.argv[2]);
      const store = new PaperStore(process.argv[1], {
        metadata: async () => ({ id: "2501.11120v2", descriptor: {}, title: "Concurrent paper", authors: "A", abstract: "Abstract", metadataUrl: "test" }),
        markdown: async () => ({ text: "Markdown", url: "test" }),
        convert: async () => {
          await appendFile(join(process.argv[1], "conversion-count"), "converted\\n");
          await new Promise(r => setTimeout(r, 100));
          return { jsonld: ${JSON.stringify(mira)}, provenance: {} };
        }
      });
      await store.submit("2501.11120v2");
      await store.idle();
    `;
    await Promise.all(Array.from({ length: 4 }, () => promisify(execFile)(process.execPath,
      ["--experimental-transform-types", "--input-type=module", "-e", worker, root, pathToFileURL(resolve("server/papers.ts")).href])));
    expect((await readFile(join(root, "conversion-count"), "utf8")).trim().split("\n")).toHaveLength(1);
    expect((await store.get("2501.11120v2"))?.status).toBe("ready");
  });
  it("preserves metadata/PDF/Markdown on conversion failure; only explicit retry resumes", async () => {
    let fail = true;
    const { store, adapters } = await setup({ convert: vi.fn(async () => { if (fail) throw new ApiError(502, "CONVERSION_FAILED", "Conversion failed"); return { jsonld: mira, provenance: { arxivId: "2501.11120v2", inputSha256: "hash", converterVersion: "test-1", model: "test", convertedAt: "today" } }; }) });
    await store.submit("2501.11120"); await store.idle();
    const failed = (await store.get("2501.11120v2"))!;
    expect(failed).toMatchObject({ status: "error", abstract: "Original abstract", error: { stage: "converting_mira", code: "CONVERSION_FAILED", retryable: true } });
    expect(await readFile(join(store.dir(failed.id), "paper.md"), "utf8")).toContain("Content persists"); expect(failed.artifacts.mira).toBeUndefined();
    await store.get(failed.id); await store.submit(failed.id); expect(adapters.convert).toHaveBeenCalledTimes(1);
    fail = false;
    await Promise.all([store.retry(failed.id), store.retry(failed.id)]); await store.idle();
    expect((await store.get(failed.id))?.status).toBe("ready");
    expect(adapters.markdown).toHaveBeenCalledTimes(1); expect(adapters.convert).toHaveBeenCalledTimes(2);
  });
  it("omits isolated cards before publication and reports linked records outside question paths", async () => {
    const jsonld = { "@graph": [...mira["@graph"],
      { "@id": "q2", "@type": "Question", content: "An independent question" },
      { "@id": "c2", "@type": "Claim", content: "An independent answer" },
      { "@id": "r2", "@type": ["RelationInstance", "addresses"], source: "c2", destination: "q2" },
      { "@id": "ev1", "@type": "Evidence", content: "A result" },
      { "@id": "ev2", "@type": "Evidence", content: "A result with provenance only" },
      { "@id": "s1", "@type": "Study", content: "Shared study" },
      { "@id": "r3", "@type": ["RelationInstance", "opposes"], source: "ev1", destination: "c1" },
      { "@id": "r4", "@type": ["RelationInstance", "grounds"], source: "s1", destination: "ev1" },
      { "@id": "r5", "@type": ["RelationInstance", "grounds"], source: "s1", destination: "ev2" },
      { "@id": "c4", "@type": "Claim", content: "A claim about the answer" },
      { "@id": "c5", "@type": "Claim", content: "A claim supported by the answer" },
      { "@id": "r7", "@type": ["RelationInstance", "supports"], source: "c4", destination: "c1" },
      { "@id": "r8", "@type": ["RelationInstance", "opposes"], source: "c1", destination: "c4" },
      { "@id": "r9", "@type": ["RelationInstance", "supports"], source: "c1", destination: "c5" },
      { "@id": "c3", "@type": "Claim", content: "A claim with no other endpoints" },
      { "@id": "r6", "@type": ["RelationInstance", "supports"], source: "c3", destination: "c3" },
    ] };
    const { store } = await setup({ convert: async () => ({ jsonld, provenance: {
      arxivId: "2501.11120v2", inputSha256: "hash", converterVersion: "test", model: "test", convertedAt: "today",
    } }) });
    const { id } = await store.submit("2501.11120v2");
    await store.idle();
    expect((await store.get(id))?.status).toBe("ready");
    const published = JSON.parse(await readFile(join(store.dir(id), "paper.mira.jsonld"), "utf8"));
    expect(published["@graph"]).toEqual(jsonld["@graph"].slice(0, -2));
    const { topology } = JSON.parse(await readFile(join(store.dir(id), "extraction-report.json"), "utf8"));
    expect(topology).toMatchObject({
      paperId: id, mapFile: "paper.mira.jsonld", removedIds: ["c3", "r6"],
      candidate: { isolated: [{ id: "c3" }] },
      output: { isolated: [], linkedClaimsOutsideArgument: ["c5"], linkedEvidenceOutsideArgument: ["ev2"],
        evidenceCoverage: { reaching: 1, total: 2 },
        questions: [{ id: "q1", claims: ["c1", "c4"], evidence: ["ev1"] }, { id: "q2", answers: ["c2"], evidence: [] }] },
    });
    expect(topology.output.components).toHaveLength(2);
  });
  it("keeps the previous map when regeneration produces only isolated cards", async () => {
    const { store, adapters } = await setup();
    const { id } = await store.submit("2501.11120v2");
    await store.idle();
    const previous = await store.get(id);
    const result = await vi.mocked(adapters.convert).mock.results[0].value;
    vi.mocked(adapters.convert).mockResolvedValueOnce({ ...result, jsonld: { "@graph": [mira["@graph"][0]] } });
    await expect(store.regenerate(id)).rejects.toMatchObject({ code: "NO_CONNECTED_RECORDS", retryable: true });
    expect(await store.get(id)).toMatchObject({ status: "ready", artifacts: previous!.artifacts });
    const files = readdirSync(store.dir(id));
    expect(files.filter((file) => file.endsWith(".mira.jsonld"))).toEqual(["paper.mira.jsonld"]);
    const report = files.find((file) => file.endsWith(".report.json"))!;
    const { topology } = JSON.parse(await readFile(join(store.dir(id), report), "utf8"));
    expect(topology).toMatchObject({ paperId: id, removedIds: ["q1"], output: null });
  });
  it("reports an unconfigured converter while preserving acquired artifacts", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    const { store } = await setup({ convert: convertMarkdown });
    await store.submit("2501.11120v2"); await store.idle();
    const paper = (await store.get("2501.11120v2"))!;
    expect(paper.error).toMatchObject({ code: "OPENROUTER_KEY_MISSING", stage: "converting_mira", retryable: true });
    expect(await readFile(join(store.dir(paper.id), "paper.md"), "utf8")).toContain("Content persists");
    expect(paper.artifacts.mira).toBeUndefined();
  });
  it("rejects unusable conversions and recovers a dead job without GET starting work", async () => {
    const { store, root, adapters } = await setup({ convert: vi.fn(async () => ({ jsonld: { "@graph": [] }, provenance: { arxivId: "2501.11120v2", inputSha256: "hash", converterVersion: "test", model: "test", convertedAt: "today" } })) });
    await store.submit("2501.11120"); await store.idle();
    const p = (await store.get("2501.11120v2"))!;
    expect(p.error?.code).toBe("INVALID_CONVERSION");
    p.status = "processing"; delete p.error;
    await writeFile(join(store.dir(p.id), "record.json"), JSON.stringify(p));
    await writeFile(join(store.dir(p.id), ".lock"), JSON.stringify({ host: hostname(), pid: 2147483647, token: "dead" }));
    const restarted = new PaperStore(root, adapters); await restarted.recover();
    expect((await restarted.get(p.id))?.error?.code).toBe("JOB_INTERRUPTED"); expect(adapters.convert).toHaveBeenCalledTimes(1);
  });
  it("copies the bundled samples into an empty library, and only into an empty one", async () => {
    const { store } = await setup(); await store.seedSamples(resolve("samples/papers")); await store.seedSamples(resolve("samples/papers"));
    const papers = await store.list(); expect(papers.length).toBe(readdirSync("samples/papers").length);
    expect(papers.every((p) => p.status === "ready")).toBe(true);
    const sample = papers.find((p) => p.id === "sample:rain-gardens")!; expect(sample.graphs).toHaveLength(2);
    const graph = parseGraphFile("paper.mira.jsonld", JSON.parse(await readFile(join(store.dir(sample.id), "paper.mira.jsonld"), "utf8")));
    expect(graph.nodes.find((n) => n.id === "c1")?.anchors.length).toBeGreaterThan(0); expect(graph.warnings).toEqual([]);
    expect(paperSource(sample).graphs).toHaveLength(2);
    const { store: used, adapters } = await setup(); await used.submit("2501.11120"); await used.idle();
    expect(adapters.metadata).toHaveBeenCalled(); await used.seedSamples(resolve("samples/papers"));
    expect((await used.list()).map((p) => p.id)).toEqual(["2501.11120v2"]);
  });
});

describe("HTTP contract and converter adapter", () => {
  it("returns 202/200, Location, error records as 200, and only published artifacts", async () => {
    let finish!: () => void;
    const wait = new Promise<void>((r) => finish = r);
    const { store } = await setup({ markdown: async () => { await wait; throw new ApiError(422, "NO_USABLE_HTML", "No HTML", false); } });
    const base = await serve(store);
    try {
      expect((await fetch(`${base}/api/papers`)).status).toBe(200);
      expect((await fetch(`${base}/api/papers`, { method: "POST", body: "{}" })).status).toBe(400);
      const r = await fetch(`${base}/api/papers`, { method: "POST", body: JSON.stringify({ arxiv: "hep-th/9901001v3" }) });
      expect(r.status).toBe(202); expect(r.headers.get("Location")).toBe("/api/papers/hep-th%2F9901001v3");
      const location = base + r.headers.get("Location");
      expect((await fetch(location)).status).toBe(200);
      expect((await fetch(`${location}/artifacts/paper.pdf`)).status).toBe(404);
      finish(); await store.idle();
      expect(await (await fetch(location)).json()).toMatchObject({ status: "error", error: { code: "NO_USABLE_HTML" } });
      expect((await fetch(`${base}/api/papers`, { method: "POST", body: JSON.stringify({ arxiv: "hep-th/9901001v3" }) })).status).toBe(200);
      expect((await fetch(`${location}/retry`, { method: "POST" })).status).toBe(409);
      expect((await fetch(`${base}/api/papers/unknown`)).status).toBe(404);
      expect((await fetch(`${base}/api/papers`, { method: "POST", headers: { Origin: "https://evil.org" }, body: "{}" })).status).toBe(403);
    } finally { finish(); await store.idle(); }
  });
  it("estimates remaining generation time and publishes regenerated maps without reacquiring the paper", async () => {
    const { store, adapters } = await setup();
    const { id } = await store.submit("2501.11120v2");
    await store.idle();
    const previous = (await store.get(id))!;
    const base = await serve(store);
    const url = `${base}/api/papers/${id}`;
    const originalResult = await vi.mocked(adapters.convert).mock.results[0].value;
    let release!: () => void;
    let started!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    vi.mocked(adapters.convert).mockImplementationOnce(async () => {
      started();
      await barrier;
      return originalResult;
    });
    const job = store.regenerate(id);
    try {
      await entered;
      const processing = await (await fetch(url)).json();
      expect(processing).toMatchObject({ status: "processing", progress: { fraction: expect.any(Number), estimatedRemainingSeconds: expect.any(Number) } });
      expect(processing.progress.estimatedRemainingSeconds).toBeGreaterThan(0);
      expect(processing).not.toHaveProperty("conversionEstimate");
      expect((await fetch(base + previous.artifacts.mira)).status).toBe(200);
      const pending = (await store.get(id))!;
      pending.conversionEstimate!.startedAt = new Date(0).toISOString();
      await writeFile(join(store.dir(id), "record.json"), JSON.stringify(pending));
      expect(await (await fetch(url)).json()).toMatchObject({ progress: { fraction: null, estimatedRemainingSeconds: null } });
      await expect(store.regenerate(id)).rejects.toMatchObject({ code: "PAPER_BUSY" });
    } finally {
      release();
      await job;
    }
    const ready = await (await fetch(url)).json();
    expect(ready.status).toBe("ready");
    expect(ready).not.toHaveProperty("progress");
    expect(ready.artifacts.mira).not.toEqual(previous.artifacts.mira);
    expect(ready.artifacts.pdf).toBe("https://arxiv.org/pdf/" + id);
    expect(adapters.markdown).toHaveBeenCalledTimes(1);
    validateMira(await (await fetch(base + ready.artifacts.mira)).json());
    vi.mocked(adapters.convert).mockRejectedValueOnce(new ApiError(502, "CONVERSION_FAILED", "Conversion failed"));
    await expect(store.regenerate(id)).rejects.toMatchObject({ code: "CONVERSION_FAILED" });
    expect(await (await fetch(url)).json()).toMatchObject({ status: "ready", artifacts: ready.artifacts });
  });
  it("publishes upstream PDF URLs and serves maps without exposing cached files and includes all records sorted by capture date with errors last", async () => {
    const { store } = await setup();
    await store.submit("2501.11120v1"); await store.idle();
    await store.submit("2501.11120v2"); await store.idle();
    const p = (await store.get("2501.11120v2"))!; p.status = "error";
    await writeFile(join(store.dir(p.id), "record.json"), JSON.stringify(p));
    const legacy = (await store.get("2501.11120v1"))!;
    const legacyPath = "/api/papers/2501.11120v1/artifacts/";
    await writeFile(join(store.dir(legacy.id), "paper.pdf"), "%PDF-legacy");
    await writeFile(join(store.dir(legacy.id), "record.json"), JSON.stringify({
      ...legacy, artifacts: { ...legacy.artifacts, pdf: legacyPath + "paper.pdf", markdown: legacyPath + "paper.md" },
    }));
    const base = await serve(store);
    const list = await (await fetch(`${base}/api/papers`)).json(); expect(list.map((p: PaperRecord) => p.id)).toEqual(["2501.11120v1", "2501.11120v2"]);
    expect(list[0].artifacts.pdf).toBe("https://arxiv.org/pdf/2501.11120v1");
    expect(list[0].artifacts).not.toHaveProperty("markdown");
    expect((await fetch(base + legacyPath + "paper.pdf")).status).toBe(404);
    expect((await fetch(base + legacyPath + "paper.md")).status).toBe(404);
    await expect(readFile(join(store.dir(p.id), "paper.pdf"))).rejects.toMatchObject({ code: "ENOENT" });
    validateMira(await (await fetch(base + list[0].artifacts.mira)).json());
    const records = [ { id: "older", capturedAt: "2020", status: "ready" }, { id: "newer", capturedAt: "2022", status: "processing" }, { id: "error-old", capturedAt: "2021", status: "error" }, { id: "error-new", capturedAt: "2023", status: "error" } ] as PaperRecord[];
    expect(sortPapers(records).map((r) => r.id)).toEqual(["newer", "older", "error-new", "error-old"]);
  });
 });
