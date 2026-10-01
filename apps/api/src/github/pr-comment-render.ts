import { isRepositoryRelativePath, redactPublicText } from "@csb/gate-core";
import type {
  GateArtifactV2,
  GateFindingDelta,
  GateOutcome,
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

/**
 * Left-to-right/right-to-left marks, embeddings, overrides and isolates. They are
 * invisible and they reorder what follows them, so a finding title can be made to
 * read as its own opposite. Nothing legitimate in scanner output needs them.
 */
const BIDI_CONTROLS = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** Invisible, directionless, and enough to stop GitHub's autolinker. */
const JOINER = "\u200d";

/**
 * The three verdicts that get a coloured pill. The pill carries no words — one
 * file serves all five languages — so the localised verdict travels as its alt
 * text, and the heading repeats it in words for anyone whose client blocks images.
 */
const VERDICT_BADGE: Partial<Record<GateOutcome, string>> = {
  blocked: "pr-verdict-blocked.png",
  warning: "pr-verdict-warning.png",
  pass: "pr-verdict-passed.png",
};

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
  /**
   * Where a brand asset of the Sentinel origin lives — the banner, the verdict
   * pill, the severity markers. `null` with no public origin, and the comment
   * then renders as words alone.
   */
  assetUrl(fileName: string): string | null;
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
    .map((finding) => renderRow(finding, input, copy));

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
  lines.push(...heading(input, copy));
  lines.push(`> ${cell(artifact.decision.summary, Number.MAX_SAFE_INTEGER)}`, "");

  const summaryRows: string[] = [
    `| **${copy.newFindingsLabel}** | ${severitySummary(parts.newFindings, copy, input)} |`,
  ];
  // A repository with no baseline has nothing to have fixed against, so the row
  // would be a zero that reads as "you fixed nothing".
  if (artifact.baselineCommit !== null) {
    summaryRows.push(`| **${copy.fixedLabel}** | ${parts.fixedCount} |`);
  }
  summaryRows.push(`| **${copy.baselineLabel}** | ${baselineCell(artifact, copy)} |`);
  summaryRows.push(`| **${copy.costLabel}** | ${costCell(artifact, copy.none)} |`);
  summaryRows.push(`| **${copy.durationLabel}** | ${durationCell(input.durationMs, copy.none)} |`);
  lines.push(
    `| ${copy.columnSummary} | ${copy.columnValue} |`,
    "|---|---|",
    ...summaryRows,
    "",
  );

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
  lines.push(...heading(input, copy));
  lines.push(copy.informational, "");
  lines.push(footer(input, copy));
  return lines.join("\n");
}

/**
 * The banner, the verdict pill, and the verdict in words. The words stay even
 * when both images are there: a pill alone is a colour, and a colour is not a
 * verdict for anyone reading this on a client that blocks images.
 */
function heading(
  input: RenderPrCommentInput,
  copy: (typeof PR_COMMENT_COPY)[GuardrailPrCommentLocale],
): string[] {
  const outcome = input.artifact.decision.outcome;
  const verdict = copy.verdict[outcome];
  const lines: string[] = [];
  const banner = input.assetUrl("pr-comment-banner.png");
  if (banner !== null) lines.push(`![Okami Sentinel](${banner})`, "");
  lines.push(`## Okami Sentinel — ${verdict}`, "");
  const badgeFile = VERDICT_BADGE[outcome];
  const badge = badgeFile === undefined ? null : input.assetUrl(badgeFile);
  if (badge !== null) lines.push(`![${verdict}](${badge})`, "");
  return lines;
}

function footer(
  input: RenderPrCommentInput,
  copy: (typeof PR_COMMENT_COPY)[GuardrailPrCommentLocale],
): string {
  const artifact = input.artifact;
  const pieces = [
    `${copy.commitLabel} \`${shortSha(artifact.changeSet.headSha)}\``,
    `${copy.modelLabel} \`${codeText(artifact.lineage.model, 60)}\``,
  ];
  if (input.gateUrl !== null) pieces.push(`[${copy.gateLink}](${input.gateUrl})`);
  return pieces.join(" · ");
}

