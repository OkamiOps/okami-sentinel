import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createPortableDeepCoveragePlan } from "./portable-codex-security-deep-coverage.js";
import { packDeepPlan, resolveDeepPlan, DEEP_PLAN_FILE } from "./portable-deep-plan.js";

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deep-plan-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const snapshotRoot = path.join(root, "source"); fs.mkdirSync(snapshotRoot);
  for (const name of ["a.ts", "b.ts", "c.ts", "d.ts"]) fs.writeFileSync(path.join(snapshotRoot, name), "x".repeat(60_000));
  return { snapshotRoot, outputDir: root, snapshotId: "content:test", resume: false };
}
const graph = { nodes: ["a", "c"].map(id => ({ id, file: `${id}.ts`, label: id, location: "1" })),
  edges: [{ source: "a", target: "c", relation: "calls", confidence: "EXTRACTED" }] };

test("graph packing groups related files and preserves every byte exactly once, including graph gaps", t => {
  const f = fixture(t); const baseline = createPortableDeepCoveragePlan(f.snapshotRoot);
  const packed = packDeepPlan(baseline, graph);
  assert.deepEqual(packed.partitions[0]!.paths, ["a.ts", "c.ts"]);
  assert.deepEqual(packed.files, baseline.files); assert.equal(packed.totalBytes, baseline.totalBytes);
  assert.deepEqual(packed.partitions.flatMap(p => p.paths).sort(), [...baseline.files].sort());
  assert.deepEqual(packDeepPlan(baseline, { ...graph, edges: [{ ...graph.edges[0]!, confidence: "INFERRED" }] }), baseline);
});
test("persisted graph plan survives absent or changed graph and rejects snapshot mismatch", t => {
  const f = fixture(t); const first = resolveDeepPlan({ ...f, graph });
  assert.deepEqual(resolveDeepPlan({ ...f, resume: true }), first);
  assert.throws(() => resolveDeepPlan({ ...f, snapshotId: "other", resume: true }), /deep_plan_invalid/);
});
test("legacy recovery keeps lexical partitions and does not invent a new plan", t => {
  const f = fixture(t);
  assert.deepEqual(resolveDeepPlan({ ...f, graph, resume: true }), createPortableDeepCoveragePlan(f.snapshotRoot));
  assert.equal(fs.existsSync(path.join(f.outputDir, DEEP_PLAN_FILE)), false);
});
test("plan validation rejects rehashed duplicate coverage and symlink manifests", t => {
  const f = fixture(t); resolveDeepPlan({ ...f, graph });
  const filename = path.join(f.outputDir, DEEP_PLAN_FILE); const saved = JSON.parse(fs.readFileSync(filename, "utf8"));
  saved.plan.partitions[1].paths = saved.plan.partitions[0].paths;
  saved.digest = createHash("sha256").update(JSON.stringify(saved.plan)).digest("hex");
  fs.writeFileSync(filename, JSON.stringify(saved));
  assert.throws(() => resolveDeepPlan({ ...f, resume: true }), /deep_plan_invalid/);
  fs.renameSync(filename, filename + ".old"); fs.symlinkSync(filename + ".old", filename);
  assert.throws(() => resolveDeepPlan({ ...f, resume: true }), /deep_plan_invalid/);
});
