import assert from "node:assert/strict";
import test from "node:test";
import type { GateRun, GitHubMonitorEvent, GitHubMonitorRule, GuardrailRepository } from "@csb/shared";
import type { AcceptedGateTargetPreview, GateTargetPreview } from "./guardrails/target-preview.js";
import { automaticGitHubScanDispatcher } from "./github-monitor-dispatch.js";

function fixture(pauseOnAccept = false) {
  const headSha = "a".repeat(40);
  const repository = { source: "github", enabled: true, repositoryKey: "github:1", githubConnectionId: "c", githubInstallationId: "i", githubRepositoryId: "1" } as GuardrailRepository;
  const rule = { id: "r", repositoryKey: "github:1", connectionId: "c", installationId: "i", repositoryId: "1", revision: 1, enabled: true, executor: "sentinel-managed", costCeilingUsd: 3, scanner: { engine: "codex-security", mode: "standard", connection: { connectionId: "provider", modelSelectionMode: "catalog", modelId: "model" } } } as GitHubMonitorRule;
  const event = { id: "e", ruleId: "r", repositoryKey: "github:1", ruleRevision: 1, headSha } as GitHubMonitorEvent;
  const target = { kind: "pull_request" as const, number: 1 };
  let preview = { resolvedTarget: { headSha }, costBudget: { maxCostUsd: 3 }, executorCapability: { ready: true } } as GateTargetPreview;
  const calls: string[] = [];
  const start = automaticGitHubScanDispatcher({
    getRepository: () => repository,
    getRule: () => rule,
    preview: async (_repo, request) => { calls.push("preview"); if (rule.executor === "sentinel-managed") assert.deepEqual(request.scanSelection?.costLimit, { kind: "manual", maxCostUsd: 3 }); else assert.equal(request.scanSelection, undefined); return preview; },
    accept: async () => { if (pauseOnAccept) rule.enabled = false; return preview as AcceptedGateTargetPreview; },
    startManaged: async () => { calls.push("managed"); return { id: "gate" } as GateRun; },
    startActions: async (_preview, key) => { assert.equal(key, "e"); calls.push("actions"); return { id: "gate" } as GateRun; },
  });
  return { rule, event, target, calls, start, setPreview: (patch: Partial<GateTargetPreview>) => { preview = { ...preview, ...patch }; } };
}

test("automatic managed scans carry the rule ceiling into frozen preflight", async () => {
  const f = fixture();
  assert.deepEqual(await f.start(f), { gateId: "gate", headSha: "a".repeat(40) });
  assert.deepEqual(f.calls, ["preview", "managed"]);
});

test("a newer head or changed authority never dispatches paid work", async () => {
  const f = fixture();
  f.event.headSha = "b".repeat(40);
  await assert.rejects(f.start(f), /head_superseded/);
  assert.deepEqual(f.calls, ["preview"]);
  f.event.ruleRevision = 2;
  await assert.rejects(f.start(f), /monitor_authority_invalid/);
  assert.deepEqual(f.calls, ["preview"]);
});

test("Actions automation uses protected policy only if its ceiling fits the rule", async () => {
  const f = fixture();
  f.rule.executor = "github-actions";
  f.rule.scanner = null;
  f.setPreview({ costBudget: { source: "policy", maxCostUsd: 8, kind: "estimated_ceiling", requestInFlightMayExceed: true } });
  await assert.rejects(f.start(f), /monitor_policy_budget_exceeds_rule/);
  assert.deepEqual(f.calls, ["preview"]);
  f.setPreview({ costBudget: { source: "policy", maxCostUsd: 2, kind: "estimated_ceiling", requestInFlightMayExceed: true } });
  await f.start(f);
  assert.deepEqual(f.calls, ["preview", "preview", "actions"]);
});


test("pausing automation during preflight prevents the pending dispatch", async () => {
  const f = fixture(true);
  await assert.rejects(f.start(f), /monitor_rule_changed/);
  assert.deepEqual(f.calls, ["preview"]);
});
