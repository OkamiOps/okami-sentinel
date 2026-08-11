import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { normalizeSeverity } from "@csb/shared";

import { PORTABLE_CODEX_SECURITY_NAMESPACE } from "./portable-codex-security-profile.js";

const MAX_EVIDENCE_FILE_BYTES = 2 * 1024 * 1024;
const MAX_ANCHOR_LINES = 200;

type PortableCodexSecurityEvidenceRole =
  | "source"
  | "entrypoint"
  | "control"
  | "sink"
  | "evidence";

export interface PortableCodexSecurityAnchorRecord extends Record<string, unknown> {
  path?: string;
  startLine?: number;
  endLine?: number;
  role?: PortableCodexSecurityEvidenceRole;
  explanation?: string;
}

export interface PortableCodexSecurityFindingRecord extends Record<string, unknown> {
  id?: string;
  title?: string;
  severity?: string;
  confidence?: string;
  category?: string;
  remediation?: string;
  summary?: string;
  rootCause?: string;
  impact?: string;
  severityRationale?: string;
  cwe?: string[];
  anchors?: Array<PortableCodexSecurityAnchorRecord | string>;
}

interface PortableCodexSecurityHandoff {
  schemaVersion?: number;
  stage?: string;
  findings?: PortableCodexSecurityFindingRecord[];
}

interface CanonicalAnchor {
  path: string;
  startLine: number;
  endLine: number;
  role: PortableCodexSecurityEvidenceRole;
  explanation: string | null;
  code: string;
}

export class PortableCodexSecurityArtifactError extends Error {
  constructor(reason: string) {
    super(`Portable Codex Security artifact rejected: ${reason}`);
    this.name = "PortableCodexSecurityArtifactError";
  }
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function requiredText(
  finding: PortableCodexSecurityFindingRecord,
  field: "id" | "title" | "severity" | "confidence" | "category" | "remediation",
): string {
  const value = text(finding[field]);
  if (!value) {
    throw new PortableCodexSecurityArtifactError(`finding is missing required ${field}`);
  }
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || Number(value) < 1) {
    const reason = Number(value) === 0 ? "line zero" : `${field} must be a positive line`;
    throw new PortableCodexSecurityArtifactError(reason);
  }
  return Number(value);
}

function repositoryRelativePath(value: unknown): string {
  const raw = text(value)?.replaceAll("\\", "/");
  if (!raw) throw new PortableCodexSecurityArtifactError("anchor path is missing");
  if (raw.includes("\0")) throw new PortableCodexSecurityArtifactError("anchor path contains NUL");
  if (raw.startsWith("/") || /^[A-Za-z]:\//.test(raw)) {
    throw new PortableCodexSecurityArtifactError("absolute path");
  }
  if (raw.split("/").includes("..")) {
    throw new PortableCodexSecurityArtifactError("nested traversal");
  }
  const normalized = path.posix.normalize(raw.replace(/^\.\//, ""));
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new PortableCodexSecurityArtifactError("traversal");
  }
  return normalized;
}

function parseAnchor(raw: PortableCodexSecurityAnchorRecord | string): {
  path: string;
  startLine: number;
  endLine: number;
  role: PortableCodexSecurityEvidenceRole;
  explanation: string | null;
} {
  if (typeof raw === "string") {
    const match = raw.match(/^(.*):(\d+)(?:-(\d+))?$/);
    if (!match) {
      throw new PortableCodexSecurityArtifactError("anchor must use path:line[-line]");
    }
    const startLine = positiveInteger(Number(match[2]), "startLine");
    const endLine = positiveInteger(Number(match[3] ?? match[2]), "endLine");
    return {
      path: repositoryRelativePath(match[1]),
      startLine,
      endLine,
      role: "evidence",
      explanation: null,
    };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PortableCodexSecurityArtifactError("anchor is not an object");
  }
  const startLine = positiveInteger(raw.startLine, "startLine");
  const endLine = raw.endLine === undefined
    ? startLine
    : positiveInteger(raw.endLine, "endLine");
  const role = ["source", "entrypoint", "control", "sink", "evidence"].includes(String(raw.role))
    ? raw.role as PortableCodexSecurityEvidenceRole
    : "evidence";
  return {
    path: repositoryRelativePath(raw.path),
    startLine,
    endLine,
    role,
    explanation: text(raw.explanation),
  };
}

function lineSnippet(
  snapshotRoot: string,
  anchor: ReturnType<typeof parseAnchor>,
): CanonicalAnchor {
  if (anchor.endLine < anchor.startLine) {
    throw new PortableCodexSecurityArtifactError("reversed range");
  }
  if (anchor.endLine - anchor.startLine + 1 > MAX_ANCHOR_LINES) {
    throw new PortableCodexSecurityArtifactError("range over 200 lines");
  }

  let root: string;
  try {
    root = fs.realpathSync(snapshotRoot);
  } catch {
    throw new PortableCodexSecurityArtifactError("snapshot root is missing");
  }

  const segments = anchor.path.split("/");
  let candidate = root;
  for (const segment of segments) {
    candidate = path.join(candidate, segment);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(candidate);
    } catch {
      throw new PortableCodexSecurityArtifactError(`missing file ${anchor.path}`);
    }
    if (stat.isSymbolicLink()) {
      throw new PortableCodexSecurityArtifactError(`symlink ${anchor.path}`);
    }
  }

  const target = path.resolve(root, anchor.path);
  const relative = path.relative(root, target);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new PortableCodexSecurityArtifactError("traversal");
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch {
    throw new PortableCodexSecurityArtifactError(`missing file ${anchor.path}`);
  }
  if (stat.isDirectory()) {
    throw new PortableCodexSecurityArtifactError(`directory ${anchor.path}`);
  }
  if (!stat.isFile()) {
    throw new PortableCodexSecurityArtifactError(`non-file ${anchor.path}`);
  }
  if (stat.size > MAX_EVIDENCE_FILE_BYTES) {
    throw new PortableCodexSecurityArtifactError(`oversized file ${anchor.path}`);
  }

  const lines = fs.readFileSync(target, "utf8").split(/\r?\n/);
  if (anchor.startLine > lines.length || anchor.endLine > lines.length) {
    throw new PortableCodexSecurityArtifactError("out-of-range line");
  }
  return {
    ...anchor,
    code: lines.slice(anchor.startLine - 1, anchor.endLine).join("\n"),
  };
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
    ".md": "markdown",
    ".toml": "toml",
  } as Record<string, string>)[extension] ?? "text";
}

