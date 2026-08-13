import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import Database from "better-sqlite3";
import type { GateRun, GuardrailRepository, ScanRun } from "@csb/shared";

const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-scan-delete-test-"));
process.env.CSB_DATA_DIR = path.join(isolatedRoot, "data");
process.env.CODEX_SECURITY_STATE_DIR = path.join(isolatedRoot, "state");
process.env.CSB_NPM_CACHE_DIR = path.join(isolatedRoot, "npm-cache");

const [activity, appModule, config, dbModule, gateStoreModule] = await Promise.all([
  import("./activity.js"),
  import("./app.js"),
  import("./config.js"),
  import("./db.js"),
  import("./gate-store.js"),
]);
const { appendCliLog, cliLogPath } = activity;
const { app } = appModule;
const {
  CODEX_SECURITY_SESSIONS_DIR,
  GATES_DIR,
  GUARDRAIL_MATERIALIZATIONS_DIR,
  SCANS_ROOT,
  WORKBENCH_DB_PATH,
} = config;
const { deleteRun, getDb, getRun, listRuns, upsertRun } = dbModule;
const {
  getGateRun,
  insertGateRun,
  upsertGuardrailRepository,
  upsertMaterializationLease,
} = gateStoreModule;

after(() => {
  fs.rmSync(isolatedRoot, { recursive: true, force: true });
});

function terminalRun(id: string, scanDir: string, repositoryPath: string): ScanRun {
  return {
    id,
    displayName: `Delete fixture ${id}`,
    repositoryPath,
    revision: "fixture-revision",
    scanDir,
    status: "failed",
    model: "fixture-model",
    effort: null,
    mode: "standard",
    engine: "codex-security",
    provider: "fixture-provider",
    authMode: "api-key",
    scannerVersion: "fixture-version",
    recipeHash: "fixture-recipe",
    startedAt: "2026-08-12T10:00:00.000Z",
    completedAt: "2026-08-12T10:01:00.000Z",
    durationMs: 60_000,
    cost: null,
    severity: {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      info: 0,
      unknown: 0,
      total: 0,
    },
    source: "benchmark",
    pid: null,
    execution: null,
  };
}

function linkedGate(id: string, scanId: string, repositoryPath: string): GateRun {
  return {
    id,
    repositoryKey: `fixture/${id}`,
    repositoryPath,
    source: "local",
    executor: "sentinel-managed",
    baseRef: "main",
    headRef: "HEAD",
    resolvedBaseSha: "a".repeat(40),
    resolvedHeadSha: "b".repeat(40),
    policySha: "c".repeat(64),
    pullRequestNumber: null,
    workflowRunId: null,
    materializationState: "released",
    scanLineageHash: null,
    artifactSchemaVersion: 2,
    scanId,
    status: "error",
    outcome: "error",
    policyVersion: 1,
    baselineCommit: null,
    artifactPath: path.join(GATES_DIR, id, "csb-gate-result.json"),
    publishStatus: "not_configured",
    publishError: null,
    publishedAt: null,
    error: "fixture",
    startedAt: "2026-08-13T10:00:00.000Z",
    completedAt: "2026-08-13T10:01:00.000Z",
    costCeilingUsd: 18,
    estimatedUsd: 0,
  };
}

function createLinkedGateFixture(gate: GateRun, leaseId: string): string {
  const repository: GuardrailRepository = {
    repositoryKey: gate.repositoryKey,
    repositoryPath: gate.repositoryPath,
    source: "local",
    displayName: gate.repositoryKey,
    defaultBranch: "main",
    defaultExecutor: "sentinel-managed",
    remoteOwner: null,
    remoteName: null,
    githubConnectionId: null,
    githubInstallationId: null,
    githubRepositoryId: null,
    enabled: true,
    policyPath: ".csb/guardrails.json",
    lastGateId: null,
    githubStatus: "not_checked",
  };
  upsertGuardrailRepository(repository);
  insertGateRun(gate);
  upsertMaterializationLease({
    id: leaseId,
    gateId: gate.id,
    repositoryKey: gate.repositoryKey,
    snapshotIdentity: "sha256:fixture",
    state: "released",
    createdAt: gate.startedAt,
    expiresAt: gate.completedAt!,
    releasedAt: gate.completedAt,
  });
  fs.mkdirSync(path.dirname(gate.artifactPath!), { recursive: true });
  fs.writeFileSync(gate.artifactPath!, "{}", "utf8");
  const materialization = path.join(GUARDRAIL_MATERIALIZATIONS_DIR, `${gate.id}--${leaseId}`);
  fs.mkdirSync(materialization, { recursive: true });
  fs.writeFileSync(path.join(materialization, "private-snapshot"), "fixture", "utf8");
  return materialization;
}

