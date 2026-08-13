import fs from "node:fs";
import path from "node:path";

import type {
  PortableCandidate,
  PortableCodexSecurityDossier,
} from "./portable-codex-security-dossier.js";

const MAX_AUDITABLE_FILES = 4_096;
const MAX_AUDITABLE_FILE_BYTES = 1_048_576;
const MAX_PARTITION_FILES = 128;
// workspace.read returns JSON-escaped source and the session retains those
// results in later requests. Keep raw pages below route pricing/context
// ceilings while deriving a larger bounded output allowance per partition.
// Keep projected source comfortably below common frozen pricing/context
// thresholds. JSON escaping and the stage envelope add bytes on top of the
// source itself; 768 KiB kept the real MiniMax-M3 request below its pinned
// 512k-token rate-card ceiling where a 1.5 MiB page crossed it.
const MAX_PARTITION_BYTES = 786_432;

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
  return {
    schemaVersion: 1,
    stageSummaries: [
      ...base.stageSummaries.filter((summary) => summary.stage !== "discovery"),
      {
        stage: "discovery",
        summary: `Deep discovery inspected ${plan.files.length}/${plan.files.length} auditable files across ${plan.partitions.length} server-owned partitions.`,
      },
    ],
    candidates: [...candidates.values()],
    assessments: [...base.assessments],
    scope: {
      // Deep scope is the exact server-enumerated auditable universe. Broad
      // model-authored markers such as "." or "src" are not coverage proof.
      inspected: [...plan.files],
      unexamined: [],
    },
  };
}

function isAuditable(relative: string): boolean {
  const base = path.posix.basename(relative);
  if (GENERATED_DEPENDENCY_LOCKS.has(base)) return false;
  const extension = path.posix.extname(base).toLowerCase();
  return SOURCE_EXTENSIONS.has(extension) || SECURITY_CONFIGURATION_EXTENSIONS.has(extension) ||
    SECURITY_CONFIGURATION_NAMES.has(base);
}
