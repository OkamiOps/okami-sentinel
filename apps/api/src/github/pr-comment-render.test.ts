import assert from "node:assert/strict";
import test from "node:test";

import { buildGateArtifactV2, buildScanLineage, defaultGuardrailPolicy } from "@csb/gate-core";
import type {
  GateArtifactV2,
  GateBaselineNotice,
  GateFindingDelta,
  GateOutcome,
  GitHubConclusion,
  GuardrailPrCommentLocale,
  Severity,
} from "@csb/shared";

import {
  isSentinelComment,
  prCommentMarker,
  PR_COMMENT_BUDGET,
  PR_COMMENT_MARKER_PREFIX,
  PR_COMMENT_MAX_ROWS,
  renderPrComment,
  type RenderPrCommentInput,
} from "./pr-comment-render.js";

const REPOSITORY_KEY = "github:991122";

function finding(
  severity: Severity,
  title: string,
  primaryPath: string | null,
  lifecycle: GateFindingDelta["lifecycle"] = "new",
  identity = `sha256:${title.length.toString().padStart(2, "0")}${severity}${primaryPath ?? "none"}`,
): GateFindingDelta {
  return {
    findingId: identity,
    occurrenceId: null,
    identity,
    title,
    severity,
    confidence: "high",
    ruleId: "CSB-1",
    summary: title,
    primaryPath,
    fingerprints: [identity],
    category: "authorization",
    cwe: ["CWE-862"],
    lifecycle,
    triage: { status: "confirmed", note: null, updatedAt: null },
    exception: null,
    sourceScanId: "scan-1",
  };
}

function critical(title: string, primaryPath: string | null): GateFindingDelta {
  return finding("critical", title, primaryPath);
}

function manyFindings(count: number): GateFindingDelta[] {
  return Array.from({ length: count }, (_, index) => finding(
    "high",
    `Finding number ${index} with a reasonably long descriptive title`,
    `src/module-${index}/handler.ts:${index + 1}`,
    "new",
    `sha256:${index.toString().padStart(64, "0")}`,
  ));
}

const CONCLUSION: Record<GateOutcome, GitHubConclusion> = {
  blocked: "failure",
  warning: "neutral",
  pass: "success",
  bootstrap: "neutral",
  no_changes: "success",
  error: "action_required",
};

