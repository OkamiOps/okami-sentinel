import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FindingDetail, ScanSastSummary } from "@csb/shared";
import { opengrepConfiguration } from "../config.js";

export interface OpengrepStatus extends ScanSastSummary {
  rules: string[];
  ruleCount: number | null;
  startedAt: string;
  finishedAt: string;
}

type Configuration = ReturnType<typeof opengrepConfiguration>;
type Json = Record<string, unknown>;
const record = (value: unknown): Json => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : {};

function atomicWrite(target: string, value: unknown): void {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp-${process.pid}`;
  const fd = fs.openSync(temporary, "w", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temporary, target);
  const directory = fs.openSync(path.dirname(target), "r");
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}

export function readOpengrepStatus(scanDir: string): OpengrepStatus | null {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(scanDir, "sast/opengrep-status.json"), "utf8")) as OpengrepStatus;
    return value && value.tool === "opengrep" && ["completed", "failed", "skipped", "timeout"].includes(value.status)
      && Number.isFinite(value.count) && Number.isFinite(value.durationMs) ? value : null;
  } catch { return null; }
}

export function readOpengrepFindings(scanDir: string): FindingDetail[] {
  if (readOpengrepStatus(scanDir)?.status !== "completed") return [];
  try {
    const value = JSON.parse(fs.readFileSync(path.join(scanDir, "sast/opengrep-findings.json"), "utf8"));
    return Array.isArray(value.findings) ? value.findings : [];
  } catch { return []; }
}

export function readSastSummary(scanDir: string): ScanSastSummary | null {
  const status = readOpengrepStatus(scanDir);
  if (!status) return null;
  const { tool, version, count, durationMs, reason } = status;
  return { status: status.status, tool, version, count, durationMs, reason };
}

export function normalizeOpengrep(payload: unknown, snapshotRoot: string): FindingDetail[] {
  const root = record(payload);
  if (!Array.isArray(root.results) || !Array.isArray(root.errors) || root.errors.length > 0) throw new Error("invalid_result");
  const findings = new Map<string, FindingDetail>();
  for (const value of root.results) {
    const result = record(value);
    const extra = record(result.extra);
    const start = record(result.start);
    const end = record(result.end);
    if (typeof result.path !== "string" || typeof result.check_id !== "string" || !Number.isSafeInteger(start.line)
      || Number(start.line) < 1 || !Number.isSafeInteger(end.line) || Number(end.line) < Number(start.line)) throw new Error("invalid_result");
    const relative = path.relative(path.resolve(snapshotRoot), path.resolve(snapshotRoot, result.path)).split(path.sep).join("/");
    if (!relative || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) throw new Error("invalid_path");
    const metadata = record(extra.metadata);
    const cwe = Array.isArray(metadata.cwe) ? metadata.cwe.filter((item): item is string => typeof item === "string")
      : typeof metadata.cwe === "string" ? [metadata.cwe] : [];
    const id = "opengrep:" + createHash("sha256").update(`${result.check_id}:${relative}:${start.line}:${start.col ?? 1}`).digest("hex");
    const location = { path: relative, startLine: start.line, endLine: end.line, startColumn: start.col ?? 1, endColumn: end.col ?? 1 };
    const message = typeof extra.message === "string" ? extra.message : result.check_id;
    findings.set(id, {
      findingId: id, occurrenceId: id, ruleId: result.check_id,
      origin: { kind: "sast", tool: "opengrep" },
      title: message, summary: message,
      severity: metadata.severity === "critical" ? "critical" : extra.severity === "ERROR" ? "high" : extra.severity === "INFO" ? "low" : "medium",
      confidence: null, primaryPath: relative, fingerprints: [id], category: "sast", cwe,
      locations: [location], codeEvidence: [{ ...location, code: typeof extra.lines === "string" ? extra.lines : "" }],
      taxonomy: { category: "sast", cwe }, attackPath: null, attackPathModel: null, remediation: null,
      rootCause: null, validation: null, preventiveControls: null, remediationTests: null,
      severityRationale: null, confidenceRationale: null,
    });
  }
  return [...findings.values()];
}

function execute(binary: string, args: string[], cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, detached: true, stdio: ["ignore", "pipe", "ignore"], env: {
      PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
      SEMGREP_SEND_METRICS: "off", SEMGREP_ENABLE_VERSION_CHECK: "0",
    } });
    let output = "";
    let failure: string | null = null;
    const kill = () => {
      if (child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      }
    };
    const timer = setTimeout(() => { failure = "timeout"; kill(); }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      if (output.length + chunk.length > 32 * 1024 * 1024) { failure = "output_limit"; kill(); }
      else output += chunk.toString("utf8");
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(new Error(error.code === "ENOENT" ? "binary_missing" : "process_failed"));
    });
    child.once("close", code => {
      clearTimeout(timer);
      if (failure || code !== 0) reject(new Error(failure ?? "nonzero_exit"));
      else resolve(output);
    });
  });
}

export async function runOpengrep(snapshotRoot: string, scanDir: string, config: Configuration = opengrepConfiguration()): Promise<void> {
  if (readOpengrepStatus(scanDir)?.status === "completed") return;
  const started = Date.now();
  const status: OpengrepStatus = {
    status: "failed", tool: "opengrep", version: null,
    rules: config.rules.map(rule => /^(?:\w+:\/\/|git\+)/.test(rule) ? "<non-local>" : rule), ruleCount: null,
    count: 0, startedAt: new Date(started).toISOString(), finishedAt: "", durationMs: 0, reason: null,
  };
  try {
    if (!config.enabled) { status.status = "skipped"; status.reason = "disabled"; }
    else {
      if (config.rules.length === 0 || config.rules.some(rule => !fs.existsSync(rule))) throw new Error("local_rules_unavailable");
      const remaining = () => Math.max(1, config.timeoutMs - (Date.now() - started));
      const version = (await execute(config.binary, ["--version"], snapshotRoot, remaining())).trim();
      status.version = /^\d+\.\d+\.\d+(?:[-+.][\w.-]+)?$/.test(version) ? version : null;
      const output = await execute(config.binary, ["scan", "--json", ...config.rules.flatMap(rule => ["--config", path.resolve(rule)]), snapshotRoot], snapshotRoot, remaining());
      let payload: unknown;
      try { payload = JSON.parse(output); } catch { throw new Error("invalid_json"); }
      const findings = normalizeOpengrep(payload, snapshotRoot);
      const data = record(payload);
      const rules = record(record(data.engine_requested).rules);
      status.ruleCount = Array.isArray(data.rules) ? data.rules.length : typeof rules.count === "number" ? rules.count : null;
      atomicWrite(path.join(scanDir, "sast/opengrep-findings.json"), { findings });
      status.status = "completed";
      status.count = findings.length;
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : "process_failed";
    status.status = reason === "binary_missing" ? "skipped" : reason === "timeout" ? "timeout" : "failed";
    status.reason = ["binary_missing", "timeout", "invalid_json", "invalid_result", "invalid_path", "local_rules_unavailable", "output_limit", "nonzero_exit"].includes(reason) ? reason : "process_failed";
  }
  status.durationMs = Date.now() - started;
  status.finishedAt = new Date().toISOString();
  try { atomicWrite(path.join(scanDir, "sast/opengrep-status.json"), status); } catch { /* SAST persistence must not prevent AI execution. */ }
}
