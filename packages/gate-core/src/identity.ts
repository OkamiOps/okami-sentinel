import type { FindingSummary } from "@csb/shared";

export function findingIdentity(finding: FindingSummary): string {
  const fingerprint = finding.fingerprints.find((value) => /(?:sha256:|fingerprint:)/i.test(value))
    ?? finding.fingerprints.find((value) => value.trim() && value !== finding.findingId && !/^codex-security\/v\d+$/i.test(value.trim()));
  if (fingerprint) return `fp:${fingerprint.trim()}`;
  if (finding.ruleId && finding.primaryPath) {
    return `rule:${finding.ruleId}::${normalizePath(finding.primaryPath)}`;
  }
  if (finding.occurrenceId) return `occ:${finding.occurrenceId}`;
  return `fallback:${finding.title.trim().toLowerCase()}::${normalizePath(finding.primaryPath ?? "")}`;
}

function normalizePath(value: string): string {
  return value
    .replaceAll("\\", "/")
    .replace(/:\d+(?::\d+)?(?:-\d+)?$/, "")
    .replace(/^\.\//, "")
    .toLowerCase();
}
