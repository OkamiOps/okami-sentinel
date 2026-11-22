import type { AgentWireRequest } from "../agent/session-types.js";
import type { FrozenScannerPricing } from "../model-pricing.js";

export const MIN_PORTABLE_TURN_OUTPUT_TOKENS = 1_024;
const DEFAULT_OUTPUT_TOKENS = 65_536;

export function reservePortableTurn(
  request: AgentWireRequest,
  pricing: FrozenScannerPricing,
  remainingUsd: number,
  maximumInputTokens: number | null,
): AgentWireRequest | null {
  remainingUsd -= Math.max(1e-12, Math.abs(remainingUsd) * Number.EPSILON * 4);
  const body = request.body as Record<string, unknown>;
  const outputKey = request.operation === "responses" ? "max_output_tokens"
    : request.operation === "messages" ? "max_tokens"
    : "max_completion_tokens" in body ? "max_completion_tokens" : "max_tokens";
  const existing = body[outputKey];
  const requested = typeof existing === "number" && Number.isSafeInteger(existing) && existing > 0
    ? existing : DEFAULT_OUTPUT_TOKENS;
  const boundedBody = { ...body, [outputKey]: requested };
  // Reserve the model's entire input window, including provider-held history.
  if (maximumInputTokens === null || !Number.isSafeInteger(maximumInputTokens) || maximumInputTokens <= 0) return null;
  if (pricing.maximumInputTokensInclusive !== null && maximumInputTokens > pricing.maximumInputTokensInclusive) return null;
  const inputRate = pricing.inputUsdPerMillionTokens;
  const outputRate = pricing.outputUsdPerMillionTokens;
  if (inputRate === null || outputRate === null || !Number.isFinite(inputRate) || !Number.isFinite(outputRate) || inputRate < 0 || outputRate < 0 || !Number.isFinite(remainingUsd)) return null;
  const available = remainingUsd - maximumInputTokens * inputRate / 1_000_000;
  if (available < 0) return null;
  let affordable = outputRate === 0 ? requested : Math.min(requested, Math.floor(available * 1_000_000 / outputRate));
  if ((maximumInputTokens * inputRate + affordable * outputRate) / 1_000_000 > remainingUsd) affordable--;
  if (affordable >= requested) return existing === requested ? request : { ...request, body: boundedBody };
  if (affordable < MIN_PORTABLE_TURN_OUTPUT_TOKENS) return null;
  return { ...request, body: { ...boundedBody, [outputKey]: affordable } };
}

/** Shared across all sessions in one scan; failed/unknown requests retain their hold. */
export function createPortableTurnBudget(initialOutstandingUsd = 0, persist: (outstandingUsd: number) => void = () => {}) {
  let outstandingUsd = initialOutstandingUsd;
  return {
    reserve(request: AgentWireRequest, pricing: FrozenScannerPricing, remainingUsd: number, maximumInputTokens: number | null) {
      const bounded = reservePortableTurn(request, pricing, remainingUsd - outstandingUsd, maximumInputTokens);
      if (!bounded || maximumInputTokens === null) return null;
      const body = bounded.body as Record<string, number>;
      const output = body.max_output_tokens ?? body.max_completion_tokens ?? body.max_tokens!;
      const amount = (maximumInputTokens * pricing.inputUsdPerMillionTokens! + output * pricing.outputUsdPerMillionTokens!) / 1_000_000;
      outstandingUsd += amount;
      persist(outstandingUsd);
      let settled = false;
      return {
        request: bounded,
        settle() {
          if (settled) return;
          settled = true;
          outstandingUsd = Math.max(0, outstandingUsd - amount);
          persist(outstandingUsd);
        },
      };
    },
  };
}
