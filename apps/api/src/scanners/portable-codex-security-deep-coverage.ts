import fs from "node:fs";
import path from "node:path";

import type {
  PortableCandidate,
  PortableCodexSecurityDossier,
} from "./portable-codex-security-dossier.js";

const MAX_AUDITABLE_FILES = 4_096;
const MAX_AUDITABLE_FILE_BYTES = 1_048_576;
const MAX_PARTITION_FILES = 32;
// Discovery must emit a complete candidate artifact in one model response.
// Bound both source volume and file count so dense repositories do not turn
// one large page into repeated, truncated artifact writes. Larger individual
// files remain intact in their own partition; this is a packing target, not
// permission to truncate source or reduce coverage.
const MAX_PARTITION_BYTES = 131_072;

const SOURCE_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".cs", ".css", ".go", ".h", ".hpp", ".html",
  ".java", ".js", ".jsx", ".kt", ".kts", ".lua", ".mjs", ".php", ".pl",
  ".pug", ".py", ".rb", ".rs", ".scala", ".sh", ".sol", ".sql", ".svelte",
  ".swift", ".tf", ".ts", ".tsx", ".vue", ".xml",
]);
const SECURITY_CONFIGURATION_EXTENSIONS = new Set([
  ".ini", ".json", ".properties", ".toml", ".yaml", ".yml",
]);
const SECURITY_CONFIGURATION_NAMES = new Set([
  ".env.example", ".env.sample", "Cargo.toml", "Dockerfile",
  "Gemfile", "Makefile", "Procfile", "build.gradle", "composer.json",
  "go.mod", "nginx.conf", "package.json", "pom.xml", "requirements.txt",
  "settings.gradle", "tsconfig.json", "web.config",
]);
const GENERATED_DEPENDENCY_LOCKS = new Set([
  "bun.lock", "bun.lockb", "package-lock.json", "pnpm-lock.yaml", "yarn.lock",
]);

export interface PortableDeepCoveragePartition {
  index: number;
  total: number;
  paths: readonly string[];
  fileBytes: Readonly<Record<string, number>>;
  bytes: number;
}

export interface PortableDeepCoverageSourceFile {
  path: string;
  lineCount: number;
  content: string;
}

/**
 * Reads one server-planned immutable partition for prompt projection. The
 * model receives every byte as untrusted data; it no longer has to spend
 * hundreds of tool calls proving that it invoked workspace.read.
 */
export function readPortableDeepCoveragePartition(
  snapshotRoot: string,
  partition: PortableDeepCoveragePartition,
): readonly PortableDeepCoverageSourceFile[] {
  const root = path.resolve(snapshotRoot);
  return partition.paths.map((relativePath) => {
    const absolute = path.resolve(root, relativePath);
    if (!absolute.startsWith(`${root}${path.sep}`)) throw new Error("deep_coverage_unavailable");
    const expectedBytes = partition.fileBytes[relativePath];
    const info = fs.lstatSync(absolute);
    if (info.isSymbolicLink() || !info.isFile() || info.size !== expectedBytes) {
      throw new Error("deep_coverage_unavailable");
    }
    const content = fs.readFileSync(absolute, "utf8");
    const lineCount = content.length === 0
      ? 0
      : content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
    return { path: relativePath, lineCount, content };
  });
}

export interface PortableDeepCoveragePlan {
  files: readonly string[];
  totalBytes: number;
  partitions: readonly PortableDeepCoveragePartition[];
}

/** Enumerates the immutable, model-readable source/configuration universe for a Deep scan. */
export function createPortableDeepCoveragePlan(snapshotRoot: string): PortableDeepCoveragePlan {
  const root = path.resolve(snapshotRoot);
  const files: Array<{ path: string; bytes: number }> = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (!isAuditable(relative)) continue;
      const info = fs.lstatSync(absolute);
      if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_AUDITABLE_FILE_BYTES) {
        throw new Error("deep_coverage_unavailable");
      }
      files.push({ path: relative, bytes: info.size });
      if (files.length > MAX_AUDITABLE_FILES) throw new Error("deep_coverage_unavailable");
    }
  };
  visit(root);
  if (files.length === 0) throw new Error("deep_coverage_unavailable");

  const pages: Array<{ paths: string[]; bytes: number }> = [];
  let current = { paths: [] as string[], bytes: 0 };
  for (const file of files) {
    if (current.paths.length > 0 &&
        (current.paths.length >= MAX_PARTITION_FILES || current.bytes + file.bytes > MAX_PARTITION_BYTES)) {
      pages.push(current);
      current = { paths: [], bytes: 0 };
    }
    current.paths.push(file.path);
    current.bytes += file.bytes;
  }
  if (current.paths.length > 0) pages.push(current);
  return {
    files: files.map((file) => file.path),
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    partitions: pages.map((page, index) => ({
      ...page,
      fileBytes: Object.fromEntries(page.paths.map((filePath) => [
        filePath,
        files.find((file) => file.path === filePath)!.bytes,
      ])),
      index,
      total: pages.length,
    })),
  };
}

