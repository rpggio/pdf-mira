import { XMLParser } from "fast-xml-parser";

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public retryable = true) { super(message); }
}
export function normalizeArxiv(value: unknown): string {
  if (typeof value !== "string") throw new ApiError(400, "INVALID_ARXIV", "Enter an arXiv URL or ID.", false);
  let id = value.trim().replace(/^arxiv:\s*/i, "");
  if (/^https?:\/\//i.test(id)) {
    let url: URL;
    try { url = new URL(id); } catch { throw new ApiError(400, "INVALID_ARXIV", "Invalid arXiv URL.", false); }
    if (!["arxiv.org", "www.arxiv.org", "export.arxiv.org"].includes(url.hostname) || url.port || url.username || url.password)
      throw new ApiError(400, "INVALID_ARXIV", "Use a URL from arxiv.org.", false);
    id = url.pathname.replace(/^\/(abs|pdf|html)\//, "");
  }
  id = id.replace(/\.pdf$/i, "");
  if (!/^(?:\d{4}\.\d{4,5}|[a-z][a-z.-]*\/\d{7})(?:v[1-9]\d*)?$/.test(id))
    throw new ApiError(400, "INVALID_ARXIV", "Enter a valid arXiv ID, such as 2501.11120v1.", false);
  return id;
}
export async function checkedFetch(url: string, init?: RequestInit): Promise<Response> {
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(180_000) });
    if (!r.ok) throw new ApiError(502, "UPSTREAM_ERROR", `Upstream request failed (${r.status}).`);
    return r;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(502, "UPSTREAM_UNAVAILABLE", "The acquisition or conversion service could not be reached. Try again later.");
  }
}
// arXiv asks clients to leave three seconds between API queries.
let metadataQueue: Promise<unknown> = Promise.resolve();
let lastMetadata = 0;
export async function fetchMetadata(input: string) {
  const task = metadataQueue.then(async () => {
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, lastMetadata + 3000 - Date.now())));
    lastMetadata = Date.now();
    const url = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(input)}`;
    const xml = await (await checkedFetch(url)).text();
    const parsed = new XMLParser({ ignoreAttributes: false, parseTagValue: false }).parse(xml);
    const entry = Array.isArray(parsed.feed?.entry) ? parsed.feed.entry[0] : parsed.feed?.entry;
    if (!entry || typeof entry.id !== "string" || !entry.title || !entry.summary)
      throw new ApiError(404, "PAPER_NOT_FOUND", "arXiv returned no paper metadata for this ID.");
    const id = normalizeArxiv(entry.id);
    if (!/v[1-9]\d*$/.test(id) || id.replace(/v\d+$/, "") !== input.replace(/v\d+$/, "") || (/v\d+$/.test(input) && id !== input))
      throw new ApiError(502, "VERSION_UNRESOLVED", "arXiv did not resolve the requested version. No record was created.");
    const authors = [entry.author ?? []].flat().map((a: { name?: string }) => a.name).filter(Boolean).join(", ");
    return { id, descriptor: entry as Record<string, unknown>, title: String(entry.title).replace(/\s+/g, " ").trim(),
      authors, abstract: String(entry.summary).trim(), metadataUrl: url };
  });
  metadataQueue = task.catch(() => {});
  return task;
}
export async function fetchMarkdown(id: string) {
  const url = `https://arxiv2md.org/api/markdown?url=${encodeURIComponent(id)}&remove_refs=false&remove_citations=false&remove_toc=false`;
  let r: Response;
  try { r = await checkedFetch(url); } catch (e) {
    if (e instanceof ApiError && /\((404|422)\)/.test(e.message)) throw new ApiError(422, "NO_USABLE_HTML", "No usable HTML-derived Markdown is available for this paper. PDF extraction and OCR are not supported.", false);
    throw e;
  }
  const text = await r.text();
  if (text.trim().length < 100 || /^\s*(?:<!doctype|<html|\{\s*"(?:error|detail)")/i.test(text))
    throw new ApiError(422, "NO_USABLE_HTML", "No usable HTML-derived Markdown is available for this paper. PDF extraction and OCR are not supported.", false);
  return { text, url };
}
