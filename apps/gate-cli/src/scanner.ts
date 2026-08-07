import { spawn, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
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

export function createScannerAdapter(spawnCommand: SpawnCommand = defaultSpawnCommand): ScannerAdapter {
  return {
    async run(input) {
      fs.mkdirSync(input.outputDir, { recursive: true, mode: 0o700 });
      const args = [
        "--yes", "@openai/codex-security", "scan", input.repositoryPath,
        "--model", input.policy.scan.model,
        "--effort", input.policy.scan.effort,
        "--mode", input.policy.scan.mode,
        "--max-cost", String(input.policy.scan.maxCostUsd),
        "--output-dir", input.outputDir,
        "--json",
      ];
      for (const changedPath of input.paths) args.push("--path", changedPath);

      const child = spawnCommand("npx", args, {
        cwd: input.repositoryPath,
        env: { ...process.env, CI: "1", NO_COLOR: "1" },
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

      const manifest = readJson(path.join(input.outputDir, "scan-manifest.json"));
      const scan = record(manifest.scan);
      const scanId = stringValue(scan.id);
      if (scanId === null) throw new Error("Security scanner did not produce a scan id");

      return {
        scanId,
        scanDir: input.outputDir,
        status: "completed",
        findings: readFindings(input.outputDir),
        cost: null,
        scannerVersion: stringValue(record(manifest.scanner).version),
      };
    },
  };
}

export const defaultScannerAdapter = createScannerAdapter();

function readFindings(scanDir: string): FindingSummary[] {
  const document = readJson(path.join(scanDir, "findings.json"));
  const findings = Array.isArray(document.findings) ? document.findings : [];
  return findings.map((value, index) => {
    const finding = record(value);
    const locations = Array.isArray(finding.locations) ? finding.locations.map(record) : [];
    const evidence = Array.isArray(finding.codeEvidence) ? finding.codeEvidence.map(record) : [];
    const primary = [...locations, ...evidence].find((candidate) => stringValue(candidate.path) !== null);
    const fingerprints = record(finding.fingerprints);
    const fingerprintValues = Object.values(fingerprints).filter((entry): entry is string => typeof entry === "string");
    const findingId = stringValue(finding.findingId) ?? stringValue(finding.occurrenceId) ?? `finding-${index + 1}`;
    if (!fingerprintValues.includes(findingId)) fingerprintValues.push(findingId);
    const taxonomy = record(finding.taxonomy);
    const cwe = Array.isArray(taxonomy.cwe)
      ? taxonomy.cwe.filter((entry): entry is string => typeof entry === "string")
      : [];
    return {
      findingId,
      occurrenceId: stringValue(finding.occurrenceId),
      title: stringValue(finding.title) ?? "Untitled finding",
      severity: normalizeSeverity(finding.severity),
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

function readJson(filePath: string): Record<string, unknown> {
  return record(JSON.parse(fs.readFileSync(filePath, "utf8")));
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
