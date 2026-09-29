export class FailureWindow {
  readonly #entries = new Map<string, { count: number; start: number }>();

  constructor(readonly limit: number, readonly windowMs: number, readonly now: () => number = Date.now) {}

  blocked(key: string): number | null {
    const entry = this.#entries.get(key);
    if (!entry) return null;
    const elapsed = this.now() - entry.start;
    if (elapsed >= this.windowMs) {
      this.#entries.delete(key);
      return null;
    }
    return entry.count >= this.limit ? Math.ceil((this.windowMs - elapsed) / 1000) : null;
  }

  fail(key: string): void {
    const now = this.now();
    const entry = this.#entries.get(key);
    if (!entry || now - entry.start >= this.windowMs) this.#entries.set(key, { count: 1, start: now });
    else entry.count += 1;
    if (this.#entries.size > 10_000) this.#entries.delete(this.#entries.keys().next().value!);
  }

  reset(key: string): void {
    this.#entries.delete(key);
  }
}
