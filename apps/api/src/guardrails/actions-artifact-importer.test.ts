import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  buildGateArtifactV2,
  buildScanLineage,
  defaultGuardrailPolicy,
} from "@csb/gate-core";
import type { GateArtifactV2, GateRun, GuardrailRepository } from "@csb/shared";

import type {
  GitHubActionsArtifactMetadata,
  GitHubActionsDispatchMetadata,
  GateRunUpdate,
} from "../gate-store.js";
import {
  ActionsArtifactImporter,
  type ActionsArtifactImporterStore,
  parseActionsArtifactArchive,
} from "./actions-artifact-importer.js";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);

test("validates the GitHub digest, internal manifest and GateArtifact v2 together", () => {
  const artifact = artifactFixture();
  const archive = archiveFixture(artifact);
  const bundle = parseActionsArtifactArchive(archive, digest(archive));

  assert.equal(bundle.artifact.gateId, "gate-actions-1");
  assert.equal(bundle.manifest.workflowRunId, "7001");
  assert.throws(
    () => parseActionsArtifactArchive(archive, `sha256:${"0".repeat(64)}`),
    /actions_artifact_digest_invalid/,
  );
});

test("imports only an artifact bound to the persisted run and is idempotent", () => {
  const fixture = importerFixture();
  const archive = archiveFixture(fixture.artifact);
  const first = fixture.importer.import({
    artifactId: fixture.metadata.id,
    gateId: fixture.gate.id,
    githubDigest: digest(archive),
    archive,
  });

  assert.equal(first.applied, true);
  assert.equal(first.duplicate, false);
  assert.equal(fixture.writes.length, 1);
  assert.equal(fixture.gate.status, "completed");
  assert.equal(fixture.metadata.status, "validated");

  const second = fixture.importer.import({
    artifactId: fixture.metadata.id,
    gateId: fixture.gate.id,
    githubDigest: digest(archive),
    archive,
  });
  assert.equal(second.duplicate, true);
  assert.equal(fixture.writes.length, 1);
});

test("a duplicate import rejects swapped content instead of accepting a new digest", () => {
  const fixture = importerFixture();
  const original = archiveFixture(fixture.artifact);
  fixture.importer.import({
    artifactId: fixture.metadata.id,
    gateId: fixture.gate.id,
    githubDigest: digest(original),
    archive: original,
  });
  const swapped = archiveFixture({
    ...fixture.artifact,
    decision: { ...fixture.artifact.decision, summary: "Swapped valid content." },
  });
  assert.throws(() => fixture.importer.import({
    artifactId: fixture.metadata.id,
    gateId: fixture.gate.id,
    githubDigest: digest(swapped),
    archive: swapped,
  }), /actions_artifact_identity_invalid/);
  assert.equal(fixture.writes.length, 1);
});

test("rejects a swapped workflow identity before writing any gate artifact", () => {
  const fixture = importerFixture();
  const archive = archiveFixture({
    ...fixture.artifact,
    workflowRun: { id: "7999", attempt: 1 },
  });

  assert.throws(() => fixture.importer.import({
    artifactId: fixture.metadata.id,
    gateId: fixture.gate.id,
    githubDigest: digest(archive),
    archive,
  }), /actions_artifact_identity_invalid/);
  assert.equal(fixture.writes.length, 0);
  assert.equal(fixture.metadata.status, "pending");
  assert.equal(fixture.gate.status, "scanning");
});

test("keeps a cancelled gate terminal when a valid artifact arrives late", () => {
  const fixture = importerFixture({ status: "cancelled", completedAt: "2026-08-12T12:04:00.000Z" });
  const archive = archiveFixture(fixture.artifact);
  const result = fixture.importer.import({
    artifactId: fixture.metadata.id,
    gateId: fixture.gate.id,
    githubDigest: digest(archive),
    archive,
  });

  assert.equal(result.applied, false);
  assert.equal(fixture.writes.length, 0);
  assert.equal(fixture.gate.status, "cancelled");
  assert.equal(fixture.gate.artifactPath, null);
  assert.equal(fixture.metadata.status, "validated");
  assert.equal(fixture.dispatch.state, "cancelled");
});

