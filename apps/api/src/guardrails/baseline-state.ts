import type Database from "better-sqlite3";

import { defaultGuardrailPolicy } from "@csb/gate-core";
import type { GuardrailBaseline, GuardrailBaselineState } from "@csb/shared";

import { getDb } from "../db.js";
import { listGateRuns, listGuardrailRepositories } from "../gate-store.js";
import { getRepositoryPolicy } from "./policy-store.js";
import { REPOSITORY_BASELINE_SCHEMA_SQL } from "./projection-schema.js";

/**
 * The one word the screen reads for a repository's baseline.
 *
 * - `absent`: nothing comparable exists. The first merge on the protected branch
 *   builds it, and a pull request meanwhile is still evaluated.
 * - `building`: a protected-branch gate was asked for and has not finished.
 * - `ready`: the newest protected-branch gate is comparable.
 * - `stale`: there is a baseline, and something changed that makes it
 *   incomparable. The next merge rebuilds it; nothing is blocked meanwhile.
 */
export type BaselineState = GuardrailBaselineState;
export type RepositoryBaseline = GuardrailBaseline;

/** The newest protected-branch gate of a repository, as the projection sees it. */
export interface BaselineCandidate {
  gateId: string;
  commitSha: string | null;
  /** The branch the gate ran on, which may no longer be the protected one. */
  protectedBranch: string;
  scanLineageHash: string | null;
  builtAt: string | null;
  /** Why it cannot be compared, or `null` when it can. */
  incompatibleReason: string | null;
}

export interface BaselineStateDependencies {
  database?: Database.Database;
  now?(): string;
  /** The branch a baseline must have been built on to count. */
  protectedBranch(repositoryKey: string): string | null;
  findBaselineCandidate(repositoryKey: string): BaselineCandidate | null;
}

const BASELINE_SCHEMA_VERSION = 1;



interface BaselineRow {
  state: string;
  gate_id: string | null;
  commit_sha: string | null;
  protected_branch: string | null;
  scan_lineage_hash: string | null;
  built_at: string | null;
  stale_reason: string | null;
  requested_at: string | null;
  updated_at: string;
}

const migratedHandles = new WeakSet<Database.Database>();

export function ensureRepositoryBaselineSchema(database: Database.Database = getDb()): void {
  if (migratedHandles.has(database)) return;
  if (recordedVersion(database) >= BASELINE_SCHEMA_VERSION) {
    migratedHandles.add(database);
    return;
  }
  database.transaction(() => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS guardrail_baseline_schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);
    if (recordedVersion(database) >= BASELINE_SCHEMA_VERSION) return;
    database.exec(REPOSITORY_BASELINE_SCHEMA_SQL);
    database.prepare(`
      INSERT OR REPLACE INTO guardrail_baseline_schema_migrations (version, name, applied_at)
      VALUES (?, ?, ?)
    `).run(BASELINE_SCHEMA_VERSION, "baseline projection", new Date().toISOString());
  })();
  migratedHandles.add(database);
}

export function getRepositoryBaselineState(
  repositoryKey: string,
  database: Database.Database = getDb(),
): RepositoryBaseline {
  ensureRepositoryBaselineSchema(database);
  const row = database.prepare(`
    SELECT state, gate_id, commit_sha, protected_branch, scan_lineage_hash,
           built_at, stale_reason, requested_at, updated_at
    FROM guardrail_repository_baselines
    WHERE repository_key = ?
  `).get(repositoryKey) as BaselineRow | undefined;
  return row === undefined ? absent(repositoryKey) : rowToBaseline(repositoryKey, row);
}

/**
 * Recomputes the word from the newest protected-branch gate.
 *
 * Staleness is **sticky**: a lineage or protected-branch change is recorded against
 * the gate that was the baseline, and only a *different*, newer gate clears it.
 * Without that, the refresh that runs when a gate completes would immediately
 * declare the same incomparable artifact ready again.
 */
export function refreshRepositoryBaselineState(
  repositoryKey: string,
  dependencies: BaselineStateDependencies = productionDependencies(),
): RepositoryBaseline {
  const database = dependencies.database ?? getDb();
  ensureRepositoryBaselineSchema(database);
  // An unknown repository gets no row: the foreign key would refuse it anyway, and
  // a projection must not be the thing that invents a registration.
  if (!isEnrolled(repositoryKey, database)) return absent(repositoryKey);

  const stored = getRepositoryBaselineState(repositoryKey, database);
  const protectedBranch = dependencies.protectedBranch(repositoryKey);
  const candidate = dependencies.findBaselineCandidate(repositoryKey);
  const now = (dependencies.now ?? (() => new Date().toISOString()))();

  const next = derive({ repositoryKey, stored, candidate, protectedBranch, now });
  // Writing an identical row would move `updated_at` for nothing, and the screen
  // would report a change the product did not make.
  if (sameProjection(stored, next)) return stored;
  write(repositoryKey, next, database);
  return next;
}

