import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { normalizeSeverity } from "@csb/shared";

type VulnHunterEvidenceRole =
  | "source"
  | "entrypoint"
  | "control"
  | "sink"
  | "evidence";

interface VulnHunterEvidenceRecord extends Record<string, unknown> {
  path?: string;
  startLine?: number;
  endLine?: number;
  role?: VulnHunterEvidenceRole;
  explanation?: string;
}

export interface VulnHunterFindingRecord extends Record<string, unknown> {
  id?: string;
  title?: string;
  severity?: string;
  confidence?: string;
  cwe?: string[];
  summary?: string;
  rootCause?: string;
  entryPoint?: string;
  dataFlow?: string;
  impact?: string;
  remediation?: string;
  severityRationale?: string;
  validation?: {
    summary?: string;
    limitations?: string[];
  };
  evidence?: VulnHunterEvidenceRecord[];
}

interface VulnHunterHandoff {
  schemaVersion?: number;
  findings?: VulnHunterFindingRecord[];
}

interface CanonicalLocation {
  path: string;
  startLine?: number;
  endLine?: number;
  lines?: string;
  role: "primary";
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function positiveLine(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function repositoryRelativePath(value: unknown): string | null {
  const raw = text(value)?.replaceAll("\\", "/");
  if (!raw || raw.includes("\0") || raw.startsWith("/") || /^[A-Za-z]:\//.test(raw)) {
    return null;
  }
  const normalized = path.posix.normalize(raw.replace(/^\.\//, ""));
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    return null;
  }
  return normalized;
}

function languageForPath(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  return ({
    ".ts": "typescript",
    ".tsx": "typescript",
    ".js": "javascript",
    ".jsx": "javascript",
    ".py": "python",
    ".go": "go",
    ".rs": "rust",
    ".java": "java",
    ".rb": "ruby",
    ".php": "php",
    ".sql": "sql",
    ".sh": "shell",
    ".yml": "yaml",
    ".yaml": "yaml",
    ".json": "json",
    ".xml": "xml",
    ".html": "html",
    ".css": "css",
    ".scss": "scss",
    ".toml": "toml",
  } as Record<string, string>)[extension] ?? "text";
}

function sourceSnippet(
  snapshotRoot: string | null,
  location: CanonicalLocation,
): string | null {
  if (!snapshotRoot || location.startLine == null) return null;
  let root: string;
  try {
    root = fs.realpathSync(snapshotRoot);
  } catch {
    return null;
  }
  const target = path.resolve(root, location.path);
  const relative = path.relative(root, target);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) return null;
  try {
    const realTarget = fs.realpathSync(target);
    const realRelative = path.relative(root, realTarget);
    if (
      realRelative === "" ||
      realRelative === ".." ||
      realRelative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(realRelative)
    ) return null;
    const stat = fs.statSync(realTarget);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return null;
    const lines = fs.readFileSync(realTarget, "utf8").split(/\r?\n/);
    const start = location.startLine;
    const end = Math.min(lines.length, location.endLine ?? start, start + 199);
    if (start > lines.length || end < start) return null;
    return lines.slice(start - 1, end).join("\n");
  } catch {
    return null;
  }
}

function canonicalEvidence(
  finding: VulnHunterFindingRecord,
  snapshotRoot: string | null,
): Array<Record<string, unknown>> {
  return (finding.evidence ?? []).flatMap((raw, index) => {
    const evidencePath = repositoryRelativePath(raw.path);
    if (!evidencePath) return [];
    const startLine = positiveLine(raw.startLine);
    const endLine = positiveLine(raw.endLine) ?? startLine;
    const location: CanonicalLocation = {
      path: evidencePath,
      ...(startLine == null ? {} : { startLine }),
      ...(endLine == null ? {} : { endLine }),
      ...(startLine == null
        ? {}
        : { lines: startLine === endLine ? String(startLine) : `${startLine}-${endLine}` }),
      role: "primary",
    };
    const role = ["source", "entrypoint", "control", "sink", "evidence"].includes(
      String(raw.role),
    )
      ? raw.role
      : "evidence";
    return [{
      id: `evidence-${index + 1}`,
      label: `Evidence at ${evidencePath}${startLine ? `:${startLine}${endLine !== startLine ? `–${endLine}` : ""}` : ""}`,
      ...location,
      role,
      code: sourceSnippet(snapshotRoot, location),
      language: languageForPath(evidencePath),
      explanation: text(raw.explanation) ?? "Reported by the VulnHunter static review.",
    }];
  });
}

function fingerprint(finding: VulnHunterFindingRecord): string {
  const primaryEvidence = finding.evidence?.find((item) => item.role === "sink")
    ?? finding.evidence?.[0];
  const identity = [
    [...(finding.cwe ?? [])].sort().join(","),
    repositoryRelativePath(primaryEvidence?.path),
    positiveLine(primaryEvidence?.startLine),
    positiveLine(primaryEvidence?.endLine),
  ];
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

function confidenceLevel(value: unknown): "high" | "medium" | "low" {
  const normalized = String(value ?? "").toLowerCase();
  if (normalized === "high") return "high";
  if (normalized === "low") return "low";
  return "medium";
}

export function isReportableVulnHunterFinding(
  finding: VulnHunterFindingRecord,
): boolean {
  return Boolean(text(finding.id) && text(finding.title) && text(finding.severity));
}

export function normalizeVulnHunterFinding(
  finding: VulnHunterFindingRecord,
  snapshotRoot: string | null = null,
): Record<string, unknown> {
  const id = text(finding.id) ?? "unknown";
  const evidence = canonicalEvidence(finding, snapshotRoot);
  const evidenceRefs = evidence.map((item) => String(item.id));
  const locations = evidence.map((item) => ({
    path: item.path,
    startLine: item.startLine,
    endLine: item.endLine,
    lines: item.lines,
    role: "primary",
  }));
  const cwe = (finding.cwe ?? []).filter(
    (value): value is string => typeof value === "string" && /^CWE-\d+$/i.test(value),
  );
  const validationSummary = text(finding.validation?.summary);
  const limitations = (finding.validation?.limitations ?? [])
    .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
    .map((value) => value.trim());
  const adapterLimitation = "No exploit payload, PoC code, or exploit test was generated or executed by Sentinel's read-only Codex port.";
  if (!limitations.includes(adapterLimitation)) limitations.push(adapterLimitation);
  const confidence = confidenceLevel(finding.confidence);

  return {
    findingId: `vulnhunter-${id}`,
    occurrenceId: id,
    title: text(finding.title),
    summary: text(finding.summary) ?? text(finding.impact) ?? text(finding.title),
    severity: {
      level: normalizeSeverity(finding.severity),
      rationale: text(finding.severityRationale),
    },
    confidence: {
      level: confidence,
      rationale: "VulnHunter retained this finding after read-only static falsification; no exploit material was generated or executed.",
    },
    ruleId: cwe[0] ? `vulnhunter/${cwe[0]}` : "vulnhunter/attacker-first-review",
    remediation: text(finding.remediation),
    locations,
    codeEvidence: evidence,
    taxonomy: {
      category: "VulnHunter attacker-first review",
      cwe,
    },
    attackPath: {
      summary: text(finding.dataFlow),
      evidenceRefs,
      reachability: {
        attacker: "Untrusted caller",
        preconditions: text(finding.entryPoint),
      },
      dataflow: {
        summary: text(finding.dataFlow),
        outcome: text(finding.impact),
        evidenceRefs,
      },
    },
    rootCause: {
      summary: text(finding.rootCause),
    },
    validation: {
      status: "STATIC_REVIEW",
      summary: validationSummary,
      method: "VulnHunter read-only static falsification; exploit payloads, PoC code, and exploit tests were neither generated nor executed.",
      limitations,
      supportingEvidence: evidenceRefs,
    },
    fingerprints: {
      algorithm: "capitalone-vulnhunter/v1",
      primary: `capitalone-vulnhunter/v1:sha256:${fingerprint(finding)}`,
      vulnhunterId: id,
    },
    provenance: {
      source: "capitalone-vulnhunter",
      rawFinding: "vulnhunter/results/sentinel-findings.json",
    },
  };
}

export function readVulnHunterFindingRecords(resultsDir: string): VulnHunterFindingRecord[] {
  const handoffPath = path.join(resultsDir, "sentinel-findings.json");
  if (!fs.existsSync(handoffPath)) {
    throw new Error("VulnHunter handoff is missing sentinel-findings.json.");
  }
  let payload: VulnHunterHandoff;
  try {
    payload = JSON.parse(fs.readFileSync(handoffPath, "utf8")) as VulnHunterHandoff;
  } catch (error) {
    throw new Error(
      `VulnHunter handoff is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (payload.schemaVersion !== 1 || !Array.isArray(payload.findings)) {
    throw new Error("VulnHunter handoff does not match schemaVersion 1.");
  }
  const ids = new Set<string>();
  payload.findings.forEach((finding, index) => {
    if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
      throw new Error(`VulnHunter finding ${index + 1} is not an object.`);
    }
    const id = text(finding.id);
    if (!id || !text(finding.title) || !text(finding.severity)) {
      throw new Error(`VulnHunter finding ${index + 1} is missing id, title, or severity.`);
    }
    if (ids.has(id)) throw new Error(`VulnHunter handoff contains duplicate id ${id}.`);
    ids.add(id);
    const validEvidence = Array.isArray(finding.evidence)
      && finding.evidence.some((item) =>
        repositoryRelativePath(item?.path) && positiveLine(item?.startLine)
      );
    if (!validEvidence) {
      throw new Error(`VulnHunter finding ${id} has no confined line-level evidence.`);
    }
  });
  return payload.findings;
}

export function normalizeVulnHunterWorkspace(
  resultsDir: string,
  outputDir: string,
): number {
  const raw = readVulnHunterFindingRecords(resultsDir);
  const snapshotRoot = path.join(outputDir, "vulnhunter-snapshot");
  const findings = raw
    .filter(isReportableVulnHunterFinding)
    .map((finding) => normalizeVulnHunterFinding(
      finding,
      fs.existsSync(snapshotRoot) ? snapshotRoot : null,
    ));
  const payload = {
    schemaVersion: 1,
    engine: "vulnhunter",
    generatedAt: new Date().toISOString(),
    sourceFindings: raw.length,
    findings,
  };
  const target = path.join(outputDir, "findings.json");
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(temporary, target);
  return findings.length;
}
