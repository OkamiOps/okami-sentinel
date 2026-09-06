import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import type { ScanRun } from "@csb/shared";
import type { ProcessSnapshot, ProcessSignal } from "./process-identity.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-cancel-"));
process.env.CSB_DATA_DIR = path.join(root, "data");
process.env.CODEX_SECURITY_STATE_DIR = path.join(root, "state");
const { getDb, upsertRun, getRun } = await import("./db.js");
const { cancelScan } = await import("./runner.js");
const { createProcessIdentityService } = await import("./process-identity.js");
const { MANTIS_WORKER_ENTRY } = await import("./config.js");
after(() => { getDb().close(); fs.rmSync(root, { recursive: true, force: true }); });

function fixture(id: string): ScanRun {
  return { id, displayName: id, scanDir: path.join(root, id), repositoryPath: root, revision: null, status: "running", engine: "mantis", model: null, effort: null, mode: "standard", provider: null, authMode: "api-key", scannerVersion: null, recipeHash: null, startedAt: new Date().toISOString(), completedAt: null, durationMs: null, pid: 4100, cost: null, source: "benchmark", execution: null, severity: { critical: 0, high: 0, medium: 0, low: 0, info: 0, unknown: 0, total: 0 } };
}

function scenario(id: string) {
  const run = fixture(id);
  upsertRun(run);
  const snapshots = new Map<number, ProcessSnapshot>([[4100, { pid: 4100, startTime: "boot:100", command: `node ${MANTIS_WORKER_ENTRY} ${path.join(run.scanDir, "mantis-run.json")}` }]]);
  const signals: Array<[number, ProcessSignal]> = [];
  const escalations: Array<() => void> = [];
  const processes = createProcessIdentityService({ currentPid: 9000, findPidsByPattern: () => [...snapshots.keys()], inspect: (pid) => snapshots.get(pid) ?? null, signal: (pid, signal) => { signals.push([pid, signal]); } });
  const identity = processes.captureProcessIdentity(4100, run.scanDir)!;
  const dependencies = { processes, readIdentity: () => identity, scheduleEscalation: (fn: () => void) => { escalations.push(fn); } };
  return { run, snapshots, signals, escalations, dependencies };
}

test("cancel rechecks identity before escalation and never signals another scan", () => {
  const state = scenario("selected");
  const other = fixture("other");
  upsertRun(other);
  state.snapshots.set(4200, { pid: 4200, startTime: "boot:100", command: `node ${MANTIS_WORKER_ENTRY} ${path.join(other.scanDir, "mantis-run.json")}` });
  assert.equal(cancelScan(state.run.id, state.dependencies), true);
  assert.deepEqual(state.signals, [[4100, "SIGTERM"]]);
  assert.equal(getRun("selected")?.status, "cancelled");
  assert.equal(getRun("other")?.status, "running");
  state.snapshots.set(4100, { ...state.snapshots.get(4100)!, startTime: "boot:999" });
  state.escalations[0]();
  assert.deepEqual(state.signals, [[4100, "SIGTERM"]]);
});

test("a recovered PID with a changed start time is not rebound by discovery", () => {
  const state = scenario("reused");
  state.snapshots.set(4100, { ...state.snapshots.get(4100)!, startTime: "boot:999" });
  assert.equal(cancelScan(state.run.id, state.dependencies), true);
  assert.deepEqual(state.signals, []);
  assert.deepEqual(state.escalations, []);
});

test("a still-verified worker receives escalation but a finished scan is untouched", () => {
  const state = scenario("still-current");
  cancelScan(state.run.id, state.dependencies);
  state.escalations[0]();
  assert.deepEqual(state.signals, [[4100, "SIGTERM"], [4100, "SIGKILL"]]);
  assert.equal(cancelScan(state.run.id, state.dependencies), false);
});
