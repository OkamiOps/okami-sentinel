import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizeOpengrep } from "../sast/opengrep.js";
import { createPortableCodexSecurityDossier } from "./portable-codex-security-dossier.js";
import { addPortableSastCandidates, planPortableSastTriage, PORTABLE_SAST_REVIEW_LIMIT } from "./portable-sast-triage.js";

test("SAST triage ranks static matches deterministically, bounds review work, and preserves raw alerts", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "portable-sast-triage-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "tests"));
  for (const name of ["index.ts", "tests/index.ts"]) fs.writeFileSync(path.join(root, name), "const marker = true;\n".repeat(12));
  const match = (name: string, line: number, severity: string) => ({
    check_id: "test-marker", path: name, start: { line }, end: { line },
    extra: { severity, message: "Untrusted scanner text that must not enter the model prompt" },
  });
  const findings = normalizeOpengrep({ results: [
    ...Array.from({ length: 10 }, (_, i) => match("index.ts", i + 1, "INFO")),
    match("tests/index.ts", 1, "ERROR"), match("index.ts", 11, "ERROR"),
    match("tests/index.ts", 2, "CRITICAL"), match("index.ts", 99, "CRITICAL"),
  ] }, root);
  const original = structuredClone(findings);
  const plan = planPortableSastTriage(findings, root);
  assert.deepEqual(plan, planPortableSastTriage([...findings].reverse(), root));
  assert.equal(plan.total, findings.length);
  assert.equal(plan.queued.length, PORTABLE_SAST_REVIEW_LIMIT);
  assert.deepEqual(plan.queued.slice(0, 3).map(entry => [entry.severity, entry.scope, entry.startLine]), [
    ["critical", "supporting", 2], ["high", "runtime", 11], ["high", "supporting", 1],
  ]);
  assert.deepEqual(plan.queued.slice(3).map(entry => entry.startLine), [1, 2, 3, 4, 5]);
  const base = { ...createPortableCodexSecurityDossier(), candidates: [{
    id: "business-logic", category: "authorization", anchors: [{ path: "index.ts", startLine: 1, endLine: 1, role: "control" as const }],
  }] };
  const augmented = addPortableSastCandidates(base, plan);
  assert.deepEqual(augmented.candidates.map(candidate => candidate.id), [...plan.queued.map(entry => entry.findingId), "business-logic"]);
  assert.doesNotMatch(JSON.stringify(augmented), /Untrusted scanner text/);
  assert.deepEqual(findings, original);
  assert.equal(addPortableSastCandidates(base, null), base);
});
