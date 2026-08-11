export interface ScannerUsage {
  /**
   * Present in new runtime artifacts once the provider has emitted a usage
   * record. Older artifacts omit it, so their non-zero counters remain valid.
   */
  reported?: boolean;
  /**
   * Optional durable presence bits for providers that can omit individual
   * counters. A numeric zero is only authoritative when its matching bit is
   * true. Legacy scanner artifacts omit these fields.
   */
  inputTokensKnown?: boolean;
  cachedInputTokensKnown?: boolean;
  cacheWriteInputTokensKnown?: boolean;
  outputTokensKnown?: boolean;
  /** Largest provider-reported input count for one request in this scan. */
  maximumInputTokensPerRequest?: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens?: number;
  outputTokens: number;
}

export interface ScannerUsageUpdate {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  outputTokens: number | null;
}

/** Accumulates usage without ever turning an omitted provider field into a reported zero. */
export function addScannerUsage(
  current: ScannerUsage,
  update: ScannerUsageUpdate,
): ScannerUsage {
  const incoming = {
    inputTokens: validTokenCount(update.inputTokens) ? update.inputTokens : null,
    cachedInputTokens: validTokenCount(update.cachedInputTokens)
      ? update.cachedInputTokens
      : null,
    cacheWriteInputTokens: validTokenCount(update.cacheWriteInputTokens)
      ? update.cacheWriteInputTokens
      : null,
    outputTokens: validTokenCount(update.outputTokens) ? update.outputTokens : null,
  };
  if (!Object.values(incoming).some((value) => value !== null)) return current;
  const hadUsage = current.reported === true;
  const knownAfter = (wasKnown: boolean | undefined, isKnown: boolean): boolean =>
    hadUsage ? wasKnown === true && isKnown : isKnown;
  return {
    reported: true,
    inputTokensKnown: knownAfter(current.inputTokensKnown, incoming.inputTokens !== null),
    cachedInputTokensKnown: knownAfter(
      current.cachedInputTokensKnown,
      incoming.cachedInputTokens !== null,
    ),
    cacheWriteInputTokensKnown: knownAfter(
      current.cacheWriteInputTokensKnown,
      incoming.cacheWriteInputTokens !== null,
    ),
    outputTokensKnown: knownAfter(current.outputTokensKnown, incoming.outputTokens !== null),
    ...(incoming.inputTokens === null
      ? {}
      : {
        maximumInputTokensPerRequest: Math.max(
          current.maximumInputTokensPerRequest ?? 0,
          incoming.inputTokens,
        ),
      }),
    inputTokens: current.inputTokens + (incoming.inputTokens ?? 0),
    cachedInputTokens: current.cachedInputTokens + (incoming.cachedInputTokens ?? 0),
    cacheWriteInputTokens:
      (current.cacheWriteInputTokens ?? 0) + (incoming.cacheWriteInputTokens ?? 0),
    outputTokens: current.outputTokens + (incoming.outputTokens ?? 0),
  };
}

export function scannerUsageWasReported(usage: ScannerUsage): boolean {
  if (typeof usage.reported === "boolean") return usage.reported;
  return (
    usage.inputTokens > 0 ||
    usage.cachedInputTokens > 0 ||
    (usage.cacheWriteInputTokens ?? 0) > 0 ||
    usage.outputTokens > 0
  );
}

export function scannerCacheWriteInputTokens(usage: ScannerUsage): number {
  return usage.cacheWriteInputTokens ?? 0;
}

export function scannerUsageSummary(usage: ScannerUsage): import("@csb/shared").ScanUsageSummary | null {
  if (!scannerUsageWasReported(usage)) return null;
  const known = (flag: boolean | undefined, value: number): number | null =>
    flag === true || (flag === undefined && value > 0) ? value : null;
  return {
    inputTokens: known(usage.inputTokensKnown, usage.inputTokens),
    cachedInputTokens: known(usage.cachedInputTokensKnown, usage.cachedInputTokens),
    cacheWriteInputTokens: known(
      usage.cacheWriteInputTokensKnown,
      usage.cacheWriteInputTokens ?? 0,
    ),
    outputTokens: known(usage.outputTokensKnown, usage.outputTokens),
  };
}

function validTokenCount(value: number | null): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
