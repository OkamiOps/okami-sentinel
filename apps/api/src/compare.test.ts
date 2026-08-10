import assert from "node:assert/strict";
import test from "node:test";
import type { FindingSummary, Severity } from "@csb/shared";
import { buildFindingDiff, compareScans } from "./compare.js";

function finding(id: string, severity: Severity): FindingSummary {
  return {
    findingId: id,
    occurrenceId: null,
    title: `Finding ${id}`,
    severity,
    confidence: "high",
    ruleId: `rule-${id}`,
    summary: `Summary ${id}`,
    primaryPath: `src/${id}.ts`,
    fingerprints: [id],
    category: "test",
    cwe: ["CWE-79"],
  };
}

function scannerFinding(input: {
  id: string;
  title: string;
  cwe: string;
  path: string;
  line: number;
  fingerprint: string;
}): FindingSummary & { locations: unknown[] } {
  return {
    ...finding(input.id, "high"),
    title: input.title,
    ruleId: input.id.startsWith("mantis") ? `mantis/${input.cwe}` : input.cwe,
    primaryPath: input.path,
    fingerprints: [input.fingerprint],
    cwe: [input.cwe],
    locations: [{ path: input.path, startLine: input.line, endLine: input.line }],
  };
}

test("reports observed coverage without claiming that an absent finding was resolved", () => {
  const result = buildFindingDiff(
    "baseline",
    "candidate",
    new Map([
      ["baseline", [finding("baseline-only", "high"), finding("changed", "medium"), finding("same", "low")]],
      ["candidate", [finding("candidate-only", "critical"), finding("changed", "high"), finding("same", "low")]],
    ]),
  );

  assert.deepEqual(result.counts, {
    candidate_only: 1,
    baseline_only: 1,
    both: 1,
    severity_changed: 1,
  });
  assert.deepEqual(result.findings.map((item) => item.change), [
    "candidate_only",
    "severity_changed",
    "baseline_only",
    "both",
  ]);
  assert.equal(result.findings[0].candidate?.primaryPath, "src/candidate-only.ts");
  assert.equal(result.findings[2].candidate, null);
  assert.equal(result.findings[2].baseline?.primaryPath, "src/baseline-only.ts");
  assert.equal(result.findings[1].baseline?.severity, "medium");
  assert.equal(result.findings[1].candidate?.severity, "high");
});

test("accepts up to six scan slots before resolving their ids", () => {
  assert.throws(
    () => compareScans(Array.from({ length: 7 }, (_, index) => `missing-${index}`)),
    /Selecione de 2 a 6 scans/,
  );
  assert.throws(
    () => compareScans(Array.from({ length: 6 }, (_, index) => `missing-${index}`)),
    /Scan não encontrado: missing-0/,
  );
});

test("matches the same vulnerability across scanners by CWE and exact evidence location", () => {
  const codex = scannerFinding({
    id: "codex-login-sqli",
    title: "Public login SQL injection permits authentication and role bypass",
    cwe: "CWE-89",
    path: "routes/login.ts",
    line: 34,
    fingerprint: "codex-security/v1:sha256:codex-only",
  });
  const mantis = scannerFinding({
    id: "mantis-login-sqli",
    title: "SQL injection in login query",
    cwe: "CWE-89",
    path: "routes/login.ts",
    line: 34,
    fingerprint: "mantis-only-signature",
  });

  const result = buildFindingDiff(
    "codex",
    "mantis",
    new Map([["codex", [codex]], ["mantis", [mantis]]]),
  );

  assert.deepEqual(result.counts, {
    candidate_only: 0,
    baseline_only: 0,
    both: 1,
    severity_changed: 0,
  });
  assert.equal(result.findings[0]?.baseline?.findingId, "codex-login-sqli");
  assert.equal(result.findings[0]?.candidate?.findingId, "mantis-login-sqli");
});

test("does not merge unrelated findings that merely share a CWE and file", () => {
  const first = scannerFinding({
    id: "codex-first-xss",
    title: "Stored product description executes in the browser",
    cwe: "CWE-79",
    path: "server.ts",
    line: 120,
    fingerprint: "codex-security/v1:sha256:first",
  });
  const second = scannerFinding({
    id: "mantis-second-xss",
    title: "Registration email reaches trusted administration HTML",
    cwe: "CWE-79",
    path: "server.ts",
    line: 640,
    fingerprint: "mantis-second",
  });

  const result = buildFindingDiff(
    "codex",
    "mantis",
    new Map([["codex", [first]], ["mantis", [second]]]),
  );

  assert.equal(result.counts.both, 0);
  assert.equal(result.counts.baseline_only, 1);
  assert.equal(result.counts.candidate_only, 1);
});

test("keeps duplicate partial findings addressable without reusing response keys", () => {
  const first = finding("partial-a", "high");
  const second = finding("partial-b", "high");
  first.fingerprints = ["shared-partial-fingerprint"];
  second.fingerprints = ["shared-partial-fingerprint"];

  const result = buildFindingDiff(
    "partial",
    "empty",
    new Map([["partial", [first, second]], ["empty", []]]),
  );

  assert.equal(result.findings.length, 2);
  assert.equal(new Set(result.findings.map((item) => item.key)).size, 2);
});
