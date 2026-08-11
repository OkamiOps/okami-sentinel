import type { ScanCost, ScanRun } from "@csb/shared";

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const PRICING_TTL_MS = 6 * 60 * 60 * 1000;
const FAILURE_RETRY_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 5_000;
const FALLBACK_UPDATED_AT = "2026-08-11T16:49:02.000Z";

export interface OpenRouterPricing {
  prompt: string;
  completion: string;
  input_cache_read?: string;
  input_cache_write?: string;
}

export interface OpenRouterModel {
  id: string;
  pricing: OpenRouterPricing;
}

export interface OpenRouterCostBreakdown {
  uncachedInputTokens: number;
  uncachedInputUsd: number;
  cachedInputUsd: number;
  cacheWriteInputUsd: number;
  inputUsd: number;
  outputUsd: number;
  totalUsd: number;
}

interface Usage {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
}

interface CatalogState {
  models: OpenRouterModel[];
  updatedAt: string;
  refreshedAtMs: number;
}

interface PricingResolution {
  model: OpenRouterModel;
  pricingMatch: "exact" | "catalog-unique" | "approved-alias";
  pricingAliasId?: string;
}

const approvedModelAliases = [
  {
    aliasId: "openai.spark-to-gpt-5.3-codex.v1",
    id: "openai/gpt-5.3-codex-spark",
    targetId: "openai/gpt-5.3-codex",
  },
] as const;

const fallbackModels: OpenRouterModel[] = [
  {
    id: "openai/gpt-5.6-sol",
    pricing: {
      prompt: "0.000005",
      completion: "0.00003",
      input_cache_read: "0.0000005",
      input_cache_write: "0.00000625",
    },
  },
  {
    id: "openai/gpt-5.6-terra",
    pricing: {
      prompt: "0.000001",
      completion: "0.000006",
      input_cache_read: "0.0000001",
      input_cache_write: "0.00000125",
    },
  },
  {
    id: "openai/gpt-5.3-codex",
    pricing: {
      prompt: "0.00000175",
      completion: "0.000014",
      input_cache_read: "0.000000175",
    },
  },
];

let catalog: CatalogState = {
  models: fallbackModels,
  updatedAt: FALLBACK_UPDATED_AT,
  refreshedAtMs: 0,
};
let refreshPromise: Promise<boolean> | null = null;
let lastAttemptAtMs = 0;

function usd(value: number): number {
  return Number(value.toFixed(12));
}

function rate(value: string | undefined, fallback?: number): number {
  const parsed = value == null ? Number.NaN : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : (fallback ?? 0);
}

export function calculateOpenRouterCost(
  usage: Usage,
  pricing: OpenRouterPricing,
): OpenRouterCostBreakdown | null {
  const inputTokens = Math.max(0, usage.inputTokens);
  const cachedInputTokens = Math.max(0, usage.cachedInputTokens);
  const cacheWriteInputTokens = Math.max(0, usage.cacheWriteInputTokens);
  if (cachedInputTokens + cacheWriteInputTokens > inputTokens) return null;
  const uncachedInputTokens = inputTokens - cachedInputTokens - cacheWriteInputTokens;
  const promptRate = rate(pricing.prompt);
  const cacheReadRate = rate(pricing.input_cache_read, promptRate);
  const cacheWriteRate = rate(pricing.input_cache_write, promptRate);
  const completionRate = rate(pricing.completion);
  const uncachedInputUsd = usd(uncachedInputTokens * promptRate);
  const cachedInputUsd = usd(cachedInputTokens * cacheReadRate);
  const cacheWriteInputUsd = usd(cacheWriteInputTokens * cacheWriteRate);
  const outputUsd = usd(Math.max(0, usage.outputTokens) * completionRate);
  const inputUsd = usd(uncachedInputUsd + cachedInputUsd + cacheWriteInputUsd);
  return {
    uncachedInputTokens,
    uncachedInputUsd,
    cachedInputUsd,
    cacheWriteInputUsd,
    inputUsd,
    outputUsd,
    totalUsd: usd(inputUsd + outputUsd),
  };
}

