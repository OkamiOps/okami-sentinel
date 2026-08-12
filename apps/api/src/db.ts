import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import {
  emptySeverityCounts,
  type FindingTriage,
  type FindingTriageStatus,
  type ScanCost,
  type ScanConnectionProvenance,
  type ScanLaunchSelection,
  type ReasoningWireField,
  type ScanRun,
  type ScanUsageSummary,
  type ScanStatus,
  type ScannerAuthMode,
  type ScannerEngine,
  type SeverityCounts,
} from "@csb/shared";
import { BENCHMARK_DB_PATH, DATA_DIR } from "./config.js";
import { migrateGuardrailsSchema } from "./guardrails-migrations.js";
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
  execution_profile?: string | null;
  profile_version?: string | null;
  methodology_ref?: string | null;
  capability_check_id?: string | null;
  connection_id?: string | null;
  route_kind?: string | null;
  protocol?: string | null;
  auth_kind?: string | null;
  launch_selection_json?: string | null;
  cost_json?: string | null;
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
      execution_profile TEXT,
      profile_version TEXT,
      methodology_ref TEXT,
      capability_check_id TEXT,
      connection_id TEXT,
      route_kind TEXT,
      protocol TEXT,
      auth_kind TEXT,
      launch_selection_json TEXT,
      cost_json TEXT,
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
  migrateGuardrailsSchema(db);
  return db;
}

export function ensureRunMetadataColumns(database: Database.Database): void {
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
    ["execution_profile", "TEXT"],
    ["profile_version", "TEXT"],
    ["methodology_ref", "TEXT"],
    ["capability_check_id", "TEXT"],
    ["connection_id", "TEXT"],
    ["route_kind", "TEXT"],
    ["protocol", "TEXT"],
    ["auth_kind", "TEXT"],
    ["launch_selection_json", "TEXT"],
    ["cost_json", "TEXT"],
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

  const subscriptionUsageUnavailable =
    (row.engine === "mantis" || row.engine === "vulnhunter") &&
    row.auth_mode === "chatgpt" &&
    (row.input_tokens ?? 0) <= 0 &&
    (row.cached_input_tokens ?? 0) <= 0 &&
    (row.cache_write_tokens ?? 0) <= 0 &&
    (row.output_tokens ?? 0) <= 0;
  // A local existing-session CLI exposes no billable/token accounting contract.
  // Its output must never be re-priced from the OpenRouter catalog.
  const localSessionUsageUnreported =
    row.engine === "mantis" && row.auth_mode === "existing-session";
  const cost: ScanCost | null =
    row.cost_json == null
      ? row.estimated_usd != null && row.estimated_usd > 0 &&
          !subscriptionUsageUnavailable && !localSessionUsageUnreported
        ? {
            estimatedUsd: row.estimated_usd,
            inputTokens: row.input_tokens ?? 0,
            cachedInputTokens: row.cached_input_tokens ?? 0,
            cacheWriteInputTokens: row.cache_write_tokens ?? 0,
            outputTokens: row.output_tokens ?? 0,
            model: row.model ?? undefined,
          }
        : null
      : parseCostJson(row.cost_json);
  const usage = subscriptionUsageUnavailable || localSessionUsageUnreported
    ? null
    : rowToUsageSummary(row);
  const execution = rowToExecutionProvenance(row);
  const connection = rowToConnectionProvenance(row);
  const launchSelection = parseLaunchSelection(row.launch_selection_json);

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
    usage,
    severity,
    source: row.source as ScanRun["source"],
    pid: row.pid,
    execution,
    connection,
    launchSelection,
  });
}

