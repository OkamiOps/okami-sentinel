import fs from "node:fs";
import path from "node:path";

export const VULNHUNTER_HTTP_BUNDLE_NAME = "vulnhunter-bundle.json";

export const VULNHUNTER_HTTP_BUNDLE_ARTIFACTS = [
  "reconnaissance.md",
  "trace-review.md",
  "verification.md",
  "validation-notes.md",
  "coverage-sweep.md",
  "README.md",
  "sentinel-findings.json",
] as const;

type BundleArtifactName = (typeof VULNHUNTER_HTTP_BUNDLE_ARTIFACTS)[number];

const MARKDOWN_ARTIFACTS = new Set<BundleArtifactName>([
  "reconnaissance.md",
  "trace-review.md",
  "verification.md",
  "validation-notes.md",
  "coverage-sweep.md",
  "README.md",
]);
const BUNDLE_KEYS = new Set(["schemaVersion", "artifacts"]);
const ARTIFACT_KEYS = new Set(["name", "content"]);
const SENTINEL_KEYS = new Set(["schemaVersion", "findings"]);
const FINDING_KEYS = new Set([
  "id", "title", "severity", "confidence", "cwe", "summary", "rootCause", "entryPoint",
  "dataFlow", "impact", "remediation", "severityRationale", "validation", "evidence",
]);
const VALIDATION_KEYS = new Set(["summary", "limitations"]);
const EVIDENCE_KEYS = new Set(["path", "startLine", "endLine", "role", "explanation"]);
const VALID_EVIDENCE_ROLES = new Set(["source", "entrypoint", "control", "sink", "evidence"]);
const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;
const MAX_MARKDOWN_BYTES = 1 * 1024 * 1024;
const MAX_SENTINEL_BYTES = 2 * 1024 * 1024;
const MAX_FINDINGS = 1_000;
const NO_FOLLOW = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
const READ_NO_FOLLOW = fs.constants.O_RDONLY | NO_FOLLOW;
const WRITE_NEW_NO_FOLLOW = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW;

export type VulnHunterHttpBundleErrorCode = "bundle_invalid";

/** Stable, secret-free validation failure for the provider's one terminal artifact. */
export class VulnHunterHttpBundleError extends Error {
  constructor(readonly code: VulnHunterHttpBundleErrorCode = "bundle_invalid") {
    super(code);
    this.name = "VulnHunterHttpBundleError";
  }
}

interface MaterializedArtifact {
  name: BundleArtifactName;
  content: string;
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
 * Validates all bundle bytes before creating any legacy file. The normalizer
 * therefore receives the unchanged seven-file VulnHunter handoff contract.
 */
export function materializeVulnHunterHttpBundle(
  handoffRoot: string,
  resultsDir: string,
): readonly BundleArtifactName[] {
  const bundle = readExactBundle(handoffRoot);
  const artifacts = parseBundle(bundle);
  assertPrivateDirectory(resultsDir);
  assertEmptyDirectory(resultsDir);

  for (const artifact of artifacts) writeNewPrivateFile(resultsDir, artifact);
  return artifacts.map((artifact) => artifact.name);
}

function readExactBundle(handoffRoot: string): string {
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
  return readPinnedFile(path.join(handoffRoot, VULNHUNTER_HTTP_BUNDLE_NAME), MAX_BUNDLE_BYTES);
}

function parseBundle(raw: string): readonly MaterializedArtifact[] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return invalidBundle();
  }
  const bundle = object(value);
  if (bundle === null || !hasOnlyKeys(bundle, BUNDLE_KEYS) || bundle.schemaVersion !== 1 || !Array.isArray(bundle.artifacts)) {
    return invalidBundle();
  }
  if (bundle.artifacts.length !== VULNHUNTER_HTTP_BUNDLE_ARTIFACTS.length) return invalidBundle();

  const names = new Set<string>();
  const materialized: MaterializedArtifact[] = [];
  for (const value of bundle.artifacts) {
    const artifact = object(value);
    if (artifact === null || !hasOnlyKeys(artifact, ARTIFACT_KEYS) || typeof artifact.name !== "string") {
      return invalidBundle();
    }
    const name = artifact.name as BundleArtifactName;
    if (!VULNHUNTER_HTTP_BUNDLE_ARTIFACTS.includes(name) || names.has(name)) return invalidBundle();
    names.add(name);
    if (MARKDOWN_ARTIFACTS.has(name)) {
      if (!nonEmptyText(artifact.content, MAX_MARKDOWN_BYTES)) return invalidBundle();
      materialized.push({ name, content: artifact.content });
      continue;
    }
    if (name !== "sentinel-findings.json") return invalidBundle();
    const handoff = assertSentinelHandoff(artifact.content);
    const content = `${JSON.stringify(handoff, null, 2)}\n`;
    if (Buffer.byteLength(content, "utf8") > MAX_SENTINEL_BYTES) return invalidBundle();
    materialized.push({ name, content });
  }
  if (names.size !== VULNHUNTER_HTTP_BUNDLE_ARTIFACTS.length ||
      VULNHUNTER_HTTP_BUNDLE_ARTIFACTS.some((name) => !names.has(name))) {
    return invalidBundle();
  }
  return materialized;
}

