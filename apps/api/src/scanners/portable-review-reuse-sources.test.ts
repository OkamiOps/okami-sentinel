import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import type { ScanRun } from "@csb/shared";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-reuse-sources-"));
process.env.CSB_DATA_DIR = path.join(root, "data");
process.env.CODEX_SECURITY_STATE_DIR = path.join(root, "state");
const { getDb, upsertRun, closeDb } = await import("../db.js");
const { reviewReuseSources } = await import("./portable-review-reuse.js");
const { createPortableCodexSecurityDossier, writePortableCodexSecurityDossier } = await import("./portable-codex-security-dossier.js");
const { writePortableCodexSecurityRuntime } = await import("./portable-codex-security-runtime.js");

after(() => {
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

test("source selection uses repository identity, creation order, status, mode and a five-scan cap", () => {
  const oldDir = path.join(root, "old");
  const currentDir = path.join(root, "current");
  fs.mkdirSync(path.join(oldDir, "portable-codex-security-snapshot"), { recursive: true });
  fs.writeFileSync(path.join(oldDir, "portable-codex-security-snapshot", "route.ts"), "return input;\n");
  writePortableCodexSecurityDossier(path.join(oldDir, "portable-codex-security-results"), createPortableCodexSecurityDossier());
  const source = { scanDir: oldDir, repositoryPath: root, engine: "codex-security",
    execution: { executionProfile: "portable", profileVersion: "sentinel-codex-security-portable-v1",
      methodologyRef: "sentinel/codex-security-methodology@v1", capabilityCheckId: null, connectionId: null, routeKind: null, protocol: null, authKind: null },
  } as ScanRun;
  for (let index = 0; index < 9; index++) {
    const id = `source-${index}`;
    upsertRun({ ...source, id, displayName: id, severity: { critical: 0, high: 0, medium: 0, low: 0, info: 0, unknown: 0, total: 0 },
      source: "workbench", mode: index === 8 ? "standard" : "deep", status: index === 7 ? "failed" : "completed" });
    getDb().prepare("UPDATE runs SET created_at = ? WHERE id = ?").run(`2026-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`, id);
  }
  const deep = reviewReuseSources("current", root, currentDir, "deep", "2026-02-01T00:00:00.000Z");
  assert.deepEqual(deep.map(s => s.id), ["source-6", "source-5", "source-4", "source-3", "source-2"]);
  assert.equal(reviewReuseSources("current", root, currentDir, "standard", "2026-02-01T00:00:00.000Z")[0]!.id, "source-8");
  assert.equal(reviewReuseSources("current", "/other/project", currentDir, "deep", "2026-02-01T00:00:00.000Z").length, 0);
  assert.deepEqual(reviewReuseSources("current", root, currentDir, "deep", "2026-01-03T00:00:00.000Z").map(s => s.id), ["source-1", "source-0"]);
  getDb().prepare("UPDATE runs SET status = 'incomplete' WHERE id = 'source-6'").run();
  assert.equal(reviewReuseSources("current", root, currentDir, "deep", "2026-02-01T00:00:00.000Z")[0]!.id, "source-5");
  writePortableCodexSecurityRuntime(oldDir, {
    engine: "codex-security", executionProfile: "portable", profileVersion: "sentinel-codex-security-portable-v1",
    methodologyRef: "sentinel/codex-security-methodology@v1", status: "incomplete", stage: "validation", stageLabel: "validation", percent: 80,
    detail: null, startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", completedAt: null, findings: 0,
    snapshotId: "content:old", sourceRef: "old", error: null, errorCode: null,
    usage: { reported: false, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
    budgetPartial: { stopReason: "budget", spentUsd: 1, maxCostUsd: 1, completed: [],
      interrupted: { stage: "validation", page: null, artifactPath: null }, pending: [{ stage: "validation", page: null, artifactPath: null }] },
  });
  assert.equal(reviewReuseSources("current", root, currentDir, "deep", "2026-02-01T00:00:00.000Z")[0]!.id, "source-6");
  fs.renameSync(path.join(oldDir, "portable-codex-security-results"), path.join(oldDir, "retired-results"));
  assert.equal(reviewReuseSources("current", root, currentDir, "deep", "2026-02-01T00:00:00.000Z").length, 0);
});
