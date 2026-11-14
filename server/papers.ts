import { appendFile, cp, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import type { PaperRecord, Stage } from "../src/lib/papers.ts";
import { ApiError, fetchMarkdown, fetchMetadata, normalizeArxiv } from "./arxiv.ts";
import { convertMarkdown, validateMira } from "./converter.ts";
import { auditMap } from "./map-topology.ts";

export const storageKey = (id: string) => Buffer.from(id).toString("base64url");
const artifactUrl = (id: string, file: string) => `/api/papers/${encodeURIComponent(id)}/artifacts/${encodeURIComponent(file)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const exists = async (file: string) => stat(file).then(() => true, () => false);
export async function atomicWrite(file: string, bytes: string | Uint8Array) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temp, bytes); await rename(temp, file); }
  finally { await rm(temp, { force: true }); }
}
interface Owner { pid: number; host: string; token: string }
// Same-host filesystem locks. A reaper serializes abandoned-lock recovery.
async function deadLock(file: string) {
  try {
    const owner: Owner = JSON.parse(await readFile(file, "utf8"));
    if (owner.host !== hostname()) return false;
    try { process.kill(owner.pid, 0); return false; } catch (e) { return (e as NodeJS.ErrnoException).code === "ESRCH"; }
  } catch { return stat(file).then((s) => Date.now() - s.mtimeMs > 30_000, () => false); }
}
async function acquire(dir: string): Promise<(() => Promise<void>) | null> {
  await mkdir(dir, { recursive: true });
  const lock = join(dir, ".lock");
  const reaper = join(dir, ".reaper");
  const owner = JSON.stringify({ pid: process.pid, host: hostname(), token: randomUUID() });
  if (await exists(reaper)) {
    if (await deadLock(reaper)) await rm(reaper, { force: true });
    else return null;
  }
  try {
    const handle = await open(lock, "wx");
    await handle.writeFile(owner); await handle.close();
    if (await exists(reaper)) { await rm(lock, { force: true }); return null; }
    return async () => { if (await readFile(lock, "utf8").catch(() => "") === owner) await rm(lock, { force: true }); };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  if (!(await deadLock(lock))) return null;
  let handle;
  try { handle = await open(reaper, "wx"); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw e;
  }
  try { await handle.writeFile(owner); await handle.close(); if (await deadLock(lock)) await rm(lock, { force: true }); }
  finally { await rm(reaper, { force: true }); }
  return acquire(dir);
}
export interface Adapters {
  metadata: typeof fetchMetadata;
  markdown: typeof fetchMarkdown;
  convert: typeof convertMarkdown;
}
export class PaperStore {
  readonly root: string;
  private adapters: Adapters;
  private jobs = new Set<Promise<void>>();
  constructor(root = process.env.PAPERS_DIR ?? "data/papers", adapters: Partial<Adapters> = {}) {
    this.root = resolve(root);
    this.adapters = { metadata: fetchMetadata, markdown: fetchMarkdown, convert: convertMarkdown, ...adapters };
  }
  dir(id: string) { return join(this.root, storageKey(id)); }
  async get(id: string): Promise<PaperRecord | null> {
    try { return JSON.parse(await readFile(join(this.dir(id), "record.json"), "utf8")); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
  }
  private async save(p: PaperRecord) {
    p.updatedAt = new Date().toISOString();
    await atomicWrite(join(this.dir(p.id), "record.json"), JSON.stringify(p, null, 2));
  }
  private async log(id: string, event: string, details: Record<string, unknown> = {}) {
    await appendFile(join(this.dir(id), "processing.log"), JSON.stringify({ time: new Date().toISOString(), event, ...details }) + "\n");
  }
  private track(job: Promise<void>) { this.jobs.add(job); void job.finally(() => this.jobs.delete(job)).catch(() => {}); }
  async idle() { await Promise.all(this.jobs); }
  async list() {
    await mkdir(this.root, { recursive: true });
    const all: PaperRecord[] = [];
    for (const name of await readdir(this.root)) {
      if (!/^[A-Za-z0-9_-]+$/.test(name)) continue;
      const file = join(this.root, name, "record.json");
      try { all.push(JSON.parse(await readFile(file, "utf8"))); }
      catch (e) { if (["ENOENT", "ENOTDIR"].includes((e as NodeJS.ErrnoException).code ?? "")) continue; throw e; }
    }
    return all.sort((a, b) => Number(a.status === "error") - Number(b.status === "error") || b.capturedAt.localeCompare(a.capturedAt) || a.id.localeCompare(b.id));
  }
  async submit(value: unknown): Promise<PaperRecord> {
    const input = normalizeArxiv(value);
    // Versioned cache hits need no metadata request (including during outages).
    if (/v\d+$/.test(input)) { const cached = await this.get(input); if (cached) return cached; }
    const metadata = await this.adapters.metadata(input);
    const dir = this.dir(metadata.id);
    for (let i = 0; i < 100; i++) {
      const unlock = await acquire(dir);
      if (!unlock) { const current = await this.get(metadata.id); if (current) return current; await sleep(20); continue; }
      let handedOff = false;
      try {
        const current = await this.get(metadata.id);
        if (current) return current;
        const now = new Date().toISOString();
        const paper: PaperRecord = { id: metadata.id, arxivId: metadata.id, descriptor: metadata.descriptor,
          title: metadata.title, authors: metadata.authors, abstract: metadata.abstract, status: "processing", stage: "fetching_metadata",
          capturedAt: now, updatedAt: now, artifacts: {}, provenance: { metadata: { url: metadata.metadataUrl, acquiredAt: now } } };
        await this.save(paper);
        await this.log(paper.id, "created", { arxivId: paper.id });
        handedOff = true;
        this.track(this.process(paper, unlock));
        return paper;
      } finally { if (!handedOff) await unlock(); }
    }
    throw new ApiError(503, "PAPER_BUSY", "The paper is being added by another request. Try again shortly.");
  }
  async retry(id: string): Promise<PaperRecord> {
    const unlock = await acquire(this.dir(id));
    if (!unlock) { const current = await this.get(id); if (current) return current; throw new ApiError(404, "NOT_FOUND", "Paper not found.", false); }
    let handedOff = false;
    try {
      const paper = await this.get(id);
      if (!paper) throw new ApiError(404, "NOT_FOUND", "Paper not found.", false);
      if (paper.status !== "error") return paper;
      if (!paper.error?.retryable) throw new ApiError(409, "NOT_RETRYABLE", "This failure cannot be retried.", false);
      paper.status = "processing"; delete paper.error;
      await this.save(paper); await this.log(id, "retry");
      handedOff = true; this.track(this.process(paper, unlock)); return paper;
    } finally { if (!handedOff) await unlock(); }
  }
  private async process(p: PaperRecord, unlock: () => Promise<void>) {
    const dir = this.dir(p.id);
    const stage = async (s: Stage) => { p.stage = s; await this.save(p); await this.log(p.id, s); };
    try {
      if (!(await exists(join(dir, "paper.md")))) {
        await stage("fetching_markdown");
        const md = await this.adapters.markdown(p.id);
        await atomicWrite(join(dir, "paper.md"), md.text);
        p.provenance = { ...p.provenance, markdown: { url: md.url, provider: "arxiv2md", removeReferences: false, removeCitations: false, acquiredAt: new Date().toISOString() } };
        await this.save(p);
      }
      if (!p.artifacts.mira) {
        await this.generateMap(p, "paper.mira.jsonld");
      }
      p.status = "ready"; delete p.error; delete p.conversionEstimate;
      await this.save(p); await this.log(p.id, "ready");
    } catch (e) {
      const error = e instanceof ApiError ? e : new ApiError(500, "PROCESSING_FAILED", "Processing failed on the server. Try again or check the server log.");
      p.status = "error"; delete p.conversionEstimate; p.error = { stage: p.stage, code: error.code, message: error.message, retryable: error.retryable };
      await this.save(p); await this.log(p.id, "error", p.error);
    } finally { await unlock(); }
  }
  private async generateMap(p: PaperRecord, file: string) {
    const dir = this.dir(p.id);
    p.stage = "converting_mira";
    const markdown = await readFile(join(dir, "paper.md"), "utf8");
    // Compact Sol took about 73 seconds on a 187k-character paper.
    // Input size is a rough proxy for work, so leave room for generation.
    p.conversionEstimate = { startedAt: new Date().toISOString(), durationSeconds: Math.ceil(32 + markdown.length / 4500) };
    await this.save(p);
    await this.log(p.id, p.stage);
    let logged = Promise.resolve();
    const result = await this.adapters.convert(p.id, markdown, (progress) => {
      logged = logged.then(() => this.log(p.id, "extraction_progress", { ...progress }));
      void logged.catch(() => {});
    });
    await logged;
    const { document, graph } = validateMira(result.jsonld);
    const candidate = auditMap(graph);
    const isolated = new Set(candidate.isolated.map(({ id }) => id));
    // Only reader-visible records and their incident relations are eligible for
    // removal. Preserve the canonical metadata and all retained edge semantics.
    const removed = new Set([
      ...isolated,
      ...graph.edges.filter((edge) => isolated.has(edge.subject) || isolated.has(edge.object)).map(({ id }) => id),
    ]);
    const jsonld = removed.size ? {
      ...document,
      "@graph": document["@graph"].filter((entry) => !removed.has(entry["@id"] as string)),
    } : document;
    const rejected = isolated.size === candidate.cards;
    const output = rejected ? null : removed.size ? auditMap(validateMira(jsonld).graph) : candidate;
    const reportFile = file === "paper.mira.jsonld" ? "extraction-report.json" : file.replace(".mira.jsonld", ".report.json");
    const topology = { paperId: p.id, mapFile: file, candidate, removedIds: [...removed], output };
    await atomicWrite(join(dir, reportFile), JSON.stringify({ ...result.diagnostics, topology }, null, 2));
    if (rejected)
      throw new ApiError(502, "NO_CONNECTED_RECORDS", "The generated map had no cards connected to each other. Retry to generate a new map.");
    await atomicWrite(join(dir, file), JSON.stringify(jsonld, null, 2));
    const previous = p.artifacts.mira;
    const url = artifactUrl(p.id, file);
    const extraMaps = (p.graphs ?? []).filter((graph) => graph.url !== previous);
    const prompt = result.provenance.promptVersion ? `; prompt: ${result.provenance.promptVersion}` : "";
    p.artifacts.mira = url;
    p.provenance = { ...p.provenance, conversion: result.provenance };
    p.graphs = [{ file, url, label: "MIRA-extraction",
      provenance: `AI reconstruction by ${result.provenance.converterVersion}; model: ${result.provenance.model}${prompt}` }, ...extraMaps];
    await this.log(p.id, "extraction_complete", result.provenance);
  }
  async regenerate(id: string): Promise<PaperRecord> {
    const unlock = await acquire(this.dir(id));
    if (!unlock) throw new ApiError(409, "PAPER_BUSY", "This paper is already being processed.");
    try {
      const previous = await this.get(id);
      if (!previous?.arxivId || previous.status !== "ready" || !(await exists(join(this.dir(id), "paper.md"))) || !previous.artifacts.mira)
        throw new ApiError(409, "NOT_REGENERATABLE", "Regeneration needs a ready arXiv paper with saved Markdown and a map.", false);
      const paper: PaperRecord = structuredClone(previous);
      paper.status = "processing";
      try {
        await this.generateMap(paper, `map-${Date.now()}.mira.jsonld`);
        paper.status = "ready";
        delete paper.conversionEstimate;
        await this.save(paper);
      } catch (error) {
        await this.save(previous);
        await this.log(id, "regeneration_failed", { code: error instanceof ApiError ? error.code : "PROCESSING_FAILED" });
        throw error;
      }
      return paper;
    } finally { await unlock(); }
  }
  // Startup only. GET never launches work. Interrupted records become explicit,
  // retryable failures, retaining all artifacts published before the crash.
  async recover() {
    for (const p of await this.list()) {
      if (p.status !== "processing") continue;
      const unlock = await acquire(this.dir(p.id));
      if (!unlock) continue;
      try {
        const current = await this.get(p.id);
        if (current?.status === "processing") {
          delete current.conversionEstimate;
          if (current.artifacts.mira) {
            current.status = "ready";
            await this.save(current);
            await this.log(p.id, "regeneration_interrupted");
            continue;
          }
          current.status = "error";
          current.error = { stage: current.stage, code: "JOB_INTERRUPTED", message: "Processing was interrupted. Retry to continue from saved artifacts.", retryable: true };
          await this.save(current); await this.log(p.id, "interrupted", { stage: current.stage });
        }
      } finally { await unlock(); }
    }
  }
  // Startup only. An empty library gets a copy of the bundled samples
  // (samples/papers, kept in source control); a library with papers is left alone.
  async seedSamples(samplesDir = process.env.SAMPLES_DIR ?? "samples/papers") {
    await mkdir(this.root, { recursive: true });
    if ((await this.list()).length) return;
    const from = resolve(samplesDir);
    for (const name of await readdir(from).catch(() => [])) {
      if (!/^[A-Za-z0-9_-]+$/.test(name) || !(await exists(join(from, name, "record.json")))) continue;
      if (await exists(join(this.root, name))) continue;
      await cp(join(from, name), join(this.root, name), { recursive: true, filter: (src) => !/\.(lock|reaper)$|\.tmp$/.test(src) });
    }
  }
}
