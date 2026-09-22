import { spawn, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import {
  normalizeSeverity,
  type FindingSummary,
  type GuardrailPolicy,
  type ScanCost,
} from "@csb/shared";

export interface ScannerResult {
  scanId: string;
  scanDir: string;
  status: "completed" | "failed";
  findings: FindingSummary[];
  cost: ScanCost | null;
  scannerVersion: string | null;
}

export interface ScannerAdapter {
  run(input: {
    repositoryPath: string;
    paths: string[];
    policy: GuardrailPolicy;
    outputDir: string;
  }): Promise<ScannerResult>;
}

export interface SpawnedScannerProcess {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  once(event: "error", listener: (error: Error) => void): this;
  once(event: "close", listener: (code: number | null) => void): this;
}

export type SpawnCommand = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => SpawnedScannerProcess;

const defaultSpawnCommand: SpawnCommand = (command, args, options) =>
  spawn(command, [...args], options) as SpawnedScannerProcess;

type ScannerBinaryResolver = () => string;

const TRUSTED_SCANNER_PACKAGE = "@openai/codex-security";
const TRUSTED_SCANNER_VERSION = "0.1.29";
const trustedRequire = createRequire(import.meta.url);

export function createScannerAdapter(
  spawnCommand: SpawnCommand = defaultSpawnCommand,
  resolveScannerBinary: ScannerBinaryResolver = resolveTrustedScannerBinary,
): ScannerAdapter {
  return {
    async run(input) {
      const requestedOutputDir = path.resolve(input.outputDir);
      const repositoryPath = path.resolve(input.repositoryPath);
      assertOutputOutsideRepository(repositoryPath, requestedOutputDir);
      fs.mkdirSync(requestedOutputDir, { recursive: true, mode: 0o700 });
      const outputDir = fs.realpathSync(requestedOutputDir);
      assertOutputOutsideRepository(fs.realpathSync(repositoryPath), outputDir);
      fs.chmodSync(outputDir, 0o700);
      const runtimeDir = prepareRuntimeDirectory(outputDir);
      const args = [
        resolveScannerBinary(), "scan", repositoryPath,
        "--model", input.policy.scan.model,
        "--effort", input.policy.scan.effort,
        "--mode", input.policy.scan.mode,
        "--max-cost", String(input.policy.scan.maxCostUsd),
        "--output-dir", outputDir,
        "--json",
      ];
      for (const changedPath of input.paths) args.push("--path", changedPath);

      const child = spawnCommand(process.execPath, args, {
        cwd: runtimeDir,
        env: scannerEnvironment(runtimeDir),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout?.resume();
      child.stderr?.resume();

      const exitCode = await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolve(code ?? 1));
      });
      if (exitCode !== 0) throw new Error(`Security scanner failed with exit code ${exitCode}`);

      const manifest = readScanManifest(outputDir);
      const findings = readFindings(outputDir, manifest.scanId);

      return {
        scanId: manifest.scanId,
        scanDir: outputDir,
        status: "completed",
        findings,
        cost: null,
        scannerVersion: TRUSTED_SCANNER_VERSION,
      };
    },
  };
}

export const defaultScannerAdapter = createScannerAdapter();

function resolveTrustedScannerBinary(): string {
  let packageEntry: string;
  try {
    packageEntry = trustedRequire.resolve(TRUSTED_SCANNER_PACKAGE);
  } catch {
    throw new Error("Trusted Codex Security scanner is unavailable");
  }
  const packageRoot = path.resolve(path.dirname(packageEntry), "..");
  const packageManifest = readJson(path.join(packageRoot, "package.json"), "trusted scanner manifest");
  if (stringValue(packageManifest.version) !== TRUSTED_SCANNER_VERSION) {
    throw new Error("Trusted Codex Security scanner version is unavailable");
  }
  const binary = path.join(packageRoot, "bin", "codex-security.mjs");
  try {
    if (!fs.statSync(binary).isFile()) throw new Error();
  } catch {
    throw new Error("Trusted Codex Security scanner binary is unavailable");
  }
  return binary;
}

function assertOutputOutsideRepository(repositoryPath: string, outputDir: string): void {
  const relative = path.relative(repositoryPath, outputDir);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    throw new Error("Security scanner output must be outside the scanned repository");
  }
}

function prepareRuntimeDirectory(outputDir: string): string {
  const runtimeDir = path.join(path.dirname(outputDir), ".csb-scanner-runtime");
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(runtimeDir, 0o700);
  for (const name of ["home", "tmp"] as const) {
    const directory = path.join(runtimeDir, name);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
  }
  return runtimeDir;
}

function scannerEnvironment(runtimeDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    CI: "1",
    NO_COLOR: "1",
    PATH: process.env.PATH ?? "",
    HOME: path.join(runtimeDir, "home"),
    TMPDIR: path.join(runtimeDir, "tmp"),
  };
  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey !== undefined && apiKey !== "") env.OPENAI_API_KEY = apiKey;
  return env;
}

