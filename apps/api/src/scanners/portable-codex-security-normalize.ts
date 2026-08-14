import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { normalizeSeverity } from "@csb/shared";

import {
  globalSecretRedactor,
  type SecretRedactor,
} from "../redaction.js";
import {
  PORTABLE_CODEX_SECURITY_METHODOLOGY_REF,
  PORTABLE_CODEX_SECURITY_NAMESPACE,
} from "./portable-codex-security-profile.js";
import {
  readPortableCodexSecurityDossier,
  validatePortableCodexSecurityReportCoverage,
  PortableCodexSecurityDossierError,
} from "./portable-codex-security-dossier.js";

export const PORTABLE_CODEX_SECURITY_NORMALIZATION_LIMITS = Object.freeze({
  maxHandoffBytes: 1_048_576,
  // Deep report execution can produce up to 32 validated pages with 16
  // confirmed candidates each. This is a whole-report bound, not a page bound.
  maxFindings: 512,
  maxAnchorsPerFinding: 20,
  maxTextFieldBytes: 16_384,
  maxSnippetBytes: 65_536,
  maxEvidenceFileBytes: 2_097_152,
  maxAnchorLines: 200,
  maxOutputBytes: 4_194_304,
} as const);

export type PortableCodexSecurityPinnedFileSystem = Pick<
  typeof fs,
  "openSync" | "fstatSync" | "readSync" | "lstatSync" | "closeSync"
>;

const NO_FOLLOW = typeof fs.constants.O_NOFOLLOW === "number"
  ? fs.constants.O_NOFOLLOW
  : 0;
const READ_NO_FOLLOW = fs.constants.O_RDONLY | NO_FOLLOW;

export interface PortableCodexSecurityNormalizationDependencies {
  redactor?: Pick<SecretRedactor, "redactText">;
  fileSystem?: PortableCodexSecurityPinnedFileSystem;
}

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
  candidateId?: string;
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
  coverage?: unknown;
}

interface CanonicalAnchor {
  path: string;
  startLine: number;
  endLine: number;
  snippetStartLine: number;
  snippetEndLine: number;
  role: PortableCodexSecurityEvidenceRole;
  explanation: string | null;
  code: string;
}

interface PinnedSnapshotRoot {
  lexicalPath: string;
  canonicalPath: string;
  lexicalInfo: fs.Stats;
  canonicalInfo: fs.Stats;
}

export class PortableCodexSecurityArtifactError extends Error {
  constructor(reason: string) {
    super(`Portable Codex Security artifact rejected: ${reason}`);
    this.name = "PortableCodexSecurityArtifactError";
  }
}

class PortableCodexSecurityOutputBudget {
  private usedBytes = 0;

  debit(value: string): void {
    const bytes = Buffer.byteLength(value, "utf8");
    if (
      bytes >
        PORTABLE_CODEX_SECURITY_NORMALIZATION_LIMITS.maxOutputBytes - this.usedBytes
    ) {
      throw new PortableCodexSecurityArtifactError("output byte budget exceeded");
    }
    this.usedBytes += bytes;
  }
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function boundedText(value: unknown, field: string): string | null {
  const result = text(value);
  if (
    result !== null &&
    Buffer.byteLength(result, "utf8") >
      PORTABLE_CODEX_SECURITY_NORMALIZATION_LIMITS.maxTextFieldBytes
  ) {
    throw new PortableCodexSecurityArtifactError(`text field byte limit exceeded for ${field}`);
  }
  return result;
}

function requiredText(
  finding: PortableCodexSecurityFindingRecord,
  field: "id" | "candidateId" | "title" | "severity" | "confidence" | "category" | "summary" | "rootCause" | "impact" | "remediation",
): string {
  const value = boundedText(finding[field], field);
  if (!value) {
    throw new PortableCodexSecurityArtifactError(`finding is missing required ${field}`);
  }
  return value;
}

function redactPublicText(
  value: string,
  field: string,
  redactor: Pick<SecretRedactor, "redactText">,
  outputBudget: PortableCodexSecurityOutputBudget,
  byteLimit: number = PORTABLE_CODEX_SECURITY_NORMALIZATION_LIMITS.maxTextFieldBytes,
): string {
  let redacted: string;
  try {
    redacted = redactor.redactText(value);
  } catch {
    throw new PortableCodexSecurityArtifactError("redaction failed");
  }
  if (
    typeof redacted !== "string" ||
    Buffer.byteLength(redacted, "utf8") > byteLimit
  ) {
    throw new PortableCodexSecurityArtifactError(`redacted ${field} exceeds its byte limit`);
  }
  outputBudget.debit(redacted);
  return redacted;
}

function redactOptionalText(
  value: unknown,
  field: string,
  redactor: Pick<SecretRedactor, "redactText">,
  outputBudget: PortableCodexSecurityOutputBudget,
): string | null {
  const bounded = boundedText(value, field);
  return bounded === null
    ? null
    : redactPublicText(bounded, field, redactor, outputBudget);
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || Number(value) < 1) {
    const reason = Number(value) === 0 ? "line zero" : `${field} must be a positive line`;
    throw new PortableCodexSecurityArtifactError(reason);
  }
  return Number(value);
}

