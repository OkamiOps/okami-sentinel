import type { ModelPricing, ProviderProtocol, ScanCost, ScanRun } from "@csb/shared";

import {
  estimateFrozenScannerUsageCost,
  freezeCatalogPricing,
  scannerPricingQuoteMatchesRun,
  type FrozenScannerPricing,
} from "./model-pricing.js";
import { resolveOpenRouterLaunchPricing } from "./openrouter-pricing.js";
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
  // MiniMax M3 passive prompt caching has no additional cache-write charge.
  cacheWriteInputUsdPerMillionTokens: 0,
  outputUsdPerMillionTokens: 1.2,
};

const MIMO_V25_PRO_PAYG_RATES: ModelPricing = {
  inputUsdPerMillionTokens: 0.435,
  cachedInputUsdPerMillionTokens: 0.0036,
  // Xiaomi's published rate card currently lists cache writes as free.
  cacheWriteInputUsdPerMillionTokens: 0,
  outputUsdPerMillionTokens: 0.87,
};

/**
 * Resolves frozen auditable prices. Compatible endpoints may also use an
 * exact or unambiguous OpenRouter catalog match; ambiguous aliases fail closed.
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

  if (isExactMimoV25ProTokenPlan(input)) {
    return freezeQuote(input, MIMO_V25_PRO_PAYG_RATES, {
      pricingSource: "official-rate-card",
      pricingBasis: "payg-equivalent",
      billingMode: "subscription",
      pricingRateCardId: "xiaomi.mimo-v2.5-pro.payg.2026-08-06",
      rateCardUpdatedAt: "2026-08-06T00:00:00.000Z",
      maximumInputTokensInclusive: null,
    });
  }

  if (input.modelPricing === null) {
    const openRouter = resolveOpenRouterLaunchPricing({
      providerKind: input.providerKind,
      routeKind: input.routeKind,
      modelId: input.modelId,
    });
    if (openRouter === null) return null;
    const directOpenRouter = input.providerKind === "openrouter" &&
      input.routeKind === "openrouter-api" && input.protocol === "openai-chat";
    return freezeQuote(input, openRouter.pricing, {
      pricingSource: "openrouter",
      pricingBasis: directOpenRouter ? "metered" : "payg-equivalent",
      billingMode: directOpenRouter ? "metered" : "unknown",
      pricingRateCardId: `openrouter/${openRouter.modelId}`,
      rateCardUpdatedAt: openRouter.pricingUpdatedAt,
      maximumInputTokensInclusive: null,
      pricingModelId: openRouter.modelId,
      pricingMatch: openRouter.pricingMatch,
      ...(openRouter.pricingAliasId === undefined
        ? {}
        : { pricingAliasId: openRouter.pricingAliasId }),
    });
  }
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

/**
 * Applies the same frozen-quote and exact official-rate-card rules to every
 * provider-backed scanner engine. A mismatched frozen quote always blocks
 * fallback instead of borrowing a price from another connection.
 */
export function resolveReconciledScannerCost(input: {
  run: Pick<
    ScanRun,
    "connection" | "model" | "provider" | "startedAt"
  >;
  usage: ScannerUsage;
  pricing: FrozenScannerPricing | null;
}): ScanCost | null {
  if (input.pricing !== null) {
    return scannerPricingQuoteMatchesRun(input.pricing, input.run)
      ? estimateFrozenScannerUsageCost(input.usage, input.pricing)
      : null;
  }
  const { connection, model, provider, startedAt } = input.run;
  if (connection === null || connection === undefined || model === null || provider === null) {
    return null;
  }
  return resolveHistoricalOfficialCost({
    connectionId: connection.connectionId,
    providerKind: provider,
    routeKind: connection.routeKind,
    protocol: connection.protocol,
    modelId: model,
    modelPricing: null,
    capturedAt: startedAt ?? new Date(0).toISOString(),
    usage: input.usage,
  });
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
    | "pricingModelId"
    | "pricingMatch"
    | "pricingAliasId"
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

function isExactMimoV25ProTokenPlan(input: ResolveScannerPricingQuoteInput): boolean {
  return input.providerKind === "xiaomi" &&
    input.routeKind === "mimo-token-plan" &&
    input.protocol === "openai-chat" &&
    input.modelId === "mimo-v2.5-pro";
}

function safeIdentifier(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/.test(value);
}
