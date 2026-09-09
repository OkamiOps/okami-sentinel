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
  const terms = value.query.trim().toLowerCase().split(/\s+/);
  const matches = index.nodes.filter(node => terms.every(term => `${node.id} ${node.label} ${node.file}`.toLowerCase().includes(term)));
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const output = () => JSON.stringify({ status: "ready", nodes, edges, truncated: true,
    note: "Navigation evidence only. Read source to validate reachability, controls and vulnerabilities. Missing edges do not prove absence." });
  if (Buffer.byteLength(output()) > maxOutputBytes) throw new Error("agent_output_byte_limit");
  for (const node of matches.slice(0, maxResults as number)) {
    nodes.push(node);
    if (Buffer.byteLength(output()) > maxOutputBytes) { nodes.pop(); break; }
  }
  const selected = new Set(nodes.map(node => node.id));
  const byId = new Map(index.nodes.map(node => [node.id, node]));
  for (const edge of index.edges) {
    if (!selected.has(edge.source) && !selected.has(edge.target)) continue;
    if (edges.length >= (maxResults as number) * 2) break;
    const additions = [edge.source, edge.target].filter((id, i, ids) => ids.indexOf(id) === i && !nodes.some(node => node.id === id)).map(id => byId.get(id)!);
    nodes.push(...additions); edges.push(edge);
    if (Buffer.byteLength(output()) > maxOutputBytes) { edges.pop(); nodes.splice(nodes.length - additions.length, additions.length); break; }
  }
  // Bounded neighborhoods deliberately do not claim exhaustive graph coverage.
  return output();
}