function openRouterProviderNamespace(provider: string | null): string {
  if (provider === "xai") return "x-ai";
  return provider ?? "openai";
}

function openRouterModelId(run: ScanRun): string | null {
  const model = run.cost?.model ?? run.model;
  if (!model) return null;
  const namespace = openRouterProviderNamespace(run.provider);
  if (model.includes("/")) {
    const declaredNamespace = model.slice(0, model.indexOf("/")).toLowerCase();
    const compatibleGateway = run.provider === "openrouter" ||
      run.connection?.routeKind.startsWith("custom-") === true;
    if (!compatibleGateway && declaredNamespace !== namespace.toLowerCase()) return null;
    return model;
  }
  return `${namespace}/${model}`;
}

function resolvePricing(
  modelId: string,
  models: OpenRouterModel[],
  allowCatalogUnique: boolean,
): PricingResolution | null {
  const normalizedModelId = modelId.toLowerCase();
  const exact = models.find((candidate) => candidate.id.toLowerCase() === normalizedModelId);
  if (exact) return { model: exact, pricingMatch: "exact" };

  const alias = approvedModelAliases.find((candidate) => candidate.id === modelId);
  if (alias) {
    const target = models.find((candidate) => candidate.id === alias.targetId);
    if (!target) return null;
    return {
      model: target,
      pricingMatch: "approved-alias",
      pricingAliasId: alias.aliasId,
    };
  }

  if (!allowCatalogUnique) return null;
  const modelSlug = normalizedModelId.slice(normalizedModelId.lastIndexOf("/") + 1);
  const uniqueMatches = models.filter((candidate) =>
    candidate.id.toLowerCase().endsWith(`/${modelSlug}`)
  );
  return uniqueMatches.length === 1
    ? { model: uniqueMatches[0]!, pricingMatch: "catalog-unique" }
    : null;
}

function pricingSnapshot(pricing: OpenRouterPricing, capturedAt: string): NonNullable<ScanCost["pricingSnapshot"]> {
  const promptRate = rate(pricing.prompt);
  return {
    currency: "USD",
    capturedAt,
    inputUsdPerMillionTokens: perMillion(promptRate),
    cachedInputUsdPerMillionTokens: perMillion(
      rate(pricing.input_cache_read, promptRate),
    ),
    cacheWriteInputUsdPerMillionTokens: perMillion(
      rate(pricing.input_cache_write, promptRate),
    ),
    outputUsdPerMillionTokens: perMillion(rate(pricing.completion)),
  };
}

function perMillion(perTokenRate: number): number {
  return usd(perTokenRate * 1_000_000);
}

