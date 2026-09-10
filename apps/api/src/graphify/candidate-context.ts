import type { WorkspaceToolHost } from "../agent/session-types.js";
import type { GraphIndex, GraphNode } from "./graph-index.js";

export interface CandidateContextAnchor { path: string; startLine: number; endLine: number }
export interface CandidateSourceWindow {
  path: string; startLine: number; endLine: number; content: string;
  boundary: "declared" | "next-symbol-inferred";
  symbol: string; relation: string; direction: "anchor" | "caller" | "callee";
}
export interface CandidateGraphContext {
  windows: CandidateSourceWindow[];
  eligibleSymbols: number;
  omittedSymbols: number;
  truncated: boolean;
  note: string;
}
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function location(node: GraphNode): CandidateContextAnchor | null {
  const match = /^L?(\d+)(?:-L?(\d+))?$/.exec(node.location);
  if (!match) return null;
  const startLine = Number(match[1]);
  const endLine = Number(match[2] ?? match[1]);
  if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || startLine < 1 || endLine < startLine) return null;
  return { path: node.file, startLine, endLine };
}

/** Candidate-local navigation plus source, never a reachability proof or full-file coverage. */
export async function buildCandidateGraphContext(
  index: GraphIndex,
  anchors: readonly CandidateContextAnchor[],
  host: WorkspaceToolHost,
  maxOutputBytes = 16_384,
): Promise<CandidateGraphContext | null> {
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 0) throw new Error("graph_context_budget_invalid");
  const budget = Math.min(maxOutputBytes, 32_768);
  const byId = new Map(index.nodes.map(node => [node.id, node]));
  const fileLines = new Map<string, number[]>();
  for (const node of index.nodes) {
    const span = location(node);
    if (span) { const lines = fileLines.get(node.file) ?? []; lines.push(span.startLine); fileLines.set(node.file, lines); }
  }
  const nextLines = new Map<string, Map<number, number>>();
  for (const [file, values] of fileLines) {
    const lines = [...new Set(values)].sort((a, b) => a - b);
    nextLines.set(file, new Map(lines.slice(0, -1).map((line, i) => [line, lines[i + 1]])));
  }
  const spanFor = (node: GraphNode): CandidateContextAnchor | null => {
    const span = location(node);
    if (!span || /-/.test(node.location)) return span;
    const next = nextLines.get(node.file)?.get(span.startLine);
    // Point declarations have no proven extent. Infer only navigation ownership.
    const lastAnchor = Math.max(span.startLine, ...anchors.slice(0, 32).filter(anchor => anchor.path === node.file &&
      Number.isSafeInteger(anchor.endLine)).map(anchor => anchor.endLine));
    return { ...span, endLine: next ? next - 1 : lastAnchor };
  };
  // Pick the smallest enclosing symbol, not every unrelated symbol in the anchor file.
  const seeds = new Map<string, GraphNode>();
  const seedAnchors = new Map<string, CandidateContextAnchor>();
  for (const anchor of anchors.slice(0, 32)) {
    if (!Number.isSafeInteger(anchor.startLine) || !Number.isSafeInteger(anchor.endLine) || anchor.startLine < 1 || anchor.endLine < anchor.startLine) continue;
    const matches = index.nodes.filter(node => {
      const span = spanFor(node);
      return span && span.path === anchor.path && span.startLine <= anchor.startLine && span.endLine >= anchor.endLine;
    }).sort((a, b) => {
      const x = spanFor(a)!; const y = spanFor(b)!;
      return (x.endLine - x.startLine) - (y.endLine - y.startLine) || compare(a.id, b.id);
    });
    if (matches[0]) {
      seeds.set(matches[0].id, matches[0]);
      if (!seedAnchors.has(matches[0].id)) seedAnchors.set(matches[0].id, anchor);
    }
  }
  const choices = [...seeds.values()].map(node => ({ node, relation: "anchor", direction: "anchor" as CandidateSourceWindow["direction"], rank: 0 }));
  for (const edge of index.edges) {
    if (edge.confidence !== "EXTRACTED" || !/^(calls|call|invokes)$/i.test(edge.relation)) continue;
    const incoming = seeds.has(edge.target); const outgoing = seeds.has(edge.source);
    if (incoming === outgoing) continue;
    const node = byId.get(incoming ? edge.source : edge.target);
    if (node && location(node)) choices.push({ node, relation: edge.relation, direction: incoming ? "caller" : "callee", rank: incoming ? 1 : 2 });
  }
  choices.sort((a, b) => a.rank - b.rank || compare(a.node.file, b.node.file) || compare(a.node.id, b.node.id));
  const unique = [...new Map(choices.map(choice => [choice.node.id, choice])).values()];
  const windows: CandidateSourceWindow[] = [];
  const output = (): CandidateGraphContext => ({ windows: [...windows], eligibleSymbols: unique.length,
    omittedSymbols: unique.length - windows.length, truncated: windows.length < unique.length,
    note: "Source excerpts selected through EXTRACTED syntax relationships. Verify attacker reachability and controls; these are not proven vulnerabilities or complete-file review. Point-location boundaries use the next symbol as a heuristic, not verified function extents. Missing relations do not establish safety." });
  if (Buffer.byteLength(JSON.stringify(output())) > budget) return null;
  // A fixed read cap prevents pathological graphs from turning omitted hints into unbounded I/O.
  for (const choice of unique.slice(0, 12)) {
    if (windows.length >= 8) break;
    const span = spanFor(choice.node)!;
    const anchor = seedAnchors.get(choice.node.id);
    const startLine = anchor ? Math.max(span.startLine, anchor.startLine - 8) : span.startLine;
    const endLine = Math.min(span.endLine, startLine + 79);
    try {
      const result = await host.call("workspace.read", { path: span.path, startLine, endLine, maxBytes: 4096 }, { maxOutputBytes: 8192 });
      const source = JSON.parse(result.content) as { content: string };
      windows.push({ path: span.path, startLine, endLine, content: source.content,
        boundary: /-/.test(choice.node.location) ? "declared" : "next-symbol-inferred",
        symbol: choice.node.label, relation: choice.relation, direction: choice.direction });
      if (Buffer.byteLength(JSON.stringify(output())) > budget) windows.pop();
    } catch {
      // Invalid locations, changed files and denied paths remain explicitly omitted.
    }
  }
  return output();
}
