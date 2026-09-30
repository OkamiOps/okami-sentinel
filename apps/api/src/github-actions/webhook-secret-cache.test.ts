import assert from "node:assert/strict";
import test from "node:test";

import { createWebhookSecretCache } from "./webhook-secret-cache.js";
import type { GitHubWebhookSecret } from "./webhook-signature.js";

const secrets = (value: string): GitHubWebhookSecret[] => [
  { connectionId: "c1", secret: value, appId: "1001" },
];

test("reads the vault once per window, not once per delivery", async () => {
  let loads = 0;
  let clock = 0;
  const cache = createWebhookSecretCache({
    load: async () => { loads += 1; return secrets(`s${loads}`); },
    ttlMs: 30_000,
    now: () => clock,
  });
  assert.deepEqual(await cache.read(), secrets("s1"));
  assert.deepEqual(await cache.read(), secrets("s1"));
  assert.equal(loads, 1, "an unsigned flood must not touch the vault per request");
  clock = 29_999;
  assert.deepEqual(await cache.read(), secrets("s1"));
  clock = 30_000;
  assert.deepEqual(await cache.read(), secrets("s2"));
  assert.equal(loads, 2);
});

test("a rotated secret takes effect at once", async () => {
  let loads = 0;
  const cache = createWebhookSecretCache({
    load: async () => { loads += 1; return secrets(`s${loads}`); },
    ttlMs: 30_000,
    now: () => 0,
  });
  assert.deepEqual(await cache.read(), secrets("s1"));
  // The route that stores a new secret calls this, so the operator does not wait
  // out the window wondering why the delivery still fails.
  cache.invalidate();
  assert.deepEqual(await cache.read(), secrets("s2"));
  assert.equal(loads, 2);
});

test("concurrent readers share one load", async () => {
  let loads = 0;
  let release: (() => void) | undefined;
  const cache = createWebhookSecretCache({
    load: async () => {
      loads += 1;
      await new Promise<void>((resolve) => { release = resolve; });
      return secrets("s1");
    },
    ttlMs: 30_000,
    now: () => 0,
  });
  const readers = [cache.read(), cache.read(), cache.read()];
  await Promise.resolve();
  release!();
  assert.deepEqual(await Promise.all(readers), [secrets("s1"), secrets("s1"), secrets("s1")]);
  assert.equal(loads, 1);
});

test("a failed load is not cached, and never leaves a stale promise behind", async () => {
  let attempt = 0;
  const cache = createWebhookSecretCache({
    load: async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("vault unavailable");
      return secrets("s1");
    },
    ttlMs: 30_000,
    now: () => 0,
  });
  await assert.rejects(async () => { await cache.read(); }, /vault unavailable/);
  assert.deepEqual(await cache.read(), secrets("s1"));
  assert.equal(attempt, 2);
});
