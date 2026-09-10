import test from "node:test";
import { once } from "node:events";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertPortableRestartLaunchAllowed, claimPortableRestartCapacity, recoverPortableServerRuns, type ServerRecoveryCandidate, type ServerRecoveryDependencies } from "./portable-server-recovery.js";

function setup(t: test.TestContext) {
  const scanDir = fs.mkdtempSync(path.join(os.tmpdir(), "server-recovery-"));
  t.after(() => fs.rmSync(scanDir, { recursive: true, force: true }));
  const candidate: ServerRecoveryCandidate = { id: "same-id", scanDir, status: "incomplete", portable: true };
  let starts = 0;
  const dependencies: ServerRecoveryDependencies = {
    getCandidate: () => candidate, hasProcess: () => false,
    prepare: async () => ({ snapshotId: "frozen", start: async () => { starts++; candidate.status = "running"; } }),
  };
  return { candidate, dependencies, starts: () => starts };
}

test("restart preserves scan identity and persists bounded restart budget", async t => {
  const state = setup(t);
  for (let i = 0; i < 2; i++) {
    state.candidate.status = "incomplete";
    assert.deepEqual(await recoverPortableServerRuns(["same-id", "same-id"], state.dependencies), [{ scanId: "same-id", status: "resumed" }]);
  }
  state.candidate.status = "incomplete";
  assert.deepEqual(await recoverPortableServerRuns(["same-id"], state.dependencies), [{ scanId: "same-id", status: "blocked", reason: "restart_budget_exhausted" }]);
  assert.equal(state.starts(), 2);
});

test("only explicitly captured incomplete portable runs with no living worker resume", async t => {
  const state = setup(t);
  assert.deepEqual(await recoverPortableServerRuns([], state.dependencies), []);
  for (const status of ["cancelled", "completed", "failed", "running", "queued"]) {
    state.candidate.status = status;
    assert.equal((await recoverPortableServerRuns(["same-id"], state.dependencies))[0]?.status, "skipped");
  }
  state.candidate.status = "incomplete";
  state.dependencies.hasProcess = () => true;
  assert.equal((await recoverPortableServerRuns(["same-id"], state.dependencies))[0]?.status, "skipped");
  assert.equal(state.starts(), 0);
});

test("failed preflight and corrupt journals cannot launch and do not disclose errors", async t => {
  const state = setup(t);
  state.dependencies.prepare = async () => { throw new Error("sensitive source or credential"); };
  assert.deepEqual(await recoverPortableServerRuns(["same-id"], state.dependencies), [{ scanId: "same-id", status: "blocked", reason: "restart_validation_or_launch_failed" }]);
  assert.equal(state.starts(), 0);
  assert.deepEqual(fs.readdirSync(state.candidate.scanDir), []);
});

test("cancellation during checkpoint preparation prevents dispatch", async t => {
  const state = setup(t);
  state.dependencies.prepare = async () => {
    state.candidate.status = "cancelled";
    return { snapshotId: "frozen", start: async () => { throw new Error("must not dispatch"); } };
  };
  assert.equal((await recoverPortableServerRuns(["same-id"], state.dependencies))[0]?.status, "skipped");
});

test("failed dispatch consumes durable attempt and rejects changed snapshot", async t => {
  const state = setup(t);
  state.dependencies.prepare = async () => ({ snapshotId: "frozen", start: async () => { throw new Error("restart_capability_unavailable"); } });
  assert.equal((await recoverPortableServerRuns(["same-id"], state.dependencies))[0]?.reason, "restart_capability_unavailable");
  const journal = JSON.parse(fs.readFileSync(path.join(state.candidate.scanDir, "portable-server-recovery.json"), "utf8"));
  assert.equal(journal.attempts, 1);
  state.dependencies.prepare = async () => ({ snapshotId: "changed", start: async () => undefined });
  assert.equal((await recoverPortableServerRuns(["same-id"], state.dependencies))[0]?.reason, "restart_state_invalid");
});

