import fs from "node:fs";
import path from "node:path";

export interface GraphNode { id: string; label: string; file: string; location: string }
export interface GraphEdge { source: string; target: string; relation: string; confidence: string }
export interface GraphIndex { nodes: GraphNode[]; edges: GraphEdge[] }

const MAX_NODES = 100_000;
const MAX_EDGES = 300_000;
const text = (value: unknown, limit = 512): string => typeof value === "string" ? value.slice(0, limit) : "";

/** Reduce upstream data to source-backed references; never expose arbitrary graph metadata. */
export function normalizeGraph(raw: unknown, snapshotRoot: string): GraphIndex {
  if (!raw || typeof raw !== "object") throw new Error("graph_invalid");
  const value = raw as { nodes?: unknown; edges?: unknown };
  if (!Array.isArray(value.nodes) || !Array.isArray(value.edges) || value.nodes.length > MAX_NODES || value.edges.length > MAX_EDGES) throw new Error("graph_invalid");
  const root = fs.realpathSync(snapshotRoot);
  const nodes: GraphNode[] = [];
  const ids = new Set<string>();
  for (const item of value.nodes) {
    if (!item || typeof item !== "object") continue;
    const id = text(item.id);
    const source = text(item.source_file, 2_048);
    if (!id || ids.has(id) || !source) continue;
    const absolute = path.resolve(root, source);
    const file = path.relative(root, absolute);
    if (!file || file === ".." || file.startsWith(`..${path.sep}`) || path.isAbsolute(file)) continue;
    try {
      if (!fs.lstatSync(absolute).isFile() || fs.realpathSync(absolute) !== absolute) continue;
    } catch { continue; }
    ids.add(id);
    nodes.push({ id, label: text(item.label), file: file.split(path.sep).join("/"), location: text(item.source_location, 64) });
  }
  const edges: GraphEdge[] = [];
  for (const item of value.edges) {
    if (!item || typeof item !== "object" || !ids.has(item.source) || !ids.has(item.target)) continue;
    edges.push({ source: item.source, target: item.target, relation: text(item.relation, 80),
      confidence: ["EXTRACTED", "INFERRED", "AMBIGUOUS"].includes(item.confidence) ? item.confidence : "UNKNOWN" });
  }
  return { nodes, edges };
}

/** Literal symbol/path search plus one-hop callers/callees. No shell, regex, or model call. */
export function queryGraph(index: GraphIndex, input: unknown, maxOutputBytes: number): string {
  const value = input as { query?: unknown; maxResults?: unknown } | null;
  if (!value || typeof value.query !== "string" || !value.query.trim() || value.query.length > 200) throw new Error("tool_argument_invalid");
  const maxResults = value.maxResults ?? 10;
  if (!Number.isSafeInteger(maxResults) || (maxResults as number) < 1 || (maxResults as number) > 20) throw new Error("tool_argument_invalid");
  const query = value.query.trim().toLowerCase();
  const terms = query.split(/\s+/);
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  const rank = (node: GraphNode) => node.id.toLowerCase() === query || node.label.toLowerCase() === query
    ? 0 : node.file.toLowerCase() === query ? 1 : 2;
  const matches = index.nodes
    .filter(node => terms.every(term => `${node.id} ${node.label} ${node.file}`.toLowerCase().includes(term)))
    .sort((a, b) => rank(a) - rank(b) || compare(a.file, b.file) || compare(a.label, b.label) || compare(a.id, b.id));
  const seeds = matches.slice(0, maxResults as number);
  const byId = new Map(index.nodes.map(node => [node.id, node]));
  let neighborhood: GraphEdge[] = [];
  const edges: GraphEdge[] = [];
  const nodes = () => {
    const returned = new Map(seeds.map(node => [node.id, node]));
    for (const edge of edges) {
      for (const id of [edge.source, edge.target]) {
        if (!returned.has(id)) returned.set(id, byId.get(id)!);
      }
    }
    return [...returned.values()];
  };
  const output = () => {
    const resultsTruncated = seeds.length < matches.length;
    const neighborhoodTruncated = edges.length < neighborhood.length;
    return JSON.stringify({ status: "ready", nodes: nodes(), edges,
      matchesTotal: matches.length, matchesReturned: seeds.length,
      neighborhoodEdgesTotal: neighborhood.length, neighborhoodEdgesReturned: edges.length,
      resultsTruncated, neighborhoodTruncated, truncated: resultsTruncated || neighborhoodTruncated,
      note: "Navigation evidence only. Read source to validate reachability, controls and vulnerabilities. Missing edges do not prove absence." });
  };
  const selectNeighborhood = () => {
    // Freeze seed identities: a returned neighbor must never expand to a second hop.
    const selected = new Set(seeds.map(node => node.id));
    neighborhood = index.edges.filter(edge => byId.has(edge.source) && byId.has(edge.target) &&
      (selected.has(edge.source) || selected.has(edge.target)))
      .sort((a, b) => compare(a.source, b.source) || compare(a.target, b.target) ||
        compare(a.relation, b.relation) || compare(a.confidence, b.confidence));
  };
  selectNeighborhood();
  // Recompute the entire envelope on every change, including counts and flags.
  while (Buffer.byteLength(output()) > maxOutputBytes && seeds.length > 0) {
    seeds.pop();
    selectNeighborhood();
  }
  if (Buffer.byteLength(output()) > maxOutputBytes) throw new Error("agent_output_byte_limit");
  for (const edge of neighborhood) {
    if (edges.length >= (maxResults as number) * 2) break;
    edges.push(edge);
    if (Buffer.byteLength(output()) > maxOutputBytes) { edges.pop(); break; }
  }
  return output();
}
