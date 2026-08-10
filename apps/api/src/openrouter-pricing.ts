import type { ScanCost, ScanRun } from "@csb/shared";

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models?model_authors=openai";
const PRICING_TTL_MS = 6 * 60 * 60 * 1000;
const FAILURE_RETRY_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 5_000;
const FALLBACK_UPDATED_AT = "2026-08-10T16:51:49.000Z";

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
): OpenRouterCostBreakdown {
  const inputTokens = Math.max(0, usage.inputTokens);
  const cachedInputTokens = Math.min(inputTokens, Math.max(0, usage.cachedInputTokens));
  const uncachedInputTokens = inputTokens - cachedInputTokens;
  const promptRate = rate(pricing.prompt);
  const cacheReadRate = rate(pricing.input_cache_read, promptRate);
  const cacheWriteRate = rate(pricing.input_cache_write, promptRate);
  const completionRate = rate(pricing.completion);
  const uncachedInputUsd = usd(uncachedInputTokens * promptRate);
  const cachedInputUsd = usd(cachedInputTokens * cacheReadRate);
  const cacheWriteInputUsd = usd(Math.max(0, usage.cacheWriteInputTokens) * cacheWriteRate);
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

export function estimateScanWithOpenRouterPricing(
  run: ScanRun,
  models: OpenRouterModel[],
  pricingUpdatedAt: string,
): ScanRun {
  const subscriptionScanner = run.engine === "mantis" || run.engine === "vulnhunter";
  if (!subscriptionScanner || run.authMode !== "chatgpt" || !run.cost) return run;
  const reportedTokens =
    run.cost.inputTokens +
    run.cost.cachedInputTokens +
    run.cost.cacheWriteInputTokens +
    run.cost.outputTokens;
  if (reportedTokens <= 0) return run;
  const modelId = openRouterModelId(run);
  const model = modelId ? models.find((candidate) => candidate.id === modelId) : undefined;
  if (!model) return run;
  const estimate = calculateOpenRouterCost(run.cost, model.pricing);
  const cost: ScanCost = {
    ...run.cost,
    estimatedUsd: estimate.totalUsd,
    pricingSource: "openrouter",
    pricingModel: model.id,
    pricingUpdatedAt,
    inputUsd: estimate.inputUsd,
    cachedInputUsd: estimate.cachedInputUsd,
    cacheWriteInputUsd: estimate.cacheWriteInputUsd,
    outputUsd: estimate.outputUsd,
  };
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
      const models = (payload.data ?? []).filter(validModel);
      if (!models.length) return false;
      catalog = {
        models,
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
