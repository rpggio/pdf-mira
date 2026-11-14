import { expect, it } from "vitest";
import { effectiveGraph } from "../src/lib/graph.ts";
import { parseGraphFile } from "../src/lib/parse.ts";

it("assigns map-local keys in stored order and cleans only matching title prefixes", () => {
  const graph = parseGraphFile("example.mira.jsonld", {
    "@graph": [
      { "@id": "x:n3", "@type": "Question", title: "QUE - What changed?" },
      { "@id": "x:n2", "@type": "Claim", title: "CLM — The result changed" },
      { "@id": "x:n1", "@type": "Question", title: "CLM - What does that label mean?" },
      { "@id": "x:r0", "@type": ["RelationInstance", "addresses"], source: "x:n2", destination: "x:n3" },
    ],
  });
  const { nodes, edges } = effectiveGraph(graph);
  expect(nodes.map(({ id, displayKey, text }) => [id, displayKey, text])).toEqual([
    ["x:n3", "QUE-01", "What changed?"],
    ["x:n2", "CLM-01", "The result changed"],
    ["x:n1", "QUE-02", "CLM - What does that label mean?"],
  ]);
  expect(edges[0]).toMatchObject({ subject: "x:n2", object: "x:n3" });
  expect(graph.nodes[0].text).toBe("QUE - What changed?");
});
