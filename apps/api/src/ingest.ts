import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import {
  emptySeverityCounts,
  normalizeSeverity,
  type FindingDetail,
  type FindingSummary,
  type ScanRun,
  type SeverityCounts,
} from "@csb/shared";
import { SCANS_ROOT, WORKBENCH_DB_PATH } from "./config.js";
import {
  deleteRun,
  displayNameFromPaths,
  durationMs,
  listRuns,
  mapWorkbenchStatus,
  parseCostJson,
  parseRecipe,
  upsertRun,
} from "./db.js";
import { normalizeAttackPath } from "./attack-path.js";
import { dirsMatch } from "./progress.js";

interface WorkbenchScanRow {
  id: string;
  target_path: string;
  target_revision: string;
  scan_dir: string;
  status: string;
  mode: string;
  started_at: string;
  completed_at: string | null;
  canceled_at: string | null;
  recipe_json: string | null;
  cost_json: string | null;
  target_summary: string | null;
}

function countSeverityFromFindings(findingsPath: string): SeverityCounts {
  const counts = emptySeverityCounts();
  if (!fs.existsSync(findingsPath)) return counts;
  try {
    const raw = JSON.parse(fs.readFileSync(findingsPath, "utf8")) as {
      findings?: Array<{ severity?: unknown }>;
    };
    for (const f of raw.findings ?? []) {
      const sev = normalizeSeverity(f.severity);
      counts[sev] += 1;
      counts.total += 1;
    }
  } catch {
    // ignore malformed findings
  }
  return counts;
}

/**
 * When a scan dies before writing findings.json (e.g. ChatGPT cyber flag),
 * recover reportable findings from the on-disk findings/<slug>/*.md folders.
 */
