import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import type { GateRun, GuardrailRepository } from "@csb/shared";
import {
  appendGateEvent,
  ensureGateSchema,
  getCachedGitHubBaseline,
  getGitHubActionsArtifact,
  getGateRun,
  getMaterializationLease,
  insertGateRun,
  listGateEvents,
  listGitHubAppConnections,
  listGitHubAppInstallations,
  listGitHubInstallationRepositories,
  listGatePublicationAttempts,
  listGateRuns,
  listGuardrailRepositories,
  recordGatePublicationAttempt,
  updateGateRun,
  upsertCachedGitHubBaseline,
  upsertGitHubActionsArtifact,
  upsertGitHubAppConnection,
  upsertGitHubAppInstallation,
  upsertGitHubInstallationRepository,
  upsertGuardrailRepository,
  upsertMaterializationLease,
} from "./gate-store.js";

function repositoryFixture(
  overrides: Partial<GuardrailRepository> = {},
): GuardrailRepository {
  return {
    repositoryKey: "github.com/okami/csb",
    repositoryPath: "/workspace/csb",
    source: "local",
    displayName: "Codex Security Benchmark",
    defaultBranch: "main",
    defaultExecutor: "sentinel-managed",
    remoteOwner: "okami",
    remoteName: "csb",
    githubConnectionId: null,
    githubInstallationId: null,
    githubRepositoryId: null,
    enabled: true,
    policyPath: ".csb/guardrails.json",
    lastGateId: null,
    githubStatus: "not_checked",
    ...overrides,
  };
}

function gateRunFixture(overrides: Partial<GateRun> = {}): GateRun {
  return {
    id: "gate-1",
    repositoryKey: "github.com/okami/csb",
    repositoryPath: "/workspace/csb",
    source: "local",
    executor: "sentinel-managed",
    baseRef: "main",
    headRef: "HEAD",
    resolvedBaseSha: null,
    resolvedHeadSha: null,
    policySha: null,
    pullRequestNumber: null,
    workflowRunId: null,
    materializationState: "not_required",
    scanLineageHash: null,
    artifactSchemaVersion: 1,
    scanId: null,
    status: "queued",
    outcome: null,
    policyVersion: 1,
    baselineCommit: null,
    artifactPath: null,
    publishStatus: "not_configured",
    publishError: null,
    publishedAt: null,
    error: null,
    startedAt: "2026-08-07T09:00:00Z",
    completedAt: null,
    estimatedUsd: 0,
    ...overrides,
  };
}

test("persists repositories and gate runs without changing scan tables", () => {
  const db = new Database(":memory:");

  try {
    ensureGateSchema(db);
    upsertGuardrailRepository(repositoryFixture(), db);
    insertGateRun(gateRunFixture(), db);

    assert.equal(
      listGuardrailRepositories(db)[0]?.repositoryKey,
      "github.com/okami/csb",
    );
    assert.equal(getGateRun("gate-1", db)?.status, "queued");

    updateGateRun(
      "gate-1",
      {
        status: "completed",
        outcome: "pass",
        completedAt: "2026-08-07T10:00:00Z",
      },
      db,
    );
    assert.equal(getGateRun("gate-1", db)?.outcome, "pass");

    appendGateEvent(
      "gate-1",
      {
        sequence: 1,
        type: "status",
        payload: { status: "completed" },
        createdAt: "2026-08-07T10:00:00Z",
      },
      db,
    );
    assert.deepEqual(
      listGateEvents("gate-1", db).map((event) => event.sequence),
      [1],
    );

    assert.deepEqual(
      db
        .prepare(
          "SELECT count(*) count FROM sqlite_master WHERE name = 'runs'",
        )
        .get(),
      { count: 0 },
    );
  } finally {
    db.close();
  }
});

function databaseSchema(database: Database.Database): string {
  return (database.prepare(`
    SELECT group_concat(sql, '\n') AS sql
    FROM sqlite_master
    WHERE sql IS NOT NULL
  `).get() as { sql: string }).sql;
}

