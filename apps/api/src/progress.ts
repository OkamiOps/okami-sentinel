import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { ScanPhase, ScanProgress, ScanRun, ScanStatus } from "@csb/shared";
import { WORKBENCH_DB_PATH } from "./config.js";
import {
  mantisRuntimeProgress,
  readMantisRuntime,
} from "./scanners/mantis-runtime.js";

const PHASES: ScanPhase[] = [
  "preflight",
  "threat_model",
  "discovery",
  "validation",
  "attack_path",
  "reporting",
];

const PHASE_LABELS: Record<string, string> = {
  preflight: "Preflight",
  threat_model: "Threat model",
  discovery: "Discovery",
  validation: "Validação",
  attack_path: "Attack path",
  reporting: "Relatório",
  setup: "Setup (deep)",
  reducing: "Redução (deep)",
  terminal: "Finalização (deep)",
};

interface ProgressRow {
  id: string;
  phase: string;
  mode: string;
  status: string;
  scan_dir: string;
  phase_items_total: number | null;
  phase_items_completed: number | null;
  phase_progress_unit: string | null;
  review_items_total: number | null;
  review_items_completed: number | null;
  reportable_findings_count: number | null;
  preflight_checks_total: number | null;
  preflight_checks_completed: number | null;
  deep_phase: string | null;
  discovery_runs_dispatched: number | null;
  max_discovery_runs: number | null;
  consecutive_no_new: number | null;
  stop_after_no_new: number | null;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function phaseIndex(phase: string | null | undefined): number {
  if (!phase) return 0;
  const i = PHASES.indexOf(phase as ScanPhase);
  return i >= 0 ? i : 0;
}

function phaseLabel(phase: string | null | undefined, deepPhase?: string | null): string {
  if (deepPhase && (phase === "discovery" || phase === "preflight")) {
    return PHASE_LABELS[deepPhase] ?? PHASE_LABELS[phase ?? ""] ?? phase ?? "Em andamento";
  }
  return PHASE_LABELS[phase ?? ""] ?? phase ?? "Em andamento";
}

function unitLabel(unit: string | null): string | null {
  if (!unit) return null;
  const map: Record<string, string> = {
    checks: "checks",
    threat_surfaces: "surfaces",
    review_receipts: "reviews",
    candidate_findings: "candidatos",
    validated_findings: "validados",
    report_artifacts: "artefatos",
    discovery_runs: "discovery runs",
  };
  return map[unit] ?? unit;
}

export function computeProgressFromRow(row: ProgressRow): ScanProgress {
  const phase = row.phase || "preflight";
  const idx = phaseIndex(phase);
  const bucket = 100 / PHASES.length;

  let itemsCompleted = Number(row.phase_items_completed ?? 0);
  let itemsTotal = Number(row.phase_items_total ?? 0);
  let unit = row.phase_progress_unit;

  // Prefer preflight check counters when phase items are empty.
  if (
    phase === "preflight" &&
    itemsTotal <= 0 &&
    Number(row.preflight_checks_total ?? 0) > 0
  ) {
    itemsTotal = Number(row.preflight_checks_total);
    itemsCompleted = Number(row.preflight_checks_completed ?? 0);
    unit = "checks";
  }

  // Review counters as a soft fallback inside discovery/validation.
  if (
    itemsTotal <= 0 &&
    Number(row.review_items_total ?? 0) > 0 &&
    (phase === "discovery" || phase === "validation")
  ) {
    itemsTotal = Number(row.review_items_total);
    itemsCompleted = Number(row.review_items_completed ?? 0);
    unit = unit ?? "review_receipts";
  }

  let fraction = itemsTotal > 0 ? itemsCompleted / itemsTotal : 0;

  // Deep discovery/reducing: use dispatched discovery runs vs cap.
  const deepPhase = row.deep_phase;
  const dispatched = Number(row.discovery_runs_dispatched ?? 0);
  const maxRuns = Number(row.max_discovery_runs ?? 0);
  if (
    row.mode === "deep" &&
    maxRuns > 0 &&
    (phase === "discovery" ||
      deepPhase === "discovery" ||
      deepPhase === "reducing")
  ) {
    fraction = Math.max(fraction, Math.min(1, dispatched / maxRuns));
    itemsCompleted = dispatched;
    itemsTotal = maxRuns;
    unit = "discovery_runs";
  }

  let percent = idx * bucket + fraction * bucket;

  // Soft floor so "running" never looks stuck at 0 forever.
  if (row.status === "running") {
    percent = clamp(percent, phase === "preflight" ? 3 : 8, 97);
  } else if (row.status === "complete") {
    percent = 100;
  }

  const u = unitLabel(unit);
  let detail: string | null = null;
  if (itemsTotal > 0) {
    detail = u
      ? `${itemsCompleted}/${itemsTotal} ${u}`
      : `${itemsCompleted}/${itemsTotal}`;
  } else if (Number(row.reportable_findings_count ?? 0) > 0) {
    detail = `${row.reportable_findings_count} findings reportáveis`;
  }

  if (
    row.mode === "deep" &&
    deepPhase === "reducing" &&
    row.stop_after_no_new != null &&
    row.consecutive_no_new != null
  ) {
    const sat = `saturação ${row.consecutive_no_new}/${row.stop_after_no_new}`;
    detail = detail ? `${detail} · ${sat}` : sat;
  }

  return {
    percent: Math.round(percent),
    phase,
    phaseLabel: phaseLabel(phase, deepPhase),
    detail,
    unit: u,
    itemsCompleted,
    itemsTotal,
    deepPhase,
    reportableFindings: Number(row.reportable_findings_count ?? 0),
  };
}

function queryProgressRows(wb: Database.Database): ProgressRow[] {
  return wb
    .prepare(
      `SELECT s.id, s.phase, s.mode, s.status, s.scan_dir,
              p.phase_items_total, p.phase_items_completed, p.phase_progress_unit,
              p.review_items_total, p.review_items_completed, p.reportable_findings_count,
              p.preflight_checks_total, p.preflight_checks_completed,
              d.phase AS deep_phase, d.discovery_runs_dispatched, d.max_discovery_runs,
              d.consecutive_no_new, d.stop_after_no_new
       FROM scans s
       LEFT JOIN scan_progress p ON p.scan_id = s.id
       LEFT JOIN deep_scan_runs d ON d.scan_id = s.id
       ORDER BY s.started_at DESC`,
    )
    .all() as ProgressRow[];
}

export function dirsMatch(a: string, b: string): boolean {
  const ra = path.resolve(a);
  const rb = path.resolve(b);
  if (ra === rb) return true;
  // Deep mode may relocate under /var/folders while CSB keeps the csb-* dir.
  const ba = path.basename(ra);
  const bb = path.basename(rb);
  if (ba && (rb.endsWith(`/${ba}`) || ra.endsWith(`/${bb}`))) return true;
  if (ba.startsWith("csb-") && rb.includes(ba)) return true;
  if (bb.startsWith("csb-") && ra.includes(bb)) return true;
  return false;
}

/** Read progress for a scan directory (or basename match). */
export function readProgressForScanDir(scanDir: string): ScanProgress | null {
  if (!fs.existsSync(WORKBENCH_DB_PATH)) return null;
  try {
    const wb = new Database(WORKBENCH_DB_PATH, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      const rows = queryProgressRows(wb);
      const hit = rows.find((r) => dirsMatch(r.scan_dir, scanDir));
      return hit ? computeProgressFromRow(hit) : null;
    } finally {
      wb.close();
    }
  } catch {
    return null;
  }
}

function scanDirLooksIdle(scanDir: string): boolean {
  if (!fs.existsSync(scanDir)) return true;
  try {
    const entries = fs.readdirSync(scanDir).filter((n) => n !== "csb-cli.log");
    return entries.length === 0;
  } catch {
    return true;
  }
}

function elapsedMs(startedAt: string | null | undefined): number | null {
  if (!startedAt) return null;
  const t = Date.parse(startedAt);
  return Number.isFinite(t) ? Date.now() - t : null;
}

export function progressForStatus(
  status: ScanStatus,
  scanDir: string,
  mode?: string | null,
  startedAt?: string | null,
): ScanProgress | null {
  if (status === "completed") {
    return {
      percent: 100,
      phase: "reporting",
      phaseLabel: "Concluído",
      detail: null,
      unit: null,
      itemsCompleted: 0,
      itemsTotal: 0,
    };
  }
  if (status !== "running" && status !== "queued") return null;

  const mantis = readMantisRuntime(scanDir);
  if (mantis) return mantisRuntimeProgress(mantis);

  const fromWb = readProgressForScanDir(scanDir);
  const age = elapsedMs(startedAt);
  const idleDir = scanDirLooksIdle(scanDir);
  const stalled =
    age != null &&
    age > 12 * 60_000 &&
    idleDir &&
    (!fromWb ||
      fromWb.phase === "preflight" ||
      ((fromWb.itemsTotal ?? 0) === 0 && (fromWb.percent ?? 0) < 10));

  if (fromWb) {
    if (stalled) {
      return {
        ...fromWb,
        percent: Math.min(fromWb.percent, 5),
        phaseLabel: "Travado",
        detail:
          "1h+ em preflight sem artefatos — provável fila/slot do Codex Security ou auth",
      };
    }
    return fromWb;
  }

  // No workbench row yet — show a honest soft estimate.
  if (stalled || (age != null && age > 12 * 60_000 && idleDir)) {
    return {
      percent: 3,
      phase: "preflight",
      phaseLabel: "Travado",
      detail:
        mode === "deep"
          ? "sem workbench/artefatos — outro deep Contion pode estar ocupando o slot"
          : "sem artefatos há >12 min — CLI provavelmente à espera",
      unit: null,
      itemsCompleted: 0,
      itemsTotal: 0,
    };
  }

  return {
    percent: status === "queued" ? 1 : 5,
    phase: "preflight",
    phaseLabel: status === "queued" ? "Na fila" : "Iniciando",
    detail: mode === "deep" ? "aguardando workbench deep" : "aguardando fase do CLI",
    unit: null,
    itemsCompleted: 0,
    itemsTotal: 0,
  };
}

export function withProgress(run: ScanRun): ScanRun {
  const progress = progressForStatus(
    run.status,
    run.scanDir,
    run.mode,
    run.startedAt,
  );
  return { ...run, progress };
}

export function withProgressMany(runs: ScanRun[]): ScanRun[] {
  return runs.map((r) => withProgress(r));
}

/** Parse CLI progress lines as a weak fallback before workbench rows exist. */
export function parseCliPhaseHint(line: string): Partial<ScanProgress> | null {
  const sentinelMarker = line.match(/SENTINEL_PROGRESS\s+(.+)$/);
  if (sentinelMarker) {
    try {
      const marker = JSON.parse(sentinelMarker[1]) as {
        percent?: unknown;
        phaseLabel?: unknown;
        detail?: unknown;
        stage?: unknown;
        findings?: unknown;
      };
      const percent = Number(marker.percent);
      if (Number.isFinite(percent)) {
        return {
          percent: clamp(percent, 1, 99),
          phase: typeof marker.stage === "string" ? marker.stage : "discovery",
          phaseLabel:
            typeof marker.phaseLabel === "string" ? marker.phaseLabel : "Mantis",
          detail: typeof marker.detail === "string" ? marker.detail : null,
          reportableFindings: Number(marker.findings ?? 0) || 0,
        };
      }
    } catch {
      // Preserve compatibility with non-JSON CLI lines.
    }
  }

  const phaseMatch = line.match(
    /Scan phase:\s*(.+?)(?:\s*\(|$)/i,
  );
  if (phaseMatch) {
    const raw = phaseMatch[1]!.trim().toLowerCase();
    let phase: string = "discovery";
    if (raw.includes("preflight") || raw.includes("setup")) phase = "preflight";
    else if (raw.includes("threat")) phase = "threat_model";
    else if (raw.includes("validat") || raw.includes("review")) phase = "validation";
    else if (raw.includes("attack")) phase = "attack_path";
    else if (raw.includes("report")) phase = "reporting";
    else if (raw.includes("discover") || raw.includes("file")) phase = "discovery";
    const idx = phaseIndex(phase);
    const percent = clamp(Math.round((idx + 0.25) * (100 / PHASES.length)), 5, 90);
    return {
      percent,
      phase,
      phaseLabel: phaseLabel(phase),
      detail: phaseMatch[1]!.trim(),
    };
  }

  const workers = line.match(/reviewing files\s*\((\d+)\s*workers?\)/i);
  if (workers) {
    return {
      percent: 35,
      phase: "discovery",
      phaseLabel: "Discovery",
      detail: `${workers[1]} workers revisando arquivos`,
    };
  }
  return null;
}
