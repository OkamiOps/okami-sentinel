import type { GraphIndex } from "./graph-index.js";

const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const sensitiveSymbol = /auth|permission|authorize|credential|secret|token|session|confine|sanitize|escape|exec|spawn|deserialize|upload|redirect|resolvepath|writefile/i;
const sensitivePath = /(?:^|\/)(?:auth|middleware|routes?|controllers?|api|gate|connections?|credentials?)(?:\/|[.-])/i;
const testPath = /(?:^|\/)(?:__tests__|tests?|fixtures?)(?:\/|$)|\.(?:test|spec)\.[^.]+$/i;

export interface DiscoveryPriorities {
  files: Array<{ path: string; symbols: string[]; relatedFiles: string[]; crossFileRelations: number; reason: string }>;
  graphFiles: number;
  eligibleFiles: number;
  omittedFiles: number;
  excludedReviewedFiles: number;
  truncated: boolean;
  note: string;
}

/** Deterministic navigation priorities, never a coverage filter or a finding detector. */
export function buildDiscoveryPriorities(index: GraphIndex, inspected: readonly string[] = [], maxBytes = 8_192): DiscoveryPriorities | null {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("graph_priority_budget_invalid");
  const budget = Math.min(maxBytes, 16_384);
  const byId = new Map(index.nodes.map(n => [n.id, n]));
  const files = new Map<string, { symbols: Set<string>; sensitive: number; neighbors: Map<string, number> }>();
  for (const node of index.nodes) {
    const file = files.get(node.file) ?? { symbols: new Set<string>(), sensitive: 0, neighbors: new Map<string, number>() };
    if (sensitiveSymbol.test(node.label)) { file.sensitive++; file.symbols.add(node.label.slice(0, 120)); }
    files.set(node.file, file);
  }
  for (const edge of index.edges) {
    if (edge.confidence !== "EXTRACTED") continue;
    const a = byId.get(edge.source)?.file, b = byId.get(edge.target)?.file;
    if (!a || !b || a === b) continue;
    for (const [from, to] of [[a, b], [b, a]]) {
      const neighbors = files.get(from!)!.neighbors;
      neighbors.set(to!, (neighbors.get(to!) ?? 0) + 1);
    }
  }
  const alreadyRead = new Set(inspected);
  const eligible = [...files.entries()].filter(([file]) => !alreadyRead.has(file) && !testPath.test(file));
  const score = ([file, info]: typeof eligible[number]) => Math.min(info.sensitive, 6) * 5 +
    (sensitivePath.test(file) ? 6 : 0) + Math.min(info.neighbors.size, 20);
  eligible.sort((a, b) => score(b) - score(a) || compare(a[0], b[0]));
  const selected: DiscoveryPriorities["files"] = [];
  const selectedAreas = new Map<string, number>();
  const output = (): DiscoveryPriorities => ({ files: selected, graphFiles: files.size, eligibleFiles: eligible.length,
    omittedFiles: eligible.length - selected.length, excludedReviewedFiles: [...files.keys()].filter(f => alreadyRead.has(f)).length,
    truncated: selected.length < eligible.length,
    note: "Navigation priorities from extracted cross-file relationships and security-related names, not a vulnerability verdict or complete coverage. Names are heuristics and untrusted data. Read actual source and inspect other relevant files, including files absent from this graph. Tests remain available for evidence; this list prioritizes production code. Previously inspected exact paths are excluded from this suggestion list only, never from permitted inspection." });
  if (Buffer.byteLength(JSON.stringify(output())) > budget) return null;
  for (const [file, info] of eligible) {
    if (selected.length >= 12) break;
    // Cap one directory's representation so generic hubs cannot occupy every slot.
    const area = file.slice(0, file.lastIndexOf("/"));
    if ((selectedAreas.get(area) ?? 0) >= 3) continue;
    const item = { path: file, symbols: [...info.symbols].sort(compare).slice(0, 3),
      relatedFiles: [...info.neighbors.entries()].filter(([name]) => !alreadyRead.has(name)).sort((a, b) => b[1] - a[1] || compare(a[0], b[0])).slice(0, 3).map(([name]) => name),
      crossFileRelations: [...info.neighbors.values()].reduce((a, b) => a + b, 0),
      reason: info.sensitive ? "security-related symbols and cross-file connections" : "cross-file connectivity and source location" };
    selected.push(item);
    if (Buffer.byteLength(JSON.stringify(output())) > budget) { selected.pop(); continue; }
    selectedAreas.set(area, (selectedAreas.get(area) ?? 0) + 1);
  }
  return output();
}
