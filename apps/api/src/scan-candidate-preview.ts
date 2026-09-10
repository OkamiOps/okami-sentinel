import fs from "node:fs";
import path from "node:path";
import type { ScanRun, ScanCandidatePreview, ScanCandidatePreviewItem } from "@csb/shared";
import { normalizePortableCodexSecurityStageArtifact, type PortableCandidate } from "./scanners/portable-codex-security-dossier.js";

const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;

/** Read accepted discovery artifacts only. Never persist provisional claims as findings. */
export function scanCandidatePreview(scan: ScanRun, now = Date.now()): ScanCandidatePreview {
  const result: ScanCandidatePreview = {
    scanId: scan.id, measuredAt: new Date(now).toISOString(), provisional: true, candidates: [],
  };
  if (scan.status === "completed" || scan.engine !== "codex-security" || scan.execution?.executionProfile !== "portable") return result;
  const candidates = new Map<string, ScanCandidatePreviewItem>();
  try {
    const root = fs.realpathSync(scan.scanDir);
    const artifacts = path.join(root, "portable-codex-security-artifacts");
    // Child directories and files must remain inside this scan, without symlink indirection.
    if (!fs.lstatSync(artifacts).isDirectory() || fs.realpathSync(artifacts) !== artifacts) return result;
    const dirs = fs.readdirSync(artifacts, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && /^discovery(?:-\d+|-review)?$/.test(entry.name))
      .map(entry => entry.name).sort();
    for (const dir of dirs) {
      let fd: number | undefined;
      try {
        const file = path.join(artifacts, dir, "03-discovery.json");
        if (fs.realpathSync(file) !== file) continue;
        fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size > MAX_ARTIFACT_BYTES) continue;
        // Bounded descriptor read also handles a file growing during inspection.
        const buffer = Buffer.alloc(Math.min(stat.size + 1, MAX_ARTIFACT_BYTES + 1));
        const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
        if (length > MAX_ARTIFACT_BYTES) continue;
        const artifact = normalizePortableCodexSecurityStageArtifact("03-discovery.json", JSON.parse(buffer.subarray(0, length).toString("utf8")));
        if (!artifact || !Array.isArray(artifact.candidates)) continue;
        for (const candidate of artifact.candidates as PortableCandidate[]) {
          candidates.set(candidate.id, {
            id: candidate.id, category: candidate.category, hypothesis: candidate.hypothesis ?? "",
            ...(candidate.expectedImpact === undefined ? {} : { expectedImpact: candidate.expectedImpact }),
            ...(candidate.prerequisites === undefined ? {} : { prerequisites: candidate.prerequisites }),
            anchors: candidate.anchors.map(anchor => ({ path: anchor.path, line: anchor.startLine, explanation: anchor.explanation ?? "" })),
          });
        }
      } catch { /* Missing, partial or malformed artifacts are not accepted evidence. */ }
      finally { if (fd !== undefined) fs.closeSync(fd); }
    }
  } catch { /* Legacy/native scans and discovery that has not started have no preview yet. */ }
  result.candidates = [...candidates.values()];
  return result;
}
