import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import Database from "better-sqlite3";
import { RUNS_DIR, SCANS_ROOT, WORKBENCH_DB_PATH } from "./config.js";
import { dirsMatch } from "./progress.js";
import { redactText } from "./redaction.js";

export function cliLogPath(scanDir: string): string {
  return path.join(RUNS_DIR, `${path.basename(scanDir)}.log`);
}

export interface CliLogSnapshot {
  lines: string[];
  cursor: number;
}

export interface CliLogEntry {
  line: string;
  cursor: number;
}

export function appendCliLog(scanDir: string, line: string): number {
  try {
    const file = cliLogPath(scanDir);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, `${redactText(line)}\n`, "utf8");
    return fs.statSync(file).size;
  } catch {
    // ignore disk errors
    return 0;
  }
}

export function readCliLogSnapshot(scanDir: string, maxLines = 250): CliLogSnapshot {
  const file = cliLogPath(scanDir);
  if (!fs.existsSync(file)) return { lines: [], cursor: 0 };
  try {
    const buffer = fs.readFileSync(file);
    return {
      lines: buffer.toString("utf8").split(/\r?\n/).filter(Boolean).slice(-maxLines).map(redactText),
      cursor: buffer.byteLength,
    };
  } catch {
    return { lines: [], cursor: 0 };
  }
}

export function readCliLogSince(
  scanDir: string,
  afterCursor: number,
  maxLines = 250,
): CliLogEntry[] {
  const file = cliLogPath(scanDir);
  if (!fs.existsSync(file)) return [];
  try {
    const buffer = fs.readFileSync(file);
    const start = Math.max(0, Math.min(Math.trunc(afterCursor), buffer.byteLength));
    const segments = buffer.subarray(start).toString("utf8").split("\n");
    const entries: CliLogEntry[] = [];
    let cursor = start;
    for (const segment of segments) {
      if (!segment && cursor >= buffer.byteLength) continue;
      cursor += Buffer.byteLength(segment, "utf8") + 1;
      const line = redactText(segment.endsWith("\r") ? segment.slice(0, -1) : segment);
      if (line) entries.push({ line, cursor: Math.min(cursor, buffer.byteLength) });
    }
    return entries.slice(-maxLines);
  } catch {
    return [];
  }
}

export function readCliLogTail(scanDir: string, maxLines = 250): string[] {
  return readCliLogSnapshot(scanDir, maxLines).lines;
}

export function purgeScanArtifacts(
  scanDir: string,
  managedRoots: string[] = [SCANS_ROOT],
): void {
  if (!isManagedScanArtifactDirectory(scanDir, managedRoots)) {
    throw new Error("Diretório do scan fora das raízes gerenciadas; exclusão recusada.");
  }

  const resolvedScanDir = path.resolve(scanDir);
  unlockManagedArtifactTree(resolvedScanDir);
  fs.rmSync(resolvedScanDir, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 50,
  });
  fs.rmSync(cliLogPath(resolvedScanDir), { force: true });
}

function unlockManagedArtifactTree(candidate: string): void {
  let metadata: fs.Stats;
  try {
    metadata = fs.lstatSync(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }

  if (metadata.isSymbolicLink()) return;

  if (metadata.isDirectory()) {
    chmodEntryWithoutFollowingLinks(candidate, metadata, 0o700);
    for (const entry of fs.readdirSync(candidate)) {
      unlockManagedArtifactTree(path.join(candidate, entry));
    }
    return;
  }

  if (metadata.isFile()) {
    chmodEntryWithoutFollowingLinks(candidate, metadata, 0o600);
  }
}

function chmodEntryWithoutFollowingLinks(
  candidate: string,
  expected: fs.Stats,
  mode: number,
): void {
  const noFollow = typeof fs.constants.O_NOFOLLOW === "number"
    ? fs.constants.O_NOFOLLOW
    : 0;
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(candidate, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(descriptor);
    if (opened.dev !== expected.dev || opened.ino !== expected.ino) {
      throw new Error("Artefato do scan mudou durante a exclusão; tente novamente.");
    }
    fs.fchmodSync(descriptor, mode);
  } catch (error) {
    if (["ENOENT", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
    throw error;
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

export function isManagedScanArtifactDirectory(
  scanDir: string,
  managedRoots: string[] = [SCANS_ROOT],
): boolean {
  const resolvedScanDir = path.resolve(scanDir);
  const canonicalScanDir = fs.existsSync(resolvedScanDir)
    ? fs.realpathSync.native(resolvedScanDir)
    : resolvedScanDir;
  return managedRoots.some((root) => {
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
