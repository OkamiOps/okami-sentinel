import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { preflightPortableResume } from "./resume-portable-scan.js";
import { createPortableCodexSecuritySnapshot } from "./portable-codex-security-worker-support.js";

function fixture(candidateCount = 1) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "resume-checkpoint-test-"));
  const source = path.join(root, "source"); const scan = path.join(root, "scan");
  fs.mkdirSync(source); fs.mkdirSync(scan);
  fs.writeFileSync(path.join(source, "route.ts"), "export const route = 1;\n");
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
    fs.writeFileSync(path.join(target, file), JSON.stringify({schemaVersion:1, stage, summary: `Verified ${stage} checkpoint`, observations: [], ...extra}));
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
