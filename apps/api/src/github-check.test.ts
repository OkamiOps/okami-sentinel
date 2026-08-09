import assert from "node:assert/strict";
import test from "node:test";

import { defaultGuardrailPolicy } from "@csb/gate-core";
import type { GateArtifact, GateFindingDelta } from "@csb/shared";

import type { GhRunner } from "./github-cli.js";
import { publishGateCheck } from "./github-check.js";

function finding(
  identity: string,
  severity: GateFindingDelta["severity"],
  lifecycle: GateFindingDelta["lifecycle"],
  primaryPath = "src/report.ts:88",
): GateFindingDelta {
  return {
    findingId: identity,
    occurrenceId: null,
    identity,
    title: lifecycle === "reopened" ? "High reaberto" : `Finding ${identity}`,
    severity,
    confidence: "high",
    ruleId: "CSB-1",
    summary: `Evidence for ${identity}`,
    primaryPath,
    fingerprints: [identity],
    category: "authorization",
    cwe: ["CWE-862"],
    lifecycle,
    triage: { status: "confirmed", note: null, updatedAt: null },
    exception: null,
    sourceScanId: "scan-1",
  };
}

function blockedArtifact(): GateArtifact {
  const reopened = finding("reopened-high", "high", "reopened");
  return {
    schemaVersion: 1,
    gateId: "gate-1",
    repository: {
      key: "github.com/OkamiOps/okami-sentinel",
      owner: "OkamiOps",
      name: "okami-sentinel",
      defaultBranch: "main",
    },
    source: "local",
    changeSet: {
      baseRef: "main",
      headRef: "HEAD",
      baseSha: "base-sha",
      headSha: "head-sha",
      files: [{
        status: "modified",
        path: "src/report.ts",
        previousPath: null,
        additions: 4,
        deletions: 1,
      }],
      scanPaths: ["src/report.ts"],
      scopeMode: "changed",
      fallbackReason: null,
    },
    policy: defaultGuardrailPolicy(),
    scan: { id: "scan-1", cost: null, status: "completed" },
    baselineCommit: "base-sha",
    findings: [
      finding("fixed-low", "low", "fixed"),
      finding("new-critical", "critical", "new"),
      reopened,
      ...Array.from({ length: 22 }, (_, index) =>
        finding(`medium-${String(index).padStart(2, "0")}`, "medium", "persistent")),
    ],
    decision: {
      outcome: "blocked",
      summary: "A reopened high finding blocks this change.",
      violations: [{
        findingIdentity: reopened.identity,
        ruleIndex: 1,
        decision: "block",
        reason: "high/reopened",
      }],
      warnings: [],
      exceptionsApplied: [],
      githubConclusion: "failure",
      decisionGraph: { nodes: [], selectedNodeId: "verdict" },
    },
    versions: { gateCore: "0.1.0", scanner: null },
    createdAt: "2026-08-07T10:00:00.000Z",
  };
}

function recordingGh(result: { exitCode?: number; stderr?: string } = {}): {
  runner: GhRunner;
  calls: Array<{ args: string[]; cwd: string; stdin?: string }>;
} {
  const calls: Array<{ args: string[]; cwd: string; stdin?: string }> = [];
  return {
    calls,
    runner: async (args, options) => {
      calls.push({ args, ...options });
      return {
        stdout: "",
        stderr: result.stderr ?? "",
        exitCode: result.exitCode ?? 0,
      };
    },
  };
}

test("publishes a failure check for a blocked gate", async () => {
  const gh = recordingGh();
  const artifact = blockedArtifact();

  await publishGateCheck({
    artifact,
    owner: "OkamiOps",
    repository: "okami-sentinel",
    detailsUrl: null,
  }, gh.runner);

  assert.deepEqual(gh.calls[0]?.args, [
    "api",
    "--method",
    "POST",
    "repos/OkamiOps/okami-sentinel/check-runs",
    "--input",
    "-",
  ]);
  const payload = JSON.parse(gh.calls[0]?.stdin ?? "{}") as {
    name?: string;
    conclusion?: string;
    head_sha?: string;
    output?: { summary?: string; annotations?: Array<{ title?: string }> };
  };
  assert.equal(payload.name, "CSB Security Change Gate");
  assert.equal(payload.conclusion, "failure");
  assert.equal(payload.head_sha, artifact.changeSet.headSha);
  assert.ok(payload.output?.summary?.includes("High reaberto"));
  assert.equal(payload.output?.annotations?.length, 20);
  assert.deepEqual(
    payload.output?.annotations?.slice(0, 2).map((annotation) => annotation.title),
    ["Finding new-critical", "High reaberto"],
  );
});

test("never publishes absolute local paths", async () => {
  const gh = recordingGh();
  const artifact = blockedArtifact();
  artifact.findings[0]!.primaryPath = "/Users/marcos/private/src/report.ts:88";
  artifact.findings[0]!.summary = "Evidence at /Users/marcos/private/src/report.ts";
  artifact.decision.summary = "Generated from /Users/marcos/private";

  await publishGateCheck({
    artifact,
    owner: "OkamiOps",
    repository: "CSB",
    detailsUrl: null,
  }, gh.runner);

  assert.equal((gh.calls[0]?.stdin ?? "").includes("/Users/"), false);
});

test("reports a failed gh publication", async () => {
  const gh = recordingGh({ exitCode: 1, stderr: "GitHub API unavailable" });
  await assert.rejects(
    () => publishGateCheck({
      artifact: blockedArtifact(),
      owner: "OkamiOps",
      repository: "CSB",
      detailsUrl: null,
    }, gh.runner),
    /github.*unavailable/i,
  );
});
