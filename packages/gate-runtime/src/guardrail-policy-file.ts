import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { defaultGuardrailPolicy } from "@csb/gate-core";
import type {
  GateFindingLifecycle,
  GateRuleDecision,
  GuardrailPolicy,
  Severity,
} from "@csb/shared";

const policyKeys = ["schemaVersion", "protectedBranches", "scope", "scan", "rules"] as const;
const severityValues = ["critical", "high", "medium", "low", "info", "unknown"] as const;
const lifecycleValues = ["new", "reopened", "persistent", "fixed"] as const;
const decisionValues = ["block", "review"] as const;

export class GuardrailPolicyError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(`${path}: ${message}`);
    this.name = "GuardrailPolicyError";
  }
}

export function readGuardrailPolicy(repositoryPath: string): GuardrailPolicy {
  const policyPath = path.join(repositoryPath, ".csb", "guardrails.json");
  if (!fs.existsSync(policyPath)) return defaultGuardrailPolicy();

  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(policyPath, "utf8"));
  } catch (error) {
    throw new GuardrailPolicyError(`invalid JSON: ${errorMessage(error)}`, "policy");
  }
  return parseGuardrailPolicy(value);
}

export function writeGuardrailPolicy(repositoryPath: string, policy: GuardrailPolicy): void {
  const validated = parseGuardrailPolicy(policy);
  const preparedDirectory = preparePolicyDirectory(repositoryPath);
  const { directory } = preparedDirectory;
  const destination = path.join(directory, "guardrails.json");
  const temporary = path.join(directory, `guardrails.json.${randomUUID()}.tmp`);

  let descriptor: number | null = null;
  let temporaryIdentity: FileIdentity | null = null;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    temporaryIdentity = fileIdentity(fs.fstatSync(descriptor));
    assertSafePolicyDirectory(repositoryPath, directory, undefined, preparedDirectory.identity);
    assertTemporaryIdentity(temporary, temporaryIdentity);
    fs.writeFileSync(descriptor, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    assertSafePolicyDirectory(repositoryPath, directory, undefined, preparedDirectory.identity);
    assertTemporaryIdentity(temporary, temporaryIdentity);
    fs.renameSync(temporary, destination);
  } catch (error) {
    if (descriptor !== null) fs.closeSync(descriptor);
    if (temporaryIdentity !== null) safeUnlinkTemporary(temporary, temporaryIdentity);
    throw error;
  }
}

export function parseGuardrailPolicy(value: unknown): GuardrailPolicy {
  const policy = record(value, "policy");
  exactKeys(policy, policyKeys, "policy");
  if (policy.schemaVersion !== 1) fail("schemaVersion", "must equal 1");

  const protectedBranches = nonEmptyStringArray(policy.protectedBranches, "protectedBranches", true);
  const scope = record(policy.scope, "scope");
  exactKeys(scope, ["mode", "maxChangedPaths", "fallback"], "scope");
  if (scope.mode !== "changed" && scope.mode !== "repository") fail("scope.mode", "must be changed or repository");
  positiveInteger(scope.maxChangedPaths, "scope.maxChangedPaths");
  if (scope.fallback !== "repository" && scope.fallback !== "error") fail("scope.fallback", "must be repository or error");

  const scan = record(policy.scan, "scan");
  exactKeys(scan, ["model", "effort", "mode", "maxCostUsd"], "scan");
  const model = nonEmptyString(scan.model, "scan.model");
  const effort = nonEmptyString(scan.effort, "scan.effort");
  if (scan.mode !== "standard" && scan.mode !== "deep") fail("scan.mode", "must be standard or deep");
  positiveFinite(scan.maxCostUsd, "scan.maxCostUsd");

  if (!Array.isArray(policy.rules) || policy.rules.length === 0) fail("rules", "must be a non-empty array");
  const rules = policy.rules.map((value, index) => {
    const rulePath = `rules[${index}]`;
    const rule = record(value, rulePath);
    exactKeys(rule, ["severity", "lifecycle", "decision"], rulePath);
    const severity = enumArray<Severity>(rule.severity, severityValues, `${rulePath}.severity`);
    const lifecycle = enumArray<GateFindingLifecycle>(rule.lifecycle, lifecycleValues, `${rulePath}.lifecycle`);
    const decision = enumValue<GateRuleDecision>(rule.decision, decisionValues, `${rulePath}.decision`);
    return { severity, lifecycle, decision };
  });

  return {
    schemaVersion: 1,
    protectedBranches,
    scope: {
      mode: scope.mode,
      maxChangedPaths: scope.maxChangedPaths,
      fallback: scope.fallback,
    },
    scan: {
      model,
      effort,
      mode: scan.mode,
      maxCostUsd: scan.maxCostUsd,
    },
    rules,
  };
}