test("creates only the additive gate schema and expected index", () => {
  const db = new Database(":memory:");

  try {
    ensureGateSchema(db);
    const objects = db
      .prepare(
        `SELECT name, type
         FROM sqlite_master
         WHERE name IN (
           'guardrail_repositories',
           'guardrail_schema_migrations',
           'gate_runs',
           'gate_runs_by_repository_started',
           'gate_runs_by_workflow_run',
           'gate_events',
           'github_baselines',
           'github_app_connections',
           'github_app_installations',
           'github_app_installations_by_connection',
           'github_installation_repositories',
           'github_installation_repositories_by_installation',
           'materialization_leases',
           'materialization_leases_by_gate',
           'github_actions_artifacts',
           'github_actions_artifacts_by_run_attempt',
           'gate_publication_attempts',
           'gate_publication_attempts_by_gate'
         )
         ORDER BY name`,
      )
      .all();

    assert.deepEqual(objects, [
      { name: "gate_events", type: "table" },
      { name: "gate_publication_attempts", type: "table" },
      { name: "gate_publication_attempts_by_gate", type: "index" },
      { name: "gate_runs", type: "table" },
      { name: "gate_runs_by_repository_started", type: "index" },
      { name: "gate_runs_by_workflow_run", type: "index" },
      { name: "github_actions_artifacts", type: "table" },
      { name: "github_actions_artifacts_by_run_attempt", type: "index" },
      { name: "github_app_connections", type: "table" },
      { name: "github_app_installations", type: "table" },
      { name: "github_app_installations_by_connection", type: "index" },
      { name: "github_baselines", type: "table" },
      { name: "github_installation_repositories", type: "table" },
      { name: "github_installation_repositories_by_installation", type: "index" },
      { name: "guardrail_repositories", type: "table" },
      { name: "guardrail_schema_migrations", type: "table" },
      { name: "materialization_leases", type: "table" },
      { name: "materialization_leases_by_gate", type: "index" },
    ]);
  } finally {
    db.close();
  }
});

test("migrates a local-plan gate schema idempotently", () => {
  const db = new Database(":memory:");

  try {
    db.exec(`
      CREATE TABLE gate_runs (
        id TEXT PRIMARY KEY,
        repository_key TEXT NOT NULL,
        repository_path TEXT NOT NULL,
        source TEXT NOT NULL,
        base_ref TEXT NOT NULL,
        head_ref TEXT NOT NULL,
        pull_request_number INTEGER,
        scan_id TEXT,
        status TEXT NOT NULL,
        outcome TEXT,
        policy_version INTEGER NOT NULL,
        baseline_commit TEXT,
        artifact_path TEXT,
        error TEXT,
        estimated_usd REAL NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL,
        completed_at TEXT
      );
    `);

    ensureGateSchema(db);
    ensureGateSchema(db);

    const columns = db
      .prepare("PRAGMA table_info(gate_runs)")
      .all()
      .map((column) => (column as { name: string }).name);
    assert.equal(columns.includes("publish_status"), true);
    assert.equal(columns.includes("publish_error"), true);
    assert.equal(columns.includes("published_at"), true);
  } finally {
    db.close();
  }
});

test("keeps every publication retry and finalizes each attempt in place", () => {
  const db = new Database(":memory:");

  try {
    const first = {
      id: "attempt-1",
      gateId: "gate-1",
      status: "publishing" as const,
      error: null,
      createdAt: "2026-08-07T10:00:00.000Z",
    };
    recordGatePublicationAttempt(first, db);
    recordGatePublicationAttempt({
      ...first,
      status: "failed",
      error: "GitHub API unavailable",
    }, db);
    recordGatePublicationAttempt({
      id: "attempt-2",
      gateId: "gate-1",
      status: "published",
      error: null,
      createdAt: "2026-08-07T10:01:00.000Z",
    }, db);

    assert.deepEqual(listGatePublicationAttempts("gate-1", db), [
      {
        id: "attempt-2",
        gateId: "gate-1",
        status: "published",
        error: null,
        createdAt: "2026-08-07T10:01:00.000Z",
      },
      {
        id: "attempt-1",
        gateId: "gate-1",
        status: "failed",
        error: "GitHub API unavailable",
        createdAt: "2026-08-07T10:00:00.000Z",
      },
    ]);
  } finally {
    db.close();
  }
});

