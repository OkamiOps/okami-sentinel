import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveDeepPlan, STANDARD_PLAN_FILE } from "./portable-deep-plan.js";
import { preflightPortableResume } from "./resume-portable-scan.js";
import { createPortableCodexSecuritySnapshot } from "./portable-codex-security-worker-support.js";

function fixture(candidateCount = 1, extraFiles = 0) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "resume-checkpoint-test-"));
  const source = path.join(root, "source"); const scan = path.join(root, "scan");
  fs.mkdirSync(source); fs.mkdirSync(scan);
  fs.writeFileSync(path.join(source, "route.ts"), "export const route = 1;\n");
  for (let i = 0; i < extraFiles; i++) fs.writeFileSync(path.join(source, `source-${i}.ts`), "export const value = 1;\n");
  const snapshot = createPortableCodexSecuritySnapshot(source, scan);
  fs.writeFileSync(path.join(scan, "portable-codex-security-runtime.json"), JSON.stringify({
    engine: "codex-security", executionProfile: "portable", profileVersion: "sentinel-codex-security-portable-v1",
    methodologyRef: "sentinel/codex-security-methodology@v1", status: "failed", stage: "validation", stageLabel: "Validation",
    percent: 75, detail: null, startedAt: "2026-09-10T00:00:00.000Z", updatedAt: "2026-09-10T00:01:00.000Z", completedAt: null,
    snapshotId: snapshot.snapshotId, sourceRef: "a".repeat(40), findings: 0, usage: { reported: false, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }, error: null, errorCode: null,
  }));
  const anchor = { path: "route.ts", startLine: 1, endLine: 1, role: "control" };
  const write = (dir: string, file: string, stage: string, extra = {}) => {
    const target = path.join(scan, "portable-codex-security-artifacts", dir); fs.mkdirSync(target, {recursive: true});
    fs.writeFileSync(path.join(target, file), JSON.stringify(stage === "report" ? extra : {schemaVersion:1, stage, summary: `Verified ${stage} checkpoint`, observations: [], ...extra}));
  };
  write("inventory", "01-inventory.json", "inventory");
  write("threat-model", "02-threat-model.json", "threat-model");
  const candidates = Array.from({length:candidateCount},(_,i)=>({id:`c${i+1}`,category:"authorization",anchors:[anchor]}));
  const assessments = candidates.map(c=>({candidateId:c.id,status:"confirmed",reason:"untrusted-flow-reaches-sink",evidence:[anchor]}));
  write("discovery-001", "03-discovery.json", "discovery", {scope:{inspected:["route.ts"],unexamined:[]},candidates});
  if (candidateCount <= 32) write("dataflow", "04-dataflow.json", "dataflow", {assessments});
  else for(let i=0;i<Math.ceil(candidateCount/32);i++) write(`dataflow-${String(i+1).padStart(2,"0")}`,"04-dataflow.json","dataflow",{assessments:assessments.slice(i*32,(i+1)*32)});
  return { root, scan, snapshot, write, assessments };
}
function cleanup(root: string) { for (const entry of fs.readdirSync(root,{withFileTypes:true})) {const p=path.join(root,entry.name); if(entry.isDirectory()) { fs.chmodSync(p,0o700); cleanup(p); }} fs.rmSync(root,{recursive:true,force:true}); }