export function recoverFindingsJsonFromMarkdown(scanDir: string): number {
  const findingsPath = path.join(scanDir, "findings.json");
  if (fs.existsSync(findingsPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(findingsPath, "utf8")) as {
        findings?: unknown[];
      };
      if ((existing.findings?.length ?? 0) > 0) return existing.findings!.length;
    } catch {
      // rewrite below
    }
  }

  const findings: Array<Record<string, unknown>> = [];

  // 1) Classic sealed layout: findings/<slug>/*.md
  const root = path.join(scanDir, "findings");
  if (fs.existsSync(root)) {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(root, entry.name);
      let names: string[] = [];
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue;
      }
      const mdName =
        names.find((f) => f.endsWith(".md") && !f.toLowerCase().includes("readme")) ??
        names.find((f) => f.endsWith(".md"));
      if (!mdName) continue;
      const body = fs.readFileSync(path.join(dir, mdName), "utf8");
      const titleMatch = body.match(/^#\s+(.+)$/m);
      const title = (titleMatch?.[1] ?? entry.name).trim();
      const exec =
        body.match(/##\s+Executive Summary\s*\n+([\s\S]*?)(?:\n##\s|\n#\s|$)/i)?.[1]?.trim() ??
        null;
      const summary = exec
        ? exec.split(/\n\n+/)[0]!.replace(/\s+/g, " ").trim().slice(0, 600)
        : title;
      const sev =
        body.match(
          /\bas(?:sess|sessed)?\s+(?:the\s+)?(?:issue|severity)\s+as\s+(critical|high|medium|low)\b/i,
        )?.[1] ??
        body.match(
          /(?:^|\n)\s*[-*]?\s*severity\s*:\s*(critical|high|medium|low)\b/i,
        )?.[1] ??
        body.match(/\b(critical|high|medium|low)\s+severity\b/i)?.[1] ??
        body.match(/\bseverity[^.\n]{0,40}\b(critical|high|medium|low)\b/i)?.[1] ??
        "medium";
      const pathHit =
        body.match(
          /`((?:contion-app|contion-landing|apps|src|functions)[^`\n]{2,160})`/,
        )?.[1] ??
        body.match(/`([^`\n]+\.(?:ts|tsx|js|jsx|py|go|rs)(?::\d+(?:-\d+)?)?)`/)?.[1] ??
        null;

      findings.push({
        findingId: entry.name,
        occurrenceId: `recovered-${entry.name}`,
        title,
        summary,
        severity: { level: sev.toLowerCase() },
        confidence: {
          level: "medium",
          rationale:
            "Recovered from on-disk finding markdown after incomplete scan seal.",
        },
        ruleId: `recovered/${entry.name}`,
        remediation: null,
        locations: pathHit ? [{ path: pathHit, role: "primary" }] : [],
        codeEvidence: [],
        taxonomy: { category: "Recovered finding", cwe: [] },
        provenance: { source: "csb-recovery", note: "Synthesized from findings/*.md" },
      });
    }
  }

  // 2) Deep mode mid-run: artifacts/04_reconciliation/deduped_candidates.jsonl
  if (findings.length === 0) {
    const deepCandidates = [
      path.join(scanDir, "artifacts", "04_reconciliation", "deduped_candidates.jsonl"),
      path.join(scanDir, "artifacts", "02_discovery", "raw_candidates.jsonl"),
    ];
    for (const file of deepCandidates) {
      if (!fs.existsSync(file)) continue;
      const byId = new Map<string, Record<string, unknown>>();
      for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line) as Record<string, unknown>;
          const cid = String(row.candidate_id ?? "");
          if (!cid) continue;
          byId.set(cid, row);
        } catch {
          // skip bad line
        }
      }
      for (const [cid, row] of byId) {
        const locs = Array.isArray(row.affected_locations)
          ? (row.affected_locations as Array<Record<string, unknown>>)
          : [];
        const primary = locs.find((l) => typeof l.path === "string") ?? null;
        const primaryPath =
          primary && typeof primary.path === "string"
            ? String(primary.path).replace(/^\.worktrees\/[^/]+\//, "")
            : null;
        const impact =
          typeof row.impact === "string" ? row.impact : null;
        const title =
          typeof row.title === "string" && row.title.trim()
            ? row.title.trim()
            : cid;
        const cwe = Array.isArray(row.cwe_ids)
          ? row.cwe_ids.filter((x): x is string => typeof x === "string")
          : [];
        findings.push({
          findingId: cid,
          occurrenceId: `recovered-deep-${cid}`,
          title,
          summary: impact ?? title,
          severity: { level: "medium" },
          confidence: {
            level: "medium",
            rationale:
              "Recovered from deep discovery candidates (validation/severity not finalized).",
          },
          ruleId: `deep-candidate/${cid}`,
          remediation: null,
          locations: primaryPath
            ? [
                {
                  path: primaryPath,
                  role: "primary",
                  lines: typeof primary?.lines === "string" ? primary.lines : null,
                },
              ]
            : [],
          codeEvidence: [],
          taxonomy: {
            category: "Deep discovery candidate",
            cwe,
          },
          provenance: {
            source: "csb-recovery-deep",
            note: path.basename(file),
          },
        });
      }
      if (findings.length > 0) break;
    }
  }

  if (findings.length === 0) return 0;
  fs.writeFileSync(
    findingsPath,
    JSON.stringify(
      {
        documentType: "codex-security.findings",
        schemaVersion: "recovered-1",
        recovered: true,
        findings,
      },
      null,
      2,
    ),
    "utf8",
  );
  return findings.length;
}

