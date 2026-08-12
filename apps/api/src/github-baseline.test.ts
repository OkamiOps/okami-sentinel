import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  buildGateArtifactV2,
  buildScanLineage,
  defaultGuardrailPolicy,
} from "@csb/gate-core";
import type { GateArtifactV2 } from "@csb/shared";

import {
  BaselineUnavailableError,
  GitHubBaselineProvider,
  type GitHubBaselineAuthority,
} from "./github-baseline.js";

const SHA_OLD = "a".repeat(40);
const SHA_NEW = "b".repeat(40);

test("selects only a validated v2 protected-branch artifact through App authority", async () => {
  const oldArtifact = artifactFixture("7001", SHA_OLD);
  const newArtifact = artifactFixture("7002", SHA_NEW, { repositoryId: "other" });
  const authority = authorityFixture([
    runFixture("7002", SHA_NEW, "2026-08-12T13:00:00.000Z"),
    runFixture("7001", SHA_OLD, "2026-08-12T12:00:00.000Z"),
  ], { "7002": newArtifact, "7001": oldArtifact });

  const baseline = await new GitHubBaselineProvider(authority).getBaseline(context());

  assert.equal(baseline?.gateId, oldArtifact.gateId);
  assert.equal(baseline?.resolvedTarget.headSha, SHA_OLD);
  assert.equal(authority.calls.every((call) => call.permissions.actions === "read"), true);
  assert.equal(authority.calls.some((call) => call.path.includes("event=push")), true);
});

test("returns null when the protected branch has no completed v2 history", async () => {
  const authority = authorityFixture([], {});
  assert.equal(await new GitHubBaselineProvider(authority).getBaseline(context()), null);
  assert.equal(authority.downloads.length, 0);
});

test("fails closed for malformed history instead of bootstrapping", async () => {
  const authority = authorityFixture([], {});
  authority.history = { workflow_runs: [{ id: 7001, event: "push" }] };
  await assert.rejects(
    new GitHubBaselineProvider(authority).getBaseline(context()),
    (error: unknown) => error instanceof BaselineUnavailableError
      && /runs v2 válidos/.test(error.message),
  );
});

test("rejects ambiguous artifacts for one persisted workflow run", async () => {
  const artifact = artifactFixture("7001", SHA_OLD);
  const authority = authorityFixture(
    [runFixture("7001", SHA_OLD, "2026-08-12T12:00:00.000Z")],
    { "7001": artifact },
  );
  authority.artifactLists.set("7001", {
    artifacts: [
      artifactMetadata("9001", archiveFixture(artifact)),
      artifactMetadata("9002", archiveFixture(artifact)),
    ],
  });

  await assert.rejects(
    new GitHubBaselineProvider(authority).getBaseline(context()),
    (error: unknown) => error instanceof BaselineUnavailableError
      && /ambíguo/.test(error.message),
  );
  assert.equal(authority.downloads.length, 0);
});

test("rejects history that only contains an artifact for another repository", async () => {
  const authority = authorityFixture(
    [runFixture("7001", SHA_OLD, "2026-08-12T12:00:00.000Z")],
    { "7001": artifactFixture("7001", SHA_OLD, { repositoryId: "other" }) },
  );
  await assert.rejects(
    new GitHubBaselineProvider(authority).getBaseline(context()),
    (error: unknown) => error instanceof BaselineUnavailableError
      && /identidade v2 incompatível/.test(error.message),
  );
});

function context() {
  return {
    repositoryKey: "github:991122",
    owner: "OkamiOps",
    name: "private-sentinel",
    defaultBranch: "main",
    connectionId: "connection-1",
    installationId: "77",
    repositoryId: "991122",
  };
}

function runFixture(id: string, headSha: string, createdAt: string) {
  return {
    id: Number(id),
    run_attempt: 1,
    event: "push",
    status: "completed",
    conclusion: "success",
    head_branch: "main",
    head_sha: headSha,
    created_at: createdAt,
    path: ".github/workflows/csb-security-change-gate.yml",
  };
}