export function estimateScanWithOpenRouterPricing(
  run: ScanRun,
  models: OpenRouterModel[],
  pricingUpdatedAt: string,
): ScanRun {
  if (run.cost?.pricingSource !== undefined || run.cost?.pricingSnapshot !== undefined) return run;
  const measured = measuredUsage(run);
  if (measured === null) return run;
  const reportedTokens = measured.usage.inputTokens + measured.usage.outputTokens;
  if (reportedTokens <= 0) return run;
  const modelId = openRouterModelId(run);
  const compatibleGateway = run.provider === "openrouter" || run.provider === "custom" ||
    run.connection?.routeKind.startsWith("custom-") === true;
  const resolution = modelId
    ? resolvePricing(modelId, models, compatibleGateway)
    : null;
  if (!resolution) return run;
  const estimate = calculateOpenRouterCost(measured.usage, resolution.model.pricing);
  if (estimate === null) return run;
  const directOpenRouter = run.provider === "openrouter" &&
    run.connection?.routeKind === "openrouter-api";
  const cost: ScanCost = {
    estimatedUsd: estimate.totalUsd,
    inputTokens: measured.usage.inputTokens,
    cachedInputTokens: measured.usage.cachedInputTokens,
    cacheWriteInputTokens: measured.usage.cacheWriteInputTokens,
    outputTokens: measured.usage.outputTokens,
    model: run.cost?.model ?? run.model ?? resolution.model.id,
    pricingSource: "openrouter",
    pricingBasis: directOpenRouter ? "metered" : "payg-equivalent",
    billingMode: directOpenRouter ? "metered" : "unknown",
    pricingMatch: resolution.pricingMatch,
    pricingSnapshot: pricingSnapshot(
      resolution.model.pricing,
      pricingUpdatedAt,
    ),
    pricingModel: resolution.model.id,
    pricingUpdatedAt,
    inputUsd: estimate.inputUsd,
    cachedInputUsd: estimate.cachedInputUsd,
    cacheWriteInputUsd: estimate.cacheWriteInputUsd,
    outputUsd: estimate.outputUsd,
    pricingTiming: "post-hoc",
  };
  if (!measured.cacheCoverageComplete) cost.estimateKind = "upper-bound";
  if (resolution.pricingAliasId !== undefined) cost.pricingAliasId = resolution.pricingAliasId;
  return { ...run, cost };
}

function measuredUsage(run: ScanRun): {
  usage: Usage;
  cacheCoverageComplete: boolean;
} | null {
  if (run.usage !== null && run.usage !== undefined) {
    if (run.usage.inputTokens === null || run.usage.outputTokens === null) return null;
    return {
      usage: {
        inputTokens: run.usage.inputTokens,
        cachedInputTokens: run.usage.cachedInputTokens ?? 0,
        cacheWriteInputTokens: run.usage.cacheWriteInputTokens ?? 0,
        outputTokens: run.usage.outputTokens,
      },
      cacheCoverageComplete: run.usage.cachedInputTokens !== null &&
        run.usage.cacheWriteInputTokens !== null,
    };
  }
  if (run.cost === null || run.cost === undefined) return null;
  return {
    usage: {
      inputTokens: run.cost.inputTokens,
      cachedInputTokens: run.cost.cachedInputTokens,
      cacheWriteInputTokens: run.cost.cacheWriteInputTokens,
      outputTokens: run.cost.outputTokens,
    },
    cacheCoverageComplete: true,
  };
}

export function withOpenRouterPricingEstimate(run: ScanRun): ScanRun {
  return estimateScanWithOpenRouterPricing(run, catalog.models, catalog.updatedAt);
}

function validModel(value: unknown): value is OpenRouterModel {
  if (!value || typeof value !== "object") return false;
  const model = value as Partial<OpenRouterModel>;
  return typeof model.id === "string" &&
    Boolean(model.pricing) &&
    validCatalogRate(model.pricing?.prompt) &&
    validCatalogRate(model.pricing?.completion);
}

function validCatalogRate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0;
}

/** Refreshes pricing opportunistically; the checked-in snapshot remains available offline. */
export async function refreshOpenRouterPricing(
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<boolean> {
  if (catalog.refreshedAtMs > 0 && now - catalog.refreshedAtMs < PRICING_TTL_MS) return true;
  if (refreshPromise) return refreshPromise;
  if (lastAttemptAtMs > 0 && now - lastAttemptAtMs < FAILURE_RETRY_MS) return false;
  lastAttemptAtMs = now;
  refreshPromise = (async () => {
    try {
      const response = await fetchImpl(OPENROUTER_MODELS_URL, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) return false;
      const payload = await response.json() as { data?: unknown[] };
      const refreshedModels = (payload.data ?? [])
        .filter(validModel)
        .map((model) => ({ id: model.id, pricing: model.pricing }));
      if (!refreshedModels.length) return false;
      catalog = {
        models: refreshedModels,
        updatedAt: new Date(now).toISOString(),
        refreshedAtMs: now,
      };
      return true;
    } catch {
      return false;
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}