function createWorkbenchFixture(id: string, scanDir: string): void {
  fs.mkdirSync(path.dirname(WORKBENCH_DB_PATH), { recursive: true });
  const database = new Database(WORKBENCH_DB_PATH);
  try {
    database.pragma("foreign_keys = ON");
    database.exec(`
      CREATE TABLE IF NOT EXISTS scans (
        id TEXT PRIMARY KEY,
        target_path TEXT NOT NULL,
        target_revision TEXT NOT NULL,
        scan_dir TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        mode TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        canceled_at TEXT,
        recipe_json TEXT,
        cost_json TEXT,
        target_summary TEXT
      );
      CREATE TABLE IF NOT EXISTS scan_progress (
        scan_id TEXT PRIMARY KEY REFERENCES scans(id) ON DELETE CASCADE,
        marker TEXT NOT NULL
      );
    `);
    database.prepare(`
      INSERT INTO scans (
        id, target_path, target_revision, scan_dir, status, mode,
        started_at, completed_at, canceled_at, recipe_json, cost_json, target_summary
      ) VALUES (?, ?, ?, ?, 'failed', 'standard', ?, ?, NULL, NULL, NULL, NULL)
    `).run(
      id,
      "/fixture/repository",
      "fixture-revision",
      scanDir,
      "2026-08-12T10:00:00.000Z",
      "2026-08-12T10:01:00.000Z",
    );
    database.prepare("INSERT INTO scan_progress (scan_id, marker) VALUES (?, 'keep-until-delete')").run(id);
  } finally {
    database.close();
  }
}

function removeWorkbenchFixture(id: string): void {
  if (!fs.existsSync(WORKBENCH_DB_PATH)) return;
  const database = new Database(WORKBENCH_DB_PATH);
  try {
    database.pragma("foreign_keys = ON");
    database.prepare("DELETE FROM scans WHERE id = ?").run(id);
  } finally {
    database.close();
  }
}

function workbenchCounts(id: string): { scans: number; progress: number } {
  const database = new Database(WORKBENCH_DB_PATH, { readonly: true, fileMustExist: true });
  try {
    const scans = database.prepare("SELECT COUNT(*) AS count FROM scans WHERE id = ?").get(id) as { count: number };
    const progress = database.prepare("SELECT COUNT(*) AS count FROM scan_progress WHERE scan_id = ?").get(id) as { count: number };
    return { scans: scans.count, progress: progress.count };
  } finally {
    database.close();
  }
}

function removeBenchmarkFixture(id: string): void {
  const database = getDb();
  database.prepare("DELETE FROM hidden_runs WHERE id = ?").run(id);
  deleteRun(id);
}

