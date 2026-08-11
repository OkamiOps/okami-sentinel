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
  try {
    const metadata = fs.lstatSync(target);
    if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
      return null;
    }
    const parsed: unknown = JSON.parse(fs.readFileSync(target, "utf8"));
    if (!isPricingFile(parsed)) return null;
    return parsed.pricing;
  } catch {
    return null;
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
  if (!isRecord(value) || value.schemaVersion !== 1 || !("pricing" in value)) return false;
  return value.pricing === null || isFrozenCatalogPricing(value.pricing);
}

function isFrozenCatalogPricing(value: unknown): value is FrozenCatalogPricing {
  if (!isRecord(value) || value.currency !== "USD") return false;
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
