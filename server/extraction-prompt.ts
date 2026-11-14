import { AsyncLocalStorage } from "node:async_hooks";

const endpoint = "https://openrouter.ai/api/v1/chat/completions";
const extractionPrompt = new AsyncLocalStorage<string>();
let wrappedFetch: typeof fetch | undefined;

export const COMPACT_PROMPT_VERSION = "compact-v5";
const addendum = `CORE REASONING MAP

Create one grounded reading of the paper's arguments. Other maps may organize the same paper around different questions or levels of detail. Keep the JSON shape, node types, edge grammar and quotation rules above. Use distinct records so a reader can follow the reasoning and inspect how claims, evidence, studies, methods and sources connect in MIRA.

1. Start with the central questions and add secondary questions where the paper develops a distinct argument, application, or comparison. Give each an answering Claim. Keep consequential intermediate claims, assumptions, challenges, and qualifications as separate records when their connections help explain the argument. Distinguish observations, interpretations, and proposed explanations.
2. Give meaningful comparisons and worked examples their own Evidence records when they support different inferences or illustrate different capabilities. Preserve informative controls, null results, competing explanations, and limits on generalization. For a conceptual paper, consider the evidence supplied by worked examples, case studies, and comparisons with other approaches. Keep exact numbers when they affect interpretation.
3. Wire each argument. Use addresses for answering Claims and supports or opposes for warranted steps from Evidence or Claims. Every Evidence record should have a directed argument path to a Question. Shared provenance alone cannot establish that path. Describe gaps in the paper honestly and never invent a link.
4. Show the provenance that makes the argument inspectable. Keep distinct Studies and link them to their Evidence. Include Protocols when a method, control, dataset, or material matters to interpreting the result. A SourceDocument must be an identifiable work distinct from the input paper and must contribute specific provenance for a retained Study. Never create a SourceDocument for the input paper itself, including under its DOI, arXiv ID, alternate title, or another version. Ground the input paper's own Studies and other records with passages from the input. Include a Request when the paper explicitly calls for work that addresses a meaningful gap and the record can be linked under the relation grammar.
5. Use the size guide to choose how much detail to show. Expand first into independently supported arguments, distinct worked examples, material qualifications, and provenance that readers can follow. Adjust for the density of the paper's substantive content, especially when references or appendices account for much of its length. Omit repetitions and filler. Use short labels without node-type prefixes and anchor records to the paper. Quote a relation when a passage establishes the connection between its endpoints.
6. Before emitting JSON, verify that each SourceDocument describes a work distinct from the input paper. Omit any self-source and its relations. Check that every edge endpoint exists and every card has a justified link to another card. Trace each Question back to its answers and supporting or opposing Evidence. Keep separate arguments when the paper warrants them. Return only the JSON graph.`;

export async function withCompactPrompt<T>(markdownLength: number, extract: () => Promise<T>): Promise<T> {
  const targetCards = Math.max(6, Math.round(markdownLength * 26 / 100_000));
  const sizeGuide = `For this paper, aim for roughly ${targetCards} visible cards across all record types. Treat this as a flexible target, neither a quota nor a cap.`;
  // The pinned extractor uses global fetch and has no prompt override.
  // Limit the request rewrite to the async context of this extraction.
  if (globalThis.fetch !== wrappedFetch) {
    const fetchOriginal = globalThis.fetch;
    wrappedFetch = (input, init) => {
      const prompt = extractionPrompt.getStore();
      if (!prompt || input !== endpoint || init?.method !== "POST" || typeof init.body !== "string")
        return fetchOriginal(input, init);
      const request = JSON.parse(init.body);
      const system = request.messages?.[0];
      if (system?.role !== "system" || typeof system.content !== "string")
        throw new Error("Unexpected extractor prompt format");
      system.content += "\n\n" + prompt;
      return fetchOriginal(input, { ...init, body: JSON.stringify(request) });
    };
    globalThis.fetch = wrappedFetch;
  }
  return extractionPrompt.run(addendum + "\n\n" + sizeGuide, extract);
}
