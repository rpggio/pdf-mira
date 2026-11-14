import { effectiveGraph } from "../src/lib/graph.ts";
import type { MiraGraph } from "../src/lib/types.ts";

export function auditMap(graph: MiraGraph) {
  const { nodes, edges, byId } = effectiveGraph(graph);
  const neighbors = new Map(nodes.map(({ id }) => [id, new Set<string>()]));
  const answeringClaims = new Map<string, Set<string>>();
  const argumentPredecessors = new Map<string, Set<string>>();

  for (const { subject, object, relation } of edges) {
    if (subject === object) continue;
    neighbors.get(subject)!.add(object);
    neighbors.get(object)!.add(subject);
    const source = byId.get(subject)!.type;
    const target = byId.get(object)!.type;
    if (relation === "addresses" && source === "Claim" && target === "Question") {
      addPredecessor(answeringClaims, object, subject);
    }
    if ((relation === "supports" || relation === "opposes") &&
        (source === "Claim" || source === "Evidence") && target === "Claim") {
      addPredecessor(argumentPredecessors, object, subject);
    }
  }

  const components: string[][] = [];
  const seen = new Set<string>();
  for (const { id } of nodes) {
    if (seen.has(id)) continue;
    const component = reachable([id], neighbors);
    for (const member of component) seen.add(member);
    components.push([...component]);
  }

  const questions = nodes.filter((node) => node.type === "Question").map(({ id }) => {
    const answers = answeringClaims.get(id) ?? [];
    const backing = reachable(answers, argumentPredecessors);
    return {
      id,
      answers: [...answers],
      claims: nodes.filter((node) => node.type === "Claim" && backing.has(node.id)).map((node) => node.id),
      evidence: nodes.filter((node) => node.type === "Evidence" && backing.has(node.id)).map((node) => node.id),
    };
  });
  const claimPaths = new Set(questions.flatMap((question) => question.claims));
  const evidencePaths = new Set(questions.flatMap((question) => question.evidence));
  const outsidePath = (type: "Claim" | "Evidence", paths: Set<string>) =>
    nodes.filter((node) => node.type === type && neighbors.get(node.id)!.size && !paths.has(node.id)).map(({ id }) => id);

  return {
    cards: nodes.length,
    links: edges.length,
    inferredLinks: edges.filter((edge) => edge.provisional).length,
    components,
    isolated: nodes.filter(({ id }) => !neighbors.get(id)!.size).map(({ id, type, text }) => ({ id, type, text })),
    questions,
    claimCoverage: questions.length ? { reaching: claimPaths.size, total: nodes.filter((node) => node.type === "Claim").length } : null,
    evidenceCoverage: questions.length ? { reaching: evidencePaths.size, total: nodes.filter((node) => node.type === "Evidence").length } : null,
    linkedClaimsOutsideArgument: questions.length ? outsidePath("Claim", claimPaths) : null,
    linkedEvidenceOutsideArgument: questions.length ? outsidePath("Evidence", evidencePaths) : null,
    warnings: graph.warnings,
  };
}

function addPredecessor(index: Map<string, Set<string>>, object: string, subject: string) {
  const predecessors = index.get(object) ?? new Set<string>();
  predecessors.add(subject);
  index.set(object, predecessors);
}

function reachable(start: Iterable<string>, index: Map<string, Set<string>>) {
  const visited = new Set(start);
  // Set iteration visits newly added members, and cycles cannot add a member twice.
  for (const id of visited) {
    for (const next of index.get(id) ?? []) visited.add(next);
  }
  return visited;
}
