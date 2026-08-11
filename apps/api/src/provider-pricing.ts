import type { ModelPricing, ProviderProtocol, ScanCost } from "@csb/shared";

import {
  estimateFrozenScannerUsageCost,
  freezeCatalogPricing,
  type FrozenScannerPricing,
} from "./model-pricing.js";
import type { ScannerUsage } from "./scanners/usage.js";

export interface ResolveScannerPricingQuoteInput {
  connectionId: string;
  providerKind: string;
  routeKind: string;
  protocol: ProviderProtocol;
  modelId: string;
  modelPricing: ModelPricing | null;
  capturedAt: string;
}

export interface ResolveHistoricalOfficialCostInput extends ResolveScannerPricingQuoteInput {
  usage: ScannerUsage;
}

const GROK_45_MODEL_IDS = new Set([
  "grok-4.5",
  "grok-4.5-latest",
  "grok-build-latest",
]);

const XAI_GROK_45_RATES: ModelPricing = {
  inputUsdPerMillionTokens: 2,
  cachedInputUsdPerMillionTokens: 0.3,
  cacheWriteInputUsdPerMillionTokens: null,
  outputUsdPerMillionTokens: 6,
};

const MINIMAX_M3_PAYG_RATES: ModelPricing = {
  inputUsdPerMillionTokens: 0.3,
  cachedInputUsdPerMillionTokens: 0.06,
  cacheWriteInputUsdPerMillionTokens: null,
  outputUsdPerMillionTokens: 1.2,
};

/**
 * Resolves only exact, auditable prices. Arbitrary compatible endpoints remain
 * unpriced unless their normalized provider catalog supplied ModelPricing.
 */
export function resolveScannerPricingQuote(
  input: ResolveScannerPricingQuoteInput,
): FrozenScannerPricing | null {
  if (isExactXaiGrok45(input)) {
    return freezeQuote(input, XAI_GROK_45_RATES, {
      pricingSource: "official-rate-card",
      pricingBasis: input.routeKind === "xai-api" ? "metered" : "payg-equivalent",
      billingMode: input.routeKind === "xai-api" ? "metered" : "subscription",
      pricingRateCardId: "xai.grok-4.5.2026-07-03",
      rateCardUpdatedAt: "2026-07-03T00:00:00.000Z",
      // The published long-context tier applies only when a request exceeds 200k.
      maximumInputTokensInclusive: 200_000,
    });
  }

  if (isExactMiniMaxM3TokenPlan(input)) {
    return freezeQuote(input, MINIMAX_M3_PAYG_RATES, {
      pricingSource: "official-rate-card",
      pricingBasis: "payg-equivalent",
      billingMode: "subscription",
      pricingRateCardId: "minimax.m3.payg.2026-08-11",
      rateCardUpdatedAt: "2026-08-11T17:03:00.000Z",
      // The higher PAYG tier applies only above 512k input tokens per request.
      maximumInputTokensInclusive: 512_000,
    });
  }

  if (input.modelPricing === null) return null;
  const trustedOpenRouterMetering = input.providerKind === "openrouter" &&
    input.routeKind === "openrouter-api" && input.protocol === "openai-chat";
  const declaredBilling = validDeclaredBilling(input.modelPricing)
    ? {
      pricingBasis: input.modelPricing.pricingBasis!,
      billingMode: input.modelPricing.billingMode!,
    }
    : null;
  return freezeQuote(input, input.modelPricing, {
    pricingSource: "provider-catalog",
    pricingBasis: trustedOpenRouterMetering
      ? "metered"
      : declaredBilling?.pricingBasis ?? "payg-equivalent",
    billingMode: trustedOpenRouterMetering
      ? "metered"
      : declaredBilling?.billingMode ?? "unknown",
    pricingRateCardId: null,
    rateCardUpdatedAt: input.capturedAt,
    maximumInputTokensInclusive: null,
  });
}

function validDeclaredBilling(pricing: ModelPricing): boolean {
  if (pricing.pricingBasis === undefined && pricing.billingMode === undefined) return false;
  if (pricing.pricingBasis === "metered") return pricing.billingMode === "metered";
  return pricing.pricingBasis === "payg-equivalent" &&
    (pricing.billingMode === "subscription" || pricing.billingMode === "credits" ||
      pricing.billingMode === "unknown");
}

/** Explicit operator-audited repair for a historical run; never used as a fuzzy migration. */
export function resolveHistoricalOfficialCost(
  input: ResolveHistoricalOfficialCostInput,
): ScanCost | null {
  const quote = resolveScannerPricingQuote(input);
  if (quote?.pricingSource !== "official-rate-card") return null;
  const cost = estimateFrozenScannerUsageCost(input.usage, quote);
  return cost === null ? null : { ...cost, pricingTiming: "post-hoc" };
}

function freezeQuote(
  input: ResolveScannerPricingQuoteInput,
  pricing: ModelPricing,
  provenance: Pick<
    FrozenScannerPricing,
    | "pricingSource"
    | "pricingBasis"
    | "billingMode"
    | "pricingRateCardId"
    | "rateCardUpdatedAt"
    | "maximumInputTokensInclusive"
  >,
): FrozenScannerPricing | null {
  const frozen = freezeCatalogPricing(pricing, input.capturedAt, input.modelId);
  if (frozen === null || !safeIdentifier(input.connectionId) ||
    !safeIdentifier(input.providerKind) || !safeIdentifier(input.routeKind) ||
    !safeIdentifier(input.protocol)) return null;
  return {
    ...frozen,
    connectionId: input.connectionId,
    providerKind: input.providerKind,
    routeKind: input.routeKind,
    protocol: input.protocol,
    ...provenance,
  };
}

function isExactXaiGrok45(input: ResolveScannerPricingQuoteInput): boolean {
  const apiTuple = input.routeKind === "xai-api" && input.protocol === "openai-responses";
  const oauthTuple = input.routeKind === "xai-oauth" &&
    input.protocol === "xai-oauth-responses";
  return input.providerKind === "xai" && (apiTuple || oauthTuple) &&
    GROK_45_MODEL_IDS.has(input.modelId);
}

function isExactMiniMaxM3TokenPlan(input: ResolveScannerPricingQuoteInput): boolean {
  return input.providerKind === "minimax" &&
    input.routeKind === "minimax-token-plan" &&
    input.protocol === "anthropic-messages" &&
    input.modelId === "MiniMax-M3";
}

function safeIdentifier(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/.test(value);
}