function normalizeConfidence(value: string): "high" | "medium" | "low" {
  const normalized = value.toLowerCase();
  if (normalized === "high" || normalized === "medium" || normalized === "low") {
    return normalized;
  }
  throw new PortableCodexSecurityArtifactError("confidence must be high, medium, or low");
}

function fingerprint(
  id: string,
  severity: string,
  category: string,
  anchors: CanonicalAnchor[],
): string {
  return createHash("sha256").update(JSON.stringify({
    id,
    severity,
    category,
    anchors: anchors.map((anchor) => [anchor.path, anchor.startLine, anchor.endLine]),
  })).digest("hex");
}

function normalizeFinding(
  finding: PortableCodexSecurityFindingRecord,
  snapshotRoot: string,
): Record<string, unknown> {
  const id = requiredText(finding, "id");
  const title = requiredText(finding, "title");
  const requestedSeverity = requiredText(finding, "severity");
  const severity = normalizeSeverity(requestedSeverity);
  if (severity === "unknown") {
    throw new PortableCodexSecurityArtifactError("severity is invalid");
  }
  const confidence = normalizeConfidence(requiredText(finding, "confidence"));
  const category = requiredText(finding, "category");
  const remediation = requiredText(finding, "remediation");
  if (!Array.isArray(finding.anchors) || finding.anchors.length === 0) {
    throw new PortableCodexSecurityArtifactError(`finding ${id} has no path:line[-line] anchor`);
  }
  const anchors = finding.anchors.map((anchor) => lineSnippet(snapshotRoot, parseAnchor(anchor)));
  const evidenceRefs = anchors.map((_, index) => `evidence-${index + 1}`);
  const cwe = (finding.cwe ?? []).filter(
    (value): value is string => typeof value === "string" && /^CWE-\d+$/i.test(value),
  );
  const primary = fingerprint(id, severity, category, anchors);

  return {
    findingId: `portable-codex-security-${id}`,
    occurrenceId: id,
    title,
    summary: text(finding.summary) ?? text(finding.impact) ?? title,
    severity: {
      level: severity,
      rationale: text(finding.severityRationale),
    },
    confidence: {
      level: confidence,
      rationale: "Portable Codex Security retained this evidence after static validation only.",
    },
    ruleId: `sentinel-codex-security-portable/${category.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    remediation,
    locations: anchors.map((anchor) => ({
      path: anchor.path,
      startLine: anchor.startLine,
      endLine: anchor.endLine,
      lines: anchor.startLine === anchor.endLine
        ? String(anchor.startLine)
        : `${anchor.startLine}-${anchor.endLine}`,
      role: "primary",
    })),
    codeEvidence: anchors.map((anchor, index) => ({
      id: evidenceRefs[index],
      label: `Evidence at ${anchor.path}:${anchor.startLine}${anchor.endLine !== anchor.startLine ? `–${anchor.endLine}` : ""}`,
      path: anchor.path,
      startLine: anchor.startLine,
      endLine: anchor.endLine,
      lines: anchor.startLine === anchor.endLine
        ? String(anchor.startLine)
        : `${anchor.startLine}-${anchor.endLine}`,
      role: anchor.role,
      code: anchor.code,
      language: languageForPath(anchor.path),
      explanation: anchor.explanation ?? "Reported by the Portable Codex Security static review.",
    })),
    taxonomy: {
      category,
      cwe,
    },
    attackPath: {
      summary: text(finding.summary),
      evidenceRefs,
      reachability: {
        attacker: "Untrusted caller",
        preconditions: null,
      },
      dataflow: {
        summary: text(finding.rootCause),
        outcome: text(finding.impact),
        evidenceRefs,
      },
    },
    rootCause: {
      summary: text(finding.rootCause),
    },
    validation: {
      status: "STATIC_REVIEW",
      summary: text(finding.summary),
      method: "Portable Codex Security static validation; no target code, exploit payload, or PoC was executed.",
      supportingEvidence: evidenceRefs,
    },
    fingerprints: {
      algorithm: PORTABLE_CODEX_SECURITY_NAMESPACE,
      primary: `${PORTABLE_CODEX_SECURITY_NAMESPACE}:sha256:${primary}`,
      portableCodexSecurityId: id,
    },
    provenance: {
      source: PORTABLE_CODEX_SECURITY_NAMESPACE,
      rawFinding: "portable-codex-security/results/sentinel-findings.json",
    },
  };
}

export function readPortableCodexSecurityFindingRecords(
  resultsDir: string,
): PortableCodexSecurityFindingRecord[] {
  const handoffPath = path.join(resultsDir, "sentinel-findings.json");
  if (!fs.existsSync(handoffPath)) {
    throw new PortableCodexSecurityArtifactError("missing sentinel-findings.json");
  }
  let handoff: PortableCodexSecurityHandoff;
  try {
    handoff = JSON.parse(fs.readFileSync(handoffPath, "utf8")) as PortableCodexSecurityHandoff;
  } catch {
    throw new PortableCodexSecurityArtifactError("sentinel-findings.json is not valid JSON");
  }
  if (handoff.schemaVersion !== 1 || !Array.isArray(handoff.findings)) {
    throw new PortableCodexSecurityArtifactError("sentinel-findings.json does not match schemaVersion 1");
  }
  if (handoff.stage !== undefined && handoff.stage !== "report") {
    throw new PortableCodexSecurityArtifactError("sentinel-findings.json has an invalid stage");
  }
  const ids = new Set<string>();
  handoff.findings.forEach((finding, index) => {
    if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
      throw new PortableCodexSecurityArtifactError(`finding ${index + 1} is not an object`);
    }
    const id = requiredText(finding, "id");
    requiredText(finding, "title");
    requiredText(finding, "severity");
    requiredText(finding, "confidence");
    requiredText(finding, "category");
    requiredText(finding, "remediation");
    if (ids.has(id)) {
      throw new PortableCodexSecurityArtifactError(`duplicate finding id ${id}`);
    }
    ids.add(id);
  });
  return handoff.findings;
}

export function normalizePortableCodexSecurityWorkspace(
  resultsDir: string,
  outputDir: string,
): number {
  const raw = readPortableCodexSecurityFindingRecords(resultsDir);
  const snapshotRoot = path.join(outputDir, "portable-codex-security-snapshot");
  const findings = raw.map((finding) => normalizeFinding(finding, snapshotRoot));
  const payload = {
    schemaVersion: 1,
    engine: "codex-security",
    executionProfile: "portable",
    methodologyRef: "sentinel/codex-security-methodology@v1",
    generatedAt: new Date().toISOString(),
    sourceFindings: raw.length,
    findings,
  };
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const target = path.join(outputDir, "findings.json");
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(temporary, target);
  return findings.length;
}
