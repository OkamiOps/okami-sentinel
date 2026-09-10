import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { GraphIndex } from "../graphify/graph-index.js";
import { createPortableDeepCoveragePlan, type PortableDeepCoveragePlan } from "./portable-codex-security-deep-coverage.js";

export const DEEP_PLAN_FILE = "portable-deep-plan.json";
export const STANDARD_PLAN_FILE = "portable-standard-plan.json";
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/** Graph relations change locality, never the auditable file universe. */
export function packDeepPlan(baseline: PortableDeepCoveragePlan, graph: GraphIndex): PortableDeepCoveragePlan {
  const sizes = Object.assign({}, ...baseline.partitions.map(p => p.fileBytes)) as Record<string, number>;
  const remaining = new Set([...baseline.files].sort(compare));
  const byId = new Map(graph.nodes.map(n => [n.id, n.file]));
  const weights = new Map<string, Map<string, number>>();
  const add = (a: string, b: string) => {
    const neighbors = weights.get(a) ?? new Map<string, number>();
    neighbors.set(b, (neighbors.get(b) ?? 0) + 1); weights.set(a, neighbors);
  };
  for (const edge of graph.edges) {
    const a = byId.get(edge.source), b = byId.get(edge.target);
    if (edge.confidence !== "EXTRACTED" || !a || !b || a === b || !remaining.has(a) || !remaining.has(b)) continue;
    add(a, b); add(b, a);
  }
  if (weights.size === 0) return baseline;
  const pages: string[][] = [];
  while (remaining.size) {
    const first = remaining.values().next().value!;
    remaining.delete(first);
    const page = [first]; let bytes = sizes[first]!;
    const affinity = new Map<string, number>();
    const include = (file: string) => {
      for (const [neighbor, weight] of weights.get(file) ?? []) affinity.set(neighbor, (affinity.get(neighbor) ?? 0) + weight);
    };
    include(first);
    while (page.length < 32 && bytes <= 131_072) {
      let best: string | undefined; let score = -1;
      for (const file of remaining) {
        if (bytes + sizes[file]! > 131_072) continue;
        const candidateScore = affinity.get(file) ?? 0;
        if (candidateScore > score || (candidateScore === score && best !== undefined && compare(file, best) < 0)) {
          best = file; score = candidateScore;
        }
      }
      if (best === undefined) break;
      page.push(best); remaining.delete(best); bytes += sizes[best]!; include(best);
    }
    pages.push(page);
  }
  return { files: baseline.files, totalBytes: baseline.totalBytes, partitions: pages.map((paths, index) => ({
    index, total: pages.length, paths, bytes: paths.reduce((n, f) => n + sizes[f]!, 0),
    fileBytes: Object.fromEntries(paths.map(f => [f, sizes[f]!])),
  })) };
}

/** Resume uses the persisted partition identities, even if Graphify later changes. Legacy runs retain their old ordering. */
export function resolveDeepPlan(input: {
  snapshotRoot: string; snapshotId: string; outputDir: string; resume: boolean; graph?: GraphIndex; mode?: "standard" | "deep";
}): PortableDeepCoveragePlan {
  const baseline = createPortableDeepCoveragePlan(input.snapshotRoot);
  const planFile = input.mode === "standard" ? STANDARD_PLAN_FILE : DEEP_PLAN_FILE;
  const file = path.join(input.outputDir, planFile);
  if (fs.existsSync(file)) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4_194_304) throw new Error("deep_plan_invalid");
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    if (saved.version !== 1 || saved.snapshotId !== input.snapshotId || !["graph-affinity-v1", "lexical-v1"].includes(saved.algorithm) ||
        saved.digest !== digest(saved.plan)) throw new Error("deep_plan_invalid");
    validatePlan(saved.plan, baseline);
    return saved.plan;
  }
  if (input.resume) return baseline;
  const plan = input.graph ? packDeepPlan(baseline, input.graph) : baseline;
  const saved = { version: 1, snapshotId: input.snapshotId, algorithm: plan === baseline ? "lexical-v1" : "graph-affinity-v1", plan, digest: digest(plan) };
  const temporary = path.join(input.outputDir, `${planFile}.${randomUUID()}.tmp`);
  try {
    const descriptor = fs.openSync(temporary, "wx", 0o600);
    try { fs.writeFileSync(descriptor, JSON.stringify(saved)); fs.fsyncSync(descriptor); }
    finally { fs.closeSync(descriptor); }
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
  return plan;
}

function digest(plan: unknown): string { return createHash("sha256").update(JSON.stringify(plan)).digest("hex"); }
function validatePlan(plan: PortableDeepCoveragePlan, baseline: PortableDeepCoveragePlan): void {
  const bad = () => { throw new Error("deep_plan_invalid"); };
  if (!plan || !Array.isArray(plan.files) || !Array.isArray(plan.partitions) || plan.totalBytes !== baseline.totalBytes ||
      JSON.stringify(plan.files) !== JSON.stringify(baseline.files) || plan.partitions.length === 0) bad();
  const sizes = Object.assign({}, ...baseline.partitions.map(p => p.fileBytes));
  const seen = new Set<string>();
  for (const [index, page] of plan.partitions.entries()) {
    if (!page || page.index !== index || page.total !== plan.partitions.length || !Array.isArray(page.paths) || !page.fileBytes ||
        page.paths.length < 1 || page.paths.length > 32 || Object.keys(page.fileBytes).length !== page.paths.length) bad();
    let bytes = 0;
    for (const file of page.paths) {
      if (!Object.hasOwn(sizes, file) || seen.has(file) || page.fileBytes[file] !== sizes[file]) bad();
      seen.add(file); bytes += sizes[file];
    }
    if (bytes !== page.bytes || (bytes > 131_072 && page.paths.length !== 1)) bad();
  }
  if (seen.size !== baseline.files.length) bad();
}