function renderRow(
  finding: GateFindingDelta,
  input: RenderPrCommentInput,
  copy: (typeof PR_COMMENT_COPY)[GuardrailPrCommentLocale],
): string {
  const title = cell(finding.title, CELL_LIMIT) || "—";
  const url = input.findingUrl(finding.identity);
  const link = url === null ? "" : `[${copy.viewFinding}](${url})`;
  const place = location(finding.primaryPath, copy.pathWithheld);
  return `| ${severityCell(finding.severity, copy, input)} | ${title} | ${place} | ${link} |`;
}

/** The coloured marker and the severity's name, in the repository's language. */
function severityCell(
  severity: Severity,
  copy: (typeof PR_COMMENT_COPY)[GuardrailPrCommentLocale],
  input: RenderPrCommentInput,
): string {
  const name = copy.severity[severity];
  const icon = input.assetUrl(`pr-severity-${severity}.png`);
  return icon === null ? name : `![${name}](${icon}) ${name}`;
}

function location(primaryPath: string | null, pathWithheld: string): string {
  if (primaryPath === null) return "—";
  if (!isRepositoryRelativePath(primaryPath)) return pathWithheld;
  return `\`${codeText(primaryPath, CELL_LIMIT)}\``;
}

function severitySummary(
  findings: readonly GateFindingDelta[],
  copy: (typeof PR_COMMENT_COPY)[GuardrailPrCommentLocale],
  input: RenderPrCommentInput,
): string {
  if (findings.length === 0) return `0 ${copy.none}`.trim();
  const counts = SEVERITY_ORDER
    .map((severity) => ({ severity, count: findings.filter((f) => f.severity === severity).length }))
    .filter((entry) => entry.count > 0)
    .map((entry) => `${severityCell(entry.severity, copy, input)} ${entry.count}`);
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
  return /^[0-9a-f]{7,}$/i.test(value) ? value.slice(0, 7) : codeText(value, 40);
}

function compareFindings(left: GateFindingDelta, right: GateFindingDelta): number {
  return SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity]
    || left.title.localeCompare(right.title)
    || left.identity.localeCompare(right.identity);
}

/**
 * Every piece of scanner text that reaches a public comment starts here: the
 * gate-core public-text redaction (no secrets, no host paths), then the escaping
 * a markdown table needs, then a length.
 *
 * `<!--` and `-->` are removed rather than escaped — a finding title must never
 * be able to forge or close Sentinel's own marker — and so are the bidi and
 * isolate controls, which can make a cell read as the reverse of what it says.
 *
 * This is the form safe inside a code span, where markdown does not parse. Plain
 * text goes through `cell`, which neutralises markdown on top of it.
 */
function codeText(value: string, limit: number): string {
  // `\|` is needed even inside a code span: a raw pipe ends the table cell first.
  let text = redactPublicText(value)
    .replaceAll("|", "\\|")
    .replaceAll("`", "'")
    .replaceAll("<!--", "")
    .replaceAll("-->", "")
    .replace(BIDI_CONTROLS, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length > limit) text = `${text.slice(0, limit - 1).trimEnd()}…`;
  // Truncation must not leave a dangling escape that would eat the next character.
  return text.replace(/\\+$/, "");
}

/**
 * Scanner text rendered as prose. On top of `codeText` it closes every way a
 * finding title could speak in Sentinel's voice:
 *
 * - `&`, `<`, `>` escaped, so GitHub's markdown-embedded HTML cannot start;
 * - `[`, `]`, `(`, `)` and `!` escaped, so no link and no image can form — a
 *   counterfeit verdict pill beside the real one is the worst outcome here;
 * - `@name` and `#123`/`GH-123` broken by a zero-width joiner, so re-rendering
 *   the comment on every commit cannot notify people or cross-link other threads.
 *
 * The joiner is invisible and carries no direction, so what the reader sees is
 * exactly the text the scanner wrote.
 */
function cell(value: string, limit: number): string {
  return codeText(value, limit)
    // One pass over the three characters that can change the meaning of GitHub's
    // markdown-embedded HTML. Nothing here keeps any markup, so escaping is the
    // whole job and a sanitizer — which exists to keep some — is the wrong tool.
    .replace(/[&<>]/g, (character) => MARKDOWN_ENTITIES[character] ?? character)
    .replace(/[[\]()!]/g, (character) => `\\${character}`)
    .replace(/@(?=[A-Za-z0-9])/g, `@${JOINER}`)
    .replace(/#(?=\d)/g, `#${JOINER}`)
    .replace(/\bGH(?=-\d)/g, `GH${JOINER}`);
}
