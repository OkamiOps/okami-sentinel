import { isRepositoryRelativePath, redactPublicText } from "@csb/gate-core";
import type {
  GateArtifactV2,
  GateFindingDelta,
  GuardrailPrCommentLocale,
  Severity,
} from "@csb/shared";

import { PR_COMMENT_COPY } from "./pr-comment-copy.js";

/**
 * The hidden line that makes the comment findable again on the next commit. It
 * carries the repository key, so two Sentinel installations commenting on the same
 * fork never edit each other's comment.
 */
export const PR_COMMENT_MARKER_PREFIX = "<!-- okami-sentinel:gate repository=";

/**
 * GitHub refuses a comment body over 65,536 characters. The budget is deliberately
 * under it: the body is built, measured and shortened until it fits, and the slack
 * is what keeps a last-minute footer change from costing a publication.
 */
export const PR_COMMENT_BUDGET = 60_000;

/** No pull request is reviewed from a table longer than this. The rest is a link. */
export const PR_COMMENT_MAX_ROWS = 50;

/** How much of a finding's title survives into a table cell. */
const CELL_LIMIT = 160;

const SEVERITY_RANK: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
  unknown: 5,
};

const SEVERITY_ORDER: readonly Severity[] = ["critical", "high", "medium", "low", "info", "unknown"];

const MARKDOWN_ENTITIES: Readonly<Record<string, string>> = Object.freeze({
  "&": "&amp;", "<": "&lt;", ">": "&gt;",
});

export function prCommentMarker(repositoryKey: string): string {
  return `${PR_COMMENT_MARKER_PREFIX}${repositoryKey} -->`;
}

export function isSentinelComment(body: string, repositoryKey: string): boolean {
  return body.includes(prCommentMarker(repositoryKey));
}

export interface RenderPrCommentInput {
  artifact: GateArtifactV2;
  repositoryKey: string;
  locale: GuardrailPrCommentLocale;
  /** `null` with no public origin: the comment then carries no link at all. */
  gateUrl: string | null;
  bannerUrl: string | null;
  findingUrl(findingIdentity: string): string | null;
  durationMs: number | null;
}

export interface RenderedPrComment {
  body: string;
  /** How many new findings the table did not show. */
  truncatedCount: number;
}

export function renderPrComment(input: RenderPrCommentInput): RenderedPrComment {
  const copy = PR_COMMENT_COPY[input.locale];
  const artifact = input.artifact;
  const newFindings = artifact.findings
    .filter((finding) => finding.lifecycle === "new" || finding.lifecycle === "reopened")
    .sort(compareFindings);
  const fixedCount = artifact.findings.filter((finding) => finding.lifecycle === "fixed").length;
  const rows = newFindings
    .slice(0, PR_COMMENT_MAX_ROWS)
    .map((finding) => renderRow(finding, input, copy.pathWithheld, copy.viewFinding));

  const compose = (shown: number): string => fullBody(input, copy, {
    newFindings,
    fixedCount,
    rows: rows.slice(0, shown),
    truncatedCount: newFindings.length - shown,
  });

  let shown = rows.length;
  let body = compose(shown);
  // Rows are already ordered by severity, so the row that goes is always the one
  // the reviewer would have read last.
  while (shown > 0 && body.length > PR_COMMENT_BUDGET) {
    shown -= 1;
    body = compose(shown);
  }
  if (body.length > PR_COMMENT_BUDGET) {
    // Nothing but the verdict and the way to the whole of it. A decision summary
    // long enough to reach here is a defect somewhere else; it must not cost the
    // author the one line that tells them what happened.
    return { body: minimalBody(input, copy), truncatedCount: newFindings.length };
  }
  return { body, truncatedCount: newFindings.length - shown };
}

interface BodyParts {
  newFindings: readonly GateFindingDelta[];
  fixedCount: number;
  rows: readonly string[];
  truncatedCount: number;
}

function fullBody(
  input: RenderPrCommentInput,
  copy: (typeof PR_COMMENT_COPY)[GuardrailPrCommentLocale],
  parts: BodyParts,
): string {
  const artifact = input.artifact;
  const lines: string[] = [prCommentMarker(input.repositoryKey), ""];
  if (input.bannerUrl !== null) lines.push(`![Okami Sentinel](${input.bannerUrl})`, "");
  lines.push(`## Okami Sentinel — ${copy.verdict[artifact.decision.outcome]}`, "");
  lines.push(`> ${cell(artifact.decision.summary, Number.MAX_SAFE_INTEGER)}`, "");

  const summaryRows: string[] = [
    `| **${copy.verdictLabel}** | ${copy.verdict[artifact.decision.outcome]} |`,
    `| **${copy.newFindingsLabel}** | ${severitySummary(parts.newFindings, copy.none)} |`,
  ];
  // A repository with no baseline has nothing to have fixed against, so the row
  // would be a zero that reads as "you fixed nothing".
  if (artifact.baselineCommit !== null) {
    summaryRows.push(`| **${copy.fixedLabel}** | ${parts.fixedCount} |`);
  }
  summaryRows.push(`| **${copy.baselineLabel}** | ${baselineCell(artifact, copy)} |`);
  summaryRows.push(`| **${copy.costLabel}** | ${costCell(artifact, copy.none)} |`);
  summaryRows.push(`| **${copy.durationLabel}** | ${durationCell(input.durationMs, copy.none)} |`);
  lines.push("| | |", "|---|---|", ...summaryRows, "");

  lines.push(`### ${copy.newFindingsHeading}`, "");
  if (parts.rows.length === 0) {
    lines.push(copy.noNewFindings, "");
  } else {
    lines.push(
      `| ${copy.columnSeverity} | ${copy.columnFinding} | ${copy.columnLocation} | |`,
      "|---|---|---|---|",
      ...parts.rows,
      "",
    );
  }
  if (parts.truncatedCount > 0) lines.push(copy.more(parts.truncatedCount), "");

  lines.push("---", "");
  lines.push(copy.informational, "");
  lines.push(footer(input, copy));
  return lines.join("\n");
}