export function readFindingsFile(scanDir: string): FindingDetail[] {
  const findingsPath = path.join(scanDir, "findings.json");
  if (!fs.existsSync(findingsPath)) {
    recoverFindingsJsonFromMarkdown(scanDir);
  } else {
    try {
      const existing = JSON.parse(fs.readFileSync(findingsPath, "utf8")) as {
        findings?: unknown[];
      };
      if ((existing.findings?.length ?? 0) === 0) {
        recoverFindingsJsonFromMarkdown(scanDir);
      }
    } catch {
      recoverFindingsJsonFromMarkdown(scanDir);
    }
  }
  if (!fs.existsSync(findingsPath)) return [];
  const raw = JSON.parse(fs.readFileSync(findingsPath, "utf8")) as {
    findings?: Array<Record<string, unknown>>;
  };
  return (raw.findings ?? []).map((f) => {
    const locations = Array.isArray(f.locations) ? f.locations : [];
    const primary =
      locations.find(
        (l) =>
          l &&
          typeof l === "object" &&
          "path" in l &&
          typeof (l as { path: unknown }).path === "string",
      ) ??
      (Array.isArray(f.codeEvidence)
        ? f.codeEvidence.find(
            (e) =>
              e &&
              typeof e === "object" &&
              "path" in e &&
              typeof (e as { path: unknown }).path === "string",
          )
        : null);

    const fingerprints: string[] = [];
    if (f.fingerprints && typeof f.fingerprints === "object") {
      for (const v of Object.values(f.fingerprints as Record<string, unknown>)) {
        if (typeof v === "string") fingerprints.push(v);
      }
    }
    if (typeof f.findingId === "string") fingerprints.push(f.findingId);

    const primaryPath =
      primary && typeof primary === "object" && "path" in primary
        ? String((primary as { path: string }).path)
        : null;

    const taxonomy =
      f.taxonomy && typeof f.taxonomy === "object"
        ? (f.taxonomy as { category?: unknown; cwe?: unknown })
        : null;
    const category =
      taxonomy && typeof taxonomy.category === "string" ? taxonomy.category : null;
    const cwe = Array.isArray(taxonomy?.cwe)
      ? taxonomy!.cwe.filter((x): x is string => typeof x === "string")
      : [];

    const { level: confidence, rationale: confidenceRationale } = pickLevel(
      f.confidence,
    );
    const severityObj =
      f.severity && typeof f.severity === "object"
        ? (f.severity as { rationale?: unknown })
        : null;

    const detail: FindingDetail = {
      findingId: String(f.findingId ?? f.occurrenceId ?? cryptoRandom()),
      occurrenceId: typeof f.occurrenceId === "string" ? f.occurrenceId : null,
      title: String(f.title ?? "Untitled finding"),
      severity: normalizeSeverity(f.severity),
      confidence,
      ruleId: typeof f.ruleId === "string" ? f.ruleId : null,
      summary: typeof f.summary === "string" ? f.summary : null,
      primaryPath,
      fingerprints,
      category,
      cwe,
      attackPath: f.attackPath ?? null,
      attackPathModel: null,
      codeEvidence: Array.isArray(f.codeEvidence) ? f.codeEvidence : [],
      remediation: f.remediation ?? null,
      locations: f.locations ?? null,
      taxonomy: f.taxonomy ?? null,
      rootCause: f.rootCause ?? null,
      validation: f.validation ?? null,
      preventiveControls: f.preventiveControls ?? null,
      remediationTests: f.remediationTests ?? null,
      severityRationale:
        severityObj && typeof severityObj.rationale === "string"
          ? severityObj.rationale
          : null,
      confidenceRationale,
    };
    return {
      ...detail,
      attackPathModel: normalizeAttackPath(detail),
    };
  });
}

function pickLevel(value: unknown): {
  level: string | null;
  rationale: string | null;
} {
  if (typeof value === "string") return { level: value, rationale: null };
  if (value && typeof value === "object") {
    const o = value as { level?: unknown; rationale?: unknown };
    return {
      level: typeof o.level === "string" ? o.level : null,
      rationale: typeof o.rationale === "string" ? o.rationale : null,
    };
  }
  return { level: null, rationale: null };
}

export function toFindingSummaries(details: FindingDetail[]): FindingSummary[] {
  return details.map(
    ({
      findingId,
      occurrenceId,
      title,
      severity,
      confidence,
      ruleId,
      summary,
      primaryPath,
      fingerprints,
      category,
      cwe,
    }) => ({
      findingId,
      occurrenceId,
      title,
      severity,
      confidence,
      ruleId,
      summary,
      primaryPath,
      fingerprints,
      category,
      cwe,
    }),
  );
}

function cryptoRandom(): string {
  return `unknown-${Math.random().toString(36).slice(2)}`;
}

function workbenchRowToScanRun(row: WorkbenchScanRow): ScanRun {
  const recipe = parseRecipe(row.recipe_json);
  const cost = parseCostJson(row.cost_json);
  recoverFindingsJsonFromMarkdown(row.scan_dir);
  const findingsPath = path.join(row.scan_dir, "findings.json");
  const severity = countSeverityFromFindings(findingsPath);
  return {
    id: row.id,
    displayName: displayNameFromPaths(row.target_path, row.scan_dir),
    repositoryPath: recipe.repository ?? row.target_path,
    revision: row.target_revision,
    scanDir: row.scan_dir,
    status: mapWorkbenchStatus(row.status, row.canceled_at),
    model: recipe.model ?? cost?.model ?? null,
    effort: recipe.effort,
    mode: recipe.mode ?? row.mode,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    durationMs: durationMs(row.started_at, row.completed_at),
    cost,
    severity,
    source: "workbench",
    pid: null,
  };
}

