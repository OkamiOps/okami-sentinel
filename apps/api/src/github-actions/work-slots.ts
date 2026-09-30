/**
 * A counting semaphore for the two budgets the webhook endpoint has to keep
 * apart: how many caller-paced body reads may be in flight, and how many bodies
 * may be *hashed* at once. Metering both with one counter made a stalled socket
 * cost a verification slot, which is how eight idle connections could deny the
 * endpoint to GitHub.
 *
 * `tryAcquire` is for the budget whose excess must be shed (a read: refusing
 * costs the caller nothing we have already spent). `acquire` is for the budget
 * whose excess should wait (the hash: the body is already in memory, so waiting
 * is cheaper than throwing the read away).
 */
export class WorkSlots {
  #active = 0;
  readonly #waiting: Array<() => void> = [];

  constructor(readonly limit: number) {}

  get active(): number {
    return this.#active;
  }

  tryAcquire(): boolean {
    if (this.#active >= this.limit) return false;
    this.#active += 1;
    return true;
  }

  async acquire(): Promise<void> {
    if (this.tryAcquire()) return;
    await new Promise<void>((resolve) => { this.#waiting.push(resolve); });
  }

  release(): void {
    const next = this.#waiting.shift();
    // The slot passes straight to the waiter, so a release cannot be overtaken
    // by a caller that arrives between the resolve and its continuation.
    if (next) {
      next();
      return;
    }
    this.#active = Math.max(0, this.#active - 1);
  }
}