function repositoryRelativePath(value: unknown): string {
  const raw = boundedText(value, "anchor path")?.replaceAll("\\", "/");
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
    explanation: boundedText(raw.explanation, "anchor explanation"),
  };
}

function sameVersion(first: fs.Stats, second: fs.Stats): boolean {
  return first.dev === second.dev && first.ino === second.ino &&
    first.size === second.size && first.mtimeMs === second.mtimeMs &&
    first.ctimeMs === second.ctimeMs;
}

function pinSnapshotRoot(snapshotRoot: string): PinnedSnapshotRoot {
  let lexicalInfo: fs.Stats;
  try {
    lexicalInfo = fs.lstatSync(snapshotRoot);
  } catch {
    throw new PortableCodexSecurityArtifactError("snapshot root is missing");
  }
  if (lexicalInfo.isSymbolicLink()) {
    throw new PortableCodexSecurityArtifactError("snapshot root symlink");
  }
  if (!lexicalInfo.isDirectory()) {
    throw new PortableCodexSecurityArtifactError("snapshot root is missing");
  }

  let canonicalPath: string;
  let canonicalInfo: fs.Stats;
  try {
    canonicalPath = fs.realpathSync(snapshotRoot);
    canonicalInfo = fs.lstatSync(canonicalPath);
  } catch {
    throw new PortableCodexSecurityArtifactError("snapshot root is missing");
  }
  if (
    canonicalInfo.isSymbolicLink() ||
    !canonicalInfo.isDirectory() ||
    !sameVersion(lexicalInfo, canonicalInfo)
  ) {
    throw new PortableCodexSecurityArtifactError("snapshot root identity changed");
  }
  return {
    lexicalPath: snapshotRoot,
    canonicalPath,
    lexicalInfo,
    canonicalInfo,
  };
}

function assertSnapshotRootUnchanged(root: PinnedSnapshotRoot): void {
  let lexicalInfo: fs.Stats;
  let canonicalPath: string;
  let canonicalInfo: fs.Stats;
  try {
    lexicalInfo = fs.lstatSync(root.lexicalPath);
    canonicalPath = fs.realpathSync(root.lexicalPath);
    canonicalInfo = fs.lstatSync(canonicalPath);
  } catch {
    throw new PortableCodexSecurityArtifactError("snapshot root identity changed");
  }
  if (
    lexicalInfo.isSymbolicLink() ||
    !lexicalInfo.isDirectory() ||
    canonicalInfo.isSymbolicLink() ||
    !canonicalInfo.isDirectory() ||
    canonicalPath !== root.canonicalPath ||
    !sameVersion(root.lexicalInfo, lexicalInfo) ||
    !sameVersion(root.canonicalInfo, canonicalInfo) ||
    !sameVersion(lexicalInfo, canonicalInfo)
  ) {
    throw new PortableCodexSecurityArtifactError("snapshot root identity changed");
  }
}

function readPinnedRegularFile(
  target: string,
  expected: fs.Stats,
  maxBytes: number,
  byteLimitReason: string,
  identityReason: string,
  fileSystem: PortableCodexSecurityPinnedFileSystem = fs,
): Buffer {
  let descriptor: number | undefined;
  try {
    descriptor = fileSystem.openSync(target, READ_NO_FOLLOW);
    const opened = fileSystem.fstatSync(descriptor);
    if (
      !expected.isFile() ||
      expected.isSymbolicLink() ||
      !opened.isFile() ||
      opened.isSymbolicLink() ||
      !sameVersion(expected, opened)
    ) {
      throw new PortableCodexSecurityArtifactError(identityReason);
    }
    if (opened.size > maxBytes) {
      throw new PortableCodexSecurityArtifactError(byteLimitReason);
    }

    const content = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < content.length) {
      const bytesRead = fileSystem.readSync(
        descriptor,
        content,
        offset,
        content.length - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }

    const afterRead = fileSystem.fstatSync(descriptor);
    const afterPath = fileSystem.lstatSync(target);
    if (
      offset !== content.length ||
      afterPath.isSymbolicLink() ||
      !sameVersion(opened, afterRead) ||
      !sameVersion(opened, afterPath)
    ) {
      throw new PortableCodexSecurityArtifactError(identityReason);
    }
    return content;
  } catch (error) {
    if (error instanceof PortableCodexSecurityArtifactError) throw error;
    throw new PortableCodexSecurityArtifactError(identityReason);
  } finally {
    if (descriptor !== undefined) fileSystem.closeSync(descriptor);
  }
}

