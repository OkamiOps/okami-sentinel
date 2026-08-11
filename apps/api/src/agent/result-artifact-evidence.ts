import fs from "node:fs";
import path from "node:path";

const MAX_EVIDENCE_FILE_BYTES = 2 * 1024 * 1024;
const MAX_EVIDENCE_BYTES_PER_REPORT = 64 * 1024 * 1024;
const MAX_EVIDENCE_RANGE_LINES = 200;
const NO_FOLLOW = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
const DIRECTORY = typeof fs.constants.O_DIRECTORY === "number" ? fs.constants.O_DIRECTORY : 0;
const READ_NO_FOLLOW = fs.constants.O_RDONLY | NO_FOLLOW;
const READ_DIRECTORY_NO_FOLLOW = READ_NO_FOLLOW | DIRECTORY;

interface PinnedSnapshotRoot {
  lexicalPath: string;
  canonicalPath: string;
  lexicalInfo: fs.Stats;
  canonicalInfo: fs.Stats;
  descriptor: number;
  openedInfo: fs.Stats;
}

/**
 * Proves that every provider-supplied evidence locator resolves to a regular
 * file and a real bounded line interval inside the pinned snapshot. The check
 * is deliberately local and provider-agnostic; no wire schema or provider
 * identity is trusted as evidence.
 */
export function validateVulnHunterReportEvidence(
  report: Record<string, unknown>,
  snapshotRoot: string | undefined,
): boolean {
  const findings = report.findings;
  if (!Array.isArray(findings)) return false;
  if (findings.length === 0) return true;
  if (snapshotRoot === undefined) return false;

  let root: PinnedSnapshotRoot | undefined;
  try {
    root = pinSnapshotRoot(snapshotRoot);
    const lineCounts = new Map<string, number>();
    let verifiedBytes = 0;

    for (const findingCandidate of findings) {
      const finding = record(findingCandidate);
      if (finding === null || !Array.isArray(finding.evidence)) return false;
      for (const evidenceCandidate of finding.evidence) {
        const evidence = record(evidenceCandidate);
        if (evidence === null || typeof evidence.path !== "string" ||
            !positiveInteger(evidence.startLine) || !positiveInteger(evidence.endLine) ||
            evidence.endLine < evidence.startLine ||
            evidence.endLine - evidence.startLine + 1 > MAX_EVIDENCE_RANGE_LINES) return false;

        let lineCount = lineCounts.get(evidence.path);
        if (lineCount === undefined) {
          const verified = readVerifiedEvidenceFile(root, evidence.path, verifiedBytes);
          if (verified === null) return false;
          verifiedBytes += verified.bytes;
          lineCount = verified.lineCount;
          lineCounts.set(evidence.path, lineCount);
        }
        if (evidence.startLine > lineCount || evidence.endLine > lineCount) return false;
      }
    }
    return snapshotRootUnchanged(root);
  } catch {
    return false;
  } finally {
    if (root !== undefined) {
      try {
        fs.closeSync(root.descriptor);
      } catch {
        // A failed close cannot turn rejected evidence into accepted evidence.
      }
    }
  }
}

function pinSnapshotRoot(snapshotRoot: string): PinnedSnapshotRoot {
  const lexicalPath = path.resolve(snapshotRoot);
  const lexicalInfo = fs.lstatSync(lexicalPath);
  if (lexicalInfo.isSymbolicLink() || !lexicalInfo.isDirectory()) throw new Error("invalid root");
  const canonicalPath = fs.realpathSync(lexicalPath);
  const canonicalInfo = fs.lstatSync(canonicalPath);
  if (canonicalInfo.isSymbolicLink() || !canonicalInfo.isDirectory() ||
      !sameVersion(lexicalInfo, canonicalInfo)) throw new Error("invalid root");
  const descriptor = fs.openSync(canonicalPath, READ_DIRECTORY_NO_FOLLOW);
  try {
    const openedInfo = fs.fstatSync(descriptor);
    if (!openedInfo.isDirectory() || !sameVersion(canonicalInfo, openedInfo)) {
      throw new Error("invalid root");
    }
    return { lexicalPath, canonicalPath, lexicalInfo, canonicalInfo, descriptor, openedInfo };
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

function readVerifiedEvidenceFile(
  root: PinnedSnapshotRoot,
  relativePath: string,
  verifiedBytes: number,
): { bytes: number; lineCount: number } | null {
  const segments = relativePath.replaceAll("\\", "/").split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    return null;
  }
  const target = path.resolve(root.canonicalPath, ...segments);
  const relative = path.relative(root.canonicalPath, target);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)) return null;

  let cursor = root.canonicalPath;
  let expected: fs.Stats | undefined;
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    expected = fs.lstatSync(cursor);
    if (expected.isSymbolicLink()) return null;
  }
  if (expected === undefined || !expected.isFile() || expected.size <= 0 ||
      expected.size > MAX_EVIDENCE_FILE_BYTES ||
      verifiedBytes + expected.size > MAX_EVIDENCE_BYTES_PER_REPORT) return null;

  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(target, READ_NO_FOLLOW);
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || !sameVersion(expected, opened)) return null;
    const content = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < content.length) {
      const bytesRead = fs.readSync(descriptor, content, offset, content.length - offset, offset);
      if (bytesRead === 0) return null;
      offset += bytesRead;
    }
    const afterRead = fs.fstatSync(descriptor);
    const afterPath = fs.lstatSync(target);
    if (afterPath.isSymbolicLink() || !sameVersion(opened, afterRead) ||
        !sameVersion(opened, afterPath) || !snapshotRootUnchanged(root)) return null;
    return {
      bytes: content.length,
      lineCount: content.toString("utf8").split(/\r?\n/).length,
    };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function snapshotRootUnchanged(root: PinnedSnapshotRoot): boolean {
  try {
    const lexicalInfo = fs.lstatSync(root.lexicalPath);
    const canonicalPath = fs.realpathSync(root.lexicalPath);
    const canonicalInfo = fs.lstatSync(root.canonicalPath);
    const openedInfo = fs.fstatSync(root.descriptor);
    return !lexicalInfo.isSymbolicLink() && lexicalInfo.isDirectory() &&
      canonicalPath === root.canonicalPath && canonicalInfo.isDirectory() &&
      sameVersion(root.lexicalInfo, lexicalInfo) &&
      sameVersion(root.canonicalInfo, canonicalInfo) &&
      sameVersion(root.openedInfo, openedInfo);
  } catch {
    return false;
  }
}

function sameVersion(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