test("round-trips the cached github baseline metadata", () => {
  const db = new Database(":memory:");
  const baseline = {
    repositoryKey: "github.com/okami/csb",
    workflowRunId: "98123",
    headSha: "head456",
    artifactPath:
      "/workspace/csb/data/github-cache/github.com_okami_csb/98123/csb-gate-result.json",
    fetchedAt: "2026-08-07T12:00:00.000Z",
  };

  try {
    upsertCachedGitHubBaseline(baseline, db);
    assert.deepEqual(
      getCachedGitHubBaseline("github.com/okami/csb", db),
      baseline,
    );
    assert.equal(getCachedGitHubBaseline("github.com/okami/missing", db), null);
  } finally {
    db.close();
  }
});

test("maps repository booleans and remote status explicitly and derives the newest gate", () => {
  const db = new Database(":memory:");

  try {
    upsertGuardrailRepository(
      repositoryFixture({
        repositoryKey: "local/csb",
        remoteOwner: null,
        remoteName: null,
        enabled: false,
      }),
      db,
    );
    upsertGuardrailRepository(repositoryFixture(), db);
    insertGateRun(gateRunFixture(), db);
    insertGateRun(
      gateRunFixture({
        id: "gate-2",
        status: "completed",
        outcome: "warning",
        startedAt: "2026-08-07T11:00:00Z",
        completedAt: "2026-08-07T11:10:00Z",
      }),
      db,
    );

    const repositories = listGuardrailRepositories(db);
    const local = repositories.find(
      (repository) => repository.repositoryKey === "local/csb",
    );
    const remote = repositories.find(
      (repository) => repository.repositoryKey === "github.com/okami/csb",
    );

    assert.equal(local?.enabled, false);
    assert.equal(local?.githubStatus, "not_configured");
    assert.equal(local?.lastGateId, null);
    assert.equal(remote?.enabled, true);
    assert.equal(remote?.githubStatus, "not_checked");
    assert.equal(remote?.lastGateId, "gate-2");
  } finally {
    db.close();
  }
});

test("round-trips nullable run fields and lists newest runs first", () => {
  const db = new Database(":memory:");

  try {
    const first = gateRunFixture();
    const second = gateRunFixture({
      id: "gate-2",
      source: "github",
      repositoryPath: null,
      executor: "github-actions",
      pullRequestNumber: 184,
      scanId: "scan-2",
      status: "completed",
      outcome: "blocked",
      baselineCommit: "abc123",
      artifactPath: "/workspace/csb/gates/gate-2/result.json",
      error: null,
      startedAt: "2026-08-07T11:00:00Z",
      completedAt: "2026-08-07T11:12:00Z",
      estimatedUsd: 4.25,
    });
    insertGateRun(first, db);
    insertGateRun(second, db);

    assert.deepEqual(getGateRun("gate-1", db), first);
    assert.deepEqual(getGateRun("gate-2", db), second);
    assert.deepEqual(
      listGateRuns(null, db).map((run) => run.id),
      ["gate-2", "gate-1"],
    );
    assert.deepEqual(
      listGateRuns("github.com/okami/csb", db).map((run) => run.id),
      ["gate-2", "gate-1"],
    );
  } finally {
    db.close();
  }
});

test("round-trips a GitHub repository and gate without a filesystem path", () => {
  const db = new Database(":memory:");
  const repository = repositoryFixture({
    repositoryKey: "github:991122",
    repositoryPath: null,
    source: "github",
    remoteOwner: "OkamiOps",
    remoteName: "private-sentinel",
    githubConnectionId: "connection-1",
    githubInstallationId: "installation-1",
    githubRepositoryId: "991122",
  });
  const gate = gateRunFixture({
    id: "gate-remote",
    repositoryKey: repository.repositoryKey,
    repositoryPath: null,
    source: "github",
    executor: "github-actions",
    baseRef: "main",
    headRef: "refs/pull/42/head",
    resolvedBaseSha: "a".repeat(40),
    resolvedHeadSha: "b".repeat(40),
    policySha: "a".repeat(40),
    pullRequestNumber: 42,
    workflowRunId: "1234567",
    materializationState: "not_required",
    scanLineageHash: `sha256:${"c".repeat(64)}`,
    artifactSchemaVersion: 2,
  });

  try {
    upsertGuardrailRepository(repository, db);
    insertGateRun(gate, db);

    assert.deepEqual(listGuardrailRepositories(db), [{ ...repository, lastGateId: gate.id }]);
    assert.deepEqual(getGateRun(gate.id, db), gate);
    const persisted = JSON.stringify({
      repository: listGuardrailRepositories(db)[0],
      gate: getGateRun(gate.id, db),
    });
    assert.equal(persisted.includes("/tmp/"), false);
    assert.equal(persisted.includes("/workspace/"), false);
    assert.throws(
      () => upsertGuardrailRepository({ ...repository, repositoryPath: "/tmp/leak" }, db),
      /constraint/i,
    );
    assert.throws(
      () => insertGateRun({ ...gate, id: "gate-with-path", repositoryPath: "/tmp/leak" }, db),
      /constraint/i,
    );
  } finally {
    db.close();
  }
});

