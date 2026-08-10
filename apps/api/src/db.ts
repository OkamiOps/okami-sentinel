import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import {
  emptySeverityCounts,
  type FindingTriage,
  type FindingTriageStatus,
  type ScanCost,
  type ScanRun,
  type ScanStatus,
  type ScannerAuthMode,
  type ScannerEngine,
  type SeverityCounts,
} from "@csb/shared";
import { BENCHMARK_DB_PATH, DATA_DIR } from "./config.js";
import { withOpenRouterPricingEstimate } from "./openrouter-pricing.js";

export interface BenchmarkRow {
  id: string;
  display_name: string;
  repository_path: string | null;
  revision: string | null;
  scan_dir: string;
  status: string;
  model: string | null;
  effort: string | null;
  mode: string | null;
  engine: string | null;
  provider: string | null;
  auth_mode: string | null;
  scanner_version: string | null;
  recipe_hash: string | null;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  estimated_usd: number | null;
  input_tokens: number | null;
  cached_input_tokens: number | null;
  cache_write_tokens: number | null;
  output_tokens: number | null;
  severity_critical: number;
  severity_high: number;
  severity_medium: number;
  severity_low: number;
  severity_info: number;
  severity_unknown: number;
  severity_total: number;
  source: string;
  pid: number | null;
  created_at: string;
  updated_at: string;
}

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new Database(BENCHMARK_DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      repository_path TEXT,
      revision TEXT,
      scan_dir TEXT NOT NULL,
      status TEXT NOT NULL,
      model TEXT,
      effort TEXT,
      mode TEXT,
      engine TEXT NOT NULL DEFAULT 'codex-security',
      provider TEXT,
      auth_mode TEXT,
      scanner_version TEXT,
      recipe_hash TEXT,
      started_at TEXT,
      completed_at TEXT,
      duration_ms INTEGER,
      estimated_usd REAL,
      input_tokens INTEGER,
      cached_input_tokens INTEGER,
      cache_write_tokens INTEGER,
      output_tokens INTEGER,
      severity_critical INTEGER NOT NULL DEFAULT 0,
      severity_high INTEGER NOT NULL DEFAULT 0,
      severity_medium INTEGER NOT NULL DEFAULT 0,
      severity_low INTEGER NOT NULL DEFAULT 0,
      severity_info INTEGER NOT NULL DEFAULT 0,
      severity_unknown INTEGER NOT NULL DEFAULT 0,
      severity_total INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL,
      pid INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS runs_by_updated ON runs(updated_at DESC);
    CREATE TABLE IF NOT EXISTS hidden_runs (
      id TEXT PRIMARY KEY,
      hidden_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS repository_baselines (
      repository_key TEXT PRIMARY KEY,
      scan_id TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS finding_triage (
      repository_key TEXT NOT NULL,
      finding_key TEXT NOT NULL,
      status TEXT NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (repository_key, finding_key)
    );
    CREATE INDEX IF NOT EXISTS finding_triage_by_repository
      ON finding_triage(repository_key, updated_at DESC);
  `);
  ensureRunMetadataColumns(db);
  return db;
}

function ensureRunMetadataColumns(database: Database.Database): void {
  const columns = new Set(
    (database.prepare(`PRAGMA table_info(runs)`).all() as Array<{ name: string }>).map(
      (column) => column.name,
    ),
  );
  const additions = [
    ["engine", "TEXT NOT NULL DEFAULT 'codex-security'"],
    ["provider", "TEXT"],
    ["auth_mode", "TEXT"],
    ["scanner_version", "TEXT"],
    ["recipe_hash", "TEXT"],
  ] as const;
  for (const [name, definition] of additions) {
    if (!columns.has(name)) database.exec(`ALTER TABLE runs ADD COLUMN ${name} ${definition}`);
  }
}

export function rowToScanRun(row: BenchmarkRow): ScanRun {
  const severity: SeverityCounts = {
    critical: row.severity_critical,
    high: row.severity_high,
    medium: row.severity_medium,
    low: row.severity_low,
    info: row.severity_info,
    unknown: row.severity_unknown,
    total: row.severity_total,
  };

  const cost: ScanCost | null =
    row.estimated_usd != null
      ? {
          estimatedUsd: row.estimated_usd,
          inputTokens: row.input_tokens ?? 0,
          cachedInputTokens: row.cached_input_tokens ?? 0,
          cacheWriteInputTokens: row.cache_write_tokens ?? 0,
          outputTokens: row.output_tokens ?? 0,
          model: row.model ?? undefined,
        }
      : null;

  return withOpenRouterPricingEstimate({
    id: row.id,
    displayName: row.display_name,
    repositoryPath: row.repository_path,
    revision: row.revision,
    scanDir: row.scan_dir,
    status: row.status as ScanStatus,
    model: row.model,
    effort: row.effort,
    mode: row.mode,
    engine: (row.engine ?? "codex-security") as ScannerEngine,
    provider: row.provider,
    authMode: row.auth_mode as ScannerAuthMode | null,
    scannerVersion: row.scanner_version,
    recipeHash: row.recipe_hash,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    durationMs: row.duration_ms,
    cost,
    severity,
    source: row.source as ScanRun["source"],
    pid: row.pid,
  });
}

export function upsertRun(run: ScanRun): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO runs (
        id, display_name, repository_path, revision, scan_dir, status,
        model, effort, mode, engine, provider, auth_mode, scanner_version, recipe_hash,
        started_at, completed_at, duration_ms,
        estimated_usd, input_tokens, cached_input_tokens, cache_write_tokens, output_tokens,
        severity_critical, severity_high, severity_medium, severity_low, severity_info, severity_unknown, severity_total,
        source, pid, created_at, updated_at
      ) VALUES (
        @id, @display_name, @repository_path, @revision, @scan_dir, @status,
        @model, @effort, @mode, @engine, @provider, @auth_mode, @scanner_version, @recipe_hash,
        @started_at, @completed_at, @duration_ms,
        @estimated_usd, @input_tokens, @cached_input_tokens, @cache_write_tokens, @output_tokens,
        @severity_critical, @severity_high, @severity_medium, @severity_low, @severity_info, @severity_unknown, @severity_total,
        @source, @pid, @created_at, @updated_at
      )
      ON CONFLICT(id) DO UPDATE SET
        display_name=excluded.display_name,
        repository_path=excluded.repository_path,
        revision=excluded.revision,
        scan_dir=excluded.scan_dir,
        status=excluded.status,
        model=excluded.model,
        effort=excluded.effort,
        mode=excluded.mode,
        engine=excluded.engine,
        provider=excluded.provider,
        auth_mode=excluded.auth_mode,
        scanner_version=excluded.scanner_version,
        recipe_hash=excluded.recipe_hash,
        started_at=excluded.started_at,
        completed_at=excluded.completed_at,
        duration_ms=excluded.duration_ms,
        estimated_usd=excluded.estimated_usd,
        input_tokens=excluded.input_tokens,
        cached_input_tokens=excluded.cached_input_tokens,
        cache_write_tokens=excluded.cache_write_tokens,
        output_tokens=excluded.output_tokens,
        severity_critical=excluded.severity_critical,
        severity_high=excluded.severity_high,
        severity_medium=excluded.severity_medium,
        severity_low=excluded.severity_low,
        severity_info=excluded.severity_info,
        severity_unknown=excluded.severity_unknown,
        severity_total=excluded.severity_total,
        source=excluded.source,
        pid=excluded.pid,
        updated_at=excluded.updated_at`,
    )
    .run({
      id: run.id,
      display_name: run.displayName,
      repository_path: run.repositoryPath,
      revision: run.revision,
      scan_dir: run.scanDir,
      status: run.status,
      model: run.model,
      effort: run.effort,
      mode: run.mode,
      engine: run.engine,
      provider: run.provider,
      auth_mode: run.authMode,
      scanner_version: run.scannerVersion,
      recipe_hash: run.recipeHash,
      started_at: run.startedAt,
      completed_at: run.completedAt,
      duration_ms: run.durationMs,
      estimated_usd: run.cost?.estimatedUsd ?? null,
      input_tokens: run.cost?.inputTokens ?? null,
      cached_input_tokens: run.cost?.cachedInputTokens ?? null,
      cache_write_tokens: run.cost?.cacheWriteInputTokens ?? null,
      output_tokens: run.cost?.outputTokens ?? null,
      severity_critical: run.severity.critical,
      severity_high: run.severity.high,
      severity_medium: run.severity.medium,
      severity_low: run.severity.low,
      severity_info: run.severity.info,
      severity_unknown: run.severity.unknown,
      severity_total: run.severity.total,
      source: run.source,
      pid: run.pid,
      created_at: now,
      updated_at: now,
    });
}

export function listRuns(): ScanRun[] {
  const rows = getDb()
    .prepare(
      `SELECT runs.*
       FROM runs
       LEFT JOIN hidden_runs ON hidden_runs.id = runs.id
       WHERE hidden_runs.id IS NULL
       ORDER BY COALESCE(runs.started_at, runs.created_at) DESC`,
    )
    .all() as BenchmarkRow[];
  return rows.map(rowToScanRun);
}

export function getRun(id: string): ScanRun | null {
  const row = getDb().prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as
    | BenchmarkRow
    | undefined;
  return row ? rowToScanRun(row) : null;
}

export function getRepositoryBaseline(repositoryKey: string): string | null {
  const row = getDb()
    .prepare(`SELECT scan_id FROM repository_baselines WHERE repository_key = ?`)
    .get(repositoryKey) as { scan_id: string } | undefined;
  return row?.scan_id ?? null;
}

export function setRepositoryBaseline(repositoryKey: string, scanId: string): void {
  getDb()
    .prepare(
      `INSERT INTO repository_baselines (repository_key, scan_id, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(repository_key) DO UPDATE SET
         scan_id = excluded.scan_id,
         updated_at = excluded.updated_at`,
    )
    .run(repositoryKey, scanId, new Date().toISOString());
}

export function getFindingTriage(repositoryKey: string): Map<string, FindingTriage> {
  const rows = getDb()
    .prepare(
      `SELECT finding_key, status, note, updated_at
       FROM finding_triage
       WHERE repository_key = ?`,
    )
    .all(repositoryKey) as Array<{
      finding_key: string;
      status: FindingTriageStatus;
      note: string | null;
      updated_at: string;
    }>;
  return new Map(rows.map((row) => [row.finding_key, { status: row.status, note: row.note, updatedAt: row.updated_at }]));
}

export function upsertFindingTriage(
  repositoryKey: string,
  findingKey: string,
  status: FindingTriageStatus,
  note: string | null,
): FindingTriage {
  if (status === "unreviewed" && note === null) {
    getDb()
      .prepare(`DELETE FROM finding_triage WHERE repository_key = ? AND finding_key = ?`)
      .run(repositoryKey, findingKey);
    return { status, note, updatedAt: null };
  }

  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO finding_triage (
         repository_key, finding_key, status, note, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(repository_key, finding_key) DO UPDATE SET
         status = excluded.status,
         note = excluded.note,
         updated_at = excluded.updated_at`,
    )
    .run(repositoryKey, findingKey, status, note, now, now);
  return { status, note, updatedAt: now };
}

export function deleteRun(id: string): void {
  getDb().prepare(`DELETE FROM runs WHERE id = ?`).run(id);
}

export function hideRun(
  id: string,
  database: Database.Database = getDb(),
): void {
  database
    .prepare(
      `INSERT INTO hidden_runs (id, hidden_at)
       VALUES (?, ?)
       ON CONFLICT(id) DO UPDATE SET hidden_at = excluded.hidden_at`,
    )
    .run(id, new Date().toISOString());
}

export function parseCostJson(raw: string | null | undefined): ScanCost | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      estimatedUsd: Number(parsed.estimatedUsd ?? 0),
      inputTokens: Number(parsed.inputTokens ?? 0),
      cachedInputTokens: Number(parsed.cachedInputTokens ?? 0),
      cacheWriteInputTokens: Number(parsed.cacheWriteInputTokens ?? 0),
      outputTokens: Number(parsed.outputTokens ?? 0),
      model: typeof parsed.model === "string" ? parsed.model : undefined,
    };
  } catch {
    return null;
  }
}

export function parseRecipe(raw: string | null | undefined): {
  model: string | null;
  effort: string | null;
  mode: string | null;
  repository: string | null;
} {
  if (!raw) {
    return { model: null, effort: null, mode: null, repository: null };
  }
  try {
    const parsed = JSON.parse(raw) as {
      mode?: string;
      repository?: string;
      config?: { model?: string; model_reasoning_effort?: string };
    };
    return {
      model: parsed.config?.model ?? null,
      effort: parsed.config?.model_reasoning_effort ?? null,
      mode: parsed.mode ?? null,
      repository: parsed.repository ?? null,
    };
  } catch {
    return { model: null, effort: null, mode: null, repository: null };
  }
}

export function mapWorkbenchStatus(status: string, canceledAt?: string | null): ScanStatus {
  if (canceledAt) return "cancelled";
  if (status === "complete") return "completed";
  if (status === "running") return "running";
  if (status === "failed") return "failed";
  return "incomplete";
}

export function durationMs(startedAt: string | null, completedAt: string | null): number | null {
  if (!startedAt || !completedAt) return null;
  const a = Date.parse(startedAt);
  const b = Date.parse(completedAt);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.max(0, b - a);
}

export function displayNameFromPaths(
  targetPath: string | null,
  scanDir: string,
): string {
  if (targetPath) return path.basename(targetPath);
  const parts = scanDir.split(path.sep).filter(Boolean);
  return parts[parts.length - 2] || parts[parts.length - 1] || "scan";
}

export { emptySeverityCounts };
