import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import Database from "better-sqlite3";
import { RUNS_DIR, SCANS_ROOT, WORKBENCH_DB_PATH } from "./config.js";
import { dirsMatch } from "./progress.js";

export function cliLogPath(scanDir: string): string {
  return path.join(RUNS_DIR, `${path.basename(scanDir)}.log`);
}

export function appendCliLog(scanDir: string, line: string): void {
  try {
    const file = cliLogPath(scanDir);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, `${line}\n`, "utf8");
  } catch {
    // ignore disk errors
  }
}

export function readCliLogTail(scanDir: string, maxLines = 250): string[] {
  const file = cliLogPath(scanDir);
  if (!fs.existsSync(file)) return [];
  try {
    const text = fs.readFileSync(file, "utf8");
    return text.split(/\r?\n/).filter(Boolean).slice(-maxLines);
  } catch {
    return [];
  }
}

export function purgeScanArtifacts(
  scanDir: string,
  managedRoots: string[] = [SCANS_ROOT],
): void {
  const resolvedScanDir = path.resolve(scanDir);
  const canonicalScanDir = fs.existsSync(resolvedScanDir)
    ? fs.realpathSync.native(resolvedScanDir)
    : resolvedScanDir;
  const isManaged = managedRoots.some((root) => {
    const resolvedRoot = path.resolve(root);
    const canonicalRoot = fs.existsSync(resolvedRoot)
      ? fs.realpathSync.native(resolvedRoot)
      : resolvedRoot;
    const relative = path.relative(canonicalRoot, canonicalScanDir);
    return relative !== ""
      && relative !== ".."
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative);
  });

  if (!isManaged) {
    throw new Error("Diretório do scan fora das raízes gerenciadas; exclusão recusada.");
  }

  fs.rmSync(resolvedScanDir, { recursive: true, force: true });
  fs.rmSync(cliLogPath(resolvedScanDir), { force: true });
}

/** Resolve the live workbench scan_dir for a CSB (or workbench) directory. */
export function resolveWorkbenchScanDir(scanDir: string): string | null {
  if (!fs.existsSync(WORKBENCH_DB_PATH)) return null;
  try {
    const wb = new Database(WORKBENCH_DB_PATH, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      const rows = wb
        .prepare(`SELECT scan_dir FROM scans ORDER BY started_at DESC`)
        .all() as Array<{ scan_dir: string }>;
      const hit = rows.find((r) => dirsMatch(r.scan_dir, scanDir));
      return hit?.scan_dir ?? null;
    } finally {
      wb.close();
    }
  } catch {
    return null;
  }
}

/** Best-effort activity lines when stdout is no longer attached. */
export function readDetachedActivity(scanDir: string): string[] {
  const lines: string[] = [];
  const wbDir = resolveWorkbenchScanDir(scanDir) ?? scanDir;

  const ledger = path.join(wbDir, "artifacts", "02_discovery", "work_ledger.jsonl");
  if (fs.existsSync(ledger)) {
    try {
      const raw = fs.readFileSync(ledger, "utf8").trim().split(/\r?\n/).filter(Boolean);
      const tail = raw.slice(-6);
      for (const row of tail) {
        try {
          const j = JSON.parse(row) as Record<string, unknown>;
          const kind = String(j.kind ?? j.type ?? j.event ?? "event");
          const status = j.status != null ? ` status=${j.status}` : "";
          const id = j.id != null ? ` id=${j.id}` : j.worker_id != null ? ` worker=${j.worker_id}` : "";
          lines.push(`[workbench] ledger ${kind}${id}${status}`);
        } catch {
          lines.push(`[workbench] ${row.slice(0, 160)}`);
        }
      }
    } catch {
      // ignore
    }
  }

  const findingsDir = path.join(wbDir, "artifacts", "05_findings");
  if (fs.existsSync(findingsDir)) {
    try {
      const n = fs.readdirSync(findingsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).length;
      if (n > 0) lines.push(`[workbench] artifacts/05_findings: ${n} pasta(s)`);
    } catch {
      // ignore
    }
  }

  if (!fs.existsSync(WORKBENCH_DB_PATH)) return lines;
  try {
    const wb = new Database(WORKBENCH_DB_PATH, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      const row = wb
        .prepare(
          `SELECT s.id, s.phase, s.status, d.phase AS deep_phase,
                  d.discovery_runs_dispatched, d.max_discovery_runs,
                  d.consecutive_no_new, d.stop_after_no_new,
                  (SELECT COUNT(*) FROM deep_scan_workers w
                    WHERE w.scan_id = s.id AND w.status = 'running') AS workers_running,
                  (SELECT COUNT(*) FROM deep_scan_workers w
                    WHERE w.scan_id = s.id AND w.status = 'succeeded') AS workers_done
           FROM scans s
           LEFT JOIN deep_scan_runs d ON d.scan_id = s.id
           WHERE s.scan_dir = ?
           LIMIT 1`,
        )
        .get(wbDir) as
        | {
            id: string;
            phase: string;
            status: string;
            deep_phase: string | null;
            discovery_runs_dispatched: number | null;
            max_discovery_runs: number | null;
            consecutive_no_new: number | null;
            stop_after_no_new: number | null;
            workers_running: number;
            workers_done: number;
          }
        | undefined;
      if (row) {
        const parts = [
          `phase=${row.phase}`,
          row.deep_phase ? `deep=${row.deep_phase}` : null,
          row.max_discovery_runs
            ? `discovery=${row.discovery_runs_dispatched ?? 0}/${row.max_discovery_runs}`
            : null,
          `workers=${row.workers_running} running / ${row.workers_done} done`,
          row.stop_after_no_new != null
            ? `sat=${row.consecutive_no_new ?? 0}/${row.stop_after_no_new}`
            : null,
        ].filter(Boolean);
        lines.push(`[workbench] ${parts.join(" · ")}`);
      }
    } finally {
      wb.close();
    }
  } catch {
    // ignore
  }

  return lines.slice(-12);
}

/** Find OS PIDs whose command line mentions this scan directory. */
export function findPidsForScanDir(scanDir: string): number[] {
  const needle = path.basename(scanDir);
  if (!needle) return [];
  try {
    const out = execSync(`pgrep -f ${JSON.stringify(needle)}`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const self = process.pid;
    return out
      .split(/\n/)
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0 && n !== self);
  } catch {
    return [];
  }
}

export function processAlive(pid: number | null | undefined): boolean {
  if (pid == null || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
