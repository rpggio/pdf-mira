import { createHash } from "node:crypto";
import { tsImport } from "tsx/esm/api";
import { parseGraphFile } from "../src/lib/parse.ts";
import { ApiError } from "./arxiv.ts";
import { COMPACT_PROMPT_VERSION, withCompactPrompt } from "./extraction-prompt.ts";

// Installed as an immutable Git dependency, never copied into this app's source.
export const MIRA_REVISION = "8d98e3579cd86723c167bab89d49bb4c48401fbc";
export const DEFAULT_MODEL = "openai/gpt-6.1-sol";
export interface ExtractionProgress {
  phase: string;
  chars?: number;
  kind?: string;
  pieces?: number;
  piece?: number;
  nodes?: number;
  edges?: number;
}
export interface ConversionResult {
  jsonld: unknown;
  provenance: {
    arxivId: string;
    inputSha256: string;
    converterVersion: string;
    model: string;
    convertedAt: string;
    requestedModel?: string;
    models?: string[];
    promptVersion?: string;
    elapsedSeconds?: number;
  };
  diagnostics?: { report: unknown; dropped: unknown; stats: unknown; usage: unknown; models: string[] };
}
interface Extractor {
  SINGLE_CALL_MAX: number;
  decompose(input: { text: string }, options: {
    apiKey: string;
    model: string;
    slug: string;
    creatorName: string;
    onProgress?: (event: ExtractionProgress) => void;
  }): Promise<{ jsonld: unknown; models: string[]; report: unknown; dropped: unknown; stats: unknown; usage: unknown }>;
}
let extractor: Promise<Extractor> | undefined;
async function loadExtractor(): Promise<Extractor> {
  // The upstream library ships TypeScript; tsImport loads it server-side only.
  extractor ??= tsImport("mira-extraction/src/index.ts", import.meta.url).catch(() => {
    extractor = undefined;
    throw new ApiError(503, "EXTRACTOR_UNAVAILABLE", "The server could not load MIRA-extraction. Ask the server operator to check the installation.");
  });
  return extractor!;
}

export async function convertMarkdown(id: string, markdown: string, onProgress?: (event: ExtractionProgress) => void, options: { upstreamPrompt?: boolean } = {}): Promise<ConversionResult> {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) throw new ApiError(503, "OPENROUTER_KEY_MISSING", "Map generation needs the server's OpenRouter key. Ask the server operator to configure the key, then retry.");
  const engine = await loadExtractor();
  if (markdown.length > engine.SINGLE_CALL_MAX)
    throw new ApiError(422, "PAPER_TOO_LARGE", `This paper exceeds MIRA-extraction's ${engine.SINGLE_CALL_MAX.toLocaleString()}-character limit. The paper is not truncated.`, false);
  const model = process.env.MIRA_MODEL?.trim() || DEFAULT_MODEL;
  try {
    const started = performance.now();
    const extract = () => engine.decompose({ text: markdown }, {
      apiKey, model, slug: `arxiv-${Buffer.from(id).toString("base64url")}`, creatorName: "PDF Argument Reader", onProgress,
    });
    const result = await (options.upstreamPrompt ? extract() : withCompactPrompt(markdown.length, extract));
    validateMira(result.jsonld);
    return {
      jsonld: result.jsonld,
      provenance: { arxivId: id, inputSha256: createHash("sha256").update(markdown).digest("hex"),
        converterVersion: `MIRA-extraction@${MIRA_REVISION}`, requestedModel: model,
        model: result.models[0] || model, models: result.models, promptVersion: options.upstreamPrompt ? undefined : COMPACT_PROMPT_VERSION,
        elapsedSeconds: (performance.now() - started) / 1000, convertedAt: new Date().toISOString() },
      diagnostics: { report: result.report, dropped: result.dropped, stats: result.stats, usage: result.usage, models: result.models },
    };
  } catch (e) {
    if (e instanceof ApiError) throw e;
    // Provider errors can contain response bodies. Classify them without exposing
    // their contents or credentials to the browser, processing log or console.
    const message = e instanceof Error ? e.message : "";
    if (/HTTP (401|403)\b/.test(message)) throw new ApiError(502, "OPENROUTER_AUTH_FAILED", "OpenRouter rejected the server's credentials. Ask the server operator to check the key, then retry.");
    if (/HTTP 429\b/.test(message)) throw new ApiError(503, "OPENROUTER_RATE_LIMIT", "OpenRouter is busy or rate-limited. Retry later.");
    if (/model mismatch/.test(message)) throw new ApiError(502, "EXTRACTOR_MODEL_MISMATCH", "OpenRouter returned a different model from the one configured. No map was published.");
    throw new ApiError(502, "MIRA_EXTRACTION_FAILED", "MIRA-extraction could not generate a map. Retry later or ask the server operator to check model availability.");
  }
}

export function validateMira(json: unknown) {
  if (!json || typeof json !== "object" || !Array.isArray((json as Record<string, unknown>)["@graph"]))
    throw new ApiError(502, "INVALID_CONVERSION", "MIRA-extraction must return MIRA JSON-LD with @graph.");
  try {
    const document = json as Record<string, unknown> & { "@graph": Record<string, unknown>[] };
    const entries = document["@graph"];
    const ids = entries.map((entry) => entry?.["@id"]);
    if (ids.some((id) => typeof id !== "string" || !id) || new Set(ids).size !== ids.length) throw new Error("Invalid or duplicate IDs");
    const graph = parseGraphFile("paper.mira.jsonld", json);
    if (!graph.nodes.length || graph.nodes.some((n) => !n.text) || graph.warnings.length)
      throw new Error("Empty records or unusable map elements");
    return { document, graph };
  } catch {
    throw new ApiError(502, "INVALID_CONVERSION", "The generated map could not be loaded cleanly by the reader.");
  }
}