test("DELETE removes every managed run artifact before hiding it from the ledger", async () => {
  const id = "delete-managed-fixture";
  const projectRoot = path.join(SCANS_ROOT, `delete-project-${process.pid}`);
  const scanDir = path.join(projectRoot, `csb-delete-project-${id}`);
  const repositoryRoot = path.join(path.dirname(SCANS_ROOT), `external-repository-${process.pid}`);
  const repositoryFile = path.join(repositoryRoot, "keep.ts");
  const workbenchRoot = path.join(
    os.tmpdir(),
    `codex-security-scans-delete-${process.pid}-${Date.now()}`,
  );
  const workbenchScanDir = path.join(
    workbenchRoot,
    path.basename(scanDir),
    "official-output",
  );
  const unrelatedWorkbenchId = `unrelated-${id}`;
  const unrelatedWorkbenchScanDir = path.join(
    workbenchRoot,
    `${path.basename(scanDir)}-other`,
    "official-output",
  );
  const unrelatedArtifact = path.join(unrelatedWorkbenchScanDir, "must-survive.json");
  const sessionFiles = [scanDir, workbenchScanDir].map((cwd, index) => path.join(
    CODEX_SECURITY_SESSIONS_DIR,
    "2026",
    "08",
    "12",
    `${id}-${index}.jsonl`,
  ));
  const workbenchId = `workbench-${id}`;

  fs.mkdirSync(scanDir, { recursive: true });
  fs.mkdirSync(workbenchScanDir, { recursive: true });
  fs.mkdirSync(unrelatedWorkbenchScanDir, { recursive: true });
  fs.mkdirSync(repositoryRoot, { recursive: true });
  fs.writeFileSync(path.join(scanDir, "partial-result.json"), "{}", "utf8");
  fs.writeFileSync(path.join(workbenchScanDir, "partial-workbench-result.json"), "{}", "utf8");
  fs.writeFileSync(unrelatedArtifact, '{"keep":true}', "utf8");
  fs.writeFileSync(repositoryFile, "export const keep = true;\n", "utf8");
  fs.chmodSync(repositoryFile, 0o400);
  fs.symlinkSync(repositoryRoot, path.join(scanDir, "repository-link"), "dir");
  appendCliLog(scanDir, "terminal fixture");
  sessionFiles.forEach((sessionFile, index) => {
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(
      sessionFile,
      `${JSON.stringify({
        type: "session_meta",
        timestamp: "2026-08-12T10:00:00.000Z",
        payload: {
          id: `session-${id}-${index}`,
          parent_thread_id: null,
          cwd: index === 0 ? scanDir : workbenchScanDir,
        },
      })}\n`,
      "utf8",
    );
  });
  createWorkbenchFixture(workbenchId, workbenchScanDir);
  createWorkbenchFixture(unrelatedWorkbenchId, unrelatedWorkbenchScanDir);
  upsertRun(terminalRun(id, scanDir, repositoryRoot));

  try {
    const response = await app.request(`/scans/${id}`, { method: "DELETE" });
    const body = await response.json() as {
      ok?: boolean;
      artifactsDeleted?: boolean;
      sessionsDeleted?: number;
      workbenchRowsDeleted?: number;
    };

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.artifactsDeleted, true);
    assert.equal(body.sessionsDeleted, 2);
    assert.equal(body.workbenchRowsDeleted, 1);
    assert.equal(fs.existsSync(scanDir), false);
    assert.equal(fs.existsSync(workbenchScanDir), false);
    assert.equal(fs.readFileSync(unrelatedArtifact, "utf8"), '{"keep":true}');
    assert.deepEqual(workbenchCounts(unrelatedWorkbenchId), { scans: 1, progress: 1 });
    assert.equal(fs.existsSync(cliLogPath(scanDir)), false);
    assert.equal(sessionFiles.some((sessionFile) => fs.existsSync(sessionFile)), false);
    assert.equal(fs.existsSync(projectRoot), false);
    assert.equal(listRuns().some((run) => run.id === id), false);
    assert.equal(getRun(id), null);
    assert.deepEqual(workbenchCounts(workbenchId), { scans: 0, progress: 0 });
    assert.equal(fs.readFileSync(repositoryFile, "utf8"), "export const keep = true;\n");
    assert.equal(fs.statSync(repositoryFile).mode & 0o777, 0o400);

    const ingestResponse = await app.request("/ingest", { method: "POST" });
    assert.equal(ingestResponse.status, 200);
    assert.equal(listRuns().some((run) => run.id === id || run.id === workbenchId), false);
  } finally {
    removeBenchmarkFixture(id);
    removeBenchmarkFixture(unrelatedWorkbenchId);
    removeWorkbenchFixture(unrelatedWorkbenchId);
    if (fs.existsSync(repositoryFile)) fs.chmodSync(repositoryFile, 0o600);
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(workbenchRoot, { recursive: true, force: true });
    sessionFiles.forEach((sessionFile) => fs.rmSync(sessionFile, { force: true }));
  }
});

