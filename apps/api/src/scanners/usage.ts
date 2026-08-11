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
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens?: number;
  outputTokens: number;
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
