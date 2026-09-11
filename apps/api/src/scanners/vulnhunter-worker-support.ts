import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SNAPSHOT_EXCLUDES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".next",
  ".nuxt",
  ".turbo",
  "dist",
  "build",
  "coverage",
  ".cache",
  "_VULNHUNT_RESULTS_",
]);
const AGENT_INSTRUCTION_DIRECTORIES = new Set([
  ".claude",
  ".cursor",
  ".continue",
  ".codeium",
  ".junie",
]);
const ROOT_AGENT_INSTRUCTION_FILES = new Set([
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  ".cursorrules",
  ".windsurfrules",
]);

/**
 * Container scans may read a bind-mounted repository owned by the host user.
 * Scope Git's ownership exception to this one read-only invocation; never
 * mutate a worker or image-wide Git configuration.
 */
export function vulnhunterGitArgs(repositoryPath: string, args: string[]): string[] {
  if (process.env.CSB_RUNTIME_MODE?.trim() !== "server") {
    return ["-C", repositoryPath, ...args];
  }
  const canonicalRepositoryPath = fs.realpathSync.native(repositoryPath);
  return [
    "-c", `safe.directory=${canonicalRepositoryPath}`,
    "-c", "core.fsmonitor=false",
    "-c", "core.hooksPath=/dev/null",
    "-C", canonicalRepositoryPath,
    ...args,
  ];
}

export interface VulnHunterStageSnapshot {
  id: "recon" | "hunt" | "verify" | "validation-notes" | "sweep" | "report";
  label: string;
  percent: number;
}

const VULNHUNTER_DEFENSIVE_ARTIFACTS = new Set([
  "reconnaissance.md",
  "trace-review.md",
  "verification.md",
  "validation-notes.md",
  "coverage-sweep.md",
  "README.md",
  "sentinel-findings.json",
]);

export function assertVulnHunterNonOperationalArtifacts(resultsDir: string): void {
  if (!fs.existsSync(resultsDir)) return;
  for (const entry of fs.readdirSync(resultsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !VULNHUNTER_DEFENSIVE_ARTIFACTS.has(entry.name)) {
      throw new Error(
        `VulnHunter read-only boundary rejected operational artifact ${entry.name}.`,
      );
    }
  }
}

function inside(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === ""
    || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function listSnapshotFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push(absolute);
    }
  };
  visit(root);
  return files.sort((left, right) => left.localeCompare(right));
}

function hashSnapshot(root: string): string {
  const hash = createHash("sha256");
  for (const file of listSnapshotFiles(root)) {
    hash.update(path.relative(root, file));
    hash.update("\0");
    hash.update(fs.readFileSync(file));
    hash.update("\0");
  }
  return `content:${hash.digest("hex")}`;
}

function isSnapshotExcluded(relative: string): boolean {
  const segments = relative.split(path.sep);
  if (segments.some((segment) => SNAPSHOT_EXCLUDES.has(segment))) return true;
  if (segments.some((segment) => AGENT_INSTRUCTION_DIRECTORIES.has(segment))) return true;
  if (segments.some((segment) => ROOT_AGENT_INSTRUCTION_FILES.has(segment))) return true;
  return segments.length === 2 && segments[0] === ".github" &&
    segments[1] === "copilot-instructions.md";
}

export function openVulnHunterSnapshot(
  repositoryPath: string,
  outputDir: string,
): { snapshotRoot: string; snapshotId: string } {
  const snapshotRoot = path.join(path.resolve(outputDir), "vulnhunter-snapshot");
  if (!fs.existsSync(snapshotRoot)) {
    return createVulnHunterSnapshot(repositoryPath, outputDir);
  }
  const info = fs.lstatSync(snapshotRoot);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("VulnHunter snapshot directory already exists; refusing to overwrite it.");
  }
  return { snapshotRoot, snapshotId: hashSnapshot(snapshotRoot) };
}

export function countInspectableSnapshotFiles(root: string): number {
  if (!fs.existsSync(root)) return 0;
  return listSnapshotFiles(root).filter((file) => {
    try {
      if (path.basename(file) === ".mantis_snapshot_id") return false;
      const info = fs.lstatSync(file);
      return info.isFile() && !info.isSymbolicLink() && info.size > 0;
    } catch {
      return false;
    }
  }).length;
}

/** Require enough full-file reads to prove the snapshot was inspected, without a coverage ceiling. */
export function minimumSourceReadsForSnapshot(fileCount: number, cap: number): number {
  if (!Number.isSafeInteger(fileCount) || fileCount <= 0 || !Number.isSafeInteger(cap) || cap <= 0) {
    return 0;
  }
  if (fileCount <= 8) return fileCount;
  return Math.min(cap, Math.max(8, Math.ceil(fileCount / 16)));
}

export function createVulnHunterSnapshot(
  repositoryPath: string,
  outputDir: string,
): { snapshotRoot: string; snapshotId: string } {
  const sourceRoot = path.resolve(repositoryPath);
  const snapshotRoot = path.join(path.resolve(outputDir), "vulnhunter-snapshot");
  if (!fs.statSync(sourceRoot).isDirectory()) {
    throw new Error("VulnHunter target is not a directory.");
  }
  if (inside(sourceRoot, outputDir)) {
    throw new Error("VulnHunter output directory cannot be nested inside the target repository.");
  }
  if (fs.existsSync(snapshotRoot)) {
    throw new Error("VulnHunter snapshot directory already exists; refusing to overwrite it.");
  }

  let entries = 0;
  fs.cpSync(sourceRoot, snapshotRoot, {
    recursive: true,
    dereference: false,
    preserveTimestamps: true,
    filter(source) {
      if (source === sourceRoot) return true;
      const relative = path.relative(sourceRoot, source);
      if (isSnapshotExcluded(relative)) {
        return false;
      }
      try {
        if (fs.lstatSync(source).isSymbolicLink()) return false;
      } catch {
        return false;
      }
      entries += 1;
      if (entries > 500_000) {
        throw new Error("VulnHunter snapshot exceeds the 500,000-entry safety limit.");
      }
      return true;
    },
  });

  return { snapshotRoot, snapshotId: hashSnapshot(snapshotRoot) };
}

function hasFile(root: string, name: string): boolean {
  if (!fs.existsSync(root)) return false;
  const visit = (directory: string): boolean => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isFile() && entry.name === name) return true;
      if (entry.isDirectory() && visit(absolute)) return true;
    }
    return false;
  };
  return visit(root);
}

export function inferVulnHunterStage(resultsDir: string): VulnHunterStageSnapshot {
  if (hasFile(resultsDir, "coverage-sweep.md") || hasFile(resultsDir, "sentinel-findings.json")) {
    return { id: "report", label: "Evidence report", percent: 92 };
  }
  if (hasFile(resultsDir, "validation-notes.md")) {
    return { id: "sweep", label: "Coverage sweep", percent: 78 };
  }
  if (hasFile(resultsDir, "verification.md")) {
    return { id: "validation-notes", label: "Static validation notes", percent: 62 };
  }
  if (hasFile(resultsDir, "trace-review.md")) {
    return { id: "verify", label: "Candidate verification", percent: 45 };
  }
  if (hasFile(resultsDir, "reconnaissance.md")) {
    return { id: "hunt", label: "Static trace review", percent: 24 };
  }
  return { id: "recon", label: "Repository reconnaissance", percent: 8 };
}
