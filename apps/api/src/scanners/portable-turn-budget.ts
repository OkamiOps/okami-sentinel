import type { AgentWireRequest } from "../agent/session-types.js";
import type { FrozenScannerPricing } from "../model-pricing.js";

export const MIN_PORTABLE_TURN_OUTPUT_TOKENS = 1_024;
const DEFAULT_OUTPUT_TOKENS = 65_536;

export function reservePortableTurn(
  request: AgentWireRequest,
  pricing: FrozenScannerPricing,
  remainingUsd: number,
): AgentWireRequest | null {
  const body = request.body as Record<string, unknown>;
  const outputKey = request.operation === "responses" ? "max_output_tokens"
    : request.operation === "messages" ? "max_tokens"
    : "max_completion_tokens" in body ? "max_completion_tokens" : "max_tokens";
  const existing = body[outputKey];
  const requested = typeof existing === "number" && Number.isSafeInteger(existing) && existing > 0
    ? existing : DEFAULT_OUTPUT_TOKENS;
  const boundedBody = { ...body, [outputKey]: requested };
  const inputTokens = Math.ceil(Buffer.byteLength(JSON.stringify(boundedBody), "utf8") / 3);
  const inputRate = pricing.inputUsdPerMillionTokens;
  const outputRate = pricing.outputUsdPerMillionTokens;
  if (inputRate === null || outputRate === null || !Number.isFinite(remainingUsd)) return null;
  const available = remainingUsd - inputTokens * inputRate / 1_000_000;
  if (available < 0) return null;
  const affordable = outputRate === 0 ? requested : Math.floor(available * 1_000_000 / outputRate);
  if (affordable >= requested) return existing === requested ? request : { ...request, body: boundedBody };
  if (affordable < MIN_PORTABLE_TURN_OUTPUT_TOKENS) return null;
  return { ...request, body: { ...boundedBody, [outputKey]: affordable } };
}
