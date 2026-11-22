import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ScanRun } from "@csb/shared";
import type { AgentEvent, AgentSession } from "../agent/session-types.js";
import type { GraphIndex } from "../graphify/graph-index.js";
import {
  BUSINESS_LOGIC_ARTIFACT, extractBusinessFlows, runBusinessLogicPass, scanBusinessLogic, writeBusinessLogicRecord,
  type BusinessLogicPassInput,
} from "./portable-business-logic.js";

const ORDERS = [
  "export async function refundOrder(req) {",
  "  const order = await loadOrder(req.params.id);",
  "  return issueRefund(order);",
  "}",
  "function loadOrder(id) {",
  "  return db.orders.find(id);",
  "}",
].join("\n") + "\n";
const PAYMENTS = ["export function issueRefund(order) {", "  return gateway.refund(order.total);", "}"].join("\n") + "\n";

function scanDir(orders = ORDERS): { dir: string; snapshot: string; results: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "business-logic-"));
  const snapshot = path.join(dir, "portable-codex-security-snapshot");
  fs.mkdirSync(path.join(snapshot, "src/routes"), { recursive: true });
  fs.mkdirSync(path.join(snapshot, "src/services"), { recursive: true });
  fs.writeFileSync(path.join(snapshot, "src/routes/orders.ts"), orders);
  fs.writeFileSync(path.join(snapshot, "src/services/payments.ts"), PAYMENTS);
  fs.writeFileSync(path.join(snapshot, "src/util.ts"), "export const x = 1;\n");
  return { dir, snapshot, results: path.join(dir, "portable-codex-security-results") };
}

const GRAPH: GraphIndex = {
  nodes: [
    { id: "refund", label: "refundOrder()", file: "src/routes/orders.ts", location: "L1" },
    { id: "load", label: "loadOrder()", file: "src/routes/orders.ts", location: "L5" },
    { id: "issue", label: "issueRefund()", file: "src/services/payments.ts", location: "L1" },
    { id: "x", label: "x", file: "src/util.ts", location: "L1" },
  ],
  edges: [
    { source: "refund", target: "load", relation: "calls", confidence: "EXTRACTED" },
    { source: "refund", target: "issue", relation: "calls", confidence: "EXTRACTED" },
    { source: "refund", target: "x", relation: "calls", confidence: "INFERRED" },
  ],
};

function run(dir: string, id = "scan-1"): ScanRun {
  return { id, scanDir: dir, engine: "codex-security", execution: { executionProfile: "portable" } } as unknown as ScanRun;
}

const ARTIFACT = {
  schemaVersion: 1, stage: "business-logic", summary: "ok",
  flows: [{ flowId: "flow-01", status: "issues", summary: "Refund is repeatable.", missingEvidence: [], findings: [
    { title: "Repeatable refund", ruleKind: "idempotency-and-races", severity: "high", claim: "No refundedAt check before issueRefund.",
      impact: "Duplicate refunds.", evidence: [
        { path: "src/routes/orders.ts", startLine: 2, endLine: 3, role: "entrypoint", explanation: "loads then refunds" },
        { path: "src/services/payments.ts", startLine: 2, endLine: 2, role: "sink" },
      ] },
    { title: "Uncited", ruleKind: "authorization", severity: "medium", claim: "Bogus.", evidence: [{ path: "src/nope.ts", startLine: 1, endLine: 1 }] },
  ] }],
};

function pass(input: Partial<BusinessLogicPassInput> & Pick<BusinessLogicPassInput, "flows" | "snapshotRoot">, sessions: string[] = [],
  artifact: unknown = ARTIFACT, costPerUsage = 0.1): BusinessLogicPassInput {
  let spent = 0;
  return {
    artifactsRoot: fs.mkdtempSync(path.join(os.tmpdir(), "business-logic-artifacts-")),
    reuseSources: [],
    budgetUsd: null,
    async startSession(instructions, artifactRoot): Promise<AgentSession> {
      sessions.push(instructions);
      return {
        async *run(): AsyncIterable<AgentEvent> {
          yield { type: "usage", usage: {} } as AgentEvent;
          fs.writeFileSync(path.join(artifactRoot, BUSINESS_LOGIC_ARTIFACT), JSON.stringify(artifact));
          yield { type: "completion", text: null, structured: null };
        },
        async cancel() { return { remote: false }; },
      };
    },
    observeUsage() { spent += costPerUsage; return spent; },
    ...input,
  };
}

test("flows follow extracted Graphify call chains from business entry points", () => {
  const { snapshot } = scanDir();
  const flows = extractBusinessFlows(GRAPH, snapshot);
  assert.equal(flows.length, 1);
  assert.equal(flows[0]!.source, "graphify");
  assert.deepEqual(flows[0]!.steps.map((s) => [s.path, s.startLine, s.endLine, s.symbol]), [
    ["src/routes/orders.ts", 1, 4, "refundOrder"],
    ["src/services/payments.ts", 1, 3, "issueRefund"],
    ["src/routes/orders.ts", 5, 7, "loadOrder"],
  ]);
});

