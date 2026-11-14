import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PaperStore } from "../server/papers.ts";
import { paperSource } from "../src/lib/papers.ts";
import { createHash } from "node:crypto";
import { convertMarkdown, MIRA_REVISION } from "../server/converter.ts";
import { parseGraphFile } from "../src/lib/parse.ts";

const markdown = "# Persistence\nWe ask whether objects persist. Most objects persisted.\n## References\n[1] Prior work.";
const rawGraph = {
  nodes: [
    { id: "q1", type: "Question", text: "Do objects persist?", anchor: "We ask whether objects persist." },
    { id: "c1", type: "Claim", text: "Most objects persist.", anchor: "Most objects persisted." },
  ],
  edges: [{ relation: "addresses", subject: "c1", object: "q1" }],
};
function streamedModel(graph: unknown = rawGraph) {
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    const event = { id: "generation-test", model: body.model, choices: [{ delta: { content: JSON.stringify(graph) } }], usage: { cost: 0 } };
    return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("default MIRA-extraction integration", () => {
  it("pins the real upstream dependency and runs it on the full Markdown with server-only credentials", async () => {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    expect(pkg.dependencies["mira-extraction"]).toContain(MIRA_REVISION);
    vi.stubEnv("OPENROUTER_API_KEY", "test-server-secret"); vi.stubEnv("MIRA_MODEL", "");
    const fetcher = streamedModel();
    const progress = vi.fn();
    const result = await convertMarkdown("hep-th/9901001v3", markdown, progress);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(init.headers).toMatchObject({ Authorization: "Bearer test-server-secret" });
    expect(body.model).toBe("openai/gpt-6.1-sol"); expect(body.stream).toBe(true);
    expect(body.messages[0].content).toContain("CORE REASONING MAP");
    expect(body.messages[0].content).toContain("aim for roughly 6 visible cards");
    expect(body.messages[0].content).toContain("Never create a SourceDocument for the input paper itself");
    expect(body.messages[1].content).toContain(markdown);
    expect(JSON.stringify(body)).not.toContain("test-server-secret");
    const graph = parseGraphFile("paper.mira.jsonld", result.jsonld);
    expect(graph.warnings).toEqual([]); expect(graph.nodes.some((n) => n.text === "Do objects persist?")).toBe(true);
    expect(graph.nodes.find((n) => n.text === "Most objects persist.")?.anchors).toContain("Most objects persisted.");
    expect(graph.edges).toHaveLength(1);
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ phase: "decomposed", nodes: 2, edges: 1 }));
    expect(result.provenance).toMatchObject({ arxivId: "hep-th/9901001v3", converterVersion: `MIRA-extraction@${MIRA_REVISION}`,
      inputSha256: createHash("sha256").update(markdown).digest("hex"), model: body.model, requestedModel: body.model, promptVersion: "compact-v5", elapsedSeconds: expect.any(Number) });
    expect(result.diagnostics?.usage).toEqual([{ cost: 0 }]); expect(result.diagnostics?.report).toBeTruthy();
    expect(JSON.stringify(result)).not.toContain("test-server-secret");
  });
  it("publishes the extractor output as the default map and retains diagnostics and progress safely", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-server-secret");
    const fetcher = streamedModel();
    const root = await mkdtemp(join(tmpdir(), "mira-default-map-"));
    try {
      const store = new PaperStore(root, {
        metadata: async () => ({ id: "2501.11120v1", title: "Paper", authors: "Author", abstract: "Abstract", descriptor: {}, metadataUrl: "test" }),
        markdown: async () => ({ text: markdown, url: "test" }),
      });
      await store.submit("2501.11120v1"); await store.idle();
      const paper = (await store.get("2501.11120v1"))!;
      expect(paper.status).toBe("ready");
      expect(paperSource(paper).graphs[0]).toMatchObject({ label: "MIRA-extraction", url: paper.artifacts.mira });
      const report = await readFile(join(store.dir(paper.id), "extraction-report.json"), "utf8");
      expect(JSON.parse(report).usage).toEqual([{ cost: 0 }]);
      const log = await readFile(join(store.dir(paper.id), "processing.log"), "utf8");
      expect(log).toContain('"event":"extraction_progress"'); expect(log).toContain('"event":"extraction_complete"');
      expect(JSON.stringify(paper) + report + log).not.toContain("test-server-secret");
      await store.submit(paper.id); expect(fetcher).toHaveBeenCalledTimes(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("supports an operator model override, with no automatic model fallback", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key"); vi.stubEnv("MIRA_MODEL", "operator/chosen-model");
    const fetcher = streamedModel();
    expect((await convertMarkdown("2501.11120v1", markdown)).provenance.requestedModel).toBe("operator/chosen-model");
    expect(JSON.parse(fetcher.mock.calls[0][1].body as string).model).toBe("operator/chosen-model");
  });
  it("rejects missing credentials and oversized papers before making a model call", async () => {
    const fetcher = streamedModel();
    vi.stubEnv("OPENROUTER_API_KEY", "");
    await expect(convertMarkdown("2501.11120v1", markdown)).rejects.toMatchObject({ code: "OPENROUTER_KEY_MISSING", retryable: true });
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    await expect(convertMarkdown("2501.11120v1", "x".repeat(400_001))).rejects.toMatchObject({ code: "PAPER_TOO_LARGE", retryable: false });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("sanitizes provider failures without exposing credentials or upstream response bodies", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-server-secret");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Rejected test-server-secret private-provider-details", { status: 401 })));
    await expect(convertMarkdown("2501.11120v1", markdown)).rejects.toMatchObject({ code: "OPENROUTER_AUTH_FAILED" });
    try { await convertMarkdown("2501.11120v1", markdown); } catch (e) {
      expect((e as Error).message).not.toMatch(/test-server-secret|private-provider-details/);
    }
  });
});