test("real worker crash resumes only unfinished work and preserves checkpoint bytes", async t => {
  const { spawn } = await import("node:child_process");
  const { createHash } = await import("node:crypto");
  const state = setup(t);
  const checkpoint = path.join(state.candidate.scanDir, "page-01.json");
  const finished = path.join(state.candidate.scanDir, "page-02.json");
  const workerCode = `
    const fs = require('node:fs');
    const [first, second, mode] = process.argv.slice(1);
    if (mode === 'initial') {
      fs.writeFileSync(first, JSON.stringify({ page: 1, evidence: 'accepted' }));
      process.stdout.write('checkpoint-ready\\n');
      setInterval(() => {}, 1000);
    } else {
      if (JSON.parse(fs.readFileSync(first)).page !== 1) process.exit(2);
      fs.writeFileSync(second, JSON.stringify({ page: 2, evidence: 'remaining' }));
    }
  `;
  const first = spawn(process.execPath, ['-e', workerCode, checkpoint, finished, 'initial'], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (first.exitCode === null && first.signalCode === null) first.kill('SIGKILL'); });
  await once(first.stdout, 'data');
  const original = fs.readFileSync(checkpoint);
  const checksum = createHash('sha256').update(original).digest('hex');
  state.dependencies.hasProcess = () => {
    try { process.kill(first.pid!, 0); return true; } catch { return false; }
  };
  assert.equal((await recoverPortableServerRuns(['same-id'], state.dependencies))[0]?.status, 'skipped');
  const exit = once(first, 'exit');
  first.kill('SIGKILL'); // Only the disposable child created above.
  await exit;
  state.dependencies.prepare = async () => {
    assert.deepEqual(fs.readFileSync(checkpoint), original);
    return { snapshotId: checksum, start: async () => {
      const resumed = spawn(process.execPath, ['-e', workerCode, checkpoint, finished, 'resume'], { stdio: 'ignore' });
      t.after(() => { if (resumed.exitCode === null && resumed.signalCode === null) resumed.kill('SIGKILL'); });
      const [code] = await once(resumed, 'exit');
      assert.equal(code, 0);
      state.candidate.status = 'completed';
    } };
  };
  assert.deepEqual(await recoverPortableServerRuns(['same-id'], state.dependencies), [{ scanId: 'same-id', status: 'resumed' }]);
  assert.equal(createHash('sha256').update(fs.readFileSync(checkpoint)).digest('hex'), checksum);
  assert.equal(JSON.parse(fs.readFileSync(finished, 'utf8')).page, 2);
  assert.equal(state.candidate.status, 'completed');
});


test("failed or throwing row claim releases capacity; capacity denial releases no foreign slot", () => {
  let released = 0;
  const release = () => { released++; };
  assert.throws(() => claimPortableRestartCapacity(() => true, () => false, release), /restart_state_invalid/);
  assert.equal(released, 1);
  assert.throws(() => claimPortableRestartCapacity(() => true, () => { throw new Error("sqlite"); }, release), /sqlite/);
  assert.equal(released, 2);
  assert.throws(() => claimPortableRestartCapacity(() => false, () => true, release), /restart_capacity_full/);
  assert.equal(released, 2);
  claimPortableRestartCapacity(() => true, () => true, release);
  assert.equal(released, 2);
});


test("cancellation or shutdown during spawn stops only the new child without overwriting status", () => {
  for (const [status, draining] of [["cancelled", false], ["completed", false], ["queued", true], [undefined, false]] as const) {
    let ownChildStops = 0;
    let publishedRunning = false;
    assert.throws(() => {
      assertPortableRestartLaunchAllowed(status, draining, () => { ownChildStops++; });
      publishedRunning = true;
    }, /restart_draining/);
    assert.equal(ownChildStops, 1);
    assert.equal(publishedRunning, false);
  }
  assertPortableRestartLaunchAllowed("queued", false, () => { assert.fail("still authorized child must remain alive"); });
});