test("without a graph, route and domain files from the snapshot become code-context flows", () => {
  const { snapshot } = scanDir();
  const flows = extractBusinessFlows(undefined, snapshot);
  assert.deepEqual(flows.map((f) => [f.source, f.entry]), [["code-context", "src/routes/orders.ts"], ["code-context", "src/services/payments.ts"]]);
  assert.deepEqual(extractBusinessFlows(undefined, snapshot, ["src/services"]).map((f) => f.entry), ["src/services/payments.ts"]);
});

test("the AI pass runs without any SAST alert, supplies flow source and gates findings on snapshot citations", async () => {
  const { dir, snapshot, results } = scanDir();
  const flows = extractBusinessFlows(GRAPH, snapshot);
  const sessions: string[] = [];
  const record = await runBusinessLogicPass(pass({ flows, snapshotRoot: snapshot, budgetUsd: 1 }, sessions));
  assert.equal(sessions.length, 1);
  assert.match(sessions[0]!, /do NOT report injection/);
  assert.match(sessions[0]!, /return gateway\.refund\(order\.total\);/);
  assert.equal(record.totals.analyzed, 1);
  assert.equal(record.totals.spentUsd, 0.1);
  writeBusinessLogicRecord(results, record);
  const view = scanBusinessLogic(run(dir));
  assert.equal(view.available, true);
  assert.equal(view.flows[0]!.status, "issues");
  assert.deepEqual(view.flows[0]!.findings.map((f) => [f.title, f.status, f.downgraded]), [["Repeatable refund", "confirmed", false], ["Uncited", "inconclusive", true]]);
  assert.equal(view.flows[0]!.findings[0]!.citations[1]!.excerpt, "  return gateway.refund(order.total);");
  assert.deepEqual({ issues: view.counts.issues, findings: view.counts.findings, downgraded: view.counts.downgraded }, { issues: 1, findings: 1, downgraded: 1 });
});

test("a flow whose only findings lack valid citations is shown as inconclusive", async () => {
  const { dir, snapshot, results } = scanDir();
  const flows = extractBusinessFlows(GRAPH, snapshot);
  const uncited = { ...ARTIFACT, flows: [{ ...ARTIFACT.flows[0]!, findings: [ARTIFACT.flows[0]!.findings[1]!] }] };
  writeBusinessLogicRecord(results, await runBusinessLogicPass(pass({ flows, snapshotRoot: snapshot }, [], uncited)));
  assert.equal(scanBusinessLogic(run(dir)).flows[0]!.status, "inconclusive");
});

test("the pass stops at its budget and marks remaining flows as skipped instead of failing the scan", async () => {
  const { snapshot } = scanDir();
  const flows = extractBusinessFlows(undefined, snapshot);
  const many = Array.from({ length: 9 }, (_, i) => ({ ...flows[0]!, id: `flow-${String(i + 1).padStart(2, "0")}`, key: `k${i}` }));
  const sessions: string[] = [];
  const record = await runBusinessLogicPass(pass({ flows: many, snapshotRoot: snapshot, budgetUsd: 0.05 }, sessions));
  assert.equal(sessions.length, 1);
  assert.equal(record.totals.skippedBudget, 9);
  assert.ok(record.flows.every((f) => f.status === "skipped-budget"));
  const none = await runBusinessLogicPass(pass({ flows: many, snapshotRoot: snapshot, budgetUsd: 0 }, sessions));
  assert.equal(sessions.length, 1);
  assert.equal(none.totals.skippedBudget, 9);
});

test("unchanged flow evidence reuses the earlier analysis; a changed step is analyzed again", async () => {
  const prior = scanDir();
  const flows = extractBusinessFlows(GRAPH, prior.snapshot);
  const cited = { ...ARTIFACT, flows: [{ ...ARTIFACT.flows[0]!, findings: [ARTIFACT.flows[0]!.findings[0]!] }] };
  writeBusinessLogicRecord(prior.results, await runBusinessLogicPass(pass({ flows, snapshotRoot: prior.snapshot, budgetUsd: 1 }, [], cited)));

  const same = scanDir();
  const sessions: string[] = [];
  const reused = await runBusinessLogicPass(pass({ flows: extractBusinessFlows(GRAPH, same.snapshot), snapshotRoot: same.snapshot,
    reuseSources: [run(prior.dir, "prior")], budgetUsd: 1 }, sessions));
  assert.equal(sessions.length, 0);
  assert.equal(reused.totals.reused, 1);
  assert.equal(reused.totals.estimatedCostAvoidedUsd, 0.1);
  assert.deepEqual(reused.flows[0]!.reusedFrom, { scanId: "prior", flowId: "flow-01" });
  assert.equal(reused.flows[0]!.findings.length, 1);

  const changed = scanDir(ORDERS.replace("return issueRefund(order);", "if (!order.refundedAt) return issueRefund(order);"));
  const again = await runBusinessLogicPass(pass({ flows: extractBusinessFlows(GRAPH, changed.snapshot), snapshotRoot: changed.snapshot,
    reuseSources: [run(prior.dir, "prior")], budgetUsd: 1 }, sessions));
  assert.equal(sessions.length, 1);
  assert.equal(again.totals.reused, 0);
});

test("an artifact that does not parse marks the page as failed", async () => {
  const { snapshot } = scanDir();
  const record = await runBusinessLogicPass(pass({ flows: extractBusinessFlows(GRAPH, snapshot), snapshotRoot: snapshot }, [], { schemaVersion: 2 }));
  assert.equal(record.totals.failed, 1);
});