function readScanManifest(scanDir: string): { scanId: string } {
  const manifest = readJson(path.join(scanDir, "scan-manifest.json"), "scan manifest");
  if (manifest.documentType !== "codex-security.scan-manifest" || manifest.schemaVersion !== "1.0") {
    throw new Error("Security scanner produced an unsupported scan manifest");
  }
  const scan = requiredRecord(manifest.scan, "scan manifest");
  const scanId = requiredString(scan.id, "scan id");
  if (scan.status !== "completed" || scan.findingsRef !== "findings.json") {
    throw new Error("Security scanner produced an incomplete scan manifest");
  }
  const producer = requiredRecord(scan.producer, "scan producer");
  if (requiredString(producer.name, "scan producer") !== "codex-security-plugin") {
    throw new Error("Security scanner produced an unexpected scan producer");
  }
  requiredString(producer.version, "scan producer version");
  return { scanId };
}

function readFindings(scanDir: string, scanId: string): FindingSummary[] {
  const document = readJson(path.join(scanDir, "findings.json"), "findings document");
  if (document.documentType !== "codex-security.findings" || document.schemaVersion !== "1.0") {
    throw new Error("Security scanner produced an unsupported findings document");
  }
  if (document.scanId !== scanId || !Array.isArray(document.findings)) {
    throw new Error("Security scanner produced invalid findings");
  }
  const findings = document.findings.map((value) => validateFinding(value));
  return findings.map((value, index) => {
    const finding = value;
    const locations = Array.isArray(finding.locations) ? finding.locations.map(record) : [];
    const evidence = Array.isArray(finding.codeEvidence) ? finding.codeEvidence.map(record) : [];
    const primary = [...locations, ...evidence].find((candidate) => stringValue(candidate.path) !== null);
    const fingerprints = record(finding.fingerprints);
    const fingerprintValues = Object.values(fingerprints).filter((entry): entry is string => typeof entry === "string");
    const findingId = requiredString(finding.findingId, `finding ${index + 1} id`);
    if (!fingerprintValues.includes(findingId)) fingerprintValues.push(findingId);
    const taxonomy = record(finding.taxonomy);
    const cwe = Array.isArray(taxonomy.cwe)
      ? taxonomy.cwe.filter((entry): entry is string => typeof entry === "string")
      : [];
    return {
      findingId,
      occurrenceId: stringValue(finding.occurrenceId),
      title: stringValue(finding.title) ?? "Untitled finding",
      severity: normalizedFindingSeverity(finding),
      confidence: level(finding.confidence),
      ruleId: stringValue(finding.ruleId),
      summary: stringValue(finding.summary),
      primaryPath: primary ? stringValue(primary.path) : null,
      fingerprints: fingerprintValues,
      category: stringValue(taxonomy.category),
      cwe,
    };
  });
}

function validateFinding(value: unknown): Record<string, unknown> {
  const finding = requiredRecord(value, "finding");
  requiredString(finding.findingId, "finding id");
  requiredString(finding.occurrenceId, "finding occurrence id");
  requiredString(requiredRecord(finding.identity, "finding identity").anchor, "finding identity anchor");
  const fingerprints = requiredRecord(finding.fingerprints, "finding fingerprints");
  requiredString(fingerprints.primary, "finding primary fingerprint");
  requiredString(finding.title, "finding title");
  const severity = requiredRecord(finding.severity, "finding severity");
  if (!isSeverityLevel(severity.level)) throw new Error("Security scanner produced an invalid finding severity");
  return finding;
}

function readJson(filePath: string, documentName: string): Record<string, unknown> {
  let source: string;
  try {
    source = fs.readFileSync(filePath, "utf8");
  } catch {
    throw new Error(`Security scanner did not produce ${documentName}`);
  }
  try {
    return requiredRecord(JSON.parse(source), documentName);
  } catch {
    throw new Error(`Security scanner produced invalid ${documentName}`);
  }
}

function requiredRecord(value: unknown, description: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Security scanner produced invalid ${description}`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, description: string): string {
  const string = stringValue(value);
  if (string === null) throw new Error(`Security scanner produced invalid ${description}`);
  return string;
}

function normalizedFindingSeverity(finding: Record<string, unknown>): FindingSummary["severity"] {
  const level = requiredString(record(finding.severity).level, "finding severity level");
  return normalizeSeverity(level === "informational" ? "info" : level);
}

function isSeverityLevel(value: unknown): boolean {
  return value === "critical" || value === "high" || value === "medium" || value === "low" || value === "informational";
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function level(value: unknown): string | null {
  return stringValue(value) ?? stringValue(record(value).level);
}