export function upsertRun(run: ScanRun): void {
  const now = new Date().toISOString();
  const cost = run.cost === null ? null : sanitizeScanCost(run.cost);
  const usage = sanitizeUsageSummary(run.usage) ?? (cost === null ? null : {
    inputTokens: cost.inputTokens,
    cachedInputTokens: cost.cachedInputTokens,
    cacheWriteInputTokens: cost.cacheWriteInputTokens,
    outputTokens: cost.outputTokens,
  });
  const execution = run.execution;
  const connection = run.connection ?? null;
  const launchSelection = sanitizeLaunchSelection(run.launchSelection);
  getDb()
    .prepare(
      `INSERT INTO runs (
        id, display_name, repository_path, revision, scan_dir, status,
        model, effort, mode, engine, provider, auth_mode, scanner_version, recipe_hash,
        execution_profile, profile_version, methodology_ref, capability_check_id,
        connection_id, route_kind, protocol, auth_kind, launch_selection_json, cost_json,
        started_at, completed_at, duration_ms,
        estimated_usd, input_tokens, cached_input_tokens, cache_write_tokens, output_tokens,
        severity_critical, severity_high, severity_medium, severity_low, severity_info, severity_unknown, severity_total,
        source, pid, created_at, updated_at
      ) VALUES (
        @id, @display_name, @repository_path, @revision, @scan_dir, @status,
        @model, @effort, @mode, @engine, @provider, @auth_mode, @scanner_version, @recipe_hash,
        @execution_profile, @profile_version, @methodology_ref, @capability_check_id,
        @connection_id, @route_kind, @protocol, @auth_kind, @launch_selection_json, @cost_json,
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
        execution_profile=excluded.execution_profile,
        profile_version=excluded.profile_version,
        methodology_ref=excluded.methodology_ref,
        capability_check_id=excluded.capability_check_id,
        connection_id=excluded.connection_id,
        route_kind=excluded.route_kind,
        protocol=excluded.protocol,
        auth_kind=excluded.auth_kind,
        launch_selection_json=excluded.launch_selection_json,
        cost_json=excluded.cost_json,
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
      execution_profile: execution?.executionProfile ?? null,
      profile_version: execution?.profileVersion ?? null,
      methodology_ref: execution?.methodologyRef ?? null,
      capability_check_id: execution?.capabilityCheckId ?? null,
      connection_id: connection?.connectionId ?? execution?.connectionId ?? null,
      route_kind: connection?.routeKind ?? execution?.routeKind ?? null,
      protocol: connection?.protocol ?? execution?.protocol ?? null,
      auth_kind: connection?.authKind ?? execution?.authKind ?? null,
      launch_selection_json: launchSelection === null ? null : JSON.stringify(launchSelection),
      cost_json: cost === null ? null : JSON.stringify(cost),
      started_at: run.startedAt,
      completed_at: run.completedAt,
      duration_ms: run.durationMs,
      estimated_usd: cost?.estimatedUsd ?? null,
      input_tokens: usage?.inputTokens ?? null,
      cached_input_tokens: usage?.cachedInputTokens ?? null,
      cache_write_tokens: usage?.cacheWriteInputTokens ?? null,
      output_tokens: usage?.outputTokens ?? null,
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
  const hide = database.transaction((scanId: string, hiddenAt: string) => {
    database
      .prepare(
        `INSERT INTO hidden_runs (id, hidden_at)
         VALUES (?, ?)
         ON CONFLICT(id) DO UPDATE SET hidden_at = excluded.hidden_at`,
      )
      .run(scanId, hiddenAt);
    database
      .prepare(`DELETE FROM repository_baselines WHERE scan_id = ?`)
      .run(scanId);
  });
  hide(id, new Date().toISOString());
}

export function parseCostJson(raw: string | null | undefined): ScanCost | null {
  if (!raw) return null;
  try {
    return sanitizeScanCost(JSON.parse(raw));
  } catch {
    return null;
  }
}

function parseLaunchSelection(
  raw: string | null | undefined,
): ScanLaunchSelection | null {
  if (!raw) return null;
  try {
    return sanitizeLaunchSelection(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Keeps retry state identifier-only and rejects legacy/malformed stored JSON. */
function sanitizeLaunchSelection(value: unknown): ScanLaunchSelection | null {
  if (!isRecord(value) || !Array.isArray(value.paths)) return null;
  const modelSelectionMode = value.modelSelectionMode;
  if (
    modelSelectionMode !== "catalog" &&
    modelSelectionMode !== "runtime-default" &&
    modelSelectionMode !== "legacy-unknown"
  ) return null;
  const modelId = value.modelId;
  if (
    (modelSelectionMode === "catalog" && !safeLaunchIdentifier(modelId)) ||
    (modelSelectionMode !== "catalog" && modelId !== null) ||
    value.paths.length > 256 ||
    !value.paths.every(safeLaunchPath)
  ) return null;
  const reasoning = sanitizeLaunchReasoning(value.reasoning);
  if (value.reasoning !== undefined && reasoning === null) return null;
  return {
    modelSelectionMode,
    modelId: modelId as string | null,
    paths: [...value.paths],
    ...(reasoning === null ? {} : { reasoning }),
  };
}

function sanitizeLaunchReasoning(value: unknown): NonNullable<ScanLaunchSelection["reasoning"]> | null {
  if (!isRecord(value)) return null;
  if (value.kind === "provider-default" && value.effort === null && value.wire === null) {
    return { kind: "provider-default", effort: null, wire: null };
  }
  const wires = new Set([
    "Codex CLI config", "turn/start.effort", "reasoning.effort", "reasoning_effort",
    "output_config.effort",
  ]);
  if (
    value.kind !== "sent" ||
    !safeLaunchIdentifier(value.effort) ||
    typeof value.wire !== "string" ||
    !wires.has(value.wire)
  ) {
    return null;
  }
  return {
    kind: "sent",
    effort: value.effort,
    wire: value.wire as ReasoningWireField,
  };
}

function safeLaunchIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value &&
    value.length > 0 && value.length <= 512 && !/[\u0000-\u001F\u007F]/.test(value);
}

function safeLaunchPath(value: unknown): value is string {
  return safeLaunchIdentifier(value) && value.length <= 1_024 &&
    !path.isAbsolute(value) && !path.win32.isAbsolute(value) &&
    !value.split(/[\\/]+/).includes("..");
}

function rowToUsageSummary(row: BenchmarkRow): ScanUsageSummary | null {
  const usage: ScanUsageSummary = {
    inputTokens: row.input_tokens,
    cachedInputTokens: row.cached_input_tokens,
    cacheWriteInputTokens: row.cache_write_tokens,
    outputTokens: row.output_tokens,
  };
  return Object.values(usage).some((value) => value !== null) ? usage : null;
}

function sanitizeUsageSummary(value: unknown): ScanUsageSummary | null {
  if (!isRecord(value)) return null;
  const fields = [
    "inputTokens", "cachedInputTokens", "cacheWriteInputTokens", "outputTokens",
  ] as const;
  const usage = {} as ScanUsageSummary;
  for (const field of fields) {
    const raw = value[field];
    if (raw === null) usage[field] = null;
    else {
      const count = nonNegativeNumber(raw);
      if (count === null || !Number.isSafeInteger(count)) return null;
      usage[field] = count;
    }
  }
  return usage;
}

function rowToExecutionProvenance(row: BenchmarkRow): ScanRun["execution"] {
  if (
    (row.execution_profile !== "native" && row.execution_profile !== "portable") ||
    typeof row.profile_version !== "string" ||
    typeof row.methodology_ref !== "string"
  ) {
    return null;
  }
  return {
    executionProfile: row.execution_profile,
    profileVersion: row.profile_version,
    methodologyRef: row.methodology_ref,
    capabilityCheckId: row.capability_check_id ?? null,
    connectionId: row.connection_id ?? null,
    routeKind: row.route_kind ?? null,
    protocol: (row.protocol ?? null) as NonNullable<ScanRun["execution"]>["protocol"],
    authKind: (row.auth_kind ?? null) as NonNullable<ScanRun["execution"]>["authKind"],
  };
}

function rowToConnectionProvenance(row: BenchmarkRow): ScanConnectionProvenance | null {
  const protocols = new Set([
    "codex-cli", "codex-app-server", "claude-code-cli", "cursor-agent-cli",
    "grok-build-cli", "xai-oauth-responses", "openai-responses", "openai-chat",
    "anthropic-messages", "cursor-background-agents",
  ]);
  const authKinds = new Set([
    "existing-session", "browser-oauth", "device-code", "api-key", "custom-headers",
  ]);
  if (
    !safeLaunchIdentifier(row.connection_id) ||
    !safeLaunchIdentifier(row.route_kind) ||
    !protocols.has(row.protocol ?? "") ||
    !(row.auth_kind === null || row.auth_kind === undefined || authKinds.has(row.auth_kind))
  ) return null;
  return {
    connectionId: row.connection_id,
    routeKind: row.route_kind,
    protocol: row.protocol as ScanConnectionProvenance["protocol"],
    authKind: (row.auth_kind ?? null) as ScanConnectionProvenance["authKind"],
    capabilityCheckId: safeLaunchIdentifier(row.capability_check_id)
      ? row.capability_check_id
      : null,
  };
}

function sanitizeScanCost(value: unknown): ScanCost | null {
  if (!isRecord(value)) return null;
  const estimatedUsd = nonNegativeNumber(value.estimatedUsd);
  const inputTokens = nonNegativeNumber(value.inputTokens);
  const cachedInputTokens = nonNegativeNumber(value.cachedInputTokens);
  const cacheWriteInputTokens = nonNegativeNumber(value.cacheWriteInputTokens);
  const outputTokens = nonNegativeNumber(value.outputTokens);
  if (
    estimatedUsd === null ||
    inputTokens === null ||
    cachedInputTokens === null ||
    cacheWriteInputTokens === null ||
    outputTokens === null
  ) {
    return null;
  }

  const cost: ScanCost = {
    estimatedUsd,
    inputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    outputTokens,
  };
  if (typeof value.model === "string") cost.model = value.model;
  if (
    value.pricingSource === "openrouter" ||
    value.pricingSource === "provider-catalog" ||
    value.pricingSource === "official-rate-card"
  ) {
    cost.pricingSource = value.pricingSource;
  }
  if (value.pricingBasis === "metered" || value.pricingBasis === "payg-equivalent") {
    cost.pricingBasis = value.pricingBasis;
  }
  if (
    value.billingMode === "metered" ||
    value.billingMode === "subscription" ||
    value.billingMode === "credits" ||
    value.billingMode === "unknown"
  ) {
    cost.billingMode = value.billingMode;
  }
  if (
    value.pricingRateCardId === "xai.grok-4.5.2026-07-03" ||
    value.pricingRateCardId === "minimax.m3.payg.2026-08-11" ||
    value.pricingRateCardId === "xiaomi.mimo-v2.5-pro.payg.2026-08-06"
  ) {
    cost.pricingRateCardId = value.pricingRateCardId;
  }
  if (value.pricingTiming === "launch" || value.pricingTiming === "post-hoc") {
    cost.pricingTiming = value.pricingTiming;
  }
  if (value.estimateKind === "upper-bound") {
    cost.estimateKind = value.estimateKind;
  }
  if (value.pricingMatch === "exact" || value.pricingMatch === "catalog-unique") {
    cost.pricingMatch = value.pricingMatch;
  } else if (
    value.pricingMatch === "approved-alias" &&
    value.pricingAliasId === "openai.spark-to-gpt-5.3-codex.v1"
  ) {
    cost.pricingMatch = value.pricingMatch;
    cost.pricingAliasId = value.pricingAliasId;
  }
  if (typeof value.pricingModel === "string") cost.pricingModel = value.pricingModel;
  if (typeof value.pricingUpdatedAt === "string") cost.pricingUpdatedAt = value.pricingUpdatedAt;
  for (const field of ["inputUsd", "cachedInputUsd", "cacheWriteInputUsd", "outputUsd"] as const) {
    const amount = nonNegativeNumber(value[field]);
    if (amount !== null) cost[field] = amount;
  }
  const pricingSnapshot = sanitizePricingSnapshot(value.pricingSnapshot);
  if (pricingSnapshot !== null) cost.pricingSnapshot = pricingSnapshot;
  if (cost.estimatedUsd === 0 && cost.pricingSource === undefined) return null;
  return cost;
}

function sanitizePricingSnapshot(
  value: unknown,
): NonNullable<ScanCost["pricingSnapshot"]> | null {
  if (!isRecord(value) || value.currency !== "USD" || typeof value.capturedAt !== "string") {
    return null;
  }
  const inputUsdPerMillionTokens = nullableNonNegativeNumber(value.inputUsdPerMillionTokens);
  const cachedInputUsdPerMillionTokens = nullableNonNegativeNumber(
    value.cachedInputUsdPerMillionTokens,
  );
  const cacheWriteInputUsdPerMillionTokens = nullableNonNegativeNumber(
    value.cacheWriteInputUsdPerMillionTokens,
  );
  const outputUsdPerMillionTokens = nullableNonNegativeNumber(value.outputUsdPerMillionTokens);
  if (
    inputUsdPerMillionTokens === undefined ||
    cachedInputUsdPerMillionTokens === undefined ||
    cacheWriteInputUsdPerMillionTokens === undefined ||
    outputUsdPerMillionTokens === undefined
  ) {
    return null;
  }
  return {
    currency: "USD",
    capturedAt: value.capturedAt,
    inputUsdPerMillionTokens,
    cachedInputUsdPerMillionTokens,
    cacheWriteInputUsdPerMillionTokens,
    outputUsdPerMillionTokens,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function nullableNonNegativeNumber(value: unknown): number | null | undefined {
  if (value === null) return null;
  return nonNegativeNumber(value) ?? undefined;
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
