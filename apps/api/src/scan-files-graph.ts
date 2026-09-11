import fs from "node:fs";
import path from "node:path";
import type { ScanRun } from "@csb/shared";
import { DATA_DIR } from "./config.js";
import { managedGraphCacheKey } from "./graphify/managed-graph.js";

export interface ScanFilesGraph {
  status: "ready" | "unavailable";
  reason?: string;
  files: { path: string }[];
  edges: { source: string; target: string; count: number }[];
  snapshot: string | null;
}
const MAX_GRAPH_BYTES = 32 * 1024 * 1024;
const MAX_FILES = 100_000;
const MARKER = ".portable-codex-security-snapshot-id";

/** Descriptor-bounded reads; symlinks anywhere below the canonical root are rejected. */
function readArtifact(file: string, limit: number): string {
  if (fs.realpathSync(file) !== file) throw new Error("unsafe_artifact");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) throw new Error("artifact_too_large");
    const buffer = Buffer.alloc(Math.min(stat.size + 1, limit + 1));
    const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (length > limit) throw new Error("artifact_too_large");
    return buffer.subarray(0, length).toString("utf8");
  } finally { fs.closeSync(fd); }
}

/** Only paths from this scan's immutable snapshot; never consult repositoryPath. */
function snapshotFiles(root: string): Set<string> {
  if (!fs.lstatSync(root).isDirectory() || fs.realpathSync(root) !== root) throw new Error("snapshot_unavailable");
  const files = new Set<string>();
  const pending = [root];
  let entries = 0;
  while (pending.length) {
    const dir = pending.pop()!;
    if (fs.realpathSync(dir) !== dir) throw new Error("unsafe_snapshot");
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (++entries > MAX_FILES * 2) throw new Error("snapshot_too_large");
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile() && relative !== MARKER && fs.realpathSync(absolute) === absolute) files.add(relative);
      if (files.size > MAX_FILES) throw new Error("snapshot_too_large");
    }
  }
  return files;
}

export function scanFilesGraph(scan: ScanRun): ScanFilesGraph {
  const snapshot = typeof scan.revision === "string" && /^content:[a-f0-9]{64}$/.test(scan.revision) ? scan.revision : null;
  const unavailable = (reason: string): ScanFilesGraph => ({ status: "unavailable", reason, files: [], edges: [], snapshot });
  if (scan.engine !== "codex-security" || scan.execution?.executionProfile !== "portable") return unavailable("unsupported_scan");
  if (!snapshot) return unavailable("snapshot_unavailable");
  try {
    const root = fs.realpathSync(scan.scanDir);
    const status = JSON.parse(readArtifact(path.join(root, "graphify-status.json"), 16_384));
    if (status.status !== "ready") return unavailable("graph_unavailable");
    const snapshotRoot = path.join(root, "portable-codex-security-snapshot");
    if (readArtifact(path.join(snapshotRoot, MARKER), 256).trim() !== snapshot) return unavailable("snapshot_mismatch");
    const files = snapshotFiles(snapshotRoot);
    const cacheRoot = fs.realpathSync(path.join(DATA_DIR, "graphify-cache"));
    const graph = JSON.parse(readArtifact(path.join(cacheRoot, `${managedGraphCacheKey(snapshot)}.json`), MAX_GRAPH_BYTES));
    if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges) || graph.nodes.length > 100_000 || graph.edges.length > 300_000) return unavailable("graph_invalid");
    const nodeFiles = new Map<string, string>();
    for (const node of graph.nodes) {
      if (typeof node?.id === "string" && node.id.length <= 512 && typeof node.source_file === "string" && files.has(node.source_file) && !nodeFiles.has(node.id)) nodeFiles.set(node.id, node.source_file);
    }
    const edges = new Map<string, { source: string; target: string; count: number }>();
    for (const edge of graph.edges) {
      if (edge?.confidence !== "EXTRACTED") continue;
      const source = nodeFiles.get(edge.source), target = nodeFiles.get(edge.target);
      if (!source || !target || source === target) continue;
      const key = JSON.stringify([source, target]);
      const existing = edges.get(key);
      if (existing) existing.count++;
      else edges.set(key, { source, target, count: 1 });
    }
    return { status: "ready", snapshot, files: [...files].sort().map(path => ({ path })), edges: [...edges.values()].sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target)) };
  } catch { return unavailable("artifacts_unavailable"); }
}