function minimalBody(
  input: RenderPrCommentInput,
  copy: (typeof PR_COMMENT_COPY)[GuardrailPrCommentLocale],
): string {
  const lines: string[] = [prCommentMarker(input.repositoryKey), ""];
  if (input.bannerUrl !== null) lines.push(`![Okami Sentinel](${input.bannerUrl})`, "");
  lines.push(`## Okami Sentinel — ${copy.verdict[input.artifact.decision.outcome]}`, "");
  lines.push(copy.informational, "");
  lines.push(footer(input, copy));
  return lines.join("\n");
}

function footer(
  input: RenderPrCommentInput,
  copy: (typeof PR_COMMENT_COPY)[GuardrailPrCommentLocale],
): string {
  const artifact = input.artifact;
  const pieces = [
    `${copy.commitLabel} \`${shortSha(artifact.changeSet.headSha)}\``,
    `${copy.modelLabel} \`${cell(artifact.lineage.model, 60)}\``,
  ];
  if (input.gateUrl !== null) pieces.push(`[${copy.gateLink}](${input.gateUrl})`);
  return pieces.join(" · ");
}

function renderRow(
  finding: GateFindingDelta,
  input: RenderPrCommentInput,
  pathWithheld: string,
  viewLabel: string,
): string {
  const title = cell(finding.title, CELL_LIMIT) || "—";
  const url = input.findingUrl(finding.identity);
  const link = url === null ? "" : `[${viewLabel}](${url})`;
  return `| ${finding.severity} | ${title} | ${location(finding.primaryPath, pathWithheld)} | ${link} |`;
}

function location(primaryPath: string | null, pathWithheld: string): string {
  if (primaryPath === null) return "—";
  if (!isRepositoryRelativePath(primaryPath)) return pathWithheld;
  return `\`${cell(primaryPath, CELL_LIMIT)}\``;
}

function severitySummary(findings: readonly GateFindingDelta[], none: string): string {
  if (findings.length === 0) return `0 ${none}`.trim();
  const counts = SEVERITY_ORDER
    .map((severity) => ({ severity, count: findings.filter((f) => f.severity === severity).length }))
    .filter((entry) => entry.count > 0)
    .map((entry) => `${entry.severity} ${entry.count}`);
  return `${findings.length} — ${counts.join(" · ")}`;
}

function baselineCell(
  artifact: GateArtifactV2,
  copy: (typeof PR_COMMENT_COPY)[GuardrailPrCommentLocale],
): string {
  if (artifact.baselineCommit !== null) return `\`${shortSha(artifact.baselineCommit)}\``;
  const notice = artifact.baselineNotice;
  if (notice === null || notice.kind === "absent") return copy.baselineAbsent;
  const reason = notice.reason;
  if (reason === "scan_lineage" || reason === "coverage" || reason === "policy_schema") {
    return copy.baselineIncompatible[reason];
  }
  return reason === null
    ? copy.baselineIncompatible.default
    : `${copy.baselineIncompatible.default} (${cell(reason, 40)})`;
}

function costCell(artifact: GateArtifactV2, none: string): string {
  const estimated = artifact.scan.cost?.estimatedUsd;
  return estimated === undefined ? none : `US$ ${estimated.toFixed(2)}`;
}

function durationCell(durationMs: number | null, none: string): string {
  if (durationMs === null || !Number.isFinite(durationMs) || durationMs < 0) return none;
  const seconds = Math.round(durationMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function shortSha(value: string): string {
  return /^[0-9a-f]{7,}$/i.test(value) ? value.slice(0, 7) : cell(value, 40);
}

function compareFindings(left: GateFindingDelta, right: GateFindingDelta): number {
  return SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity]
    || left.title.localeCompare(right.title)
    || left.identity.localeCompare(right.identity);
}

/**
 * One function for every piece of scanner text that reaches a public comment:
 * the gate-core public-text redaction first (no secrets, no host paths), then
 * the escaping a markdown table and GitHub's HTML both need, then a length.
 *
 * `<!--` and `-->` are removed rather than escaped: a finding title must never be
 * able to forge or close Sentinel's own marker.
 */
function cell(value: string, limit: number): string {
  let text = redactPublicText(value)
    .replaceAll("|", "\\|")
    .replaceAll("`", "'")
    .replaceAll("<!--", "")
    .replaceAll("-->", "")
    // One pass over the three characters that can change the meaning of GitHub's
    // markdown-embedded HTML. Nothing here keeps any markup, so escaping is the
    // whole job and a sanitizer — which exists to keep some — is the wrong tool.
    .replace(/[&<>]/g, (character) => MARKDOWN_ENTITIES[character] ?? character)
    .replace(/\s+/g, " ")
    .trim();
  if (text.length > limit) text = `${text.slice(0, limit - 1).trimEnd()}…`;
  // Truncation must not leave a dangling escape that would eat the next character.
  return text.replace(/\\+$/, "");
}