export function readWorkbenchScans(): ScanRun[] {
  if (!fs.existsSync(WORKBENCH_DB_PATH)) return [];
  try {
    const wb = new Database(WORKBENCH_DB_PATH, { readonly: true, fileMustExist: true });
    try {
      const rows = wb
        .prepare(
          `SELECT id, target_path, target_revision, scan_dir, status, mode,
                  started_at, completed_at, canceled_at, recipe_json, cost_json, target_summary
           FROM scans
           ORDER BY started_at DESC`,
        )
        .all() as WorkbenchScanRow[];
      return rows.map(workbenchRowToScanRun);
    } finally {
      wb.close();
    }
  } catch {
    return [];
  }
}

export function readWorkbenchScan(id: string): ScanRun | null {
  if (!fs.existsSync(WORKBENCH_DB_PATH)) return null;
  try {
    const wb = new Database(WORKBENCH_DB_PATH, { readonly: true, fileMustExist: true });
    try {
      const row = wb
        .prepare(
          `SELECT id, target_path, target_revision, scan_dir, status, mode,
                  started_at, completed_at, canceled_at, recipe_json, cost_json, target_summary
           FROM scans WHERE id = ?`,
        )
        .get(id) as WorkbenchScanRow | undefined;
      return row ? workbenchRowToScanRun(row) : null;
    } finally {
      wb.close();
    }
  } catch {
    return null;
  }
}

function findManifestDirs(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const results: string[] = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    if (entries.some((e) => e.isFile() && e.name === "scan-manifest.json")) {
      results.push(current);
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith(".")) {
        stack.push(path.join(current, e.name));
      }
    }
  }
  return results;
}

export function readFilesystemScans(): ScanRun[] {
  const dirs = findManifestDirs(SCANS_ROOT);
  const runs: ScanRun[] = [];
  for (const scanDir of dirs) {
    try {
      const manifest = JSON.parse(
        fs.readFileSync(path.join(scanDir, "scan-manifest.json"), "utf8"),
      ) as {
        scan?: {
          id?: string;
          status?: string;
          startedAt?: string;
          completedAt?: string;
          target?: { displayName?: string; revision?: string };
        };
      };
      const id = manifest.scan?.id;
      if (!id) continue;
      const severity = countSeverityFromFindings(path.join(scanDir, "findings.json"));
      runs.push({
        id,
        displayName:
          manifest.scan?.target?.displayName ??
          displayNameFromPaths(null, scanDir),
        repositoryPath: null,
        revision: manifest.scan?.target?.revision ?? null,
        scanDir,
        status: mapWorkbenchStatus(manifest.scan?.status ?? "complete"),
        model: null,
        effort: null,
        mode: null,
        startedAt: manifest.scan?.startedAt ?? null,
        completedAt: manifest.scan?.completedAt ?? null,
        durationMs: durationMs(
          manifest.scan?.startedAt ?? null,
          manifest.scan?.completedAt ?? null,
        ),
        cost: null,
        severity,
        source: "filesystem",
        pid: null,
      });
    } catch {
      // skip
    }
  }
  return runs;
}

/** Prefer workbench (cost/model) over filesystem/benchmark stubs for the same output dir. */
function runRichness(run: ScanRun): number {
  let score = 0;
  if (run.cost?.estimatedUsd) score += 20;
  if (run.model) score += 8;
  if (run.effort) score += 4;
  if (run.repositoryPath) score += 4;
  if (run.source === "workbench") score += 6;
  if (run.source === "benchmark") score += 3;
  if (run.severity.total > 0) score += 2;
  return score;
}

function pickCost(
  a: ScanRun["cost"],
  b: ScanRun["cost"],
): ScanRun["cost"] {
  const au = a?.estimatedUsd ?? 0;
  const bu = b?.estimatedUsd ?? 0;
  if (au <= 0 && bu <= 0) return a ?? b;
  return au >= bu ? a : b;
}