test("round-trips GitHub App, installation, lease and validated artifact metadata only", () => {
  const db = new Database(":memory:");
  const now = "2026-08-12T12:00:00.000Z";
  const connection = {
    id: "connection-1",
    appId: "101",
    appSlug: "okami-sentinel",
    clientId: "Iv1.client",
    status: "ready" as const,
    createdAt: now,
    updatedAt: now,
  };
  const installation = {
    id: "installation-1",
    connectionId: connection.id,
    accountLogin: "OkamiOps",
    accountType: "Organization" as const,
    status: "ready" as const,
    createdAt: now,
    updatedAt: now,
  };
  const authorizedRepository = {
    repositoryId: "991122",
    installationId: installation.id,
    owner: "OkamiOps",
    name: "private-sentinel",
    defaultBranch: "main",
    private: true,
    archived: false,
    updatedAt: now,
  };
  const repository = repositoryFixture({
    repositoryKey: "github:991122",
    repositoryPath: null,
    source: "github",
    remoteOwner: authorizedRepository.owner,
    remoteName: authorizedRepository.name,
    githubConnectionId: connection.id,
    githubInstallationId: installation.id,
    githubRepositoryId: authorizedRepository.repositoryId,
  });
  const gate = gateRunFixture({
    id: "gate-remote",
    repositoryKey: repository.repositoryKey,
    repositoryPath: null,
    source: "github",
    executor: "github-actions",
    artifactSchemaVersion: 2,
  });
  const lease = {
    id: "lease-1",
    gateId: gate.id,
    repositoryKey: repository.repositoryKey,
    snapshotIdentity: `sha256:${"d".repeat(64)}`,
    state: "ready" as const,
    createdAt: now,
    expiresAt: "2026-08-12T12:15:00.000Z",
    releasedAt: null,
  };
  const artifact = {
    id: "artifact-1",
    gateId: gate.id,
    repositoryKey: repository.repositoryKey,
    workflowRunId: "1234567",
    workflowRunAttempt: 1,
    artifactName: "csb-gate-result",
    artifactDigest: `sha256:${"e".repeat(64)}`,
    artifactSchemaVersion: 2,
    status: "validated" as const,
    createdAt: now,
    validatedAt: now,
  };

  try {
    upsertGitHubAppConnection(connection, db);
    upsertGitHubAppInstallation(installation, db);
    upsertGitHubInstallationRepository(authorizedRepository, db);
    upsertGuardrailRepository(repository, db);
    insertGateRun(gate, db);
    upsertMaterializationLease(lease, db);
    upsertGitHubActionsArtifact(artifact, db);

    assert.deepEqual(listGitHubAppConnections(db), [connection]);
    assert.deepEqual(listGitHubAppInstallations(connection.id, db), [installation]);
    assert.deepEqual(listGitHubInstallationRepositories(installation.id, db), [authorizedRepository]);
    assert.deepEqual(getMaterializationLease(lease.id, db), lease);
    assert.deepEqual(getGitHubActionsArtifact(artifact.id, db), artifact);
    const schema = databaseSchema(db);
    assert.doesNotMatch(schema, /private[_ ]?key|installation[_ ]?token|pem|secret/i);
    assert.equal(schema.includes("repository_path TEXT NOT NULL"), false);
  } finally {
    db.close();
  }
});

