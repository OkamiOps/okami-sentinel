import { scanEstimatedUsd, type ScanRun } from "@csb/shared";
import { getDb, rowToScanRun, type BenchmarkRow } from "./db.js";
import type { AccessScope } from "./auth/principal.js";
import { scopeSql } from "./auth/scope-sql.js";

/** Local mode and administrators read the whole ledger; a member reads its grants. */
const ALL_REPOSITORIES: AccessScope = { kind: "all" };

export interface ScanListOptions {
  limit: number;
  offset: number;
  status: string;
  query: string;
}

const statuses = new Set(["all", "active", "queued", "running", "completed", "incomplete", "failed", "cancelled"]);
const visibleRuns = "FROM runs LEFT JOIN hidden_runs ON hidden_runs.id = runs.id WHERE hidden_runs.id IS NULL";
const order = "ORDER BY COALESCE(runs.started_at, runs.created_at) DESC, runs.id DESC";

export function parseScanListOptions(query: Record<string, string>): ScanListOptions | null {
  if (!["limit", "offset", "status", "query"].some((key) => key in query)) return null;
  const integer = (value: string | undefined, fallback: number, maximum: number) => {
    if (value === undefined) return fallback;
    if (!/^\d+$/.test(value)) throw new Error("Invalid scan pagination");
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed > maximum) throw new Error("Invalid scan pagination");
    return parsed;
  };
  const limit = integer(query.limit, 25, 100);
  const offset = integer(query.offset, 0, Number.MAX_SAFE_INTEGER);
  if (limit < 1 || !statuses.has(query.status ?? "all")) throw new Error("Invalid scan pagination");
  return { limit, offset, status: query.status ?? "all", query: (query.query ?? "").trim().slice(0, 500) };
}

/** The global status bar reads only active rows; it never walks terminal artifacts. */
export function listActiveRuns(scope: AccessScope = ALL_REPOSITORIES): ScanRun[] {
  const clause = scopeSql(scope, "runs.repository_key");
  return (getDb().prepare(`SELECT runs.* ${visibleRuns}${clause.sql} AND runs.status IN ('queued', 'running') ${order}`)
    .all(...clause.params) as BenchmarkRow[]).map(rowToScanRun);
}

/** Filter choices need names and a count, not scan artifacts or full run records. */
export function scanCatalog(scope: AccessScope = ALL_REPOSITORIES): { total: number; repositories: string[] } {
  const clause = scopeSql(scope, "runs.repository_key");
  const rows = getDb().prepare(`SELECT runs.display_name AS name, COUNT(*) AS count ${visibleRuns}${clause.sql} GROUP BY runs.display_name ORDER BY runs.display_name`)
    .all(...clause.params) as Array<{ name: string; count: number }>;
  return {
    total: rows.reduce((total, row) => total + row.count, 0),
    repositories: rows.map((row) => row.name).filter(Boolean),
  };
}

/** Pagination happens in SQLite. Summary costs use the same pricing rules as detail views. */
export function listRunPage(options: ScanListOptions, summarize = true, scope: AccessScope = ALL_REPOSITORIES) {
  const db = getDb();
  db.function("sentinel_search_lower", { deterministic: true }, (value: unknown) => String(value ?? "").toLowerCase());
  const clause = scopeSql(scope, "runs.repository_key");
  const params: string[] = [...clause.params];
  let where = `${visibleRuns}${clause.sql}`;
  if (options.status === "active") where += " AND runs.status NOT IN ('failed', 'cancelled')";
  else if (options.status !== "all") { where += " AND runs.status = ?"; params.push(options.status); }
  if (options.query) {
    where += " AND instr(sentinel_search_lower(runs.display_name || ' ' || COALESCE(runs.engine, '') || ' ' || COALESCE(runs.model, '') || ' ' || COALESCE(runs.effort, '') || ' ' || COALESCE(runs.repository_path, '')), ?) > 0";
    params.push(options.query.toLowerCase());
  }
  // Deferred on purpose: this page only reads, and it is polled. An immediate
  // transaction (this connection's default, see `sqlite.ts`) would take the
  // write lock and stall the dashboard behind any scanner write.
  return db.transaction(() => {
    const total = (db.prepare(`SELECT COUNT(*) AS count ${where}`).get(...params) as { count: number }).count;
    // Clamp an out-of-date last page after deletion so the ledger remains useful.
    const offset = Math.min(options.offset, Math.max(0, Math.ceil(total / options.limit) - 1) * options.limit);
    const scans = (db.prepare(`SELECT runs.* ${where} ${order} LIMIT ? OFFSET ?`)
      .all(...params, options.limit, offset) as BenchmarkRow[]).map(rowToScanRun);
    let evidence = 0;
    let costUsd: number | null = null;
    let costIsUpperBound = false;
    for (const row of summarize ? db.prepare(`SELECT runs.* ${where}`).iterate(...params) as Iterable<BenchmarkRow> : []) {
      const scan = rowToScanRun(row);
      evidence += scan.severity.total;
      const cost = scanEstimatedUsd(scan);
      if (cost !== null) {
        costUsd = (costUsd ?? 0) + cost;
        costIsUpperBound ||= scan.cost?.estimateKind === "upper-bound";
      }
    }
    const archivedCount = (db.prepare(`SELECT COUNT(*) AS count ${visibleRuns}${clause.sql} AND runs.status IN ('failed', 'cancelled')`)
      .get(...clause.params) as { count: number }).count;
    return { scans, total, limit: options.limit, offset, summary: { evidence, costUsd, costIsUpperBound, archivedCount } };
  }).deferred();
}