/**
 * Merges isolated discovery pages into one server-owned dossier. The coverage
 * summary and inspected universe are derived from the immutable plan, never
 * from a model's self-reported scope.
 */
export function mergePortableDeepDiscoveryDossiers(
  base: PortableCodexSecurityDossier,
  pages: readonly PortableCodexSecurityDossier[],
  plan: PortableDeepCoveragePlan,
): PortableCodexSecurityDossier {
  if (pages.length !== plan.partitions.length || pages.length === 0) {
    throw new Error("deep_coverage_incomplete");
  }
  const candidates = new Map<string, PortableCandidate>();
  for (const page of pages) {
    for (const candidate of page.candidates) {
      const prior = candidates.get(candidate.id);
      if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(candidate)) {
        throw new Error("deep_coverage_incomplete");
      }
      candidates.set(candidate.id, candidate);
    }
  }
  const deduplicatedCandidates = deduplicatePortableDeepCandidates([...candidates.values()]);
  return {
    schemaVersion: 1,
    stageSummaries: [
      ...base.stageSummaries.filter((summary) => summary.stage !== "discovery"),
      {
        stage: "discovery",
        summary: `Deep discovery inspected ${plan.files.length}/${plan.files.length} auditable files across ${plan.partitions.length} server-owned partitions.`,
      },
    ],
    candidates: deduplicatedCandidates,
    assessments: [...base.assessments],
    scope: {
      // Deep scope is the exact server-enumerated auditable universe. Broad
      // model-authored markers such as "." or "src" are not coverage proof.
      inspected: [...plan.files],
      unexamined: [],
    },
  };
}

/**
 * Discovery pages can independently describe the same missing control. Do not
 * collapse candidates merely because their CWE/category matches: a duplicate
 * is only safe to merge when the normalized claim and its primary broken
 * control location agree. The merged candidate keeps every affected anchor so
 * later validation and reporting retain the full evidence surface.
 */
function deduplicatePortableDeepCandidates(
  candidates: readonly PortableCandidate[],
): PortableCandidate[] {
  const unique = new Map<string, PortableCandidate>();
  for (const candidate of candidates) {
    const identity = portableDeepCandidateIssueIdentity(candidate);
    const prior = unique.get(identity);
    if (prior === undefined) {
      unique.set(identity, copyCandidate(candidate));
      continue;
    }
    const anchors = mergeAnchors(prior.anchors, candidate.anchors);
    // A report finding is structurally limited to 20 anchors. Keeping both
    // candidates is safer than silently truncating affected locations.
    if (anchors.length > 20) {
      unique.set(`${identity}\u0000${candidate.id}`, copyCandidate(candidate));
      continue;
    }
    prior.anchors = anchors;
  }
  return [...unique.values()];
}

function portableDeepCandidateIssueIdentity(candidate: PortableCandidate): string {
  // Historical candidate artifacts did not preserve a hypothesis. Keep them
  // separate rather than inventing equivalence from broad labels alone.
  if (candidate.hypothesis === undefined || candidate.controlHypothesis === undefined) {
    return `historical\u0000${candidate.id}`;
  }
  const primary = candidate.anchors.find((anchor) => anchor.role === "control") ??
    candidate.anchors.find((anchor) => anchor.role === "sink") ??
    candidate.anchors[0];
  const anchor = primary === undefined
    ? "no-anchor"
    : `${primary.path}:${primary.startLine}-${primary.endLine}:${primary.role}`;
  return [
    normalizeIssueText(candidate.category),
    normalizeIssueText(candidate.hypothesis),
    normalizeIssueText(candidate.controlHypothesis),
    candidate.attacker ?? "unknown",
    normalizeIssueText(candidate.prerequisites ?? ""),
    normalizeIssueText(candidate.expectedImpact ?? ""),
    anchor,
  ].join("\u0000");
}

function normalizeIssueText(value: string): string {
  return value.trim().toLocaleLowerCase("en-US").replace(/\s+/g, " ");
}

function mergeAnchors(
  left: readonly PortableCandidate["anchors"][number][],
  right: readonly PortableCandidate["anchors"][number][],
): PortableCandidate["anchors"] {
  const merged: PortableCandidate["anchors"] = [];
  const keys = new Set<string>();
  for (const anchor of [...left, ...right]) {
    const key = `${anchor.path}\u0000${anchor.startLine}\u0000${anchor.endLine}\u0000${anchor.role}\u0000${anchor.explanation ?? ""}`;
    if (keys.has(key)) continue;
    keys.add(key);
    merged.push({ ...anchor });
  }
  return merged;
}

function copyCandidate(candidate: PortableCandidate): PortableCandidate {
  return { ...candidate, anchors: candidate.anchors.map((anchor) => ({ ...anchor })) };
}

function isAuditable(relative: string): boolean {
  const base = path.posix.basename(relative);
  if (GENERATED_DEPENDENCY_LOCKS.has(base)) return false;
  const extension = path.posix.extname(base).toLowerCase();
  return SOURCE_EXTENSIONS.has(extension) || SECURITY_CONFIGURATION_EXTENSIONS.has(extension) ||
    SECURITY_CONFIGURATION_NAMES.has(base);
}
