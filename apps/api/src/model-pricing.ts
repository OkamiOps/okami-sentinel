import fs from "node:fs";
import path from "node:path";

import type { ModelPricing, ProviderProtocol, ScanCost, ScanRun } from "@csb/shared";

import type { ScannerUsage } from "./scanners/usage.js";

export interface FrozenCatalogPricing {
  currency: "USD";
  capturedAt: string;
  modelId: string;
  inputUsdPerMillionTokens: number | null;
  cachedInputUsdPerMillionTokens: number | null;
  cacheWriteInputUsdPerMillionTokens: number | null;
  outputUsdPerMillionTokens: number | null;
}

interface PortableCodexSecurityPricingFile {
  schemaVersion: 1;
  pricing: FrozenCatalogPricing | null;
}

export interface FrozenScannerPricing extends FrozenCatalogPricing {
  connectionId: string;
  providerKind: string;
  routeKind: string;
  protocol: ProviderProtocol;
  pricingSource: "provider-catalog" | "official-rate-card";
  pricingBasis: "metered" | "payg-equivalent";
  billingMode: "metered" | "subscription" | "credits" | "unknown";
  pricingRateCardId: string | null;
  rateCardUpdatedAt: string | null;
  /** Base-tier aggregate is safe only while every possible request remains below this bound. */
  maximumInputTokensInclusive: number | null;
}

interface ScannerPricingFile {
  schemaVersion: 1;
  pricing: FrozenScannerPricing | null;
}

const MAX_PRICING_FILE_BYTES = 64 * 1024;
const NO_FOLLOW = typeof fs.constants.O_NOFOLLOW === "number"
  ? fs.constants.O_NOFOLLOW
  : 0;
const READ_NO_FOLLOW = fs.constants.O_RDONLY | NO_FOLLOW;

export function portableCodexSecurityPricingPath(scanDir: string): string {
  return path.join(scanDir, "portable-codex-security-pricing.json");
}

export function scannerPricingQuotePath(scanDir: string): string {
  return path.join(scanDir, "scanner-pricing.json");
}

export function writeScannerPricingQuote(
  scanDir: string,
  pricing: FrozenScannerPricing | null,
): void {
  const payload: ScannerPricingFile = {
    schemaVersion: 1,
    pricing: pricing !== null && isFrozenScannerPricing(pricing) ? pricing : null,
  };
  fs.mkdirSync(scanDir, { recursive: true, mode: 0o700 });
  const target = scannerPricingQuotePath(scanDir);
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, target);
  fs.chmodSync(target, 0o600);
}

export function readScannerPricingQuote(scanDir: string): FrozenScannerPricing | null {
  const target = scannerPricingQuotePath(scanDir);
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
    if (!isScannerPricingFile(parsed)) return null;
    return parsed.pricing;
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
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
    !nullableRate(pricing.cacheWriteInputUsdPerMillionTokens) ||
    !nullableRate(pricing.outputUsdPerMillionTokens)
  ) return null;
  return {
    currency: "USD",
    capturedAt,
    modelId,
    inputUsdPerMillionTokens: pricing.inputUsdPerMillionTokens,
    cachedInputUsdPerMillionTokens: pricing.cachedInputUsdPerMillionTokens,
    cacheWriteInputUsdPerMillionTokens: pricing.cacheWriteInputUsdPerMillionTokens,
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
  return estimateFrozenUsageCost(usage, pricing, {
    pricingSource: "provider-catalog",
    // Legacy sidecars predate billing provenance. Treat their USD only as a
    // comparable PAYG estimate, never proof of marginal metered billing.
    pricingBasis: "payg-equivalent",
    billingMode: "unknown",
    pricingRateCardId: null,
    rateCardUpdatedAt: pricing?.capturedAt ?? null,
    maximumInputTokensInclusive: null,
  });
}

export function estimateFrozenScannerUsageCost(
  usage: ScannerUsage,
  pricing: FrozenScannerPricing | null,
): ScanCost | null {
  if (pricing === null) return null;
  return estimateFrozenUsageCost(usage, pricing, pricing);
}