test("validation recovery preflight preserves and accepts discovery/dataflow checkpoints", () => {
  const f=fixture(); try {
    const before=fs.readFileSync(path.join(f.scan,"portable-codex-security-artifacts/dataflow/04-dataflow.json"),"utf8");
    const result=preflightPortableResume(f.scan,"deep");
    assert.equal(result.completed,1); assert.equal(result.verifiedStages.dataflow,1); assert.equal(result.verifiedStages.validation,0);
    assert.equal(fs.readFileSync(path.join(f.scan,"portable-codex-security-artifacts/dataflow/04-dataflow.json"),"utf8"),before);
  } finally {cleanup(f.root);}
});
test("validation recovery rejects corrupt checkpoint instead of replaying past it", () => {
  const f=fixture(); try {
    fs.writeFileSync(path.join(f.scan,"portable-codex-security-artifacts/dataflow/04-dataflow.json"),"invalid");
    assert.throws(()=>preflightPortableResume(f.scan,"deep"));
  } finally {cleanup(f.root);}
});
test("validation recovery rejects tampered immutable snapshot", () => {
  const f=fixture(); try {
    const file=path.join(f.snapshot.snapshotRoot,"route.ts"); fs.chmodSync(file,0o600); fs.writeFileSync(file,"changed");
    assert.throws(()=>preflightPortableResume(f.scan,"deep"));
  } finally {cleanup(f.root);}
});

test("validation recovery accepts legacy whole page plus new bounded part and rejects overlap", () => {
  const f=fixture(48); try {
    f.write("validation-01","05-validation.json","validation",{assessments:f.assessments.slice(0,32)});
    f.write("validation-02-part-01","05-validation.json","validation",{assessments:f.assessments.slice(32,40)});
    const result=preflightPortableResume(f.scan,"deep");
    assert.equal(result.verifiedStages.dataflow,2);
    assert.equal(result.verifiedStages.validation,2);
    f.write("validation-01-part-01","05-validation.json","validation",{assessments:f.assessments.slice(0,8)});
    assert.throws(()=>preflightPortableResume(f.scan,"deep"),/resume_unrecognized_checkpoint/);
  } finally {cleanup(f.root);}
});

test("report recovery validates completed pages and rejects altered coverage or unknown pages", async () => {
  const { createPortableCodexSecurityReportShards, materializePortableCodexSecurityReportShard } = await import("./portable-codex-security-report-shards.js");
  const f=fixture(); try {
    f.write("validation","05-validation.json","validation",{assessments:f.assessments});
    const runtimePath=path.join(f.scan,"portable-codex-security-runtime.json");
    const runtime=JSON.parse(fs.readFileSync(runtimePath,"utf8"));
    fs.writeFileSync(runtimePath,JSON.stringify({...runtime,stage:"report"}));
    const initial=preflightPortableResume(f.scan,"deep");
    const shard=createPortableCodexSecurityReportShards(initial.dossier)[0]!;
    const report=materializePortableCodexSecurityReportShard(shard,{schemaVersion:1,stage:"report",findings:[{
      id:"F-1",candidateId:"c1",title:"Untrusted request reaches protected operation",severity:"medium",confidence:"high",category:"authorization",
      summary:"The untrusted caller can reach the protected operation without a validated ownership check.",
      rootCause:"The protected operation does not validate ownership of the requested record.",
      impact:"A caller could read another account's protected records through this operation.",
      remediation:"Validate the authenticated caller's ownership before returning the record.",
      anchors:[{path:"route.ts",startLine:1,endLine:1,role:"control",explanation:"The protected operation lacks the ownership check."}],
    }]});
    f.write("report-01","sentinel-findings.json","report",report);
    assert.equal(preflightPortableResume(f.scan,"deep").verifiedStages.report,1);
    const bad={...report,coverage:{...report.coverage,candidates:[]}};
    f.write("report-01","sentinel-findings.json","report",bad);
    assert.throws(()=>preflightPortableResume(f.scan,"deep"));
    f.write("report-01","sentinel-findings.json","report",report);
    f.write("report-99","sentinel-findings.json","report",report);
    assert.throws(()=>preflightPortableResume(f.scan,"deep"),/resume_unrecognized_checkpoint/);
  } finally {cleanup(f.root);}
});

