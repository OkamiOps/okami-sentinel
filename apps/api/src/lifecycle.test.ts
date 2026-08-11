import assert from "node:assert/strict";
import test from "node:test";
import { findingIdentity as coreFindingIdentity } from "@csb/gate-core";
import type { FindingSummary } from "@csb/shared";
import {
  classifyCurrentFinding,
  findingIdentity,
  isRemovableScanStatus,
  normalizeRepositoryKey,
} from "./lifecycle.js";

const finding: FindingSummary = {
  findingId: "run-specific-id",
  occurrenceId: null,
  title: "Stored XSS",
  severity: "high",
  confidence: "high",
  ruleId: "CWE-79",
  summary: null,
  primaryPath: "src/report.ts:88",
  fingerprints: ["codex-security/v1", "codex-security/v1:sha256:stable-fingerprint", "run-specific-id"],
  category: "Stored cross-site scripting",
  cwe: ["CWE-79"],
};

test("uses a stable fingerprint before run-specific ids", () => {
  assert.equal(findingIdentity, coreFindingIdentity);
  assert.equal(findingIdentity(finding), "fp:codex-security/v1:sha256:stable-fingerprint");
});

test("classifies persisting, regressed and new signals", () => {
  const key = findingIdentity(finding);
  assert.equal(classifyCurrentFinding(key, new Set([key]), new Set()), "persisting");
  assert.equal(classifyCurrentFinding(key, new Set(), new Set([key])), "regressed");
  assert.equal(classifyCurrentFinding(key, new Set(), new Set()), "new");
});

test("normalizes repository keys across trailing separators", () => {
  assert.equal(normalizeRepositoryKey("/work/repo///"), "/work/repo");
  assert.equal(normalizeRepositoryKey("C:\\work\\repo\\"), "C:/work/repo");
});

test("allows ledger removal for every terminal scan and blocks live work", () => {
  assert.equal(isRemovableScanStatus("completed"), true);
  assert.equal(isRemovableScanStatus("failed"), true);
  assert.equal(isRemovableScanStatus("cancelled"), true);
  assert.equal(isRemovableScanStatus("incomplete"), true);
  assert.equal(isRemovableScanStatus("queued"), false);
  assert.equal(isRemovableScanStatus("running"), false);
});