/** A quote is usable only by the exact server-resolved connection tuple that created it. */
export function scannerPricingQuoteMatchesRun(
  pricing: FrozenScannerPricing,
  run: Pick<ScanRun, "connection" | "model" | "provider">,
): boolean {
  return run.connection !== null && run.connection !== undefined &&
    pricing.connectionId === run.connection.connectionId &&
    pricing.routeKind === run.connection.routeKind &&
    pricing.protocol === run.connection.protocol &&
    pricing.modelId === run.model &&
    pricing.providerKind === run.provider;
}

function estimateFrozenUsageCost(
  usage: ScannerUsage,
  pricing: FrozenCatalogPricing | null,
  provenance: Pick<
    FrozenScannerPricing,
    | "pricingSource"
    | "pricingBasis"
    | "billingMode"
    | "pricingRateCardId"
    | "rateCardUpdatedAt"
    | "maximumInputTokensInclusive"
  >,
): ScanCost | null {
  if (
    pricing === null ||
    usage.reported !== true ||
    usage.inputTokensKnown !== true ||
    usage.outputTokensKnown !== true
  ) return null;

  if (
    provenance.maximumInputTokensInclusive !== null &&
    (usage.maximumInputTokensPerRequest ?? usage.inputTokens) >
      provenance.maximumInputTokensInclusive
  ) return null;

  const cacheWriteInputTokens = usage.cacheWriteInputTokens ?? 0;
  if (usage.cachedInputTokens + cacheWriteInputTokens > usage.inputTokens) return null;
  const cacheCoverageComplete = usage.cachedInputTokensKnown === true &&
    usage.cacheWriteInputTokensKnown === true;
  if (!cacheCoverageComplete) {
    const inputRate = pricing.inputUsdPerMillionTokens;
    const cachedRate = pricing.cachedInputUsdPerMillionTokens;
    const cacheWriteRate = pricing.cacheWriteInputUsdPerMillionTokens;
    const outputRate = pricing.outputUsdPerMillionTokens;
    if (
      provenance.pricingSource !== "official-rate-card" ||
      inputRate === null ||
      cachedRate === null ||
      cacheWriteRate === null ||
      outputRate === null ||
      inputRate < cachedRate ||
      inputRate < cacheWriteRate
    ) return null;
    const inputUsd = tokenCost(usage.inputTokens, inputRate);
    const outputUsd = tokenCost(usage.outputTokens, outputRate);
    const cost = baseScanCost(
      usage,
      pricing,
      provenance,
      cacheWriteInputTokens,
      inputUsd,
      outputUsd,
    );
    cost.estimateKind = "upper-bound";
    return cost;
  }

  const uncachedInputTokens = usage.inputTokens - usage.cachedInputTokens - cacheWriteInputTokens;
  if (uncachedInputTokens < 0) return null;

  if (
    (uncachedInputTokens > 0 && pricing.inputUsdPerMillionTokens === null) ||
    (usage.cachedInputTokens > 0 && pricing.cachedInputUsdPerMillionTokens === null) ||
    (cacheWriteInputTokens > 0 && pricing.cacheWriteInputUsdPerMillionTokens === null) ||
    (usage.outputTokens > 0 && pricing.outputUsdPerMillionTokens === null)
  ) return null;

  const inputUsd = tokenCost(uncachedInputTokens, pricing.inputUsdPerMillionTokens ?? 0);
  const outputUsd = tokenCost(usage.outputTokens, pricing.outputUsdPerMillionTokens ?? 0);
  const cachedInputUsd = pricing.cachedInputUsdPerMillionTokens !== null
    ? tokenCost(usage.cachedInputTokens, pricing.cachedInputUsdPerMillionTokens)
    : null;
  const cacheWriteInputUsd = pricing.cacheWriteInputUsdPerMillionTokens !== null
    ? tokenCost(cacheWriteInputTokens, pricing.cacheWriteInputUsdPerMillionTokens)
    : null;
  const cost = baseScanCost(
    usage,
    pricing,
    provenance,
    cacheWriteInputTokens,
    inputUsd,
    outputUsd,
    (cachedInputUsd ?? 0) + (cacheWriteInputUsd ?? 0),
  );
  if (cachedInputUsd !== null) cost.cachedInputUsd = cachedInputUsd;
  if (cacheWriteInputUsd !== null) cost.cacheWriteInputUsd = cacheWriteInputUsd;
  return cost;
}

