/** Library records and their reader sources. */
import type { PaperSource } from "./store.ts";

export type Stage = "fetching_metadata" | "fetching_markdown" | "fetching_pdf" | "converting_mira";
export interface PaperRecord {
  id: string;
  arxivId?: string;
  descriptor: Record<string, unknown>;
  title: string;
  authors: string;
  abstract?: string;
  status: "processing" | "ready" | "error";
  stage: Stage;
  conversionEstimate?: { startedAt: string; durationSeconds: number };
  progress?: { fraction: number | null; estimatedRemainingSeconds: number | null };
  capturedAt: string;
  updatedAt: string;
  artifacts: { pdf?: string; mira?: string };
  graphs?: { file: string; url: string; label?: string; provenance?: string }[];
  error?: { stage: Stage; code: string; message: string; retryable: boolean };
  provenance?: Record<string, unknown>;
}
export const STAGE_LABEL: Record<Stage, string> = {
  fetching_metadata: "Fetching metadata",
  fetching_markdown: "Fetching Markdown",
  fetching_pdf: "Fetching PDF",
  converting_mira: "Generating graph",
};
export const paperUrl = (id: string) => `/api/papers/${encodeURIComponent(id)}`;
export const sortPapers = (papers: PaperRecord[]) => [...papers].sort((a, b) =>
  Number(a.status === "error") - Number(b.status === "error") || b.capturedAt.localeCompare(a.capturedAt) || a.id.localeCompare(b.id));
export const arxivUrl = (id: string, format: "abs" | "pdf") =>
  `https://arxiv.org/${format}/${id.split("/").map(encodeURIComponent).join("/")}`;
export function paperSource(p: PaperRecord): PaperSource {
  return { id: p.id, title: p.title, subtitle: p.authors, pdfUrl: p.arxivId ? arxivUrl(p.arxivId, "pdf") : p.artifacts.pdf,
    arxivPage: p.arxivId ? arxivUrl(p.arxivId, "abs") : undefined,
    graphs: p.graphs ?? [{ file: "paper.mira.jsonld", label: "MIRA-extraction", url: p.artifacts.mira,
      provenance: `AI reconstruction by MIRA-extraction from arXiv ${p.arxivId}` }] };
}
export async function paperRequest<T>(url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const r = await fetch(url, { method: body === undefined ? "GET" : "POST", signal,
    headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error?.message ?? `Request failed (${r.status})`);
  return data;
}
const CACHE = "pdf-mira:papers:v1";
export function cachedPapers(): PaperRecord[] {
  try {
    const data = JSON.parse(localStorage.getItem(CACHE) ?? "[]");
    return Array.isArray(data) ? data.filter((p) => p && typeof p.id === "string" && typeof p.capturedAt === "string" && ["ready", "processing", "error"].includes(p.status)) : [];
  } catch { return []; }
}
export function cachePapers(papers: PaperRecord[]) {
  try { localStorage.setItem(CACHE, JSON.stringify(papers)); } catch { /* storage can be disabled */ }
}
