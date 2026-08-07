import fs from "node:fs";
import path from "node:path";

import type { GuardrailException } from "@csb/shared";

const documentKeys = ["schemaVersion", "exceptions"] as const;
const exceptionKeys = [
  "findingIdentity",
  "reason",
  "owner",
  "createdAt",
  "expiresAt",
  "branches",
  "ruleIndexes",
] as const;
const isoTimestamp = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export class GuardrailExceptionsError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(`${path}: ${message}`);
    this.name = "GuardrailExceptionsError";
  }
}

export function readGuardrailExceptions(repositoryPath: string): GuardrailException[] {
  const exceptionsPath = path.join(repositoryPath, ".csb", "guardrails-exceptions.json");
  if (!fs.existsSync(exceptionsPath)) return [];

  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(exceptionsPath, "utf8"));
  } catch (error) {
    throw new GuardrailExceptionsError(`invalid JSON: ${errorMessage(error)}`, "exceptions");
  }
  return parseGuardrailExceptions(value);
}

export function parseGuardrailExceptions(value: unknown): GuardrailException[] {
  const document = record(value, "exceptions");
  exactKeys(document, documentKeys, "document", new Set());
  if (document.schemaVersion !== 1) fail("schemaVersion", "must equal 1");
  if (!Array.isArray(document.exceptions)) fail("exceptions", "must be an array");

  return document.exceptions.map((value, index) => {
    const entryPath = `exceptions[${index}]`;
    const entry = record(value, entryPath);
    exactKeys(entry, exceptionKeys, entryPath, new Set(["branches", "ruleIndexes"]));

    const findingIdentity = nonEmptyString(entry.findingIdentity, `${entryPath}.findingIdentity`);
    const reason = nonEmptyString(entry.reason, `${entryPath}.reason`);
    const owner = nonEmptyString(entry.owner, `${entryPath}.owner`);
    const createdAt = timestamp(entry.createdAt, `${entryPath}.createdAt`);
    const expiresAt = timestamp(entry.expiresAt, `${entryPath}.expiresAt`);
    const branches = entry.branches === undefined
      ? []
      : stringArray(entry.branches, `${entryPath}.branches`);
    const ruleIndexes = entry.ruleIndexes === undefined
      ? []
      : indexArray(entry.ruleIndexes, `${entryPath}.ruleIndexes`);
    if (branches.length === 0 && ruleIndexes.length === 0) {
      fail(`${entryPath}.targets`, "at least one branch or rule index is required");
    }

    return {
      findingIdentity,
      reason,
      owner,
      createdAt,
      expiresAt,
      branches,
      ruleIndexes,
    };
  });
}

function record(value: unknown, fieldPath: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(fieldPath, "must be an object");
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  fieldPath: string,
  optional: ReadonlySet<string>,
): void {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected !== undefined) {
    fail(fieldPath === "document" ? unexpected : `${fieldPath}.${unexpected}`, "is not allowed");
  }
  const missing = allowed.find((key) => !optional.has(key) && !(key in value));
  if (missing !== undefined) {
    fail(fieldPath === "document" ? missing : `${fieldPath}.${missing}`, "is required");
  }
}

function nonEmptyString(value: unknown, fieldPath: string): string {
  if (typeof value !== "string" || value.trim().length === 0) fail(fieldPath, "must be a non-empty string");
  return value;
}

function timestamp(value: unknown, fieldPath: string): string {
  const candidate = nonEmptyString(value, fieldPath);
  const match = isoTimestamp.exec(candidate);
  if (match === null) fail(fieldPath, "must be a valid ISO timestamp");

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (
    month < 1
    || month > 12
    || day < 1
    || day > daysInMonth(year, month)
    || hour > 23
    || minute > 59
    || second > 59
  ) {
    fail(fieldPath, "must be a valid ISO timestamp");
  }

  const instant = Date.parse(candidate);
  if (!Number.isFinite(instant)) fail(fieldPath, "must be a valid ISO timestamp");
  return new Date(instant).toISOString();
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leapYear ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function stringArray(value: unknown, fieldPath: string): string[] {
  if (!Array.isArray(value)) fail(fieldPath, "must be an array");
  return value.map((entry, index) => nonEmptyString(entry, `${fieldPath}[${index}]`));
}

function indexArray(value: unknown, fieldPath: string): number[] {
  if (!Array.isArray(value)) fail(fieldPath, "must be an array");
  return value.map((entry, index) => {
    if (!Number.isInteger(entry) || (entry as number) < 0) fail(`${fieldPath}[${index}]`, "must be a non-negative integer");
    return entry as number;
  });
}

function fail(fieldPath: string, message: string): never {
  throw new GuardrailExceptionsError(message, fieldPath);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