function baseScanCost(
  usage: ScannerUsage,
  pricing: FrozenCatalogPricing,
  provenance: Pick<
    FrozenScannerPricing,
    | "pricingSource"
    | "pricingBasis"
    | "billingMode"
    | "pricingRateCardId"
    | "rateCardUpdatedAt"
    | "maximumInputTokensInclusive"
  >,
  cacheWriteInputTokens: number,
  inputUsd: number,
  outputUsd: number,
  cacheUsd = 0,
): ScanCost {
  const cost: ScanCost = {
    estimatedUsd: inputUsd + outputUsd + cacheUsd,
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    cacheWriteInputTokens,
    outputTokens: usage.outputTokens,
    model: pricing.modelId,
    pricingSource: provenance.pricingSource,
    pricingBasis: provenance.pricingBasis,
    billingMode: provenance.billingMode,
    pricingSnapshot: {
      currency: "USD",
      capturedAt: pricing.capturedAt,
      inputUsdPerMillionTokens: pricing.inputUsdPerMillionTokens,
      cachedInputUsdPerMillionTokens: pricing.cachedInputUsdPerMillionTokens,
      cacheWriteInputUsdPerMillionTokens: pricing.cacheWriteInputUsdPerMillionTokens,
      outputUsdPerMillionTokens: pricing.outputUsdPerMillionTokens,
    },
    pricingModel: pricing.modelId,
    pricingUpdatedAt: provenance.rateCardUpdatedAt ?? pricing.capturedAt,
    pricingTiming: "launch",
    inputUsd,
    outputUsd,
  };
  if (provenance.pricingRateCardId !== null) {
    cost.pricingRateCardId = provenance.pricingRateCardId;
  }
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

function isScannerPricingFile(value: unknown): value is ScannerPricingFile {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["schemaVersion", "pricing"]) ||
    value.schemaVersion !== 1 ||
    !("pricing" in value)
  ) return false;
  return value.pricing === null || isFrozenScannerPricing(value.pricing);
}

function isFrozenScannerPricing(value: unknown): value is FrozenScannerPricing {
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
      "connectionId",
      "providerKind",
      "routeKind",
      "protocol",
      "pricingSource",
      "pricingBasis",
      "billingMode",
      "pricingRateCardId",
      "rateCardUpdatedAt",
      "maximumInputTokensInclusive",
    ]) ||
    value.currency !== "USD" ||
    !validTimestamp(value.capturedAt) ||
    !safeModelId(value.modelId) ||
    !nullableRate(value.inputUsdPerMillionTokens) ||
    !nullableRate(value.cachedInputUsdPerMillionTokens) ||
    !nullableRate(value.cacheWriteInputUsdPerMillionTokens) ||
    !nullableRate(value.outputUsdPerMillionTokens) ||
    !safeIdentifier(value.connectionId) ||
    !safeIdentifier(value.providerKind) ||
    !safeIdentifier(value.routeKind) ||
    !safeIdentifier(value.protocol) ||
    (value.pricingSource !== "provider-catalog" && value.pricingSource !== "official-rate-card") ||
    (value.pricingBasis !== "metered" && value.pricingBasis !== "payg-equivalent") ||
    !["metered", "subscription", "credits", "unknown"].includes(String(value.billingMode)) ||
    !(value.pricingRateCardId === null || safeIdentifier(value.pricingRateCardId)) ||
    !(value.rateCardUpdatedAt === null || validTimestamp(value.rateCardUpdatedAt)) ||
    !(value.maximumInputTokensInclusive === null ||
      (Number.isSafeInteger(value.maximumInputTokensInclusive) &&
        Number(value.maximumInputTokensInclusive) > 0))
  ) return false;
  return true;
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
    nullableRate(value.cacheWriteInputUsdPerMillionTokens) &&
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

function safeIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/.test(value);
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