function authorityFixture(
  runs: unknown[],
  artifacts: Record<string, GateArtifactV2>,
): GitHubBaselineAuthority & {
  history: unknown;
  calls: Array<{ path: string; permissions: { actions: "read" } }>;
  downloads: string[];
  artifactLists: Map<string, unknown>;
} {
  const calls: Array<{ path: string; permissions: { actions: "read" } }> = [];
  const downloads: string[] = [];
  const archives = new Map<string, Uint8Array>();
  const artifactLists = new Map<string, unknown>();
  let artifactIndex = 9000;
  for (const [runId, artifact] of Object.entries(artifacts)) {
    const archive = archiveFixture(artifact);
    const artifactId = String(++artifactIndex);
    archives.set(artifactId, archive);
    artifactLists.set(runId, { artifacts: [artifactMetadata(artifactId, archive)] });
  }
  const authority = {
    history: { workflow_runs: runs },
    calls,
    downloads,
    artifactLists,
    readAuthorizedRepositoryJson: async (
      _connectionId: string,
      _installationId: string,
      _repositoryId: string,
      resourcePath: string,
      permissions: { actions: "read" },
    ) => {
      calls.push({ path: resourcePath, permissions });
      if (resourcePath.includes("/runs?")) return authority.history;
      const runId = /\/actions\/runs\/(\d+)\/artifacts/.exec(resourcePath)?.[1];
      return runId === undefined ? { artifacts: [] } : artifactLists.get(runId) ?? { artifacts: [] };
    },
    downloadAuthorizedRepositoryBytes: async (
      _connectionId: string,
      _installationId: string,
      _repositoryId: string,
      resourcePath: string,
      permissions: { actions: "read" },
    ) => {
      calls.push({ path: resourcePath, permissions });
      downloads.push(resourcePath);
      const artifactId = /\/actions\/artifacts\/(\d+)\/zip/.exec(resourcePath)?.[1];
      const archive = artifactId === undefined ? undefined : archives.get(artifactId);
      if (archive === undefined) throw new Error("artifact_missing");
      return archive;
    },
  };
  return authority;
}

function artifactMetadata(id: string, archive: Uint8Array) {
  return {
    id: Number(id),
    name: "csb-gate-artifact-v2",
    expired: false,
    digest: digest(archive),
  };
}

function artifactFixture(
  workflowRunId: string,
  headSha: string,
  overrides: { repositoryId?: string } = {},
): GateArtifactV2 {
  const repositoryId = overrides.repositoryId ?? "991122";
  const policy = defaultGuardrailPolicy();
  const lineage = buildScanLineage({
    engine: "codex-security",
    engineVersion: "1",
    route: "openai-api",
    protocol: "openai-responses",
    provider: "openai",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    methodology: "codex-security",
    profile: "portable",
    recipeHash: `sha256:${"1".repeat(64)}`,
    sourceRevision: `sha256:${"2".repeat(64)}`,
  });
  return buildGateArtifactV2({
    gateId: `gate-${workflowRunId}`,
    repository: {
      id: `github:${repositoryId}`,
      key: `github:${repositoryId}`,
      owner: "OkamiOps",
      name: "private-sentinel",
      defaultBranch: "main",
      locator: {
        kind: "github",
        repositoryId,
        owner: "OkamiOps",
        name: "private-sentinel",
      },
    },
    source: "github",
    executor: "github-actions",
    target: { kind: "protected_branch", ref: "main" },
    resolvedTarget: {
      baseRef: "main",
      headRef: "main",
      baseSha: headSha,
      headSha,
      policySha: headSha,
      pullRequestNumber: null,
    },
    policySource: "protected_branch",
    changeSet: {
      baseRef: "main",
      headRef: "main",
      baseSha: headSha,
      headSha,
      files: [],
      scanPaths: [],
      scopeMode: "repository",
      fallbackReason: null,
    },
    policy,
    scan: { id: `scan-${workflowRunId}`, cost: null, status: "completed" },
    baselineCommit: null,
    evaluation: {
      deltas: [],
      decision: {
        outcome: "bootstrap",
        summary: "Protected baseline initialized.",
        violations: [],
        warnings: [],
        exceptionsApplied: [],
        githubConclusion: "neutral",
      },
    },
    lineage,
    coverage: {
      status: "complete",
      repositoryFileCount: 1,
      inspectedFileCount: 1,
      unexaminedFileCount: 0,
      submodules: [],
      lfsPointers: [],
    },
    snapshot: {
      identity: `sha256:${"3".repeat(64)}`,
      materializerVersion: "github-actions-tree-v1",
    },
    workflowRun: { id: workflowRunId, attempt: 1 },
    versions: { gateCore: "0.1.0", scanner: "1" },
    createdAt: "2026-08-12T12:02:00.000Z",
  });
}

function archiveFixture(artifact: GateArtifactV2): Uint8Array {
  const artifactBytes = Buffer.from(`${JSON.stringify(artifact)}\n`);
  const manifestBytes = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    gateId: artifact.gateId,
    workflowRunId: artifact.workflowRun!.id,
    workflowRunAttempt: artifact.workflowRun!.attempt,
    headSha: artifact.resolvedTarget.headSha,
    artifactSha256: createHash("sha256").update(artifactBytes).digest("hex"),
  })}\n`);
  return storedZip([
    ["csb-gate-result.json", artifactBytes],
    ["csb-gate-manifest.json", manifestBytes],
  ]);
}

function storedZip(entries: ReadonlyArray<readonly [string, Buffer]>): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, contents] of entries) {
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(contents.length, 18);
    local.writeUInt32LE(contents.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    nameBytes.copy(local, 30);
    locals.push(local, contents);
    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(contents.length, 20);
    central.writeUInt32LE(contents.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBytes.copy(central, 46);
    centrals.push(central);
    offset += local.length + contents.length;
  }
  const central = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, eocd]);
}

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
