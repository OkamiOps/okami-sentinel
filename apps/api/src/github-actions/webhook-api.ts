import { Hono, type Context } from "hono";

import { clientIp } from "../auth/login-client-ip.js";
import { FailureWindow } from "../auth/rate-limit.js";
import { trustsProxy } from "../deployment-settings.js";
import { GITHUB_WEBHOOK_PATH } from "../github-app/manifest-flow.js";
import { ingestGitHubWebhook, type GitHubWebhookIngestDependencies } from "./webhook-ingest.js";

/** The spec's 1 MiB ceiling. Above it the delivery is refused before any work. */
export const GITHUB_WEBHOOK_MAX_BODY_BYTES = 1_048_576;

/** Thirty invalid signatures from one address in five minutes is not GitHub. */
const BAD_SIGNATURES_PER_ADDRESS = 30;
const BAD_SIGNATURE_WINDOW_MS = 5 * 60_000;
/** A global ceiling on accepted deliveries, so a compromised secret cannot flood. */
const ACCEPTED_DELIVERIES_PER_MINUTE = 600;
const ACCEPTED_WINDOW_MS = 60_000;

const GLOBAL_KEY = "accepted";

export interface GitHubWebhookAppOptions {
  /**
   * Resolved per request, never at import or boot: the store's first call runs
   * the schema migration, which renames the legacy monitor tables. `null` means
   * the boot path has not wired it yet and the endpoint answers 503.
   */
  resolve: () => GitHubWebhookIngestDependencies | null;
  failureWindow?: FailureWindow;
  acceptedWindow?: FailureWindow;
  trustProxy?: boolean;
}

/**
 * `POST /github/webhook`. Session-unauthenticated and CSRF-exempt by design: the
 * HMAC over the raw body is the authentication, and GitHub carries no cookie and
 * no token. Every answer is a short fixed JSON document — never the payload, and
 * never why a signature failed.
 */
export function createGitHubWebhookApp(options: GitHubWebhookAppOptions): Hono {
  const badSignatures = options.failureWindow
    ?? new FailureWindow(BAD_SIGNATURES_PER_ADDRESS, BAD_SIGNATURE_WINDOW_MS);
  const accepted = options.acceptedWindow
    ?? new FailureWindow(ACCEPTED_DELIVERIES_PER_MINUTE, ACCEPTED_WINDOW_MS);
  const app = new Hono();

  app.post(GITHUB_WEBHOOK_PATH, async (c) => {
    c.header("Cache-Control", "no-store");
    const trustProxy = options.trustProxy ?? trustsProxy();
    const address = clientIp(c, trustProxy);

    if (address !== null && badSignatures.blocked(address) !== null) {
      return c.json({ error: "rate_limited" }, 429);
    }
    // A declared length above the ceiling is refused before the body is read.
    const declared = Number(c.req.header("Content-Length") ?? "");
    if (Number.isFinite(declared) && declared > GITHUB_WEBHOOK_MAX_BODY_BYTES) {
      return c.json({ error: "payload_too_large" }, 413);
    }

    const event = c.req.header("X-GitHub-Event")?.trim() ?? "";
    const delivery = c.req.header("X-GitHub-Delivery")?.trim() ?? "";
    const signature = c.req.header("X-Hub-Signature-256")?.trim() ?? "";
    if (event === "" || delivery === "" || signature === "") {
      return c.json({ error: "malformed_delivery" }, 400);
    }

    // The ceiling is enforced on the request that follows the six-hundredth, so
    // nothing is recorded for the one that is refused — and the body of a flooded
    // minute is never read at all.
    if (accepted.blocked(GLOBAL_KEY) !== null) return c.json({ error: "rate_limited" }, 429);

    const body = await readCappedBody(c);
    if (!body) return c.json({ error: "payload_too_large" }, 413);

    const dependencies = options.resolve();
    if (!dependencies) return c.json({ error: "github_webhook_not_ready" }, 503);

    let result;
    try {
      result = await ingestGitHubWebhook({ body, headers: { event, delivery, signature } }, dependencies);
    } catch {
      // The reason stays in the server's own logs: the answer says only that the
      // delivery was not handled, so GitHub retries it.
      return c.json({ error: "webhook_failed" }, 500);
    }

    if (result.outcome === "failed" && result.reason === "signature_invalid") {
      if (address !== null) badSignatures.fail(address);
      return c.json({ error: "signature_invalid" }, 401);
    }
    accepted.fail(GLOBAL_KEY);
    if (result.outcome === "failed") {
      return c.json({ error: result.reason ?? "malformed_delivery" }, 400);
    }
    if (result.outcome === "ignored") {
      return c.json({ status: "ignored", reason: result.reason }, 200);
    }
    return c.json({ status: result.outcome }, 200);
  });

  return app;
}

/**
 * The cap is enforced while reading, not after: a caller that omits
 * `Content-Length` must not be able to make the process buffer an arbitrary body
 * before the ceiling is applied. `null` means the ceiling was exceeded.
 */
async function readCappedBody(c: Context): Promise<Uint8Array | null> {
  const stream = c.req.raw.body;
  if (!stream) {
    const buffered = new Uint8Array(await c.req.arrayBuffer());
    return buffered.byteLength > GITHUB_WEBHOOK_MAX_BODY_BYTES ? null : buffered;
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > GITHUB_WEBHOOK_MAX_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