function artifactOf(options: {
  outcome?: GateOutcome;
  summary?: string;
  newFindings?: GateFindingDelta[];
  fixed?: number;
  baselineCommit?: string | null;
  baselineNotice?: GateBaselineNotice | null;
  empty?: boolean;
} = {}): GateArtifactV2 {
  const outcome = options.outcome ?? "blocked";
  const newFindings = options.newFindings ?? [critical("Command injection in the deploy hook", "scripts/deploy.ts:88")];
  const fixed = Array.from({ length: options.fixed ?? 0 }, (_, index) => finding(
    "medium",
    `Fixed finding ${index}`,
    `src/fixed-${index}.ts:3`,
    "fixed",
    `sha256:f${index.toString().padStart(63, "0")}`,
  ));
  const baselineCommit = options.baselineCommit === undefined ? "a".repeat(40) : options.baselineCommit;
  return buildGateArtifactV2({
    gateId: "gate-pr-1",
    repository: {
      id: "github:991122",
      key: REPOSITORY_KEY,
      owner: "OkamiOps",
      name: "private-sentinel",
      defaultBranch: "main",
      locator: { kind: "github", repositoryId: "991122", owner: "OkamiOps", name: "private-sentinel" },
    },
    source: "github",
    executor: "sentinel-managed",
    target: { kind: "pull_request", number: 7 },
    resolvedTarget: {
      baseRef: "main",
      headRef: "refs/pull/7/head",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      policySha: "a".repeat(40),
      pullRequestNumber: 7,
    },
    policySource: "base",
    baselineNotice: options.baselineNotice ?? null,
    changeSet: {
      baseRef: "main",
      headRef: "refs/pull/7/head",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      files: options.empty === true
        ? []
        : [{ status: "modified", path: "src/report.ts", previousPath: null, additions: null, deletions: null }],
      scanPaths: options.empty === true ? [] : ["src/report.ts"],
      scopeMode: "changed",
      fallbackReason: null,
    },
    policy: defaultGuardrailPolicy(),
    scan: outcome === "no_changes"
      ? { id: null, cost: null, status: "not_run" }
      : {
        id: "scan-1",
        cost: {
          estimatedUsd: 0.42,
          inputTokens: 10,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          outputTokens: 5,
        },
        status: "completed",
      },
    baselineCommit,
    evaluation: {
      deltas: [...newFindings, ...fixed],
      decision: {
        outcome,
        summary: options.summary ?? "One blocking policy violation.",
        violations: outcome === "blocked"
          ? newFindings
            .filter((f) => f.severity === "critical" || f.severity === "high")
            .map((f) => ({
              findingIdentity: f.identity,
              ruleIndex: f.severity === "critical" ? 0 : 1,
              decision: "block" as const,
              reason: `${f.severity}/${f.lifecycle}`,
            }))
          : [],
        warnings: outcome === "warning"
          ? newFindings
            .filter((f) => f.severity === "high" && f.lifecycle === "persistent")
            .map((f) => ({
              findingIdentity: f.identity,
              ruleIndex: 2,
              decision: "review" as const,
              reason: "high/persistent",
            }))
          : [],
        exceptionsApplied: [],
        githubConclusion: CONCLUSION[outcome],
      },
    },
    lineage: buildScanLineage({
      engine: "codex-security",
      engineVersion: "portable-v1",
      route: "minimax-token-plan",
      protocol: "anthropic-messages",
      provider: "minimax",
      model: "MiniMax-M3",
      reasoningEffort: "provider-managed",
      methodology: "sentinel/codex-security-methodology@v1",
      profile: "portable-v1",
      recipeHash: `sha256:${"d".repeat(64)}`,
      sourceRevision: `sha256:${"e".repeat(64)}`,
    }),
    coverage: {
      status: "complete",
      repositoryFileCount: 1,
      inspectedFileCount: 1,
      unexaminedFileCount: 0,
      submodules: [],
      lfsPointers: [],
    },
    snapshot: { identity: `sha256:${"c".repeat(64)}`, materializerVersion: "github-archive-v1" },
    workflowRun: null,
    versions: { gateCore: "0.2.0", scanner: "portable-v1" },
    createdAt: "2026-08-12T12:00:00.000Z",
  });
}

type InputOptions = NonNullable<Parameters<typeof artifactOf>[0]>;

function input(
  options: InputOptions & {
    locale?: GuardrailPrCommentLocale;
    gateUrl?: string | null;
    assets?: boolean;
    durationMs?: number | null;
    /**
     * Findings the artifact validator itself would refuse — a secret, a host path.
     * They are written onto a valid artifact after it is built, because the renderer
     * must not trust its input even where the validator already does the work.
     */
    unsafeFindings?: GateFindingDelta[];
  } = {},
): RenderPrCommentInput {
  const artifact = artifactOf(options);
  if (options.unsafeFindings !== undefined) {
    (artifact as { findings: GateFindingDelta[] }).findings = options.unsafeFindings;
  }
  return {
    artifact,
    repositoryKey: REPOSITORY_KEY,
    locale: options.locale ?? "en",
    gateUrl: options.gateUrl === undefined ? "https://sentinel.example/guardrails/gate-pr-1" : options.gateUrl,
    assetUrl: (fileName) => options.assets === false
      ? null
      : `https://sentinel.example/brand/${fileName}`,
    findingUrl: (identity) => options.gateUrl === null
      ? null
      : `https://sentinel.example/guardrails/gate-pr-1?node=${encodeURIComponent(identity)}`,
    durationMs: options.durationMs === undefined ? 192_000 : options.durationMs,
  };
}

/** A finding row starts with its severity marker; the summary table never does. */
function findingRows(body: string): string[] {
  return body.split("\n").filter((line) => /^\| !\[[^\]]+\]\(\S*pr-severity-/.test(line));
}

