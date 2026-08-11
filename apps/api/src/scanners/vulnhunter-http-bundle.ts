import fs from "node:fs";
import path from "node:path";

import {
  MAX_VULNHUNTER_RESULT_REPORT_BYTES,
  normalizeVulnHunterResultReport,
  VULNHUNTER_RESULT_ARTIFACT_NAMES,
  VULNHUNTER_RESULT_ARTIFACT_PATH,
} from "../agent/result-artifact-contract.js";

export const VULNHUNTER_HTTP_BUNDLE_NAME = VULNHUNTER_RESULT_ARTIFACT_PATH;
export const VULNHUNTER_HTTP_BUNDLE_ARTIFACTS = VULNHUNTER_RESULT_ARTIFACT_NAMES;

type BundleArtifactName = (typeof VULNHUNTER_HTTP_BUNDLE_ARTIFACTS)[number];

interface ValidatedEvidence {
  path: string;
  startLine: number;
  endLine: number;
  role: string;
  explanation: string;
}

interface ValidatedFinding {
  id: string;
  title: string;
  severity: string;
  confidence: string;
  cwe: string[];
  summary: string;
  rootCause: string;
  entryPoint: string;
  dataFlow: string;
  impact: string;
  remediation: string;
  severityRationale: string;
  validation: { summary: string; limitations: string[] };
  evidence: ValidatedEvidence[];
}

interface ValidatedReport {
  schemaVersion: 1;
  findings: ValidatedFinding[];
}

interface MaterializedArtifact {
  name: BundleArtifactName;
  content: string;
}

export interface VulnHunterHttpBundleMaterializationOptions {
  /** Same immutable snapshot used by the session; required for non-empty reports. */
  snapshotRoot?: string;
  /** Test-only observation point while the unpublished staging tree is written. */
  afterStageWrite?: (name: string) => void;
}

const MAX_REPORT_BYTES = MAX_VULNHUNTER_RESULT_REPORT_BYTES;
const MAX_MARKDOWN_BYTES = 3 * 1024 * 1024;
const NO_FOLLOW = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
const READ_NO_FOLLOW = fs.constants.O_RDONLY | NO_FOLLOW;
const WRITE_NEW_NO_FOLLOW = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW;

export type VulnHunterHttpBundleErrorCode = "bundle_invalid";

/** Stable, secret-free validation failure for the provider's terminal report. */
export class VulnHunterHttpBundleError extends Error {
  constructor(readonly code: VulnHunterHttpBundleErrorCode = "bundle_invalid") {
    super(code);
    this.name = "VulnHunterHttpBundleError";
  }
}

/**
 * Creates a per-run root that the constrained session can write to, but which
 * is intentionally never the legacy results directory consumed by the normalizer.
 */
export function createVulnHunterHttpHandoffRoot(resultsDir: string): string {
  const resolvedResultsDir = path.resolve(resultsDir);
  const parent = path.dirname(resolvedResultsDir);
  assertPrivateDirectory(parent);
  assertPrivateDirectory(resolvedResultsDir);
  const handoffRoot = path.join(parent, "http-agent-handoff");
  if (handoffRoot === resolvedResultsDir || fs.existsSync(handoffRoot)) invalidBundle();
  try {
    fs.mkdirSync(handoffRoot, { mode: 0o700 });
    assertPrivateDirectory(handoffRoot);
    return handoffRoot;
  } catch {
    invalidBundle();
  }
}

/**
 * The provider submits one canonical findings report. Only after the complete
 * report is validated do we materialize the seven legacy files expected by the
 * existing VulnHunter normalizer. The generated Markdown never claims coverage
 * or reconnaissance that the provider did not report.
 */
export function materializeVulnHunterHttpBundle(
  handoffRoot: string,
  resultsDir: string,
  options: VulnHunterHttpBundleMaterializationOptions = {},
): readonly BundleArtifactName[] {
  const report = readExactReport(handoffRoot, options.snapshotRoot);
  const artifacts = materializedArtifacts(report);
  assertPrivateDirectory(resultsDir);
  assertEmptyDirectory(resultsDir);
  const stagingDir = createPrivateStagingDirectory(resultsDir);
  try {
    for (const artifact of artifacts) {
      writeNewPrivateFile(stagingDir, artifact);
      options.afterStageWrite?.(artifact.name);
    }
    publishStagedArtifacts(stagingDir, resultsDir);
    return artifacts.map((artifact) => artifact.name);
  } catch {
    discardPrivateStagingDirectory(stagingDir);
    invalidBundle();
  }
}

