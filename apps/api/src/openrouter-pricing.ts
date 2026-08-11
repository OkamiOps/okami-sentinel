import type { ScanCost, ScanRun } from "@csb/shared";

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models?model_authors=openai";
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
  pricingMatch: "exact" | "approved-alias";
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

function openRouterModelId(run: ScanRun): string | null {
  const model = run.cost?.model ?? run.model;
  if (!model) return null;
  if (model.includes("/")) return model;
  return `${run.provider ?? "openai"}/${model}`;
}

function resolvePricing(
  modelId: string,
  models: OpenRouterModel[],
): PricingResolution | null {
  const exact = models.find((candidate) => candidate.id === modelId);
  if (exact) return { model: exact, pricingMatch: "exact" };

  const alias = approvedModelAliases.find((candidate) => candidate.id === modelId);
  if (!alias) return null;
  const target = models.find((candidate) => candidate.id === alias.targetId);
  if (!target) return null;
  return {
    model: target,
    pricingMatch: "approved-alias",
    pricingAliasId: alias.aliasId,
  };
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
  const subscriptionScanner =
    (run.engine === "mantis" || run.engine === "vulnhunter") && run.authMode === "chatgpt";
  const reportedCodexSecurityUsage = run.engine === "codex-security" && run.provider === "openai";
  if (!run.cost || (!subscriptionScanner && !reportedCodexSecurityUsage)) return run;
  if (run.provider !== "openai") return run;
  if (run.cost.pricingSource !== undefined || run.cost.pricingSnapshot !== undefined) return run;
  const reportedTokens =
    run.cost.inputTokens +
    run.cost.cachedInputTokens +
    run.cost.cacheWriteInputTokens +
    run.cost.outputTokens;
  if (reportedTokens <= 0) return run;
  const modelId = openRouterModelId(run);
  const resolution = modelId ? resolvePricing(modelId, models) : null;
  if (!resolution) return run;
  const estimate = calculateOpenRouterCost(run.cost, resolution.model.pricing);
  if (estimate === null) return run;
  const cost: ScanCost = {
    ...run.cost,
    estimatedUsd: estimate.totalUsd,
    pricingSource: "openrouter",
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
  };
  if (resolution.pricingAliasId !== undefined) cost.pricingAliasId = resolution.pricingAliasId;
  return { ...run, cost };
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
