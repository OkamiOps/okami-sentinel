import fs from "node:fs";
import path from "node:path";

import type { ModelPricing, ScanCost } from "@csb/shared";

import type { ScannerUsage } from "./scanners/usage.js";

export interface FrozenCatalogPricing {
  currency: "USD";
  capturedAt: string;
  modelId: string;
  inputUsdPerMillionTokens: number | null;
  cachedInputUsdPerMillionTokens: number | null;
  cacheWriteInputUsdPerMillionTokens: null;
  outputUsdPerMillionTokens: number | null;
}

interface PortableCodexSecurityPricingFile {
  schemaVersion: 1;
  pricing: FrozenCatalogPricing | null;
}

const MAX_PRICING_FILE_BYTES = 64 * 1024;
const NO_FOLLOW = typeof fs.constants.O_NOFOLLOW === "number"
  ? fs.constants.O_NOFOLLOW
  : 0;
const READ_NO_FOLLOW = fs.constants.O_RDONLY | NO_FOLLOW;

export function portableCodexSecurityPricingPath(scanDir: string): string {
  return path.join(scanDir, "portable-codex-security-pricing.json");
}

/** Copies catalog rates before worker dispatch; reconciliation never rereads a live catalog. */
export function freezeCatalogPricing(
  pricing: ModelPricing | null,
  capturedAt: string,
  modelId: string,
): FrozenCatalogPricing | null {
  if (pricing === null || !validTimestamp(capturedAt) || !safeModelId(modelId)) return null;
  if (
    !nullableRate(pricing.inputUsdPerMillionTokens) ||
    !nullableRate(pricing.cachedInputUsdPerMillionTokens) ||
    !nullableRate(pricing.outputUsdPerMillionTokens)
  ) return null;
  return {
    currency: "USD",
    capturedAt,
    modelId,
    inputUsdPerMillionTokens: pricing.inputUsdPerMillionTokens,
    cachedInputUsdPerMillionTokens: pricing.cachedInputUsdPerMillionTokens,
    cacheWriteInputUsdPerMillionTokens: null,
    outputUsdPerMillionTokens: pricing.outputUsdPerMillionTokens,
  };
}

export function writePortableCodexSecurityPricing(
  scanDir: string,
  pricing: ModelPricing | null,
  capturedAt: string,
  modelId: string,
): void {
  const payload: PortableCodexSecurityPricingFile = {
    schemaVersion: 1,
    pricing: freezeCatalogPricing(pricing, capturedAt, modelId),
  };
  fs.mkdirSync(scanDir, { recursive: true, mode: 0o700 });
  const target = portableCodexSecurityPricingPath(scanDir);
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, target);
  fs.chmodSync(target, 0o600);
}

