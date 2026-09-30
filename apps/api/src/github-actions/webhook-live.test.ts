/**
 * The endpoint answered `503 github_webhook_not_ready` for the whole of task 1.3
 * (`resolve: () => null`), because reaching the actions store would have run the
 * migration while the poller was still reading the tables it renames. This is
 * the assertion that the wiring landed in the commit that removed the poller:
 * the route is live, and it answers with the ingestion's own codes.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { app } from "../app.js";

test("POST /github/webhook is wired, not inert", async () => {
  const body = JSON.stringify({ zen: "Keep it logically awesome." });

  // No headers: the ingestion's own refusal, which only a resolved dependency
  // set can produce. A `503` here would mean `resolve()` still returns null.
  const malformed = await app.request("/github/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: "malformed_delivery" });

  // A well-formed delivery nobody can have signed: the secret snapshot is read
  // from the vault, the HMAC runs, and no connection claims it.
  const unsigned = await app.request("/github/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-GitHub-Event": "ping",
      "X-GitHub-Delivery": `live-${Date.now()}`,
      "X-Hub-Signature-256": `sha256=${"0".repeat(64)}`,
    },
    body,
  });
  assert.equal(unsigned.status, 401);
  assert.deepEqual(await unsigned.json(), { error: "signature_invalid" });
});