test("DELETE refuses an unmanaged scan directory and keeps the run visible", async () => {
  const id = "delete-unmanaged-fixture";
  const repositoryRoot = path.join(path.dirname(SCANS_ROOT), `unmanaged-repository-${process.pid}`);
  const scanDir = path.join(repositoryRoot, ".sentinel-artifacts", id);
  const artifact = path.join(scanDir, "keep.json");

  fs.mkdirSync(scanDir, { recursive: true });
  fs.writeFileSync(artifact, "{}", "utf8");
  upsertRun(terminalRun(id, scanDir, repositoryRoot));

  try {
    const response = await app.request(`/scans/${id}`, { method: "DELETE" });
    const body = await response.json() as { error?: string };

    assert.equal(response.status, 409);
    assert.match(body.error ?? "", /raízes gerenciadas/);
    assert.equal(fs.readFileSync(artifact, "utf8"), "{}");
    assert.equal(listRuns().some((run) => run.id === id), true);
  } finally {
    removeBenchmarkFixture(id);
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test("deleting a scan also deletes its terminal gate and every managed directory", async () => {
  const scanId = "delete-linked-from-run";
  const gateId = "gate-delete-linked-from-run";
  const scanDir = path.join(SCANS_ROOT, "linked-delete", `csb-${scanId}`);
  fs.mkdirSync(scanDir, { recursive: true });
  fs.writeFileSync(path.join(scanDir, "result.json"), "{}", "utf8");
  upsertRun(terminalRun(scanId, scanDir, "/fixture/repository"));
  const gate = linkedGate(gateId, scanId, "/fixture/repository");
  const materialization = createLinkedGateFixture(gate, "lease-from-run");

  try {
    const response = await app.request(`/scans/${scanId}`, { method: "DELETE" });
    const body = await response.json() as { linkedGatesDeleted?: number };
    assert.equal(response.status, 200);
    assert.equal(body.linkedGatesDeleted, 1);
    assert.equal(listRuns().some((run) => run.id === scanId), false);
    assert.equal(getRun(scanId), null);
    assert.equal(getGateRun(gateId), null);
    assert.equal(fs.existsSync(scanDir), false);
    assert.equal(fs.existsSync(path.join(GATES_DIR, gateId)), false);
    assert.equal(fs.existsSync(materialization), false);
  } finally {
    removeBenchmarkFixture(scanId);
    fs.rmSync(path.join(GATES_DIR, gateId), { recursive: true, force: true });
    fs.rmSync(materialization, { recursive: true, force: true });
  }
});

test("deleting a gate also deletes its linked scan and every managed directory", async () => {
  const scanId = "delete-linked-from-gate";
  const gateId = "gate-delete-linked-from-gate";
  const scanDir = path.join(SCANS_ROOT, "linked-delete", `csb-${scanId}`);
  fs.mkdirSync(scanDir, { recursive: true });
  fs.writeFileSync(path.join(scanDir, "result.json"), "{}", "utf8");
  upsertRun(terminalRun(scanId, scanDir, "/fixture/repository"));
  const gate = linkedGate(gateId, scanId, "/fixture/repository");
  const materialization = createLinkedGateFixture(gate, "lease-from-gate");

  try {
    const response = await app.request(`/guardrails/gates/${gateId}`, { method: "DELETE" });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, deleted: true });
    assert.equal(listRuns().some((run) => run.id === scanId), false);
    assert.equal(getRun(scanId), null);
    assert.equal(getGateRun(gateId), null);
    assert.equal(fs.existsSync(scanDir), false);
    assert.equal(fs.existsSync(path.join(GATES_DIR, gateId)), false);
    assert.equal(fs.existsSync(materialization), false);
  } finally {
    removeBenchmarkFixture(scanId);
    fs.rmSync(path.join(GATES_DIR, gateId), { recursive: true, force: true });
    fs.rmSync(materialization, { recursive: true, force: true });
  }
});