function importerFixture(gateOverrides: Partial<GateRun> = {}) {
  const repository = repositoryFixture();
  const artifact = artifactFixture();
  const gate: GateRun = {
    id: artifact.gateId,
    repositoryKey: repository.repositoryKey,
    repositoryPath: null,
    source: "github",
    executor: "github-actions",
    baseRef: "main",
    headRef: "feature/security",
    resolvedBaseSha: BASE,
    resolvedHeadSha: HEAD,
    policySha: BASE,
    pullRequestNumber: 42,
    workflowRunId: "7001",
    materializationState: "not_required",
    scanLineageHash: null,
    artifactSchemaVersion: 2,
    scanId: null,
    status: "scanning",
    outcome: null,
    policyVersion: 1,
    baselineCommit: null,
    artifactPath: null,
    publishStatus: "waiting",
    publishError: null,
    publishedAt: null,
    error: null,
    costCeilingUsd: 18,
    estimatedUsd: 0,
    startedAt: "2026-08-12T12:00:00.000Z",
    completedAt: null,
    ...gateOverrides,
  };
  const dispatch: GitHubActionsDispatchMetadata = {
    gateId: gate.id,
    repositoryKey: gate.repositoryKey,
    idempotencyKey: "idempotency-actions-0001",
    requestFingerprint: `sha256:${"c".repeat(64)}`,
    connectionId: "connection-1",
    installationId: "77",
    repositoryId: "991122",
    workflowPath: ".github/workflows/csb-security-change-gate.yml",
    workflowRef: "main",
    releaseSha: "d".repeat(40),
    targetKind: "pull_request",
    protectedBranch: "main",
    expectedRunName: `CSB gate ${gate.id} · ${HEAD}`,
    expectedHeadSha: HEAD,
    state: gate.status === "cancelled" ? "cancelled" : "artifact_pending",
    workflowRunId: "7001",
    workflowRunAttempt: 1,
    requestedAt: "2026-08-12T12:00:00.000Z",
    dispatchedAt: "2026-08-12T12:00:01.000Z",
    lastPolledAt: "2026-08-12T12:03:00.000Z",
    completedAt: gate.completedAt,
    error: null,
  };
  const archive = archiveFixture(artifact);
  const metadata: GitHubActionsArtifactMetadata = {
    id: "github-actions:9001",
    gateId: gate.id,
    repositoryKey: gate.repositoryKey,
    workflowRunId: "7001",
    workflowRunAttempt: 1,
    artifactName: "csb-gate-artifact-v2",
    artifactDigest: digest(archive),
    artifactSchemaVersion: 2,
    status: "pending",
    createdAt: "2026-08-12T12:03:00.000Z",
    validatedAt: null,
  };
  const writes: GateArtifactV2[] = [];
  const store: ActionsArtifactImporterStore = {
    getGateRun: () => gate,
    getRepository: () => repository,
    getDispatch: () => dispatch,
    getArtifact: () => metadata,
    finalize: (input) => {
      metadata.status = input.artifactStatus;
      metadata.validatedAt = input.validatedAt;
      if (input.gateUpdates) Object.assign(gate, input.gateUpdates as GateRunUpdate);
      Object.assign(dispatch, input.dispatchUpdates);
    },
  };
  const importer = new ActionsArtifactImporter({
    store,
    writeArtifact: (_gateId, value) => {
      writes.push(value);
      return "/managed/gates/gate-actions-1/csb-gate-result.json";
    },
    now: () => "2026-08-12T12:05:00.000Z",
  });
  return { artifact, gate, dispatch, metadata, writes, importer };
}

function artifactFixture(): GateArtifactV2 {
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
    gateId: "gate-actions-1",
    repository: {
      id: "github:991122",
      key: "github:991122",
      owner: "OkamiOps",
      name: "private-sentinel",
      defaultBranch: "main",
      locator: {
        kind: "github",
        repositoryId: "991122",
        owner: "OkamiOps",
        name: "private-sentinel",
      },
    },
    source: "github",
    executor: "github-actions",
    target: { kind: "pull_request", number: 42 },
    resolvedTarget: {
      baseRef: "main",
      headRef: "feature/security",
      baseSha: BASE,
      headSha: HEAD,
      policySha: BASE,
      pullRequestNumber: 42,
    },
    policySource: "base",
    changeSet: {
      baseRef: "main",
      headRef: "feature/security",
      baseSha: BASE,
      headSha: HEAD,
      files: [{
        status: "modified",
        path: "src/security.ts",
        previousPath: null,
        additions: 1,
        deletions: 0,
      }],
      scanPaths: ["src/security.ts"],
      scopeMode: "changed",
      fallbackReason: null,
    },
    policy,
    scan: { id: "scan-actions-1", cost: null, status: "completed" },
    baselineCommit: BASE,
    evaluation: {
      deltas: [],
      decision: {
        outcome: "pass",
        summary: "No policy violations.",
        violations: [],
        warnings: [],
        exceptionsApplied: [],
        githubConclusion: "success",
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
    workflowRun: { id: "7001", attempt: 1 },
    versions: { gateCore: "0.1.0", scanner: "1" },
    createdAt: "2026-08-12T12:02:00.000Z",
  });
}

function repositoryFixture(): GuardrailRepository {
  return {
    repositoryKey: "github:991122",
    repositoryPath: null,
    source: "github",
    displayName: "OkamiOps/private-sentinel",
    defaultBranch: "main",
    defaultExecutor: "github-actions",
    remoteOwner: "OkamiOps",
    remoteName: "private-sentinel",
    githubConnectionId: "connection-1",
    githubInstallationId: "77",
    githubRepositoryId: "991122",
    enabled: true,
    policyPath: ".csb/guardrails.json",
    lastGateId: null,
    githubStatus: "ready",
  };
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
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(contents.length, 18);
    local.writeUInt32LE(contents.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    nameBytes.copy(local, 30);
    locals.push(local, contents);

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
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