test("renders the blocked verdict with counts, baseline, cost and table", () => {
  const { body } = renderPrComment(input({ outcome: "blocked", fixed: 3 }));
  assert.ok(body.startsWith(`${PR_COMMENT_MARKER_PREFIX}${REPOSITORY_KEY} -->`));
  assert.ok(isSentinelComment(body, REPOSITORY_KEY));
  assert.match(body, /## Okami Sentinel — BLOCKED/);
  assert.match(body, /\| \*\*Fixed by this PR\*\* \| 3 \|/);
  assert.match(body, /\| Summary \| Value \|/);
  assert.ok(!body.includes("| | |"), "the summary table has a real header");
  assert.match(body, /\| \*\*New findings\*\* \| 1 — !\[Critical\]\(\S+pr-severity-critical\.png\) Critical 1 \|/);
  assert.match(body, /!\[BLOCKED\]\(https:\/\/sentinel\.example\/brand\/pr-verdict-blocked\.png\)/);
  assert.match(body, /`scripts\/deploy\.ts:88`/);
  assert.match(body, /\| \*\*Cost\*\* \| US\$ 0\.42 \|/);
  assert.match(body, /\| \*\*Duration\*\* \| 3m 12s \|/);
  assert.match(body, /This check is informational/);
  assert.match(body, /!\[Okami Sentinel\]\(https:\/\/sentinel\.example\/brand\/pr-comment-banner\.png\)/);
  assert.match(body, /\[View the full gate in Sentinel\]\(https:\/\/sentinel\.example\/guardrails\/gate-pr-1\)/);
  assert.ok(body.length <= 65_536);
});

test("renders every verdict word", () => {
  const cases: Array<[GateOutcome, string, Parameters<typeof input>[0]]> = [
    ["blocked", "BLOCKED", {}],
    ["warning", "WARNING", {
      newFindings: [finding("high", "Persistent high", "src/a.ts:1", "persistent")],
    }],
    ["pass", "APPROVED", { newFindings: [] }],
    ["bootstrap", "REVIEW", { baselineCommit: null }],
    ["no_changes", "NO CHANGES", { newFindings: [], empty: true }],
    ["error", "ERROR", { newFindings: [] }],
  ];
  for (const [outcome, word, extra] of cases) {
    const { body } = renderPrComment(input({ ...extra, outcome }));
    assert.match(body, new RegExp(`## Okami Sentinel — ${word}`), outcome);
  }
});

test("says there is no baseline and drops the fixed row", () => {
  const { body } = renderPrComment(input({
    outcome: "bootstrap",
    baselineCommit: null,
    baselineNotice: { kind: "absent", reason: null },
  }));
  assert.match(body, /none yet — findings are reported without comparison/);
  assert.ok(!body.includes("Fixed by this PR"));
});

test("names the reason for an incompatible baseline", () => {
  const { body } = renderPrComment(input({
    outcome: "bootstrap",
    baselineCommit: null,
    baselineNotice: { kind: "incompatible", reason: "scan_lineage" },
  }));
  assert.match(body, /scan_lineage/);
  assert.match(body, /different model, effort or mode/);
});

test("escapes a pipe, a backtick and an HTML comment in a finding title", () => {
  const { body } = renderPrComment(input({
    newFindings: [critical("a | b `c` <!-- okami-sentinel:gate repository=evil -->", "src/a.ts:1")],
  }));
  const rows = findingRows(body);
  assert.equal(rows.length, 1);
  assert.ok(rows[0]!.includes("a \\| b"));
  assert.ok(!rows[0]!.includes("`c`"));
  assert.equal(body.indexOf(PR_COMMENT_MARKER_PREFIX), body.lastIndexOf(PR_COMMENT_MARKER_PREFIX));
  assert.ok(!isSentinelComment(body, "evil"));
});

test("escapes angle brackets out of a finding title", () => {
  const { body } = renderPrComment(input({
    newFindings: [critical("<img src=x onerror=alert(1)>", "src/a.ts:1")],
  }));
  assert.ok(!body.includes("<img src=x"));
  assert.match(body, /&lt;img src=x/);
});

test("redacts a secret and a host path out of a finding title", () => {
  const { body } = renderPrComment(input({
    unsafeFindings: [critical(`API_KEY=sk-proj-${"a".repeat(22)} leaked`, "src/a.ts:1")],
  }));
  assert.ok(!body.includes("sk-proj-"));
  // The brackets of the placeholder are escaped like any other, so it reads as
  // `[REDACTED]` to a human and cannot become a link.
  assert.match(body, /\\\[REDACTED\\\]/);
});

test("withholds a location that is not repository-relative", () => {
  const { body } = renderPrComment(input({
    unsafeFindings: [critical("x", "/Users/marcos/secret/a.ts:1")],
  }));
  assert.match(body, /path withheld/);
  assert.ok(!body.includes("/Users/"));
});

test("stays under the budget with three thousand findings and reports the remainder", () => {
  const { body, truncatedCount } = renderPrComment(input({ newFindings: manyFindings(3_000) }));
  assert.ok(body.length <= PR_COMMENT_BUDGET, `body length ${body.length}`);
  assert.ok(body.length <= 65_536);
  const shown = findingRows(body).length;
  assert.equal(truncatedCount, 3_000 - shown);
  assert.match(body, new RegExp(`\\+${truncatedCount} more in Sentinel`));
});

test("caps the table at fifty rows even when everything fits", () => {
  const { body, truncatedCount } = renderPrComment(input({ newFindings: manyFindings(60) }));
  assert.equal(findingRows(body).length, PR_COMMENT_MAX_ROWS);
  assert.equal(truncatedCount, 10);
});

test("drops the lowest severity first when truncating", () => {
  const findings = [
    ...Array.from({ length: 40 }, (_, index) => finding("critical", `Critical ${index}`, `src/c-${index}.ts:1`)),
    ...Array.from({ length: 20 }, (_, index) => finding("low", `Low ${index}`, `src/l-${index}.ts:1`)),
  ];
  const { body } = renderPrComment(input({ newFindings: findings }));
  const rows = findingRows(body);
  assert.equal(rows.length, PR_COMMENT_MAX_ROWS);
  assert.equal(rows.filter((row) => row.includes("pr-severity-critical.png")).length, 40);
  assert.equal(rows.filter((row) => row.includes("pr-severity-low.png")).length, 10);
});

test("degrades to banner, verdict and link when even the header exceeds the budget", () => {
  const { body, truncatedCount } = renderPrComment(input({ summary: "x".repeat(60_000) }));
  assert.ok(body.length <= PR_COMMENT_BUDGET, `body length ${body.length}`);
  assert.ok(body.startsWith(prCommentMarker(REPOSITORY_KEY)));
  assert.match(body, /## Okami Sentinel — BLOCKED/);
  assert.match(body, /\[View the full gate in Sentinel\]/);
  assert.equal(findingRows(body).length, 0);
  assert.equal(truncatedCount, 1);
});

test("omits the banner, the badges and the links with no public origin", () => {
  const { body } = renderPrComment(input({ gateUrl: null, assets: false }));
  assert.ok(!/https?:\/\//.test(body), body);
  assert.ok(!body.includes("!["), body);
  // The verdict and every severity still read, in words.
  assert.match(body, /## Okami Sentinel — BLOCKED/);
  assert.match(body, /\| Critical \| Command injection/);
});

test("writes the comment in each of the five locales", () => {
  const verdicts: Record<GuardrailPrCommentLocale, string> = {
    "pt-BR": "BLOQUEADO",
    en: "BLOCKED",
    es: "BLOQUEADO",
    de: "BLOCKIERT",
    fr: "BLOQUÉ",
  };
  for (const [locale, verdict] of Object.entries(verdicts) as [GuardrailPrCommentLocale, string][]) {
    const { body } = renderPrComment(input({ locale }));
    assert.match(body, new RegExp(`## Okami Sentinel — ${verdict}`), locale);
  }
  const ptBR = renderPrComment(input({ locale: "pt-BR", newFindings: manyFindings(60) }));
  assert.match(ptBR.body, /\+10 mais no Sentinel/);
  assert.match(ptBR.body, /\| Resumo \| Valor \|/);
  // The pill carries no words, so the localised verdict is its alt text.
  assert.match(ptBR.body, /!\[BLOQUEADO\]\(\S+pr-verdict-blocked\.png\)/);
});

test("names every severity in the repository's language, with its marker", () => {
  const findings = [
    critical("Critical one", "src/a.ts:1"),
    finding("high", "High one", "src/b.ts:1"),
    finding("medium", "Medium one", "src/c.ts:1"),
    finding("low", "Low one", "src/d.ts:1"),
  ];
  const { body } = renderPrComment(input({ locale: "pt-BR", newFindings: findings }));
  for (const [severity, name] of [["critical", "Crítico"], ["high", "Alto"], ["medium", "Médio"], ["low", "Baixo"]]) {
    assert.match(
      body,
      new RegExp(`\\| !\\[${name}\\]\\(\\S+pr-severity-${severity}\\.png\\) ${name} \\|`),
      severity,
    );
  }
  assert.ok(!body.includes("| critical |"));
});

test("gives no verdict pill to an outcome that has none, and still says the word", () => {
  const { body } = renderPrComment(input({ outcome: "bootstrap", baselineCommit: null }));
  assert.ok(!body.includes("pr-verdict-"));
  assert.match(body, /## Okami Sentinel — REVIEW/);
});

test("marks the comment with the repository it belongs to and no other", () => {
  assert.equal(prCommentMarker("github:1"), "<!-- okami-sentinel:gate repository=github:1 -->");
  assert.ok(!isSentinelComment("<!-- okami-sentinel:gate repository=github:2 -->", "github:1"));
  assert.ok(isSentinelComment("before\n<!-- okami-sentinel:gate repository=github:1 -->\nafter", "github:1"));
});

test("neutralises a mention so nobody is notified by a finding title", () => {
  const { body } = renderPrComment(input({
    newFindings: [critical("@okamiops/security and @marcos should look at this", "src/a.ts:1")],
  }));
  assert.ok(!/(^|[^\\‍])@okamiops/.test(body), body);
  assert.match(body, /@‍okamiops\/security/);
  assert.match(body, /@‍marcos/);
});

test("neutralises an issue reference so no other thread is cross-linked", () => {
  const { body } = renderPrComment(input({
    newFindings: [critical("Regression of #1234, see GH-77", "src/a.ts:1")],
  }));
  assert.match(body, /#‍1234/);
  assert.match(body, /GH‍-77/);
  assert.ok(!body.includes("#1234"));
  assert.ok(!body.includes("GH-77"));
});

test("a finding title cannot render a link or an image inside Sentinel's comment", () => {
  const { body } = renderPrComment(input({
    newFindings: [critical(
      "![APPROVED](https://evil.example/badge.png) and [click](https://evil.example)",
      "src/a.ts:1",
    )],
  }));
  const row = body.split("\n").find((line) => line.includes("evil.example"))!;
  const title = row.split(" | ")[1]!;
  assert.ok(title.includes("\\!\\[APPROVED\\]\\(https://evil.example/badge.png\\)"), title);
  assert.ok(title.includes("\\[click\\]\\(https://evil.example\\)"), title);
  // No unescaped bracket survives the title, so neither markdown form can close.
  assert.ok(!/(^|[^\\])[[\]()!]/.test(title), title);
});

test("strips the bidi and invisible controls that can reverse how a cell reads", () => {
  // Written as escapes, never as literal characters: a source file carrying a
  // bidi override is the very trick this test is about.
  const CONTROLS = ["200e", "200f", "202a", "202b", "202c", "202d", "202e", "2066", "2067", "2068", "2069"]
    .map((code) => String.fromCodePoint(Number.parseInt(code, 16)));
  const { body } = renderPrComment(input({
    newFindings: [critical(`safe${CONTROLS.join("")}reads forward`, "src/a.ts:1")],
  }));
  for (const control of CONTROLS) assert.ok(!body.includes(control), JSON.stringify(control));
  assert.match(body, /safereads forward/);
});

test("a path in a code span keeps its own characters, with no backslashes added", () => {
  const { body } = renderPrComment(input({
    newFindings: [critical("x", "src/(group)/a!b.ts:1")],
  }));
  // Markdown does not parse inside a code span, so escaping there would only
  // print backslashes at the reader.
  assert.match(body, /`src\/\(group\)\/a!b\.ts:1`/);
});
