import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ApiError } from "./arxiv.ts";
import { arxivUrl, type PaperRecord } from "../src/lib/papers.ts";
import { PaperStore } from "./papers.ts";

const json = (res: ServerResponse, status: number, value: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(value));
};
async function body(req: IncomingMessage) {
  let text = "";
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 8192) throw new ApiError(413, "TOO_LARGE", "Request body is too large.", false);
  }
  try { return JSON.parse(text); } catch { throw new ApiError(400, "INVALID_JSON", "Send a JSON body with an arxiv field.", false); }
}

// Generation has no known token total. Present an estimate only while it is current.
function publicRecord({ conversionEstimate, ...record }: PaperRecord): PaperRecord {
  const paper = { ...record, artifacts: {
    pdf: record.arxivId ? arxivUrl(record.arxivId, "pdf") : record.artifacts.pdf,
    mira: record.artifacts.mira,
  } };
  if (paper.status !== "processing") return paper;
  const elapsed = conversionEstimate ? Math.max(0, (Date.now() - Date.parse(conversionEstimate.startedAt)) / 1000) : NaN;
  const duration = conversionEstimate?.durationSeconds ?? 0;
  const estimated = paper.stage === "converting_mira" && elapsed < duration;
  return { ...paper, progress: {
    fraction: estimated ? elapsed / duration : null,
    estimatedRemainingSeconds: estimated ? Math.ceil(duration - elapsed) : null,
  } };
}
export function paperApi(store: PaperStore, initialized: Promise<void> = Promise.resolve()) {
  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (!path.startsWith("/api/")) return next();
    try {
      await initialized;
      // Same-origin writes. Reading the LAN library requires no account.
      const origin = req.headers.origin;
      if (req.method === "POST" && origin && new URL(origin).host !== req.headers.host)
        throw new ApiError(403, "ORIGIN_REJECTED", "Submit papers from the reader's own page.", false);
      if (path === "/api/papers") {
        if (req.method === "GET") return json(res, 200, (await store.list()).map(publicRecord));
        if (req.method === "POST") {
          const input = await body(req);
          const p = await store.submit(input?.arxiv);
          res.setHeader("Location", `/api/papers/${encodeURIComponent(p.id)}`);
          return json(res, p.status === "processing" ? 202 : 200, publicRecord(p));
        }
        throw new ApiError(405, "METHOD_NOT_ALLOWED", "Use GET or POST.", false);
      }
      const match = /^\/api\/papers\/([^/]+)(?:\/(retry|artifacts\/([^/]+)))?$/.exec(path);
      if (!match) throw new ApiError(404, "NOT_FOUND", "API route not found.", false);
      let id: string;
      try { id = decodeURIComponent(match[1]); } catch { throw new ApiError(400, "INVALID_ID", "Invalid paper ID.", false); }
      const paper = await store.get(id);
      if (!paper) throw new ApiError(404, "NOT_FOUND", "Paper not found.", false);
      if (match[2] === "retry" && req.method === "POST") {
        const p = await store.retry(id);
        res.setHeader("Location", `/api/papers/${encodeURIComponent(id)}`);
        return json(res, p.status === "processing" ? 202 : 200, publicRecord(p));
      }
      if (req.method !== "GET") throw new ApiError(405, "METHOD_NOT_ALLOWED", "Method not allowed.", false);
      if (!match[2]) return json(res, 200, publicRecord(paper));
      if (!match[3]) throw new ApiError(405, "METHOD_NOT_ALLOWED", "Use POST to retry.", false);
      const file = match[3];
      const published = [paper.arxivId ? undefined : paper.artifacts.pdf, paper.artifacts.mira, ...(paper.graphs ?? []).map((g) => g.url)];
      if (!/^(paper\.(pdf|mira\.jsonld)|map-\d+\.mira\.jsonld)$/.test(file) || !published.includes(`/api/papers/${encodeURIComponent(id)}/artifacts/${encodeURIComponent(file)}`))
        throw new ApiError(404, "NOT_FOUND", "Artifact not published.", false);
      const data = await readFile(join(store.dir(id), file));
      res.writeHead(200, { "Content-Type": file.endsWith("pdf") ? "application/pdf" : "application/ld+json",
        "Content-Length": data.length, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" }); res.end(data);
    } catch (e) {
      const error = e instanceof ApiError ? e : new ApiError(500, "SERVER_ERROR", "The server could not complete this request.");
      json(res, error.status, { error: { code: error.code, message: error.message, retryable: error.retryable } });
    }
  };
}
