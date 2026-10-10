/**
 * Xiaomi retires the MiMo v2.5 chat ids on 21 Oct 2026 10:00 UTC+8
 * (21 Oct 2026 04:00 Europe/Berlin). From 14 Oct 2026 18:00 UTC+8
 * (14 Oct 2026 12:00 Europe/Berlin) those ids are routed to v2.6 and billed
 * at the v2.6 price.
 *
 * https://mimo.mi.com/docs/en-US/updates/deprecate
 */
export const MIMO_TOKEN_PLAN_MODEL_SUCCESSORS = Object.freeze({
  "mimo-v2.5-pro": "mimo-v2.6-pro",
  "mimo-v2.5": "mimo-v2.6-flash",
} as const);

/** Chat models Sentinel sends to a MiMo Token Plan connection. */
export const MIMO_TOKEN_PLAN_AGENT_MODEL_IDS = Object.freeze([
  "mimo-v2.6-pro",
  "mimo-v2.6-flash",
] as const);

const SUCCESSOR_TO_RETIRED = Object.freeze({
  "mimo-v2.6-pro": "mimo-v2.5-pro",
  "mimo-v2.6-flash": "mimo-v2.5",
} as const);

export type MimoTokenPlanAgentModelId = (typeof MIMO_TOKEN_PLAN_AGENT_MODEL_IDS)[number];
export type RetiredMimoTokenPlanModelId = keyof typeof MIMO_TOKEN_PLAN_MODEL_SUCCESSORS;

/** The id Xiaomi still accepts after the v2.5 cutoff. Unknown ids pass through. */
export function canonicalMimoTokenPlanModelId(modelId: string): string {
  return MIMO_TOKEN_PLAN_MODEL_SUCCESSORS[modelId as RetiredMimoTokenPlanModelId] ?? modelId;
}

/** The retired id for a v2.6 chat model, or null when the id has no predecessor. */
export function retiredMimoTokenPlanModelId(modelId: string): string | null {
  const canonical = canonicalMimoTokenPlanModelId(modelId);
  return SUCCESSOR_TO_RETIRED[canonical as MimoTokenPlanAgentModelId] ?? null;
}

export function isRetiredMimoTokenPlanModelId(modelId: string): boolean {
  return Object.hasOwn(MIMO_TOKEN_PLAN_MODEL_SUCCESSORS, modelId);
}

/**
 * True for the v2.6 chat models and for the v2.5 ids that only exist as
 * aliases of those models. Other catalog rows (ASR, TTS, ultraspeed) are not
 * agent models.
 */
export function isMimoTokenPlanAgentModelId(modelId: string): boolean {
  const canonical = canonicalMimoTokenPlanModelId(modelId);
  return (MIMO_TOKEN_PLAN_AGENT_MODEL_IDS as readonly string[]).includes(canonical);
}

export function mimoTokenPlanModelIdsMatch(left: string, right: string): boolean {
  return canonicalMimoTokenPlanModelId(left) === canonicalMimoTokenPlanModelId(right);
}

/** Requested id first, then the other id in the same successor pair. */
export function mimoTokenPlanModelAliases(modelId: string): readonly string[] {
  const canonical = canonicalMimoTokenPlanModelId(modelId);
  const retired = retiredMimoTokenPlanModelId(canonical);
  if (retired === null) return [modelId];
  return modelId === retired ? [retired, canonical] : [canonical, retired];
}
