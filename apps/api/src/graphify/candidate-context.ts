import type { WorkspaceToolHost } from "../agent/session-types.js";
import type { GraphIndex, GraphNode } from "./graph-index.js";

export interface CandidateContextAnchor { path: string; startLine: number; endLine: number }
export interface CandidateNavigationStep {
  from: { path: string; line: number; symbol: string };
  to: { path: string; line: number; symbol: string };
  relation: string; confidence: "EXTRACTED";
  traversal: "caller" | "callee";
}
export interface CandidateSourceWindow {
  path: string; startLine: number; endLine: number; content: string;
  boundary: "declared" | "next-symbol-inferred";
  navigationPath: CandidateNavigationStep[];
  selection: "anchor" | "nearby-call" | "control-name-hint";
  symbol: string; relation: string; direction: "anchor" | "caller" | "callee";
}
export interface CandidateGraphContext {
  windows: CandidateSourceWindow[];
  eligibleSymbols: number;
  omittedSymbols: number;
  truncated: boolean;
  traversalTruncated: boolean;
  anchorsTruncated: boolean;
  visitedSymbols: number;
  inspectedEdges: number;
  pending?: CandidateContextAnchor[];
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
  adaptive = false,
): Promise<CandidateGraphContext | null> {
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 0) throw new Error("graph_context_budget_invalid");
  const budget = adaptive ? maxOutputBytes : Math.min(maxOutputBytes, 196_608);
  // Large assessment pages project source in proportion to their anchors.
  // Small discovery projections retain their existing footprint.
  const expanded = adaptive || budget > 32_768;
  const anchorLimit = expanded ? Math.max(32, anchors.length) : 32;
  const windowLimit = adaptive ? Infinity : expanded ? Math.max(8, Math.floor(budget / 4096)) : 8;
  const readLimit = adaptive ? Infinity : expanded ? windowLimit * 2 : 12;
  if (index.nodes.length > 100_000 || index.edges.length > 300_000) throw new Error("graph_context_index_limit");
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
    const lastAnchor = Math.max(span.startLine, ...anchors.slice(0, anchorLimit).filter(anchor => anchor.path === node.file &&
      Number.isSafeInteger(anchor.endLine)).map(anchor => anchor.endLine));
    return { ...span, endLine: next ? next - 1 : lastAnchor };
  };
  // Pick the smallest enclosing symbol, not every unrelated symbol in the anchor file.
  const seeds = new Map<string, GraphNode>();
  const seedAnchors = new Map<string, CandidateContextAnchor>();
  for (const anchor of anchors.slice(0, anchorLimit)) {
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
  type Choice = { node: GraphNode; seedId: string; relation: string; direction: CandidateSourceWindow["direction"];
    navigationPath: CandidateNavigationStep[]; selection: CandidateSourceWindow["selection"] };
  // Names affect navigation priority only. They do not establish that a control exists.
  const controlHint = (node: GraphNode) => /(?:authoriz|permission|confine|saniti|validat|guard|ownership|accesscheck)/i.test(node.label);
  const adjacency = new Map<string, Array<{ node: GraphNode; relation: string; direction: "caller" | "callee" }>>();
  for (const edge of index.edges) {
    if (edge.confidence !== "EXTRACTED" || !/^(calls|call|invokes)$/i.test(edge.relation)) continue;
    const source = byId.get(edge.source), target = byId.get(edge.target);
    if (!source || !target || source.id === target.id || !location(source) || !location(target)) continue;
    for (const [id, node, direction] of [[source.id, target, "callee"], [target.id, source, "caller"]] as const) {
      const list = adjacency.get(id) ?? [];
      list.push({ node, relation: edge.relation, direction }); adjacency.set(id, list);
    }
  }
  for (const list of adjacency.values()) list.sort((a, b) => Number(controlHint(b.node)) - Number(controlHint(a.node)) ||
    Number(b.direction === "caller") - Number(a.direction === "caller") || compare(a.node.file, b.node.file) || compare(a.node.id, b.node.id) || compare(a.relation, b.relation));
  const choices: Choice[] = [...seeds.values()].sort((a, b) => compare(a.file, b.file) || compare(a.id, b.id))
    .map(node => ({ node, seedId: node.id, relation: "anchor", direction: "anchor", navigationPath: [], selection: "anchor" }));
  const visited = new Set(choices.map(choice => choice.node.id));
  const seedVisits = new Map([...seeds.keys()].map(id => [id, 1]));
  const seedEdges = new Map([...seeds.keys()].map(id => [id, 0]));
  const maxVisitsPerSeed = Math.floor(1024 / Math.max(1, seeds.size));
  const maxEdgesPerSeed = Math.floor(4096 / Math.max(1, seeds.size));
  let inspectedEdges = 0;
  let traversalTruncated = false;
  const reference = (node: GraphNode) => ({ path: node.file, line: location(node)!.startLine, symbol: node.label });
  // Multi-source BFS keeps shortest paths, suppresses cycles and bounds expansion.
  // Incoming/outgoing steps may mix: a caller's other callee can be a relevant control.
  walk: for (let cursor = 0; cursor < choices.length; cursor++) {
    const current = choices[cursor]!;
    if (current.navigationPath.length >= 3) continue;
    for (const edge of adjacency.get(current.node.id) ?? []) {
      if ((seedVisits.get(current.seedId) ?? 0) >= maxVisitsPerSeed ||
          (seedEdges.get(current.seedId) ?? 0) >= maxEdgesPerSeed) { traversalTruncated = true; break; }
      if (inspectedEdges >= 4096 || visited.size >= 1024) { traversalTruncated = true; break walk; }
      inspectedEdges++;
      seedEdges.set(current.seedId, (seedEdges.get(current.seedId) ?? 0) + 1);
      if (visited.has(edge.node.id)) continue;
      visited.add(edge.node.id);
      seedVisits.set(current.seedId, (seedVisits.get(current.seedId) ?? 0) + 1);
      const step: CandidateNavigationStep = { from: reference(current.node), to: reference(edge.node),
        relation: edge.relation, confidence: "EXTRACTED", traversal: edge.direction };
      choices.push({ node: edge.node, seedId: current.seedId, direction: edge.direction, relation: edge.relation,
        navigationPath: [...current.navigationPath, step], selection: controlHint(edge.node) ? "control-name-hint" : "nearby-call" });
    }
  }
  // A page normally has eight candidates. Do not let eight anchor excerpts
  // occupy every slot: reserve at least half for related source, when available.
  // Round-robin by originating seed prevents one large neighborhood monopolizing
  // the projected windows. Paths retain the source seed even when its excerpt is omitted.
  const rank = (choice: Choice) => choice.selection === "anchor" ? 0 : choice.selection === "control-name-hint" ? 1 : 2;
  const sorted = [...choices].sort((a, b) => rank(a) - rank(b) || a.navigationPath.length - b.navigationPath.length ||
    Number(b.direction === "caller") - Number(a.direction === "caller") || compare(a.node.file, b.node.file) || compare(a.node.id, b.node.id));
  const anchorChoices = sorted.filter(choice => choice.selection === "anchor");
  const neighborQueues = new Map(anchorChoices.map(choice => [choice.seedId, [] as Choice[]]));
  for (const choice of sorted) if (choice.selection !== "anchor") neighborQueues.get(choice.seedId)!.push(choice);
  const neighbors: Choice[] = [];
  for (let depth = 0; ; depth++) {
    let added = false;
    for (const queue of neighborQueues.values()) {
      if (queue[depth]) { neighbors.push(queue[depth]); added = true; }
    }
    if (!added) break;
  }
  const neighborSlots = Math.min(neighbors.length, Math.max(4, Math.min(8, anchorChoices.length)));
  const preferredNeighbors = neighbors.slice(0, neighborSlots);
  const represented = new Set(preferredNeighbors.map(choice => choice.seedId));
  const fairAnchors = [...anchorChoices].sort((a, b) => Number(represented.has(a.seedId)) - Number(represented.has(b.seedId)) || compare(a.node.id, b.node.id));
  const anchorSlots = Math.min(fairAnchors.length, 8 - neighborSlots);
  const unique = expanded
    ? [...anchorChoices, ...neighbors]
    : anchorChoices.length === 1
    ? [anchorChoices[0]!, ...neighbors]
    : [...preferredNeighbors, ...fairAnchors.slice(0, anchorSlots), ...neighbors.slice(neighborSlots), ...fairAnchors.slice(anchorSlots)];
  const windows: CandidateSourceWindow[] = [];
  const pending = new Map(unique.map(choice => [choice.node.id, spanFor(choice.node)!]));
  const output = (): CandidateGraphContext => ({ windows: [...windows], eligibleSymbols: unique.length,
    omittedSymbols: unique.length - windows.length, truncated: anchors.length > anchorLimit || traversalTruncated || windows.length < unique.length, traversalTruncated,
    anchorsTruncated: anchors.length > anchorLimit,
    visitedSymbols: visited.size, inspectedEdges,
    ...(adaptive ? { pending: [...pending.values()] } : {}),
    note: "Source excerpts selected through EXTRACTED syntax relationships. Verify attacker reachability and controls; these are not proven vulnerabilities or complete-file review. Point-location boundaries use the next symbol as a heuristic, not verified function extents. Paths describe graph traversal, including reverse caller steps, not executable attacker flows. Control-name priority is a search heuristic only. Missing relations do not establish safety." });
  if (Buffer.byteLength(JSON.stringify(output())) > budget) return null;
  // A fixed read cap prevents pathological graphs from turning omitted hints into unbounded I/O.
  for (const choice of unique.slice(0, readLimit)) {
    if (windows.length >= windowLimit) break;
    const span = spanFor(choice.node)!;
    const anchor = seedAnchors.get(choice.node.id);
    const completeSymbol = adaptive || (expanded && span.endLine - span.startLine < 240);
    const startLine = completeSymbol ? span.startLine : anchor ? Math.max(span.startLine, anchor.startLine - 8) : span.startLine;
    const endLine = adaptive ? span.endLine : Math.min(span.endLine, startLine + (expanded ? 239 : 79));
    try {
      const chunks: string[] = [];
      // Host range limits are transport constraints; continue through the full symbol.
      for (let line = startLine; line <= endLine; line += adaptive ? 399 : endLine - startLine + 1) {
        const last = adaptive ? Math.min(endLine, line + 398) : endLine;
        const maxBytes = adaptive ? 65_536 : expanded ? 12_288 : 4096;
        const result = await host.call("workspace.read", { path: span.path, startLine: line, endLine: last, maxBytes }, { maxOutputBytes: adaptive ? 131_072 : expanded ? 24_576 : 8192 });
        const source = JSON.parse(result.content) as { content: string };
        if (typeof source.content !== "string") throw new Error("source_unavailable");
        chunks.push(source.content);
        if (adaptive && Buffer.byteLength(JSON.stringify(chunks)) > budget) throw new Error("source_exceeds_projection");
      }
      const source = { content: chunks.join("\n") };
      windows.push({ path: span.path, startLine, endLine, content: source.content,
        boundary: /-/.test(choice.node.location) ? "declared" : "next-symbol-inferred",
        navigationPath: choice.navigationPath, selection: choice.selection,
        symbol: choice.node.label, relation: choice.relation, direction: choice.direction });
      pending.delete(choice.node.id);
      if (Buffer.byteLength(JSON.stringify(output())) > budget) { windows.pop(); pending.set(choice.node.id, span); }
    } catch {
      // Invalid locations, changed files and denied paths remain explicitly omitted.
    }
  }
  return output();
}