test("Standard discovery recovery accepts pending candidates without prematurely constructing report shards", () => {
  const f = fixture();
  try {
    const artifacts = path.join(f.scan, "portable-codex-security-artifacts");
    fs.renameSync(path.join(artifacts, "discovery-001"), path.join(artifacts, "discovery"));
    fs.rmSync(path.join(artifacts, "dataflow"), { recursive: true });
    const runtimePath = path.join(f.scan, "portable-codex-security-runtime.json");
    const runtime = JSON.parse(fs.readFileSync(runtimePath, "utf8"));
    fs.writeFileSync(runtimePath, JSON.stringify({ ...runtime, stage: "discovery" }));
    const result = preflightPortableResume(f.scan, "standard");
    assert.equal(result.completed, 1);
    assert.equal(result.dossier.candidates.length, 1);
    assert.equal(result.verifiedStages.report, 0);
  } finally { cleanup(f.root); }
});


test("full-coverage Standard resumes persisted discovery and paginated assessments without changing checkpoints", () => {
  const f = fixture(48);
  try {
    resolveDeepPlan({ snapshotRoot: f.snapshot.snapshotRoot, snapshotId: f.snapshot.snapshotId,
      outputDir: f.scan, resume: false, mode: "standard" });
    f.write("validation-01-part-01", "05-validation.json", "validation", { assessments: f.assessments.slice(0, 8) });
    const planFile = path.join(f.scan, STANDARD_PLAN_FILE);
    const discoveryFile = path.join(f.scan, "portable-codex-security-artifacts/discovery-001/03-discovery.json");
    const planBefore = fs.readFileSync(planFile, "utf8");
    const discoveryBefore = fs.readFileSync(discoveryFile, "utf8");
    const result = preflightPortableResume(f.scan, "standard");
    assert.equal(result.completed, 1);
    assert.equal(result.totalBatches, 1);
    assert.equal(result.verifiedStages.dataflow, 2);
    assert.equal(result.verifiedStages.validation, 1);
    assert.equal(result.dossier.candidates.length, 48);
    assert.equal(fs.readFileSync(planFile, "utf8"), planBefore);
    assert.equal(fs.readFileSync(discoveryFile, "utf8"), discoveryBefore);
  } finally { cleanup(f.root); }
});

test("full-coverage Standard preserves missing discovery batches as pending and requires them before validation", () => {
  const f = fixture(1, 40);
  try {
    const plan = resolveDeepPlan({ snapshotRoot: f.snapshot.snapshotRoot, snapshotId: f.snapshot.snapshotId,
      outputDir: f.scan, resume: false, mode: "standard" });
    assert.ok(plan.partitions.length > 1);
    f.write("discovery-001", "03-discovery.json", "discovery", {
      scope: { inspected: plan.partitions[0]!.paths, unexamined: [] }, candidates: [],
    });
    fs.rmSync(path.join(f.scan, "portable-codex-security-artifacts/dataflow"), { recursive: true });
    const runtimePath = path.join(f.scan, "portable-codex-security-runtime.json");
    const runtime = JSON.parse(fs.readFileSync(runtimePath, "utf8"));
    fs.writeFileSync(runtimePath, JSON.stringify({ ...runtime, stage: "discovery" }));
    const result = preflightPortableResume(f.scan, "standard");
    assert.equal(result.completed, 1);
    assert.equal(result.totalBatches, plan.partitions.length);
    assert.equal(result.verifiedStages.dataflow, 0);
    assert.equal(result.verifiedStages.report, 0);
    fs.writeFileSync(runtimePath, JSON.stringify({ ...runtime, stage: "validation" }));
    assert.throws(() => preflightPortableResume(f.scan, "standard"), /resume_missing_prerequisite_checkpoint/);
  } finally { cleanup(f.root); }
});

test("full-coverage Standard rejects a corrupted plan instead of reverting to legacy discovery", () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.scan, STANDARD_PLAN_FILE), JSON.stringify({ version: 1, snapshotId: "other-snapshot" }));
    assert.throws(() => preflightPortableResume(f.scan, "standard"), /deep_plan_invalid/);
  } finally { cleanup(f.root); }
});
