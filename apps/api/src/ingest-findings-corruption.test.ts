import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { FindingDetail } from "@csb/shared";

import { readFindingsFile, toFindingSummaries } from "./ingest.js";

function tempScanDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("readFindingsFile returns no findings when the file was never created", () => {
  const scanDir = tempScanDir("csb-findings-missing-");
  try {
    assert.deepEqual(readFindingsFile(scanDir), []);
  } finally {
    fs.rmSync(scanDir, { recursive: true, force: true });
  }
});

test("readFindingsFile throws scan_findings_unreadable when the file stays invalid JSON after recovery", () => {
  const scanDir = tempScanDir("csb-findings-badjson-");
  try {
    // No findings/ dir and no Codex sessions exist, so markdown recovery can't
    // repair or replace this file — it must be left corrupt on disk.
    fs.writeFileSync(path.join(scanDir, "findings.json"), "{not-json");
    assert.throws(
      () => readFindingsFile(scanDir, path.join(scanDir, "no-sessions")),
      /^Error: scan_findings_unreadable$/,
    );
  } finally {
    fs.rmSync(scanDir, { recursive: true, force: true });
  }
});

test("readFindingsFile throws scan_findings_unreadable when findings is not an array", () => {
  const scanDir = tempScanDir("csb-findings-notarray-");
  try {
    fs.writeFileSync(
      path.join(scanDir, "findings.json"),
      JSON.stringify({ findings: { oops: "not a list" } }),
    );
    assert.throws(
      () => readFindingsFile(scanDir, path.join(scanDir, "no-sessions")),
      /^Error: scan_findings_unreadable$/,
    );
  } finally {
    fs.rmSync(scanDir, { recursive: true, force: true });
  }
});

test("readFindingsFile throws scan_findings_unreadable when the document root is null", () => {
  const scanDir = tempScanDir("csb-findings-null-");
  try {
    fs.writeFileSync(path.join(scanDir, "findings.json"), "null");
    assert.throws(
      () => readFindingsFile(scanDir, path.join(scanDir, "no-sessions")),
      /^Error: scan_findings_unreadable$/,
    );
  } finally {
    fs.rmSync(scanDir, { recursive: true, force: true });
  }
});

test("readFindingsFile skips null and non-object entries in an otherwise valid findings array", () => {
  const scanDir = tempScanDir("csb-findings-mixed-entries-");
  try {
    fs.writeFileSync(
      path.join(scanDir, "findings.json"),
      JSON.stringify({
        findings: [
          null,
          "not-an-object",
          42,
          ["nested", "array"],
          { findingId: "real-1", title: "Real finding" },
        ],
      }),
    );
    const findings = readFindingsFile(scanDir, path.join(scanDir, "no-sessions"));
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.findingId, "real-1");
  } finally {
    fs.rmSync(scanDir, { recursive: true, force: true });
  }
});

function baseDetail(overrides: Partial<FindingDetail>): FindingDetail {
  return {
    findingId: "finding-1",
    occurrenceId: null,
    title: "A finding",
    severity: "high",
    confidence: null,
    ruleId: null,
    summary: null,
    primaryPath: null,
    fingerprints: [],
    category: null,
    cwe: [],
    attackPath: null,
    attackPathModel: null,
    codeEvidence: [],
    remediation: null,
    locations: null,
    taxonomy: null,
    rootCause: null,
    validation: null,
    preventiveControls: null,
    remediationTests: null,
    severityRationale: null,
    confidenceRationale: null,
    ...overrides,
  };
}

test("toFindingSummaries normalizes blank optional strings to null", () => {
  const [summary] = toFindingSummaries([
    baseDetail({
      occurrenceId: "  ",
      confidence: "  ",
      ruleId: "",
      summary: "   ",
      primaryPath: "",
      category: "  ",
    }),
  ]);
  assert.equal(summary?.occurrenceId, null);
  assert.equal(summary?.confidence, null);
  assert.equal(summary?.ruleId, null);
  assert.equal(summary?.summary, null);
  assert.equal(summary?.primaryPath, null);
  assert.equal(summary?.category, null);
});

test("toFindingSummaries trims populated optional strings", () => {
  const [summary] = toFindingSummaries([
    baseDetail({
      occurrenceId: "  occ-1  ",
      confidence: " high ",
      ruleId: " rule/1 ",
      summary: "  Some summary  ",
      primaryPath: "  src/a.ts  ",
      category: "  Injection  ",
    }),
  ]);
  assert.equal(summary?.occurrenceId, "occ-1");
  assert.equal(summary?.confidence, "high");
  assert.equal(summary?.ruleId, "rule/1");
  assert.equal(summary?.summary, "Some summary");
  assert.equal(summary?.primaryPath, "src/a.ts");
  assert.equal(summary?.category, "Injection");
});

test("toFindingSummaries drops empty fingerprint and cwe entries", () => {
  const [summary] = toFindingSummaries([
    baseDetail({
      fingerprints: ["  ", "fp-1", "", "  fp-2  "],
      cwe: ["", "CWE-89", "   "],
    }),
  ]);
  assert.deepEqual(summary?.fingerprints, ["fp-1", "fp-2"]);
  assert.deepEqual(summary?.cwe, ["CWE-89"]);
});

test("toFindingSummaries falls back to findingId when title is blank", () => {
  const [summary] = toFindingSummaries([
    baseDetail({ findingId: "finding-42", title: "   " }),
  ]);
  assert.equal(summary?.title, "finding-42");
});
