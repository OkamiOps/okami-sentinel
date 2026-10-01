import type Database from "better-sqlite3";

import type { GuardrailPrCommentState } from "@csb/shared";

import { getDb } from "../db.js";

/**
 * One row per pull request: which comment Sentinel owns there, and whether the
 * last attempt to write it worked. It carries its own version ladder, like the
 * policy and baseline projections, because nothing else joins it — the gate page
 * and the publisher read it by key.
 */
const PR_COMMENT_SCHEMA_VERSION = 2;

const PR_COMMENT_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS guardrail_pr_comments (
    repository_key TEXT NOT NULL,
    pull_request_number INTEGER NOT NULL,
    comment_id TEXT,
    status TEXT NOT NULL,
    reason TEXT,
    body_hash TEXT,
    gate_id TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (repository_key, pull_request_number),
    CHECK (status IN ('published', 'failed'))
  );
`;

/**
 * One row per installation that refused the comment for want of
 * `pull_requests: write`. It exists so the refusal is recorded once, not once per
 * gate: the Integration screen already names the installation whose review is
 * pending, and an alert on every pull request of every repository under that
 * installation teaches an administrator to ignore the alert.
 */
const PR_COMMENT_PERMISSION_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS guardrail_pr_comment_permission_blocks (
    installation_id TEXT PRIMARY KEY,
    reason TEXT NOT NULL,
    recorded_at TEXT NOT NULL
  );
`;

const migratedHandles = new WeakSet<Database.Database>();

export function ensurePrCommentSchema(database: Database.Database = getDb()): void {
  if (migratedHandles.has(database)) return;
  if (recordedVersion(database) >= PR_COMMENT_SCHEMA_VERSION) {
    migratedHandles.add(database);
    return;
  }
  database.transaction(() => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS guardrail_pr_comment_schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);
    if (recordedVersion(database) >= PR_COMMENT_SCHEMA_VERSION) return;
    database.exec(PR_COMMENT_SCHEMA_SQL);
    database.exec(PR_COMMENT_PERMISSION_SCHEMA_SQL);
    database.prepare(`
      INSERT OR REPLACE INTO guardrail_pr_comment_schema_migrations (version, name, applied_at)
      VALUES (?, ?, ?)
    `).run(
      PR_COMMENT_SCHEMA_VERSION,
      "pull-request comment projection and permission blocks",
      new Date().toISOString(),
    );
  })();
  migratedHandles.add(database);
}

export function getPrComment(
  repositoryKey: string,
  pullRequestNumber: number,
  database: Database.Database = getDb(),
): GuardrailPrCommentState | null {
  ensurePrCommentSchema(database);
  const row = database.prepare(`
    SELECT comment_id, status, reason, body_hash, gate_id, updated_at
    FROM guardrail_pr_comments
    WHERE repository_key = ? AND pull_request_number = ?
  `).get(repositoryKey, pullRequestNumber) as PrCommentRow | undefined;
  if (row === undefined) return null;
  return {
    repositoryKey,
    pullRequestNumber,
    commentId: row.comment_id,
    status: row.status === "failed" ? "failed" : "published",
    reason: row.reason,
    bodyHash: row.body_hash,
    gateId: row.gate_id,
    updatedAt: row.updated_at,
  };
}

/** Every comment Sentinel owns in one repository, newest pull request first. */
export function listPrComments(
  repositoryKey: string,
  database: Database.Database = getDb(),
): GuardrailPrCommentState[] {
  ensurePrCommentSchema(database);
  const rows = database.prepare(`
    SELECT pull_request_number, comment_id, status, reason, body_hash, gate_id, updated_at
    FROM guardrail_pr_comments
    WHERE repository_key = ?
    ORDER BY pull_request_number DESC
  `).all(repositoryKey) as Array<PrCommentRow & { pull_request_number: number }>;
  return rows.map((row) => ({
    repositoryKey,
    pullRequestNumber: row.pull_request_number,
    commentId: row.comment_id,
    status: row.status === "failed" ? "failed" : "published",
    reason: row.reason,
    bodyHash: row.body_hash,
    gateId: row.gate_id,
    updatedAt: row.updated_at,
  }));
}

export function upsertPrComment(
  record: GuardrailPrCommentState,
  database: Database.Database = getDb(),
): GuardrailPrCommentState {
  ensurePrCommentSchema(database);
  database.prepare(`
    INSERT INTO guardrail_pr_comments (
      repository_key, pull_request_number, comment_id, status, reason, body_hash, gate_id, updated_at
    ) VALUES (@repository_key, @pull_request_number, @comment_id, @status, @reason, @body_hash, @gate_id, @updated_at)
    ON CONFLICT (repository_key, pull_request_number) DO UPDATE SET
      comment_id = excluded.comment_id,
      status = excluded.status,
      reason = excluded.reason,
      body_hash = excluded.body_hash,
      gate_id = excluded.gate_id,
      updated_at = excluded.updated_at
  `).run({
    repository_key: record.repositoryKey,
    pull_request_number: record.pullRequestNumber,
    comment_id: record.commentId,
    status: record.status,
    reason: record.reason,
    body_hash: record.bodyHash,
    gate_id: record.gateId,
    updated_at: record.updatedAt,
  });
  return record;
}

/**
 * Records that this installation cannot write comments. Returns `true` only the
 * first time, which is the one time the operator is told.
 */
export function recordPrCommentPermissionBlock(
  installationId: string,
  reason: string,
  now: string,
  database: Database.Database = getDb(),
): boolean {
  ensurePrCommentSchema(database);
  // `recorded_at` is always refreshed: it is the clock the hourly re-probe reads.
  // Only the first insert returns `true`, so a probe that fails again is silent.
  return database.transaction(() => {
    const first = prCommentPermissionBlockedAt(installationId, database) === null;
    database.prepare(`
      INSERT INTO guardrail_pr_comment_permission_blocks (installation_id, reason, recorded_at)
      VALUES (?, ?, ?)
      ON CONFLICT (installation_id) DO UPDATE SET
        reason = excluded.reason,
        recorded_at = excluded.recorded_at
    `).run(installationId, reason, now);
    return first;
  }).immediate();
}

/** When this installation's refusal was recorded, or `null` if there is none. */
export function prCommentPermissionBlockedAt(
  installationId: string,
  database: Database.Database = getDb(),
): string | null {
  ensurePrCommentSchema(database);
  const row = database.prepare(
    "SELECT recorded_at FROM guardrail_pr_comment_permission_blocks WHERE installation_id = ?",
  ).get(installationId) as { recorded_at: string } | undefined;
  return row?.recorded_at ?? null;
}

/**
 * The installation may write comments again — because a comment just succeeded,
 * or because the Integration refresh saw the grant. Returns whether a block was
 * actually lifted, so the caller can tell a recovery from a no-op.
 */
export function clearPrCommentPermissionBlock(
  installationId: string,
  database: Database.Database = getDb(),
): boolean {
  ensurePrCommentSchema(database);
  return database.prepare(
    "DELETE FROM guardrail_pr_comment_permission_blocks WHERE installation_id = ?",
  ).run(installationId).changes > 0;
}

interface PrCommentRow {
  comment_id: string | null;
  status: string;
  reason: string | null;
  body_hash: string | null;
  gate_id: string | null;
  updated_at: string;
}

function recordedVersion(database: Database.Database): number {
  const exists = database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'guardrail_pr_comment_schema_migrations'",
  ).get();
  if (exists === undefined) return 0;
  const row = database
    .prepare("SELECT max(version) AS version FROM guardrail_pr_comment_schema_migrations")
    .get() as { version: number | null };
  return row.version ?? 0;
}