function readExactReport(handoffRoot: string, snapshotRoot: string | undefined): ValidatedReport {
  assertPrivateDirectory(handoffRoot);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(handoffRoot, { withFileTypes: true });
  } catch {
    return invalidBundle();
  }
  if (entries.length !== 1 || entries[0]?.name !== VULNHUNTER_HTTP_BUNDLE_NAME || !entries[0].isFile()) {
    return invalidBundle();
  }
  const raw = readPinnedFile(path.join(handoffRoot, VULNHUNTER_HTTP_BUNDLE_NAME), MAX_REPORT_BYTES);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return invalidBundle();
  }
  const report = normalizeVulnHunterResultReport(parsed, snapshotRoot);
  return report === null ? invalidBundle() : report as unknown as ValidatedReport;
}

function materializedArtifacts(report: ValidatedReport): readonly MaterializedArtifact[] {
  const canonical = `${JSON.stringify(report)}\n`;
  if (Buffer.byteLength(canonical, "utf8") > MAX_REPORT_BYTES) invalidBundle();

  const counts = new Map<string, number>();
  for (const finding of report.findings) {
    const severity = finding.severity.toLowerCase();
    counts.set(severity, (counts.get(severity) ?? 0) + 1);
  }
  const countLine = ["critical", "high", "medium", "low"]
    .map((severity) => `${severity}: ${counts.get(severity) ?? 0}`)
    .join(", ");
  const inventory = report.findings.length === 0
    ? "- No evidence-backed finding was retained. This is not proof that the repository is vulnerability-free."
    : report.findings.map((finding) => `- ${inline(finding.id)} — ${inline(finding.title)} (${inline(finding.severity)})`).join("\n");
  const traces = report.findings.length === 0
    ? "- No retained finding supplied a source-to-operation trace."
    : report.findings.flatMap((finding) => [
      `## ${inline(finding.id)} — ${inline(finding.title)}`,
      ...finding.evidence.map((evidence) =>
        `- \`${inline(evidence.path)}:${evidence.startLine}-${evidence.endLine}\` (${inline(evidence.role)}): ${inline(evidence.explanation)}`
      ),
    ]).join("\n");
  const verification = report.findings.length === 0
    ? "- No candidate survived the provider's static verification. Coverage was not asserted."
    : report.findings.flatMap((finding) => [
      `## ${inline(finding.id)} — ${inline(finding.title)}`,
      `- Root cause: ${inline(finding.rootCause)}`,
      `- Entry point: ${inline(finding.entryPoint)}`,
      `- Data flow: ${inline(finding.dataFlow)}`,
      `- Validation: ${inline(finding.validation.summary)}`,
    ]).join("\n");
  const limitations = report.findings.length === 0
    ? "- Static read-only review only; no runtime validation was performed."
    : report.findings.flatMap((finding) => [
      `## ${inline(finding.id)}`,
      ...finding.validation.limitations.map((limitation) => `- ${inline(limitation)}`),
    ]).join("\n");

  const artifacts: MaterializedArtifact[] = [
    {
      name: "reconnaissance.md",
      content: "# Reconnaissance\n\nCompatibility artifact generated from the canonical findings report. No independent reconnaissance inventory or trust-boundary coverage claim was supplied by this contract.\n\n" + inventory + "\n",
    },
    {
      name: "trace-review.md",
      content: "# Trace review\n\nDeterministic projection of evidence attached to retained findings.\n\n" + traces + "\n",
    },
    {
      name: "verification.md",
      content: "# Verification\n\nDeterministic projection of retained static verification fields.\n\n" + verification + "\n",
    },
    {
      name: "validation-notes.md",
      content: "# Validation notes\n\nThis was a static, read-only review. No target code, generated code, build, test, exploit, or network validation was executed.\n\n" + limitations + "\n",
    },
    {
      name: "coverage-sweep.md",
      content: "# Coverage sweep\n\nCoverage was not asserted by the universal HTTP report contract. Zero findings is not a pass, and unreported paths must not be interpreted as reviewed.\n\n" + inventory + "\n",
    },
    {
      name: "README.md",
      content: `# VulnHunter defensive review\n\nContract: vulnhunter-report-v1\n\nRetained findings: ${report.findings.length} (${countLine}).\n\nThe six Markdown files are server-generated compatibility views of sentinel-findings.json, not independent model artifacts.\n`,
    },
    { name: "sentinel-findings.json", content: canonical },
  ];
  if (artifacts.some((artifact) => Buffer.byteLength(artifact.content, "utf8") >
      (artifact.name === "sentinel-findings.json" ? MAX_REPORT_BYTES : MAX_MARKDOWN_BYTES))) {
    invalidBundle();
  }
  return artifacts;
}

function inline(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").replace(/`/g, "'").trim();
}