function lineSnippet(
  snapshotRoot: string,
  anchor: ReturnType<typeof parseAnchor>,
  fileSystem: PortableCodexSecurityPinnedFileSystem,
): CanonicalAnchor {
  if (anchor.endLine < anchor.startLine) {
    throw new PortableCodexSecurityArtifactError("reversed range");
  }
  const pinnedRoot = pinSnapshotRoot(snapshotRoot);
  const root = pinnedRoot.canonicalPath;

  const target = path.resolve(root, anchor.path);
  const relative = path.relative(root, target);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new PortableCodexSecurityArtifactError("traversal");
  }

  let candidate = root;
  let targetInfo: fs.Stats | undefined;
  for (const segment of anchor.path.split("/")) {
    candidate = path.join(candidate, segment);
    try {
      targetInfo = fs.lstatSync(candidate);
    } catch {
      throw new PortableCodexSecurityArtifactError(`missing file ${anchor.path}`);
    }
    if (targetInfo.isSymbolicLink()) {
      throw new PortableCodexSecurityArtifactError(`symlink ${anchor.path}`);
    }
  }
  if (targetInfo === undefined) {
    throw new PortableCodexSecurityArtifactError(`missing file ${anchor.path}`);
  }
  if (targetInfo.isDirectory()) {
    throw new PortableCodexSecurityArtifactError(`directory ${anchor.path}`);
  }
  if (!targetInfo.isFile()) {
    throw new PortableCodexSecurityArtifactError(`non-file ${anchor.path}`);
  }
  if (
    targetInfo.size >
      PORTABLE_CODEX_SECURITY_NORMALIZATION_LIMITS.maxEvidenceFileBytes
  ) {
    throw new PortableCodexSecurityArtifactError(`oversized file ${anchor.path}`);
  }

  const content = readPinnedRegularFile(
    target,
    targetInfo,
    PORTABLE_CODEX_SECURITY_NORMALIZATION_LIMITS.maxEvidenceFileBytes,
    `oversized file ${anchor.path}`,
    "evidence identity changed",
    fileSystem,
  );
  assertSnapshotRootUnchanged(pinnedRoot);

  const lines = content.toString("utf8").split(/\r?\n/);
  if (anchor.startLine > lines.length || anchor.endLine > lines.length) {
    throw new PortableCodexSecurityArtifactError("out-of-range line");
  }
  const snippetEndLine = Math.min(
    anchor.endLine,
    anchor.startLine + PORTABLE_CODEX_SECURITY_NORMALIZATION_LIMITS.maxAnchorLines - 1,
  );
  const code = lines.slice(anchor.startLine - 1, snippetEndLine).join("\n");
  if (
    Buffer.byteLength(code, "utf8") >
      PORTABLE_CODEX_SECURITY_NORMALIZATION_LIMITS.maxSnippetBytes
  ) {
    throw new PortableCodexSecurityArtifactError("snippet byte limit exceeded");
  }
  return {
    ...anchor,
    snippetStartLine: anchor.startLine,
    snippetEndLine,
    code,
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
  redactor: Pick<SecretRedactor, "redactText">,
  fileSystem: PortableCodexSecurityPinnedFileSystem,
  outputBudget: PortableCodexSecurityOutputBudget,
): Record<string, unknown> {
  const rawId = requiredText(finding, "id");
  requiredText(finding, "candidateId");
  const id = redactPublicText(rawId, "id", redactor, outputBudget);
  const title = redactPublicText(
    requiredText(finding, "title"),
    "title",
    redactor,
    outputBudget,
  );
  const requestedSeverity = requiredText(finding, "severity");
  const severity = normalizeSeverity(requestedSeverity);
  if (severity === "unknown") {
    throw new PortableCodexSecurityArtifactError("severity is invalid");
  }
  const confidence = normalizeConfidence(requiredText(finding, "confidence"));
  const category = redactPublicText(
    requiredText(finding, "category"),
    "category",
    redactor,
    outputBudget,
  );
  const remediation = redactPublicText(
    requiredText(finding, "remediation"),
    "remediation",
    redactor,
    outputBudget,
  );
  const summary = redactPublicText(
    requiredText(finding, "summary"),
    "summary",
    redactor,
    outputBudget,
  );
  const impact = redactPublicText(
    requiredText(finding, "impact"),
    "impact",
    redactor,
    outputBudget,
  );
  const rootCause = redactPublicText(
    requiredText(finding, "rootCause"),
    "rootCause",
    redactor,
    outputBudget,
  );
  if (!Array.isArray(finding.anchors) || finding.anchors.length === 0) {
    throw new PortableCodexSecurityArtifactError(`finding ${id} has no path:line[-line] anchor`);
  }
  if (
    finding.anchors.length >
      PORTABLE_CODEX_SECURITY_NORMALIZATION_LIMITS.maxAnchorsPerFinding
  ) {
    throw new PortableCodexSecurityArtifactError(`finding ${id} exceeds the anchor limit`);
  }
  const languages: string[] = [];
  const anchors = finding.anchors.map((rawAnchor) => {
    const anchor = lineSnippet(snapshotRoot, parseAnchor(rawAnchor), fileSystem);
    languages.push(languageForPath(anchor.path));
    return {
      ...anchor,
      path: redactPublicText(anchor.path, "anchor path", redactor, outputBudget),
      explanation: anchor.explanation === null
        ? null
        : redactPublicText(
          anchor.explanation,
          "anchor explanation",
          redactor,
          outputBudget,
        ),
      code: redactPublicText(
        anchor.code,
        "source snippet",
        redactor,
        outputBudget,
        PORTABLE_CODEX_SECURITY_NORMALIZATION_LIMITS.maxSnippetBytes,
      ),
    };
  });
  const evidenceRefs = anchors.map((_, index) => `evidence-${index + 1}`);
  if (finding.cwe !== undefined && !Array.isArray(finding.cwe)) {
    throw new PortableCodexSecurityArtifactError(`finding ${id} has invalid cwe data`);
  }
  const cwe = (finding.cwe ?? []).flatMap((value) => {
    const bounded = boundedText(value, "cwe");
    if (bounded === null || !/^CWE-\d+$/i.test(bounded)) return [];
    const redacted = redactPublicText(bounded, "cwe", redactor, outputBudget);
    return /^CWE-\d+$/i.test(redacted) ? [redacted] : [];
  });
  const severityRationale = redactOptionalText(
    finding.severityRationale,
    "severityRationale",
    redactor,
    outputBudget,
  );
  const primary = fingerprint(id, severity, category, anchors);

  return {
    findingId: `portable-codex-security-${id}`,
    occurrenceId: id,
    title,
    summary: summary ?? impact ?? title,
    severity: {
      level: severity,
      rationale: severityRationale,
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
      label: `Evidence excerpt at ${anchor.path}:${anchor.snippetStartLine}${anchor.snippetEndLine !== anchor.snippetStartLine ? `–${anchor.snippetEndLine}` : ""}`,
      path: anchor.path,
      startLine: anchor.snippetStartLine,
      endLine: anchor.snippetEndLine,
      lines: anchor.snippetStartLine === anchor.snippetEndLine
        ? String(anchor.snippetStartLine)
        : `${anchor.snippetStartLine}-${anchor.snippetEndLine}`,
      role: anchor.role,
      code: anchor.code,
      language: languages[index]!,
      explanation: anchor.explanation ?? "Reported by the Portable Codex Security static review.",
    })),
    taxonomy: {
      category,
      cwe,
    },
    attackPath: {
      summary,
      evidenceRefs,
      reachability: {
        attacker: "Untrusted caller",
        preconditions: null,
      },
      dataflow: {
        summary: rootCause,
        outcome: impact,
        evidenceRefs,
      },
    },
    rootCause: {
      summary: rootCause,
    },
    validation: {
      status: "STATIC_REVIEW",
      summary,
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
  let handoffInfo: fs.Stats;
  try {
    handoffInfo = fs.lstatSync(handoffPath);
  } catch {
    throw new PortableCodexSecurityArtifactError("missing sentinel-findings.json");
  }
  if (handoffInfo.isSymbolicLink() || !handoffInfo.isFile()) {
    throw new PortableCodexSecurityArtifactError("sentinel-findings.json is not a regular file");
  }
  if (
    handoffInfo.size >
      PORTABLE_CODEX_SECURITY_NORMALIZATION_LIMITS.maxHandoffBytes
  ) {
    throw new PortableCodexSecurityArtifactError("handoff byte limit exceeded");
  }
  const handoffBytes = readPinnedRegularFile(
    handoffPath,
    handoffInfo,
    PORTABLE_CODEX_SECURITY_NORMALIZATION_LIMITS.maxHandoffBytes,
    "handoff byte limit exceeded",
    "handoff identity changed",
  );
  let handoff: PortableCodexSecurityHandoff;
  try {
    handoff = JSON.parse(handoffBytes.toString("utf8")) as PortableCodexSecurityHandoff;
  } catch {
    throw new PortableCodexSecurityArtifactError("sentinel-findings.json is not valid JSON");
  }
  if (handoff.schemaVersion !== 1 || !Array.isArray(handoff.findings)) {
    throw new PortableCodexSecurityArtifactError("sentinel-findings.json does not match schemaVersion 1");
  }
  if (handoff.stage !== undefined && handoff.stage !== "report") {
    throw new PortableCodexSecurityArtifactError("sentinel-findings.json has an invalid stage");
  }
  if (
    handoff.findings.length >
      PORTABLE_CODEX_SECURITY_NORMALIZATION_LIMITS.maxFindings
  ) {
    throw new PortableCodexSecurityArtifactError("finding limit exceeded");
  }
  const ids = new Set<string>();
  handoff.findings.forEach((finding, index) => {
    if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
      throw new PortableCodexSecurityArtifactError(`finding ${index + 1} is not an object`);
    }
    const id = requiredText(finding, "id");
    requiredText(finding, "candidateId");
    requiredText(finding, "title");
    requiredText(finding, "severity");
    requiredText(finding, "confidence");
    requiredText(finding, "category");
    requiredText(finding, "summary");
    requiredText(finding, "rootCause");
    requiredText(finding, "impact");
    requiredText(finding, "remediation");
    if (
      Array.isArray(finding.anchors) &&
      finding.anchors.length >
        PORTABLE_CODEX_SECURITY_NORMALIZATION_LIMITS.maxAnchorsPerFinding
    ) {
      throw new PortableCodexSecurityArtifactError(`finding ${id} exceeds the anchor limit`);
    }
    if (ids.has(id)) {
      throw new PortableCodexSecurityArtifactError(`duplicate finding id ${id}`);
    }
    ids.add(id);
  });
  const dossier = readPortableCodexSecurityDossier(resultsDir);
  if (dossier === null) {
    throw new PortableCodexSecurityArtifactError("coverage dossier is missing or invalid");
  }
  try {
    validatePortableCodexSecurityReportCoverage(handoff, dossier);
  } catch (error) {
    if (error instanceof PortableCodexSecurityDossierError) {
      throw new PortableCodexSecurityArtifactError(`coverage validation failed: ${error.reason}`);
    }
    throw error;
  }
  return handoff.findings;
}

