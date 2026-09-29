import { createHash } from "node:crypto";
import type { FindingSummary } from "@csb/shared";
import { containsLocalHostPath, containsSecret } from "./public-text.js";

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

/**
 * Identity safe to publish in the gate artifact. Raw identities that already
 * pass the public-text rules stay byte-identical so stored baselines keep
 * matching; the rest collapse into a deterministic hash of the raw identity.
 */
export function publicFindingIdentity(finding: FindingSummary): string {
  return publicIdentity(findingIdentity(finding));
}

export function publicIdentity(identity: string): string {
  if (!containsSecret(identity) && !containsLocalHostPath(identity)) return identity;
  return `hash:sha256:${createHash("sha256").update(identity).digest("hex")}`;
}

function normalizePath(value: string): string {
  return value
    .replaceAll("\\", "/")
    .replace(/:\d+(?::\d+)?(?:-\d+)?$/, "")
    .replace(/^\.\//, "")
    .toLowerCase();
}