function readPinnedFile(target: string, maxBytes: number): string {
  let descriptor: number | undefined;
  try {
    const expected = fs.lstatSync(target);
    if (!safeRegularFile(expected, maxBytes)) return invalidBundle();
    descriptor = fs.openSync(target, READ_NO_FOLLOW);
    const opened = fs.fstatSync(descriptor);
    if (!safeRegularFile(opened, maxBytes) || !sameVersion(expected, opened)) return invalidBundle();
    const content = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < content.length) {
      const bytes = fs.readSync(descriptor, content, offset, content.length - offset, offset);
      if (bytes === 0) return invalidBundle();
      offset += bytes;
    }
    const afterRead = fs.fstatSync(descriptor);
    const afterPath = fs.lstatSync(target);
    if (!sameVersion(opened, afterRead) || !sameVersion(expected, afterPath) ||
        !safeRegularFile(afterPath, maxBytes)) return invalidBundle();
    return content.toString("utf8");
  } catch {
    return invalidBundle();
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function writeNewPrivateFile(resultsDir: string, artifact: MaterializedArtifact): void {
  const target = path.join(resultsDir, artifact.name);
  const content = Buffer.from(artifact.content, "utf8");
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(target, WRITE_NEW_NO_FOLLOW, 0o600);
    fs.fchmodSync(descriptor, 0o600);
    let offset = 0;
    while (offset < content.length) {
      offset += fs.writeSync(descriptor, content, offset, content.length - offset, offset);
    }
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.size !== content.length) invalidBundle();
  } catch {
    invalidBundle();
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  try {
    const written = fs.lstatSync(target);
    if (!written.isFile() || written.isSymbolicLink() || written.size !== content.length) invalidBundle();
    fs.chmodSync(target, 0o600);
  } catch {
    invalidBundle();
  }
}

/**
 * A directory rename publishes the complete artifact set at once. The target
 * is a pre-existing empty, private per-scan results directory on the same
 * filesystem, so a failed staging write or failed rename never exposes a
 * partial legacy handoff at resultsDir.
 */
function publishStagedArtifacts(stagingDir: string, resultsDir: string): void {
  assertPrivateDirectory(stagingDir);
  assertPrivateDirectory(resultsDir);
  assertEmptyDirectory(resultsDir);
  fs.renameSync(stagingDir, resultsDir);
  assertPrivateDirectory(resultsDir);
  const entries = fs.readdirSync(resultsDir, { withFileTypes: true });
  if (entries.length !== VULNHUNTER_HTTP_BUNDLE_ARTIFACTS.length ||
      entries.some((entry) => !entry.isFile() || entry.isSymbolicLink() ||
        !VULNHUNTER_HTTP_BUNDLE_ARTIFACTS.includes(entry.name as BundleArtifactName))) {
    invalidBundle();
  }
}

function createPrivateStagingDirectory(resultsDir: string): string {
  const resolvedResultsDir = path.resolve(resultsDir);
  const parent = path.dirname(resolvedResultsDir);
  assertPrivateDirectory(parent);
  try {
    const stagingDir = fs.mkdtempSync(path.join(parent, `.${path.basename(resolvedResultsDir)}.publish-`));
    fs.chmodSync(stagingDir, 0o700);
    assertPrivateDirectory(stagingDir);
    return stagingDir;
  } catch {
    return invalidBundle();
  }
}

/** Remove only the known files from a private directory we just created. */
function discardPrivateStagingDirectory(stagingDir: string): void {
  try {
    assertPrivateDirectory(stagingDir);
    const entries = fs.readdirSync(stagingDir, { withFileTypes: true });
    if (entries.some((entry) => !entry.isFile() || entry.isSymbolicLink() ||
        !VULNHUNTER_HTTP_BUNDLE_ARTIFACTS.includes(entry.name as BundleArtifactName))) return;
    for (const entry of entries) fs.unlinkSync(path.join(stagingDir, entry.name));
    fs.rmdirSync(stagingDir);
  } catch {
    // Cleanup must never turn a rejected report into a partial final publish.
  }
}

function assertPrivateDirectory(target: string): void {
  try {
    const info = fs.lstatSync(target);
    if (info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o077) !== 0) invalidBundle();
  } catch {
    invalidBundle();
  }
}

function assertEmptyDirectory(target: string): void {
  try {
    if (fs.readdirSync(target).length !== 0) invalidBundle();
  } catch {
    invalidBundle();
  }
}

function safeRegularFile(info: fs.Stats, maxBytes: number): boolean {
  return !info.isSymbolicLink() && info.isFile() && info.size > 0 && info.size <= maxBytes;
}

function sameVersion(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function invalidBundle(): never {
  throw new VulnHunterHttpBundleError();
}