function mergeRuns(a: ScanRun, b: ScanRun): ScanRun {
  const [primary, secondary] =
    runRichness(a) >= runRichness(b) ? [a, b] : [b, a];
  // Keep the UI/benchmark id when one side is a local launch.
  const id =
    a.source === "benchmark"
      ? a.id
      : b.source === "benchmark"
        ? b.id
        : primary.id;
  return {
    ...primary,
    id,
    source: a.source === "benchmark" || b.source === "benchmark" ? "benchmark" : primary.source,
    repositoryPath: primary.repositoryPath ?? secondary.repositoryPath,
    revision: primary.revision ?? secondary.revision,
    model: primary.model ?? secondary.model,
    effort: primary.effort ?? secondary.effort,
    mode: primary.mode ?? secondary.mode,
    cost: pickCost(primary.cost, secondary.cost),
    startedAt: primary.startedAt ?? secondary.startedAt,
    completedAt: primary.completedAt ?? secondary.completedAt,
    durationMs: primary.durationMs ?? secondary.durationMs,
    severity:
      primary.severity.total >= secondary.severity.total
        ? primary.severity
        : secondary.severity,
  };
}

export function importExternalScans(): { imported: number; pruned: number } {
  const byDir = new Map<string, ScanRun>();

  // Seed with DB rows so we can merge/prune prior duplicates.
  for (const run of listRuns()) {
    byDir.set(path.resolve(run.scanDir), run);
  }
  for (const run of readFilesystemScans()) {
    const key = path.resolve(run.scanDir);
    const prev = byDir.get(key);
    byDir.set(key, prev ? mergeRuns(prev, run) : run);
  }
  // Workbench last so cost/model win when tied with stubs.
  for (const run of readWorkbenchScans()) {
    const key = path.resolve(run.scanDir);
    const prev = byDir.get(key);
    byDir.set(key, prev ? mergeRuns(prev, run) : run);
  }

  const winners = [...byDir.values()];
  const winnerIds = new Set(winners.map((r) => r.id));
  for (const run of winners) upsertRun(run);

  let pruned = 0;
  for (const run of listRuns()) {
    const key = path.resolve(run.scanDir);
    const winner = byDir.get(key);
    if (!winner) continue;
    if (run.id !== winner.id || !winnerIds.has(run.id)) {
      if (run.id !== winner.id) {
        deleteRun(run.id);
        pruned += 1;
      }
    }
  }

  return { imported: winners.length, pruned };
}

export function refreshRunFromDisk(id: string): ScanRun | null {
  const fromWb = readWorkbenchScan(id);
  if (fromWb) {
    recoverFindingsJsonFromMarkdown(fromWb.scanDir);
    fromWb.severity = countSeverityFromFindings(
      path.join(fromWb.scanDir, "findings.json"),
    );
    upsertRun(fromWb);
    return fromWb;
  }
  return null;
}

/** Merge workbench row for a scanDir into an existing benchmark run (cost/status). */
export function refreshRunByScanDir(scanDir: string, fallbackId?: string): ScanRun | null {
  for (const wb of readWorkbenchScans()) {
    if (!dirsMatch(wb.scanDir, scanDir)) continue;
    recoverFindingsJsonFromMarkdown(wb.scanDir);
    wb.severity = countSeverityFromFindings(path.join(wb.scanDir, "findings.json"));
    if (fallbackId) {
      const merged = mergeRuns(
        {
          ...wb,
          id: fallbackId,
          source: "benchmark",
          // Keep the CSB output dir so UI paths stay stable.
          scanDir,
        },
        wb,
      );
      upsertRun(merged);
      return merged;
    }
    upsertRun(wb);
    return wb;
  }
  return null;
}

/** Sync terminal status/cost from workbench for benchmark runs still marked running. */
export function reconcileRunningScans(): number {
  let updated = 0;
  for (const run of listRuns()) {
    if (run.status !== "running") continue;
    const before = `${run.status}|${run.cost?.estimatedUsd ?? 0}|${run.severity.total}`;
    const refreshed = refreshRunByScanDir(run.scanDir, run.id);
    if (!refreshed) continue;
    const after = `${refreshed.status}|${refreshed.cost?.estimatedUsd ?? 0}|${refreshed.severity.total}`;
    if (before !== after) updated += 1;
  }
  return updated;
}