export function normalizePortableCodexSecurityWorkspace(
  resultsDir: string,
  outputDir: string,
  dependencies: PortableCodexSecurityNormalizationDependencies = {},
): number {
  const raw = readPortableCodexSecurityFindingRecords(resultsDir);
  const snapshotRoot = path.join(outputDir, "portable-codex-security-snapshot");
  const redactor = dependencies.redactor ?? globalSecretRedactor;
  const fileSystem = dependencies.fileSystem ?? fs;
  const outputBudget = new PortableCodexSecurityOutputBudget();
  const findings = raw.map((finding) =>
    normalizeFinding(finding, snapshotRoot, redactor, fileSystem, outputBudget)
  );
  const payload = {
    schemaVersion: 1,
    engine: "codex-security",
    executionProfile: "portable",
    methodologyRef: PORTABLE_CODEX_SECURITY_METHODOLOGY_REF,
    generatedAt: new Date().toISOString(),
    sourceFindings: raw.length,
    findings,
  };
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  if (
    Buffer.byteLength(serialized, "utf8") >
      PORTABLE_CODEX_SECURITY_NORMALIZATION_LIMITS.maxOutputBytes
  ) {
    throw new PortableCodexSecurityArtifactError("output byte budget exceeded");
  }
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const target = path.join(outputDir, "findings.json");
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, serialized, {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(temporary, target);
  return findings.length;
}