function assertSentinelHandoff(value: unknown): Record<string, unknown> {
  const handoff = object(value);
  if (handoff === null || !hasOnlyKeys(handoff, SENTINEL_KEYS) ||
      (handoff.schemaVersion !== undefined && handoff.schemaVersion !== 1) ||
      !Array.isArray(handoff.findings)) {
    return invalidBundle();
  }
  if (handoff.findings.length > MAX_FINDINGS) return invalidBundle();
  const ids = new Set<string>();
  for (const value of handoff.findings) {
    const finding = object(value);
    if (finding === null || !hasOnlyKeys(finding, FINDING_KEYS)) return invalidBundle();
    const id = requiredText(finding.id, 256);
    if (ids.has(id)) return invalidBundle();
    ids.add(id);
    if (!nonEmptyText(finding.title, 4_096) || !isSeverity(finding.severity) ||
        !isConfidence(finding.confidence) || !stringArray(finding.cwe, 128, 128, /^CWE-\d+$/i) ||
        !nonEmptyText(finding.summary, 32_768) || !nonEmptyText(finding.rootCause, 32_768) ||
        !nonEmptyText(finding.entryPoint, 16_384) || !nonEmptyText(finding.dataFlow, 32_768) ||
        !nonEmptyText(finding.impact, 32_768) || !nonEmptyText(finding.remediation, 32_768) ||
        !nonEmptyText(finding.severityRationale, 32_768)) return invalidBundle();
    assertValidation(finding.validation);
    assertEvidence(finding.evidence);
  }
  return { schemaVersion: 1, findings: handoff.findings };
}

function assertValidation(value: unknown): void {
  const validation = object(value);
  if (validation === null || !hasOnlyKeys(validation, VALIDATION_KEYS) ||
      !nonEmptyText(validation.summary, 32_768) || !stringArray(validation.limitations, 128, 8_192)) {
    invalidBundle();
  }
}

function assertEvidence(value: unknown): void {
  if (!Array.isArray(value) || value.length === 0 || value.length > 256) invalidBundle();
  for (const item of value) {
    const evidence = object(item);
    if (evidence === null || !hasOnlyKeys(evidence, EVIDENCE_KEYS) ||
        !isRepositoryRelativePath(evidence.path) || !positiveInteger(evidence.startLine) ||
        !positiveInteger(evidence.endLine) || (evidence.endLine as number) < (evidence.startLine as number) ||
        typeof evidence.role !== "string" || !VALID_EVIDENCE_ROLES.has(evidence.role) ||
        !nonEmptyText(evidence.explanation, 32_768)) invalidBundle();
  }
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
    if (!sameVersion(opened, afterRead) || !sameVersion(expected, afterPath) || !safeRegularFile(afterPath, maxBytes)) {
      return invalidBundle();
    }
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

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function requiredText(value: unknown, maxBytes: number): string {
  if (!nonEmptyText(value, maxBytes)) invalidBundle();
  return value;
}

function nonEmptyText(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && value.trim().length > 0 &&
    Buffer.byteLength(value, "utf8") <= maxBytes && !value.includes("\u0000");
}

function stringArray(
  value: unknown,
  maxItems: number,
  maxTextBytes: number,
  pattern?: RegExp,
): value is string[] {
  return Array.isArray(value) && value.length <= maxItems && value.every((item) =>
    nonEmptyText(item, maxTextBytes) && (pattern === undefined || pattern.test(item)),
  );
}

function isSeverity(value: unknown): boolean {
  return typeof value === "string" && /^(?:critical|high|medium|low)$/i.test(value);
}

function isConfidence(value: unknown): boolean {
  return typeof value === "string" && /^(?:high|medium|low)$/i.test(value);
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isRepositoryRelativePath(value: unknown): boolean {
  if (!nonEmptyText(value, 4_096)) return false;
  const normalized = value.replaceAll("\\", "/");
  return !normalized.startsWith("/") && !/^[A-Za-z]:\//.test(normalized) &&
    !normalized.split("/").some((part) => part === "" || part === "." || part === "..");
}

function invalidBundle(): never {
  throw new VulnHunterHttpBundleError();
}
