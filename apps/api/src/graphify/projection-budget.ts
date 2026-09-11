import { ContextBudgetEstimator } from "../agent/context-budget.js";

/** Prefetch allocation for a fresh session. The serialized-wire guard remains authoritative. */
export function projectionBudget(instructions: string, contextTokens: number, completionTokens = 65_536): number {
  const ceiling = Math.min(300_000, contextTokens);
  const promptTokens = new ContextBudgetEstimator().estimate(Buffer.byteLength(JSON.stringify(instructions)));
  // Protocol/tool schemas plus headroom for follow-up reads and reasoning history.
  const protocolReserve = 16_384;
  const continuationReserve = Math.ceil(ceiling / 4);
  const available = ceiling - promptTokens - completionTokens - protocolReserve - continuationReserve;
  // JSON source is embedded in a wire string: reserve another escaping pass.
  return Math.max(0, Math.floor(available));
}
