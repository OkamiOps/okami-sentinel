import fs from "node:fs";
import path from "node:path";

export const MANTIS_REPORT_RESULT_ARTIFACT_CONTRACT = "mantis-report-v1" as const;
export const MANTIS_REPORT_RESULT_PATH = "report.json";
export const MAX_MANTIS_REPORT_BYTES = 2 * 1024 * 1024;

export type MantisReportRepairDetail = {
  kind: "mantis-report";
  reason: "envelope" | "finding" | "locator";
  findingIndex?: number;
  locatorIndex?: number;
};

export function normalizeMantisReport(
  value: unknown,
  snapshotRoot: string | undefined,
  onRepair?: (detail: MantisReportRepairDetail) => void,
): Record<string, unknown> | null {
  if (!record(value) || value.schemaVersion !== 1 || value.engine !== "mantis" ||
      value.stage !== "report" || !Array.isArray(value.findings) || value.findings.length > 1_000) {
    onRepair?.({ kind: "mantis-report", reason: "envelope" });
    return null;
  }
  for (const [findingIndex, candidate] of value.findings.entries()) {
    if (!record(candidate) || !validFindingFields(candidate)) {
      onRepair?.({ kind: "mantis-report", reason: "finding", findingIndex });
      return null;
    }
    for (const [locatorIndex, locator] of candidate.code_paths.entries()) {
      if (!validEvidenceLocator(locator, snapshotRoot)) {
        onRepair?.({ kind: "mantis-report", reason: "locator", findingIndex, locatorIndex });
        return null;
      }
    }
  }
  const canonical = {
    schemaVersion: 1,
    engine: "mantis",
    stage: "report",
    findings: value.findings,
  };
  return Buffer.byteLength(JSON.stringify(canonical), "utf8") <= MAX_MANTIS_REPORT_BYTES
    ? canonical
    : null;
}

function validFindingFields(value: Record<string, unknown>): value is Record<string, unknown> & { code_paths: unknown[] } {
  const remediation = value.remediation ?? value.mitigation;
  return isSafeText(value.id, 240) && isSafeText(value.title, 2_000) &&
    isSafeText(remediation, 8_000) && typeof value.severity === "string" &&
    ["critical", "high", "medium", "low", "info"].includes(value.severity.toLowerCase()) &&
    Array.isArray(value.code_paths) && value.code_paths.length > 0 && value.code_paths.length <= 64;
}

function validEvidenceLocator(value: unknown, snapshotRoot: string | undefined): value is string {
  if (!isSafeText(value, 2_048) || snapshotRoot === undefined) return false;
  const match = value.match(/^(.+):([1-9]\d*)(?:-([1-9]\d*))?$/);
  if (!match || !relativePath(match[1]!)) return false;
  const startLine = Number(match[2]);
  const endLine = Number(match[3] ?? match[2]);
  if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) ||
      endLine < startLine || endLine - startLine >= 200) return false;
  try {
    const root = fs.realpathSync(snapshotRoot);
    const target = fs.realpathSync(path.resolve(root, match[1]!));
    const relative = path.relative(root, target);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
    const info = fs.statSync(target);
    if (!info.isFile() || info.size > 2 * 1024 * 1024) return false;
    const lines = fs.readFileSync(target, "utf8").split(/\r\n|\n|\r/);
    if (lines.at(-1) === "") lines.pop();
    return endLine <= lines.length;
  } catch {
    return false;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max &&
    !/[\u0000-\u001F\u007F]/.test(value);
}

function relativePath(value: string): boolean {
  return value.length <= 2_048 && value !== "." && !path.isAbsolute(value) &&
    !value.split(/[\\/]/).some((segment) => segment === "" || segment === "." || segment === "..");
}
