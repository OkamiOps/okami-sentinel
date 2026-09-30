/**
 * A counting semaphore for the budgets the webhook endpoint has to keep apart:
 * how many caller-paced body reads may be in flight (globally, and per calling
 * address), and how many bodies may be *hashed* at once. Metering all of it with
 * one counter made a stalled socket cost a verification slot, which is how eight
 * idle connections could deny the endpoint to GitHub.
 *
 * `tryAcquire` is for the budget whose excess must be shed outright (the global
 * read ceiling: refusing costs the caller nothing we have already spent).
 * `acquire` is for the budget whose excess should wait — the hash, because the
 * body is already in memory and waiting is cheaper than throwing the read away,
 * and the *per-address* read budget, because a waiter there holds nothing but its
 * own headers and a bounded wait is what lets a legitimate delivery follow a
 * flood from its own address instead of being refused alongside it.
 *
 * Both waiting budgets are **depth-capped**: beyond `maxWaiting` the caller is
 * told `"shed"` instead of being queued, so the bound on what a flood can pin in
 * memory is in the code rather than in an argument about upload bandwidth.
 */
export type WorkSlotOutcome = "acquired" | "shed" | "timeout";

interface Waiter {
  settled: boolean;
  settle(outcome: "acquired" | "timeout"): void;
}

export class WorkSlots {
  #active = 0;
  readonly #waiting: Waiter[] = [];

  /**
   * @param limit how many holders may run at once.
   * @param maxWaiting how many callers may queue for a slot; the default keeps
   *   the historical unbounded behaviour for callers that pass nothing, but every
   *   call site in the webhook passes a cap.
   */
  constructor(readonly limit: number, readonly maxWaiting: number = Number.POSITIVE_INFINITY) {}

  get active(): number {
    return this.#active;
  }

  /** Queued callers that have neither been handed a slot nor given up. */
  get waiting(): number {
    return this.#waiting.reduce((total, waiter) => total + (waiter.settled ? 0 : 1), 0);
  }

  /** True while the pool holds nothing at all, so a keyed pool can drop it. */
  get idle(): boolean {
    return this.#active === 0 && this.waiting === 0;
  }

  tryAcquire(): boolean {
    if (this.#active >= this.limit) return false;
    this.#active += 1;
    return true;
  }

  /**
   * Wait for a slot, at most `timeoutMs` if given. `"shed"` means the queue was
   * already at its cap and nothing was allocated; `"timeout"` means the wait
   * expired. In both cases the caller must **not** call `release`.
   */
  async acquire(timeoutMs?: number): Promise<WorkSlotOutcome> {
    if (this.tryAcquire()) return "acquired";
    this.#prune();
    if (this.#waiting.length >= this.maxWaiting) return "shed";
    return await new Promise<WorkSlotOutcome>((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const waiter: Waiter = {
        settled: false,
        settle: (outcome) => {
          if (waiter.settled) return;
          waiter.settled = true;
          if (timer !== undefined) clearTimeout(timer);
          resolve(outcome);
        },
      };
      if (timeoutMs !== undefined) timer = setTimeout(() => { waiter.settle("timeout"); }, timeoutMs);
      this.#waiting.push(waiter);
    });
  }

  release(): void {
    for (;;) {
      const next = this.#waiting.shift();
      if (!next) {
        this.#active = Math.max(0, this.#active - 1);
        return;
      }
      // A waiter that timed out never took the slot, so keep looking instead of
      // handing it to nobody.
      if (next.settled) continue;
      // The slot passes straight to the waiter, so a release cannot be overtaken
      // by a caller that arrives between the resolve and its continuation. That
      // handoff is what makes the per-address read budget a delay rather than a
      // denial: a delivery already waiting is served before a fresh flood
      // connection can take the slot that was just freed.
      next.settle("acquired");
      return;
    }
  }

  #prune(): void {
    while (this.#waiting.length > 0 && this.#waiting[0]!.settled) this.#waiting.shift();
  }
}

/**
 * The same semaphore, one pool per key, with the pools garbage-collected as they
 * fall idle. The webhook uses it to charge concurrent body reads to the address
 * that caused them: the global ceiling alone cannot tell a flood from GitHub's
 * own concurrency, so a single address could consume all of it.
 *
 * `maxKeys` bounds the map itself. It is a flood ceiling, not an invariant: a
 * distributed caller that exceeds it falls back to the global budget, which is
 * the residual this class does not pretend to solve.
 */
export class KeyedWorkSlots {
  readonly #pools = new Map<string, WorkSlots>();

  constructor(
    readonly limit: number,
    readonly maxWaiting: number,
    readonly maxKeys: number = 10_000,
  ) {}

  get keys(): number {
    return this.#pools.size;
  }

  activeFor(key: string): number {
    return this.#pools.get(key)?.active ?? 0;
  }

  async acquire(key: string, timeoutMs?: number): Promise<WorkSlotOutcome> {
    let pool = this.#pools.get(key);
    if (!pool) {
      if (this.#pools.size >= this.maxKeys) this.#evictIdle();
      pool = new WorkSlots(this.limit, this.maxWaiting);
      this.#pools.set(key, pool);
    }
    const outcome = await pool.acquire(timeoutMs);
    if (outcome !== "acquired") this.#dropIfIdle(key, pool);
    return outcome;
  }

  release(key: string): void {
    const pool = this.#pools.get(key);
    if (!pool) return;
    pool.release();
    this.#dropIfIdle(key, pool);
  }

  #dropIfIdle(key: string, pool: WorkSlots): void {
    if (pool.idle) this.#pools.delete(key);
  }

  #evictIdle(): void {
    for (const [key, pool] of this.#pools) {
      if (pool.idle) this.#pools.delete(key);
    }
    // Still full of live pools: drop the oldest insertion so the map cannot grow
    // without bound. Its holders keep their slots; only the accounting is lost.
    if (this.#pools.size >= this.maxKeys) {
      const oldest = this.#pools.keys().next();
      if (!oldest.done) this.#pools.delete(oldest.value);
    }
  }
}