test("updates only supported mutable gate fields", () => {
  const db = new Database(":memory:");

  try {
    insertGateRun(gateRunFixture(), db);
    updateGateRun(
      "gate-1",
      {
        scanId: "scan-1",
        status: "error",
        outcome: "error",
        baselineCommit: "abc123",
        artifactPath: "/workspace/csb/gates/gate-1/result.json",
        error: "engine failed",
        completedAt: "2026-08-07T10:00:00Z",
        estimatedUsd: 1.5,
        repositoryKey: "attacker-controlled-column",
      } as Parameters<typeof updateGateRun>[1] & {
        repositoryKey: string;
      },
      db,
    );

    const updated = getGateRun("gate-1", db);
    assert.equal(updated?.repositoryKey, "github.com/okami/csb");
    assert.equal(updated?.scanId, "scan-1");
    assert.equal(updated?.status, "error");
    assert.equal(updated?.estimatedUsd, 1.5);
  } finally {
    db.close();
  }
});

test("persists bounded status summaries in sequence order", () => {
  const db = new Database(":memory:");

  try {
    appendGateEvent(
      "gate-1",
      {
        sequence: 2,
        type: "done",
        payload: { status: "completed", outcome: "pass" },
        createdAt: "2026-08-07T10:00:02Z",
      },
      db,
    );
    appendGateEvent(
      "gate-1",
      {
        sequence: 1,
        type: "scan",
        payload: { status: "scanning", scanId: "scan-1", percent: 42 },
        createdAt: "2026-08-07T10:00:01Z",
      },
      db,
    );

    assert.deepEqual(listGateEvents("gate-1", db), [
      {
        sequence: 1,
        type: "scan",
        payload: { status: "scanning", scanId: "scan-1", percent: 42 },
        createdAt: "2026-08-07T10:00:01Z",
      },
      {
        sequence: 2,
        type: "done",
        payload: { status: "completed", outcome: "pass" },
        createdAt: "2026-08-07T10:00:02Z",
      },
    ]);
  } finally {
    db.close();
  }
});

test("serializes a canonical event payload without invoking toJSON", () => {
  const db = new Database(":memory:");
  let toJsonCalls = 0;
  const payload: Record<string, unknown> = { status: "completed" };
  Object.defineProperty(payload, "toJSON", {
    enumerable: false,
    value: () => {
      toJsonCalls += 1;
      return {
        status: "completed",
        logs: "raw scanner output",
        evidence: "Bearer s3crt",
      };
    },
  });

  try {
    appendGateEvent(
      "gate-1",
      {
        sequence: 1,
        type: "status",
        payload,
        createdAt: "2026-08-07T10:00:00Z",
      },
      db,
    );

    assert.equal(toJsonCalls, 0);
    assert.deepEqual(listGateEvents("gate-1", db)[0]?.payload, {
      status: "completed",
    });
    const persisted = db
      .prepare(
        "SELECT payload_json FROM gate_events WHERE gate_id = ? AND sequence = ?",
      )
      .get("gate-1", 1) as { payload_json: string };
    assert.equal(persisted.payload_json.includes("logs"), false);
    assert.equal(persisted.payload_json.includes("evidence"), false);
    assert.equal(persisted.payload_json.includes("s3crt"), false);
  } finally {
    db.close();
  }
});

test("rejects accessors and custom prototypes without executing them", () => {
  const db = new Database(":memory:");
  let getterCalls = 0;
  let inheritedToJsonCalls = 0;
  const accessorPayload: Record<string, unknown> = {};
  Object.defineProperty(accessorPayload, "status", {
    enumerable: true,
    get: () => {
      getterCalls += 1;
      return "completed";
    },
  });
  const inheritedPayload = Object.assign(
    Object.create({
      toJSON: () => {
        inheritedToJsonCalls += 1;
        return { status: "completed", logs: "raw scanner output" };
      },
    }) as Record<string, unknown>,
    { status: "completed" },
  );

  try {
    assert.throws(
      () =>
        appendGateEvent(
          "gate-1",
          {
            sequence: 1,
            type: "status",
            payload: accessorPayload,
            createdAt: "2026-08-07T10:00:00Z",
          },
          db,
        ),
      /accessor/i,
    );
    assert.throws(
      () =>
        appendGateEvent(
          "gate-1",
          {
            sequence: 2,
            type: "status",
            payload: inheritedPayload as never,
            createdAt: "2026-08-07T10:00:01Z",
          },
          db,
        ),
      /plain status or progress summary/i,
    );
    assert.equal(getterCalls, 0);
    assert.equal(inheritedToJsonCalls, 0);
    assert.deepEqual(listGateEvents("gate-1", db), []);
  } finally {
    db.close();
  }
});