function record(value: unknown, fieldPath: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(fieldPath, "must be an object");
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], fieldPath: string): void {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected !== undefined) fail(`${fieldPath}.${unexpected}`, "is not allowed");
  const missing = allowed.find((key) => !(key in value));
  if (missing !== undefined) fail(fieldPath === "policy" ? missing : `${fieldPath}.${missing}`, "is required");
}

function nonEmptyString(value: unknown, fieldPath: string): string {
  if (typeof value !== "string" || value.trim().length === 0) fail(fieldPath, "must be a non-empty string");
  return value;
}

function nonEmptyStringArray(value: unknown, fieldPath: string, requireEntry = false): string[] {
  if (!Array.isArray(value) || (requireEntry && value.length === 0)) fail(fieldPath, "must be a non-empty array");
  return value.map((entry, index) => nonEmptyString(entry, `${fieldPath}[${index}]`));
}

function enumArray<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fieldPath: string,
): T[] {
  if (!Array.isArray(value) || value.length === 0) fail(fieldPath, "must be a non-empty array");
  return value.map((entry, index) => enumValue(entry, allowed, `${fieldPath}[${index}]`));
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], fieldPath: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    fail(fieldPath, `must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

function positiveInteger(value: unknown, fieldPath: string): asserts value is number {
  if (!Number.isInteger(value) || (value as number) <= 0) fail(fieldPath, "must be a positive integer");
}

function positiveFinite(value: unknown, fieldPath: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) fail(fieldPath, "must be finite and positive");
}

interface FileIdentity {
  dev: number;
  ino: number;
}

interface PreparedPolicyDirectory {
  directory: string;
  identity: FileIdentity;
}

function preparePolicyDirectory(repositoryPath: string): PreparedPolicyDirectory {
  let repositoryRealPath: string;
  try {
    repositoryRealPath = fs.realpathSync(repositoryPath);
  } catch (error) {
    fail("policyPath", `repository cannot be resolved: ${errorMessage(error)}`);
  }

  const directory = path.join(repositoryPath, ".csb");
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if (!isNodeError(error, "EEXIST")) {
      fail("policyPath", `configuration directory cannot be created: ${errorMessage(error)}`);
    }
  }
  const identity = assertSafePolicyDirectory(repositoryPath, directory, repositoryRealPath);
  return { directory, identity };
}

function assertSafePolicyDirectory(
  repositoryPath: string,
  directory: string,
  knownRepositoryRealPath?: string,
  expectedIdentity?: FileIdentity,
): FileIdentity {
  try {
    const metadata = fs.lstatSync(directory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      fail("policyPath", ".csb must be a real directory inside the repository");
    }
    const repositoryRealPath = knownRepositoryRealPath ?? fs.realpathSync(repositoryPath);
    const directoryRealPath = fs.realpathSync(directory);
    if (directoryRealPath !== path.join(repositoryRealPath, ".csb")) {
      fail("policyPath", ".csb resolves outside the repository");
    }
    if (expectedIdentity !== undefined && !sameIdentity(metadata, expectedIdentity)) {
      fail("policyPath", ".csb was replaced during policy publication");
    }
    return fileIdentity(metadata);
  } catch (error) {
    if (error instanceof GuardrailPolicyError) throw error;
    fail("policyPath", `configuration directory cannot be validated: ${errorMessage(error)}`);
  }
}

function assertTemporaryIdentity(temporary: string, expected: FileIdentity): void {
  let metadata: fs.Stats;
  try {
    metadata = fs.lstatSync(temporary);
  } catch (error) {
    fail("policyPath", `temporary policy cannot be validated: ${errorMessage(error)}`);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || !sameIdentity(metadata, expected)) {
    fail("policyPath", "temporary policy was replaced before publication");
  }
}

function safeUnlinkTemporary(temporary: string, expected: FileIdentity): void {
  try {
    const metadata = fs.lstatSync(temporary);
    if (metadata.isFile() && !metadata.isSymbolicLink() && sameIdentity(metadata, expected)) {
      fs.unlinkSync(temporary);
    }
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
}

function fileIdentity(metadata: fs.Stats): FileIdentity {
  return { dev: metadata.dev, ino: metadata.ino };
}

function sameIdentity(metadata: fs.Stats, expected: FileIdentity): boolean {
  return metadata.dev === expected.dev && metadata.ino === expected.ino;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function fail(fieldPath: string, message: string): never {
  throw new GuardrailPolicyError(message, fieldPath);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
