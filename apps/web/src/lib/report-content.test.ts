import assert from "node:assert/strict";
import test from "node:test";
import { normalizeReportText, reportEvidenceBlocks, reportExcerpt, REPORT_TRUNCATION_MARKER } from "./report-content";

test("bounds a long unbroken token without mutating the source", () => {
  const source = "A".repeat(8_192);
  const excerpt = reportExcerpt(source, { maxChars: 240, maxLines: 4 });
  assert.equal(source.length, 8_192);
  assert.equal(excerpt.truncated, true);
  assert.match(excerpt.text, new RegExp(REPORT_TRUNCATION_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.ok(excerpt.text.length < 400);
});

test("normalizes literal and actual line endings in PEM-like evidence", () => {
  const source = "BEGIN\\r\\nABCDEF\\nEND\r\nTAIL";
  assert.equal(normalizeReportText(source), "BEGIN\nABCDEF\nEND\nTAIL");
});

test("projects structured evidence into bounded printable blocks", () => {
  const source = [{ id: "evidence-1", path: "lib/security.ts", startLine: 18, endLine: 24, role: "source", explanation: "why", code: "x".repeat(2_000) }];
  const projected = reportEvidenceBlocks(source);
  assert.equal(projected.hidden, 0);
  assert.equal(projected.blocks[0]?.path, "lib/security.ts:18–24");
  assert.equal(projected.blocks[0]?.code.truncated, true);
  assert.equal((source[0]?.code ?? "").length, 2_000);
});
