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

const REQUIRED_PHASES = [
  "phase1_recon.md",
  "phase2_hunt.md",
  "phase2_shared.md",
  "phase2_class_inj.md",
  "phase2_class_nav.md",
  "phase2_class_log.md",
  "phase2b_verify.md",
  "phase3_reproduce_test.md",
  "phase3c_fixes.md",
  "phase3d_sweep.md",
  "phase4_report.md",
] as const;

export interface VulnHunterStageSnapshot {
  id: "recon" | "hunt" | "verify" | "validation-notes" | "sweep" | "report";
  label: string;
  percent: number;
}

export function validVulnHunterSkillRoot(root: string): boolean {
  return fs.existsSync(path.join(root, "SKILL.md"))
    && REQUIRED_PHASES.every((name) => fs.existsSync(path.join(root, "phases", name)));
}

export function assertVulnHunterNonOperationalArtifacts(resultsDir: string): void {
  for (const directoryName of ["poc", "exploit_tests"]) {
    const directory = path.join(resultsDir, directoryName);
    if (!fs.existsSync(directory)) continue;
    for (const file of listSnapshotFiles(directory)) {
      if (path.relative(directory, file).replaceAll("\\", "/") !== "README.md") {
        throw new Error(
          `VulnHunter read-only boundary rejected operational artifact ${path.relative(resultsDir, file)}.`,
        );
      }
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
      if (relative.split(path.sep).some((segment) => SNAPSHOT_EXCLUDES.has(segment))) {
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

function completedHunt(resultsDir: string): boolean {
  const partitionsDir = path.join(resultsDir, "partitions");
  const findingsDir = path.join(resultsDir, "results");
  if (!fs.existsSync(findingsDir)) return false;
  const partitionIds = fs.existsSync(partitionsDir)
    ? fs.readdirSync(partitionsDir)
      .flatMap((name) => name.match(/^(sg-.+)_data\.md$/)?.[1] ?? [])
    : [];
  const classGroups = ["inj", "nav", "log"];
  const partitionsComplete = partitionIds.every((id) =>
    classGroups.every((group) => fs.existsSync(path.join(findingsDir, `${id}_${group}_results.md`)))
  );
  return partitionsComplete
    && fs.existsSync(path.join(findingsDir, "sink_driven_results.md"));
}

export function inferVulnHunterStage(resultsDir: string): VulnHunterStageSnapshot {
  if (hasFile(resultsDir, "phase3d_output.md") || hasFile(resultsDir, "sentinel-findings.json")) {
    return { id: "report", label: "Evidence report", percent: 92 };
  }
  if (hasFile(resultsDir, "phase3_output.md")) {
    return { id: "sweep", label: "Coverage sweep", percent: 78 };
  }
  if (hasFile(resultsDir, "phase2b_output.md")) {
    return { id: "validation-notes", label: "Static validation notes", percent: 62 };
  }
  if (completedHunt(resultsDir)) {
    return { id: "verify", label: "Candidate verification", percent: 45 };
  }
  if (hasFile(resultsDir, "phase1_output.md")) {
    return { id: "hunt", label: "Parallel vulnerability hunt", percent: 24 };
  }
  return { id: "recon", label: "Repository reconnaissance", percent: 8 };
}
