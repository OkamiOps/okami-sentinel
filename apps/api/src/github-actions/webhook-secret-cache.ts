import type { GitHubWebhookSecret } from "./webhook-signature.js";

/**
 * Short enough that a paste in the Integration screen takes effect on its own,
 * long enough that a flood of unsigned deliveries cannot turn into a flood of
 * vault decryptions. The rotation path calls `invalidate()` and does not wait.
 */
export const WEBHOOK_SECRET_CACHE_TTL_MS = 30_000;

export interface WebhookSecretCache {
  /** The current snapshot, loaded at most once per window. */
  read(): Promise<ReadonlyArray<GitHubWebhookSecret>>;
  /** Called when a secret is stored or a connection is removed. */
  invalidate(): void;
}

/**
 * `listSecrets` on the webhook's hot path runs before any rate limit can shed
 * load, and with the encrypted server store one read means one file read and one
 * decryption **per connection**. That is a lever an unauthenticated caller must
 * not have, so the snapshot is cached and every concurrent reader shares the same
 * in-flight load.
 */
export function createWebhookSecretCache(options: {
  load: () => Promise<ReadonlyArray<GitHubWebhookSecret>>;
  ttlMs?: number;
  now?: () => number;
}): WebhookSecretCache {
  const ttlMs = options.ttlMs ?? WEBHOOK_SECRET_CACHE_TTL_MS;
  const now = options.now ?? Date.now;
  let entry: { loadedAt: number; secrets: ReadonlyArray<GitHubWebhookSecret> } | null = null;
  let inFlight: Promise<ReadonlyArray<GitHubWebhookSecret>> | null = null;

  return {
    async read() {
      if (entry !== null && now() - entry.loadedAt < ttlMs) return entry.secrets;
      // One load for every waiter: twenty deliveries arriving together must not
      // become twenty vault reads.
      inFlight ??= (async () => {
        try {
          const secrets = await options.load();
          entry = { loadedAt: now(), secrets };
          return secrets;
        } finally {
          // A failure is not cached: the next delivery tries again rather than
          // being refused for a whole window because the vault blinked.
          inFlight = null;
        }
      })();
      return await inFlight;
    },
    invalidate() {
      entry = null;
    },
  };
}
