import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { FrozenScannerPricing } from "../model-pricing.js";
import { normalizeOpengrep } from "../sast/opengrep.js";
import { createPortableCodexSecurityDossier, portableCodexSecurityDossierBase64 } from "./portable-codex-security-dossier.js";
import { addPortableSastCandidates, planPortableSastTriage, PORTABLE_SAST_REVIEW_LIMIT,
  PORTABLE_SAST_TRIAGE_FILE, readPortableSastTriage, writePortableSastTriage } from "./portable-sast-triage.js";

const pricing: FrozenScannerPricing = {
  currency: "USD", capturedAt: "2026-08-11T12:00:00.000Z", modelId: "model-a",
  inputUsdPerMillionTokens: 1, cachedInputUsdPerMillionTokens: 0,
  cacheWriteInputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 1,
  connectionId: "connection-a", providerKind: "custom", routeKind: "custom-openai-compatible",
  protocol: "openai-chat", pricingSource: "provider-catalog", pricingBasis: "payg-equivalent",
  billingMode: "unknown", pricingRateCardId: null, rateCardUpdatedAt: null,
  maximumInputTokensInclusive: null,
};

const match = (name: string, line: number, severity = "ERROR") => ({
  check_id: "test-marker", path: name, start: { line }, end: { line },
  extra: { severity, message: "Untrusted scanner text that must not enter the model prompt" },
});

test("SAST triage ranks static matches deterministically, bounds review work, and preserves raw alerts", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "portable-sast-triage-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "tests"));
  for (const name of ["index.ts", "tests/index.ts"]) fs.writeFileSync(path.join(root, name), "const marker = true;\n".repeat(12));
  const findings = normalizeOpengrep({ results: [
    ...Array.from({ length: 10 }, (_, i) => match("index.ts", i + 1, "INFO")),
    match("tests/index.ts", 1, "ERROR"), match("index.ts", 11, "ERROR"),
    match("tests/index.ts", 2, "CRITICAL"), match("index.ts", 99, "CRITICAL"),
  ] }, root);
  const original = structuredClone(findings);
  const plan = planPortableSastTriage(findings, root);
  assert.deepEqual(plan, planPortableSastTriage([...findings].reverse(), root));
  assert.equal(plan.total, findings.length);
  assert.equal(plan.queued.length, 11);
  assert.deepEqual(plan.queued.slice(0, 3).map(entry => [entry.severity, entry.scope, entry.startLine]), [
    ["high", "runtime", 11], ["low", "runtime", 1], ["low", "runtime", 2],
  ]);
  assert.deepEqual(plan.queued.slice(3).map(entry => entry.startLine), [3, 4, 5, 6, 7, 8, 9, 10]);
  const base = { ...createPortableCodexSecurityDossier(), candidates: [{
    id: "business-logic", category: "authorization", anchors: [{ path: "index.ts", startLine: 1, endLine: 1, role: "control" as const }],
  }] };
  const augmented = addPortableSastCandidates(base, plan);
  assert.deepEqual(augmented.candidates.map(candidate => candidate.id), [...plan.queued.map(entry => entry.findingId), "business-logic"]);
  assert.doesNotMatch(JSON.stringify(augmented), /Untrusted scanner text/);
  assert.deepEqual(findings, original);
  assert.equal(addPortableSastCandidates(base, null), base);
});

test("SAST triage excludes supporting and generated code before ranking runtime alerts", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "portable-sast-runtime-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const supporting = ["vendor/lib.js", "third_party/lib.js", "third-party/lib.js", "node_modules/lib.js",
    "bower_components/lib.js", "frontend/src/assets/private/three.js", "data/static/challenge.ts", "public/app.js",
    "dist/app.js", "build/app.js", "generated/api.ts", "samples/api.ts", "demos/api.ts", "src/app.min.js",
    "src/app.bundle.js", "tests/api.ts", "__tests__/api.ts", "fixtures/api.ts", "examples/api.ts", "docs/api.ts",
    "mocks/api.ts", "__mocks__/api.ts", "src/api.test.ts", "src/api.spec.ts", "VENDOR/lib.js"];
  const runtime = ["routes/login.ts", "routes/search.ts", "routes/captcha.ts", "routes/userProfile.ts", "lib/insecurity.ts",
    "src/publication.ts", "src/staticAnalysis.ts", "src/vendorAdapter.ts"];
  for (const file of [...supporting, ...runtime]) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), "export const value = 1;\n".repeat(40));
  }
  const findings = normalizeOpengrep({ results: [
    ...supporting.map(file => match(file, 1, "CRITICAL")),
    ...runtime.map(file => match(file, 34)), match("routes/login.ts", 23),
  ] }, root);
  const plan = planPortableSastTriage(findings, root, undefined, { remainingUsd: 0.01, maximumInputTokens: 128_000, pricing });
  assert.equal(plan.total, supporting.length + runtime.length + 1);
  assert.equal(plan.queued.length, 8);
  assert.ok(plan.queued.every(entry => entry.scope === "runtime"));
  assert.ok(plan.queued.every(entry => runtime.includes(entry.path)));
  assert.ok(plan.queued.some(entry => entry.path === "routes/login.ts" && entry.startLine === 34));
  assert.ok(plan.queued.some(entry => entry.path === "routes/search.ts"));
  assert.ok(plan.queued.some(entry => entry.path === "routes/captcha.ts"));
  assert.ok(plan.queued.some(entry => entry.path === "routes/userProfile.ts"));
  assert.ok(plan.queued.some(entry => entry.path === "lib/insecurity.ts"));
  assert.deepEqual(plan, planPortableSastTriage([...findings].reverse(), root, undefined,
    { remainingUsd: 0.01, maximumInputTokens: 128_000, pricing }));
  assert.deepEqual(planPortableSastTriage(findings.filter(f => supporting.includes(f.primaryPath!)), root).queued, []);
  assert.deepEqual(planPortableSastTriage([], root), { version: 1, total: 0, queued: [] });
});

