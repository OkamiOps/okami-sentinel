import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runPortableStageWithRecovery, type PortableStageRecoveryOptions } from "./portable-stage-recovery.js";

function setup(t: test.TestContext) {
  const metadataDir = fs.mkdtempSync(path.join(os.tmpdir(), "portable-recovery-"));
  t.after(() => fs.rmSync(metadataDir, { recursive: true, force: true }));
  return { metadataDir, snapshotId: "content:frozen", stage: "validation", page: "02-part-01" };
}
const fail = (code: string) => Object.assign(new Error("secret payload must never be journaled"), { code });

test("recovers with a fresh attempt and safe diagnostics", async t => {
  const base = setup(t);
  const attempts: unknown[] = [], events: unknown[] = [];
  const result = await runPortableStageWithRecovery({ ...base, onRecovery: e => events.push(e), run: async (attempt, prior) => {
    attempts.push([attempt, prior]);
    if (attempt === 1) throw fail("agent_output_byte_limit");
    return "valid";
  } });
  assert.equal(result, "valid");
  assert.deepEqual(attempts, [[1, undefined], [2, "agent_output_byte_limit"]]);
  assert.equal(events.length, 1);
  assert.doesNotMatch(fs.readFileSync(path.join(base.metadataDir, fs.readdirSync(base.metadataDir)[0]!), "utf8"), /secret/);
});

test("bounded budget persists across helper invocations", async t => {
  const base = setup(t); let calls = 0;
  const options = { ...base, run: async () => { calls++; throw fail("stage_artifact_invalid"); } };
  await assert.rejects(runPortableStageWithRecovery(options), { code: "stage_recovery_exhausted", attempts: 3, lastErrorCode: "stage_artifact_invalid" });
  await assert.rejects(runPortableStageWithRecovery(options), { code: "stage_recovery_exhausted" });
  assert.equal(calls, 3);
});

test("the same execution policy preserves an exhausted retry budget across resume", async t => {
  const base = { ...setup(t), executionPolicyId: "standard-discovery-output-16384-context-300000-v1" };
  let calls = 0;
  const options = { ...base, run: async () => { calls++; throw fail("agent_context_limit"); } };
  await assert.rejects(runPortableStageWithRecovery(options), { code: "stage_recovery_exhausted", attempts: 3,
    lastErrorCode: "agent_context_limit" });
  await assert.rejects(runPortableStageWithRecovery(options), { code: "stage_recovery_exhausted", attempts: 3,
    lastErrorCode: "agent_context_limit" });
  assert.equal(calls, 3);
});

test("a different explicit execution policy starts a bounded journal without altering the prior journal", async t => {
  const base = setup(t);
  const firstPolicy = "standard-discovery-output-32768-context-300000-v1";
  const secondPolicy = "standard-discovery-output-16384-context-300000-v1";
  let calls = 0;
  const exhausted = (executionPolicyId: string) => runPortableStageWithRecovery({ ...base, executionPolicyId,
    run: async () => { calls++; throw fail("agent_context_limit"); } });
  await assert.rejects(exhausted(firstPolicy), { code: "stage_recovery_exhausted", attempts: 3 });
  const firstFile = fs.readdirSync(base.metadataDir).find(file => file.endsWith(".json"))!;
  const firstJournal = fs.readFileSync(path.join(base.metadataDir, firstFile), "utf8");
  await assert.rejects(exhausted(secondPolicy), { code: "stage_recovery_exhausted", attempts: 3 });
  assert.equal(calls, 6);
  assert.equal(fs.readFileSync(path.join(base.metadataDir, firstFile), "utf8"), firstJournal);
  assert.equal(fs.readdirSync(base.metadataDir).filter(file => file.endsWith(".json")).length, 2);
});

test("omitting execution policy reads the existing v1 journal", async t => {
  const base = setup(t);
  const identity = { snapshotId: base.snapshotId, stage: base.stage, page: base.page };
  const key = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  const journal = JSON.stringify({ version: 1, ...identity, attempts: 3, lastErrorCode: "agent_context_limit" });
  const file = path.join(base.metadataDir, `${key}.json`);
  fs.writeFileSync(file, journal, { mode: 0o600 });
  let calls = 0;
  await assert.rejects(runPortableStageWithRecovery({ ...base, run: async () => { calls++; } }), {
    code: "stage_recovery_exhausted", attempts: 3, lastErrorCode: "agent_context_limit",
  });
  assert.equal(calls, 0);
  assert.equal(fs.readFileSync(file, "utf8"), journal);
});

test("validated checkpoint survives terminal session error without another call", async t => {
  let calls = 0;
  const result = await runPortableStageWithRecovery({ ...setup(t), run: async () => { calls++; throw fail("agent_turn_limit"); },
    recoverCheckpoint: async () => "validated-checkpoint" });
  assert.equal(result, "validated-checkpoint"); assert.equal(calls, 1);
});

test("does not retry auth, cost, cancellation, time or unknown failures", async t => {
  for (const code of ["agent_cancelled", "scan_cost_limit", "authentication_error", "agent_time_limit", "agent_protocol_error", "unknown"]) {
    let calls = 0; const error = fail(code);
    await assert.rejects(runPortableStageWithRecovery({ ...setup(t), run: async () => { calls++; throw error; } }), e => e === error);
    assert.equal(calls, 1);
  }
});

test("aborted work never dispatches recovery", async t => {
  const controller = new AbortController(); let calls = 0;
  await assert.rejects(runPortableStageWithRecovery({ ...setup(t), signal: controller.signal, run: async () => {
    calls++; controller.abort(); throw fail("agent_output_byte_limit");
  } }), { name: "AbortError" });
  assert.equal(calls, 1);
});

test("corrupt state and overlapping invocation fail closed", async t => {
  const base = setup(t);
  let release!: () => void;
  const first = runPortableStageWithRecovery({ ...base, run: () => new Promise<void>(resolve => { release = resolve; }) });
  await assert.rejects(runPortableStageWithRecovery({ ...base, run: async () => undefined }), { code: "stage_recovery_busy" });
  release(); await first;
  const file = fs.readdirSync(base.metadataDir).find(f => f.endsWith(".json"))!;
  fs.writeFileSync(path.join(base.metadataDir, file), '{}');
  await assert.rejects(runPortableStageWithRecovery({ ...base, run: async () => undefined }), { code: "stage_recovery_state_invalid" });
});

test("identity isolates pages and snapshots and never becomes a filesystem path", async t => {
  const base = setup(t); let calls = 0;
  const run: PortableStageRecoveryOptions<void>["run"] = async () => { calls++; };
  for (const overrides of [{}, { page: "../another" }, { snapshotId: "other" }]) await runPortableStageWithRecovery({ ...base, ...overrides, run });
  assert.equal(calls, 3); assert.equal(fs.readdirSync(base.metadataDir).length, 3);
});
