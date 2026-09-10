/**
 * Provider-independent guard, not an exact tokenizer. Code/JSON can tokenize very
 * differently across models. Start at a conservative two UTF-8 bytes per token,
 * include protocol overhead, and only increase density from observed usage.
 * All serialized wire fields count, including instructions and tool schemas.
 */
export class ContextBudgetEstimator {
  #tokensPerByte = 0.5;
  #lastInputTokens = 0;
  #lastRequestBytes = 0;
  #carriedTokens = 0;

  estimate(requestBytes: number, continuation = false): number {
    if (continuation) return Math.ceil(this.#carriedTokens + requestBytes * this.#tokensPerByte) + 2_048;
    return Math.ceil(Math.max(
      requestBytes * this.#tokensPerByte,
      this.#lastInputTokens + Math.max(0, requestBytes - this.#lastRequestBytes) * this.#tokensPerByte,
    )) + 2_048;
  }

  observe(requestBytes: number, inputTokens: number | null, continuation = false, outputTokens: number | null = null, outputReserve = 65_536): void {
    const validInput = inputTokens !== null && Number.isSafeInteger(inputTokens) && inputTokens >= 0;
    const validOutput = outputTokens !== null && Number.isSafeInteger(outputTokens) && outputTokens >= 0;
    this.#carriedTokens = (validInput ? inputTokens : this.estimate(requestBytes, continuation)) +
      (validOutput ? outputTokens : outputReserve);
    // A Responses continuation sends only a delta; its usage covers server-held
    // history as well. Dividing total usage by delta bytes invents huge density.
    if (continuation) return;
    if (inputTokens === null || !Number.isSafeInteger(inputTokens) || inputTokens < 0 || requestBytes <= 0) return;
    this.#tokensPerByte = Math.max(this.#tokensPerByte, inputTokens / requestBytes * 1.1);
    this.#lastInputTokens = inputTokens;
    this.#lastRequestBytes = requestBytes;
  }
}

/** Reserve the wire completion cap. Unknown/default provider limits reserve 64K. */
export function completionContextReserve(body: unknown): number {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    const caps = [record.max_output_tokens, record.max_completion_tokens, record.max_tokens]
      .filter((value): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0);
    if (caps.length > 0) return Math.max(...caps);
  }
  return 65_536;
}

export function carriesRemoteContext(body: unknown): boolean {
  return !!body && typeof body === "object" && typeof (body as Record<string, unknown>).previous_response_id === "string";
}