export function markRepositoryBaselineBuilding(
  repositoryKey: string,
  requestedAt: string,
  database: Database.Database = getDb(),
): RepositoryBaseline {
  ensureRepositoryBaselineSchema(database);
  if (!isEnrolled(repositoryKey, database)) return absent(repositoryKey);
  const stored = getRepositoryBaselineState(repositoryKey, database);
  // The previous commit stays on the row: while the rebuild runs, the screen can
  // still say which baseline is being replaced.
  const next: RepositoryBaseline = {
    ...stored,
    state: "building",
    requestedAt,
    updatedAt: requestedAt,
  };
  write(repositoryKey, next, database);
  return next;
}

export function markRepositoryBaselineStale(
  repositoryKey: string,
  reason: string,
  database: Database.Database = getDb(),
  now: string = new Date().toISOString(),
): RepositoryBaseline {
  ensureRepositoryBaselineSchema(database);
  if (!isEnrolled(repositoryKey, database)) return absent(repositoryKey);
  const stored = getRepositoryBaselineState(repositoryKey, database);
  // There is no stale without a baseline, and a build in flight is about to produce
  // a fresh one anyway.
  if (stored.state === "absent" || stored.state === "building") return stored;
  if (stored.state === "stale" && stored.staleReason === reason) return stored;
  const next: RepositoryBaseline = { ...stored, state: "stale", staleReason: reason, updatedAt: now };
  write(repositoryKey, next, database);
  return next;
}

function derive(input: {
  repositoryKey: string;
  stored: RepositoryBaseline;
  candidate: BaselineCandidate | null;
  protectedBranch: string | null;
  now: string;
}): RepositoryBaseline {
  const { stored, candidate, protectedBranch, now } = input;
  if (candidate === null) {
    // A requested build that has not produced a gate yet is still in flight.
    if (stored.state === "building") return stored;
    return { ...absent(input.repositoryKey), updatedAt: now };
  }
  const base: RepositoryBaseline = {
    repositoryKey: input.repositoryKey,
    state: "ready",
    gateId: candidate.gateId,
    commitSha: candidate.commitSha,
    protectedBranch: candidate.protectedBranch,
    scanLineageHash: candidate.scanLineageHash,
    builtAt: candidate.builtAt,
    staleReason: null,
    requestedAt: null,
    updatedAt: now,
  };
  // A marked staleness survives until a different gate becomes the newest one.
  if (stored.state === "stale" && stored.gateId !== null && stored.gateId === candidate.gateId) {
    return { ...base, state: "stale", staleReason: stored.staleReason };
  }
  if (candidate.protectedBranch !== protectedBranch) {
    return { ...base, state: "stale", staleReason: "protected_branch" };
  }
  if (candidate.incompatibleReason !== null) {
    return { ...base, state: "stale", staleReason: candidate.incompatibleReason };
  }
  return base;
}

/** Everything but `updatedAt`: the instant is bookkeeping, not the projection. */
function sameProjection(left: RepositoryBaseline, right: RepositoryBaseline): boolean {
  return left.state === right.state
    && left.gateId === right.gateId
    && left.commitSha === right.commitSha
    && left.protectedBranch === right.protectedBranch
    && left.scanLineageHash === right.scanLineageHash
    && left.builtAt === right.builtAt
    && left.staleReason === right.staleReason
    && left.requestedAt === right.requestedAt;
}

function write(
  repositoryKey: string,
  baseline: RepositoryBaseline,
  database: Database.Database,
): void {
  database.prepare(`
    INSERT INTO guardrail_repository_baselines (
      repository_key, state, gate_id, commit_sha, protected_branch,
      scan_lineage_hash, built_at, stale_reason, requested_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(repository_key) DO UPDATE SET
      state = excluded.state,
      gate_id = excluded.gate_id,
      commit_sha = excluded.commit_sha,
      protected_branch = excluded.protected_branch,
      scan_lineage_hash = excluded.scan_lineage_hash,
      built_at = excluded.built_at,
      stale_reason = excluded.stale_reason,
      requested_at = excluded.requested_at,
      updated_at = excluded.updated_at
  `).run(
    repositoryKey,
    baseline.state,
    baseline.gateId,
    baseline.commitSha,
    baseline.protectedBranch,
    baseline.scanLineageHash,
    baseline.builtAt,
    baseline.staleReason,
    baseline.requestedAt,
    baseline.updatedAt,
  );
}