export function readPortableCodexSecurityPricing(
  scanDir: string,
): FrozenCatalogPricing | null {
  const target = portableCodexSecurityPricingPath(scanDir);
  let descriptor: number | undefined;
  try {
    const expected = fs.lstatSync(target);
    if (!validPricingFile(expected)) return null;
    descriptor = fs.openSync(target, READ_NO_FOLLOW);
    const opened = fs.fstatSync(descriptor);
    if (!validPricingFile(opened) || !sameVersion(expected, opened)) return null;
    const buffer = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < buffer.length) {
      const bytes = fs.readSync(descriptor, buffer, offset, buffer.length - offset, offset);
      if (bytes === 0) break;
      offset += bytes;
    }
    const afterOpen = fs.fstatSync(descriptor);
    const afterPath = fs.lstatSync(target);
    if (
      offset !== buffer.length ||
      !validPricingFile(afterPath) ||
      !sameVersion(opened, afterOpen) ||
      !sameVersion(opened, afterPath)
    ) return null;
    const parsed: unknown = JSON.parse(buffer.toString("utf8"));
    if (!isPricingFile(parsed)) return null;
    return parsed.pricing;
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function estimateCatalogUsageCost(
  usage: ScannerUsage,
  pricing: ModelPricing | null,
  capturedAt: string,
  modelId: string,
): ScanCost | null {
  return estimateFrozenCatalogUsageCost(usage, freezeCatalogPricing(pricing, capturedAt, modelId));
}

export function estimateFrozenCatalogUsageCost(
  usage: ScannerUsage,
  pricing: FrozenCatalogPricing | null,
): ScanCost | null {
  if (
    pricing === null ||
    usage.reported !== true ||
    usage.inputTokensKnown !== true ||
    usage.cachedInputTokensKnown !== true ||
    usage.cacheWriteInputTokensKnown !== true ||
    usage.outputTokensKnown !== true ||
    pricing.inputUsdPerMillionTokens === null ||
    pricing.outputUsdPerMillionTokens === null
  ) return null;

  if (
    (usage.cachedInputTokens > 0 && pricing.cachedInputUsdPerMillionTokens === null) ||
    ((usage.cacheWriteInputTokens ?? 0) > 0 &&
      pricing.cacheWriteInputUsdPerMillionTokens === null)
  ) return null;

  const inputUsd = tokenCost(usage.inputTokens, pricing.inputUsdPerMillionTokens);
  const outputUsd = tokenCost(usage.outputTokens, pricing.outputUsdPerMillionTokens);
  const cachedInputUsd = pricing.cachedInputUsdPerMillionTokens !== null
    ? tokenCost(usage.cachedInputTokens, pricing.cachedInputUsdPerMillionTokens)
    : null;
  const cost: ScanCost = {
    estimatedUsd: inputUsd + outputUsd + (cachedInputUsd ?? 0),
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    cacheWriteInputTokens: usage.cacheWriteInputTokens ?? 0,
    outputTokens: usage.outputTokens,
    model: pricing.modelId,
    pricingSource: "provider-catalog",
    pricingSnapshot: {
      currency: "USD",
      capturedAt: pricing.capturedAt,
      inputUsdPerMillionTokens: pricing.inputUsdPerMillionTokens,
      cachedInputUsdPerMillionTokens: pricing.cachedInputUsdPerMillionTokens,
      cacheWriteInputUsdPerMillionTokens: null,
      outputUsdPerMillionTokens: pricing.outputUsdPerMillionTokens,
    },
    pricingModel: pricing.modelId,
    pricingUpdatedAt: pricing.capturedAt,
    inputUsd,
    outputUsd,
  };
  if (cachedInputUsd !== null) cost.cachedInputUsd = cachedInputUsd;
  return cost;
}

function tokenCost(tokens: number, rate: number): number {
  return (tokens * rate) / 1_000_000;
}

function isPricingFile(value: unknown): value is PortableCodexSecurityPricingFile {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["schemaVersion", "pricing"]) ||
    value.schemaVersion !== 1 ||
    !("pricing" in value)
  ) return false;
  return value.pricing === null || isFrozenCatalogPricing(value.pricing);
}

function isFrozenCatalogPricing(value: unknown): value is FrozenCatalogPricing {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "currency",
      "capturedAt",
      "modelId",
      "inputUsdPerMillionTokens",
      "cachedInputUsdPerMillionTokens",
      "cacheWriteInputUsdPerMillionTokens",
      "outputUsdPerMillionTokens",
    ]) ||
    value.currency !== "USD"
  ) return false;
  return validTimestamp(value.capturedAt) &&
    safeModelId(value.modelId) &&
    nullableRate(value.inputUsdPerMillionTokens) &&
    nullableRate(value.cachedInputUsdPerMillionTokens) &&
    value.cacheWriteInputUsdPerMillionTokens === null &&
    nullableRate(value.outputUsdPerMillionTokens);
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function safeModelId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 512;
}

function nullableRate(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function validPricingFile(info: fs.Stats): boolean {
  return !info.isSymbolicLink() && info.isFile() &&
    (info.mode & 0o777) === 0o600 &&
    info.size > 0 && info.size <= MAX_PRICING_FILE_BYTES;
}

function sameVersion(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}