test("rejects scanner logs, oversized summaries and unserializable events", () => {
  const db = new Database(":memory:");
  const circular: Record<string, unknown> = {};
  circular.self = circular;

  try {
    assert.throws(
      () =>
        appendGateEvent(
          "gate-1",
          {
            sequence: 1,
            type: "scan",
            payload: { logs: "raw scanner output" } as never,
            createdAt: "2026-08-07T10:00:00Z",
          },
          db,
        ),
      /status or progress summary/i,
    );
    assert.throws(
      () =>
        appendGateEvent(
          "gate-1",
          {
            sequence: 2,
            type: "status",
            payload: { code: "x".repeat(4_097) },
            createdAt: "2026-08-07T10:00:01Z",
          },
          db,
        ),
      /too large/i,
    );
    assert.throws(
      () =>
        appendGateEvent(
          "gate-1",
          {
            sequence: 3,
            type: "status",
            payload: circular,
            createdAt: "2026-08-07T10:00:02Z",
          },
          db,
        ),
      /serializable/i,
    );
    assert.deepEqual(listGateEvents("gate-1", db), []);
  } finally {
    db.close();
  }
});

test("rejects free-form event messages instead of persisting logs or secrets", () => {
  const db = new Database(":memory:");

  try {
    assert.throws(
      () =>
        appendGateEvent(
          "gate-1",
          {
            sequence: 1,
            type: "error",
            payload: {
              message: "Bearer s3crt from /home/marcos scanner.log",
            } as never,
            createdAt: "2026-08-07T10:00:00Z",
          },
          db,
        ),
      /status or progress summary/i,
    );
    assert.deepEqual(listGateEvents("gate-1", db), []);
  } finally {
    db.close();
  }
});

test("rejects mismatched summary types and free-form error codes", () => {
  const db = new Database(":memory:");

  try {
    assert.throws(
      () =>
        appendGateEvent(
          "gate-1",
          {
            sequence: 1,
            type: "status",
            payload: { status: 42 } as never,
            createdAt: "2026-08-07T10:00:00Z",
          },
          db,
        ),
      /status or progress summary/i,
    );
    assert.throws(
      () =>
        appendGateEvent(
          "gate-1",
          {
            sequence: 2,
            type: "error",
            payload: { code: "Bearer s3crt from scanner.log" },
            createdAt: "2026-08-07T10:00:01Z",
          },
          db,
        ),
      /status or progress summary/i,
    );
    assert.deepEqual(listGateEvents("gate-1", db), []);
  } finally {
    db.close();
  }
});

test("rejects loose timestamps and persists valid ISO offsets as canonical UTC", () => {
  const db = new Database(":memory:");

  try {
    assert.throws(
      () =>
        appendGateEvent(
          "gate-1",
          {
            sequence: 1,
            type: "done",
            payload: {
              completedAt:
                "Thu, 01 Jan 1970 00:00:00 GMT (Bearer s3crt)",
            },
            createdAt: "2026-08-07T10:00:00Z",
          },
          db,
        ),
      /status or progress summary/i,
    );
    assert.throws(
      () =>
        appendGateEvent(
          "gate-1",
          {
            sequence: 2,
            type: "done",
            payload: { completedAt: "2026-02-30T10:00:00Z" },
            createdAt: "2026-08-07T10:00:01Z",
          },
          db,
        ),
      /status or progress summary/i,
    );

    appendGateEvent(
      "gate-1",
      {
        sequence: 3,
        type: "done",
        payload: { completedAt: "2026-08-07T10:00:00+02:00" },
        createdAt: "2026-08-07T10:00:02Z",
      },
      db,
    );

    assert.deepEqual(listGateEvents("gate-1", db), [
      {
        sequence: 3,
        type: "done",
        payload: { completedAt: "2026-08-07T08:00:00.000Z" },
        createdAt: "2026-08-07T10:00:02Z",
      },
    ]);
    const persisted = db
      .prepare(
        "SELECT payload_json FROM gate_events WHERE gate_id = ? AND sequence = ?",
      )
      .get("gate-1", 3) as { payload_json: string };
    assert.equal(persisted.payload_json.includes("Bearer"), false);
    assert.equal(persisted.payload_json.includes("+02:00"), false);
  } finally {
    db.close();
  }
});