test("SAST review grows in eight-candidate pages using a quarter of remaining budget, with an absolute cap", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "portable-sast-budget-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "index.ts"), "export const value = 1;\n".repeat(100));
  const findings = normalizeOpengrep({ results: Array.from({ length: 100 }, (_, i) => match("index.ts", i + 1)) }, root);
  const plan = planPortableSastTriage(findings, root);
  assert.equal(plan.queued.length, PORTABLE_SAST_REVIEW_LIMIT);
  for (const [remainingUsd, count] of [[0, 8], [0.01, 8], [4, 8], [7, 16], [10, 24], [100, 32]]) {
    const bounded = planPortableSastTriage(findings, root, undefined, { remainingUsd, maximumInputTokens: 128_000, pricing });
    assert.equal(bounded.queued.length, count);
    assert.equal(bounded.total, 100);
  }
  const zeroCost = { ...pricing, inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0 };
  assert.equal(planPortableSastTriage(findings, root, undefined,
    { remainingUsd: 0, maximumInputTokens: 128_000, pricing: zeroCost }).queued.length, PORTABLE_SAST_REVIEW_LIMIT);
  for (const budget of [
    { remainingUsd: null, maximumInputTokens: 128_000, pricing },
    { remainingUsd: NaN, maximumInputTokens: 128_000, pricing },
    { remainingUsd: 100, maximumInputTokens: null, pricing },
    { remainingUsd: 100, maximumInputTokens: 128_000, pricing: { ...pricing, outputUsdPerMillionTokens: null } },
    { remainingUsd: 100, maximumInputTokens: 128_000, pricing: { ...pricing, maximumInputTokensInclusive: 1_000 } },
  ]) assert.equal(planPortableSastTriage(findings, root, undefined, budget).queued.length, 8);
  assert.throws(() => planPortableSastTriage(findings, root, () => { throw new Error("deadline"); }), /deadline/);

  const base = { ...createPortableCodexSecurityDossier(), candidates: Array.from({ length: 1_020 }, (_, i) => ({
    id: `existing-${i}`, category: "authorization", anchors: [{ path: "index.ts", startLine: 1, endLine: 1, role: "control" as const }],
  })) };
  const augmented = addPortableSastCandidates(base, plan);
  assert.equal(augmented.candidates.length, 1_024);
  assert.deepEqual(augmented.candidates.slice(0, 4).map(candidate => candidate.id), plan.queued.slice(0, 4).map(entry => entry.findingId));
  assert.deepEqual(augmented.candidates.slice(4), base.candidates);
  assert.doesNotThrow(() => portableCodexSecurityDossierBase64(augmented));
});

test("SAST triage reads legacy eight-entry plans and larger bounded plans without changing resume identities", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "portable-sast-read-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(readPortableSastTriage(root), null);
  fs.writeFileSync(path.join(root, "index.ts"), "export const value = 1;\n".repeat(40));
  const findings = normalizeOpengrep({ results: Array.from({ length: 40 }, (_, i) => match("index.ts", i + 1)) }, root);
  const plan = planPortableSastTriage(findings, root);
  const legacy = { ...plan, queued: plan.queued.slice(0, 8).map(entry => ({ ...entry, scope: "supporting" as const })) };
  writePortableSastTriage(root, legacy);
  assert.deepEqual(readPortableSastTriage(root), legacy);
  const expanded = { ...plan, queued: plan.queued.map(entry => ({ ...entry, path: "long/" + "a".repeat(700) + ".ts" })) };
  writePortableSastTriage(root, expanded);
  const file = path.join(root, PORTABLE_SAST_TRIAGE_FILE);
  assert.ok(fs.statSync(file).size > 16_384);
  assert.deepEqual(readPortableSastTriage(root), expanded);
  writePortableSastTriage(root, { ...plan, queued: [...plan.queued, { ...plan.queued[0], findingId: "opengrep:" + "f".repeat(64) }] });
  assert.throws(() => readPortableSastTriage(root), /invalid_sast_triage/);
  writePortableSastTriage(root, { ...plan, queued: [plan.queued[0], plan.queued[0]] });
  assert.throws(() => readPortableSastTriage(root), /invalid_sast_triage/);
  fs.writeFileSync(file, " ".repeat(128 * 1024 + 1));
  assert.throws(() => readPortableSastTriage(root), /invalid_sast_triage/);
});