function absent(repositoryKey: string): RepositoryBaseline {
  return {
    repositoryKey,
    state: "absent",
    gateId: null,
    commitSha: null,
    protectedBranch: null,
    scanLineageHash: null,
    builtAt: null,
    staleReason: null,
    requestedAt: null,
    updatedAt: "1970-01-01T00:00:00.000Z",
  };
}

function rowToBaseline(repositoryKey: string, row: BaselineRow): RepositoryBaseline {
  return {
    repositoryKey,
    state: row.state as BaselineState,
    gateId: row.gate_id,
    commitSha: row.commit_sha,
    protectedBranch: row.protected_branch,
    scanLineageHash: row.scan_lineage_hash,
    builtAt: row.built_at,
    staleReason: row.stale_reason,
    requestedAt: row.requested_at,
    updatedAt: row.updated_at,
  };
}

function isEnrolled(repositoryKey: string, database: Database.Database): boolean {
  return database
    .prepare("SELECT 1 FROM guardrail_repositories WHERE repository_key = ?")
    .get(repositoryKey) !== undefined;
}

function recordedVersion(database: Database.Database): number {
  const exists = database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'guardrail_baseline_schema_migrations'",
  ).get() !== undefined;
  if (!exists) return 0;
  const row = database
    .prepare("SELECT max(version) AS version FROM guardrail_baseline_schema_migrations")
    .get() as { version: number | null };
  return row.version ?? 0;
}

/**
 * The production rule, deliberately local: it reads `gate_runs` and the saved
 * policy, and never the artifact on disk or anything remote. The artifact stays the
 * authority on what a baseline *contains*; this projection only answers which gate
 * is the newest baseline-shaped one and whether it is still on the right branch.
 *
 * It does not compare lineage either. A model, effort or mode change is reported by
 * whoever makes it, through `markRepositoryBaselineStale(key, "scan_lineage")` —
 * recomputing an effective lineage here would mean planning a scan that nobody
 * asked for.
 */
function productionDependencies(): BaselineStateDependencies {
  return {
    protectedBranch: protectedBranchOf,
    findBaselineCandidate: newestBaselineGate,
  };
}

/**
 * The branch a baseline must stand on. A gate only establishes one when the branch
 * is in the effective policy's `protectedBranches`, so the answer is drawn from
 * there, preferring the repository's own default branch when the policy lists it.
 *
 * The policy read is the **Sentinel** one, never the repository's file: this runs on
 * every gate completion and must not spend a GitHub call. A repository whose file
 * protects a different branch converges anyway, because the gate it runs there
 * becomes the newest candidate and the comparison below notices.
 */
function protectedBranchOf(repositoryKey: string): string | null {
  const repository = listGuardrailRepositories()
    .find((candidate) => candidate.repositoryKey === repositoryKey) ?? null;
  if (repository === null) return null;
  const policy = getRepositoryPolicy(repositoryKey)?.policy ?? defaultGuardrailPolicy();
  if (policy.protectedBranches.includes(repository.defaultBranch)) return repository.defaultBranch;
  return policy.protectedBranches[0] ?? null;
}

/**
 * The newest gate shaped like a protected-branch run: completed, not an error, from
 * the App, schema v2, no pull request, and the same ref on both sides.
 *
 * A gate on the protected branch wins outright. Failing that, the newest one on
 * *another* branch is still returned — with the branch it ran on — so the screen can
 * say "the baseline you have is not on the branch the policy protects" instead of
 * "there is no baseline", which would be a different and less useful fact.
 */
function newestBaselineGate(repositoryKey: string): BaselineCandidate | null {
  const protectedBranch = protectedBranchOf(repositoryKey);
  let offBranch: BaselineCandidate | null = null;
  // `listGateRuns` is newest first.
  for (const gate of listGateRuns(repositoryKey)) {
    if (
      gate.status !== "completed"
      || gate.outcome === "error"
      || gate.outcome === null
      || gate.source !== "github"
      || gate.artifactSchemaVersion !== 2
      || gate.artifactPath === null
      || gate.pullRequestNumber !== null
      || gate.baseRef !== gate.headRef
    ) continue;
    const candidate: BaselineCandidate = {
      gateId: gate.id,
      commitSha: gate.resolvedHeadSha,
      protectedBranch: gate.headRef,
      scanLineageHash: gate.scanLineageHash,
      builtAt: gate.completedAt,
      incompatibleReason: null,
    };
    if (gate.headRef === protectedBranch) return candidate;
    offBranch ??= candidate;
  }
  return offBranch;
}
