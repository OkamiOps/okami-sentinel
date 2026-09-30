import { Hono, type Context } from "hono";

import { clientIp } from "../auth/login-client-ip.js";
import { FailureWindow } from "../auth/rate-limit.js";
import { trustsProxy } from "../deployment-settings.js";
import { GITHUB_WEBHOOK_PATH } from "../github-app/manifest-flow.js";
import { redactText } from "../redaction.js";
import { ingestGitHubWebhook, type GitHubWebhookIngestDependencies } from "./webhook-ingest.js";

/** The spec's 1 MiB ceiling. Above it the delivery is refused before any work. */
export const GITHUB_WEBHOOK_MAX_BODY_BYTES = 1_048_576;

/** Thirty failed verifications from one address in five minutes is not GitHub. */
const FAILED_VERIFICATIONS_PER_ADDRESS = 30;
const FAILED_VERIFICATION_WINDOW_MS = 5 * 60_000;
/**
 * The separate, generous ceiling for deliveries that *did* verify. It exists so a
 * leaked secret cannot flood the store, not to police GitHub, which is why it is
 * an order of magnitude above any real delivery rate.
 */
const VERIFIED_DELIVERIES_PER_MINUTE = 600;
const VERIFIED_WINDOW_MS = 60_000;

const GLOBAL_KEY = "verified";

/**
 * What a refused delivery leaves behind. GitHub does not retry a webhook, so every
 * 4xx and 5xx is a lost event: without this line the operator sees a red row in
 * GitHub's *Recent Deliveries* and nothing at all on our side. The payload and the
 * secret never appear here — only the delivery id, the event name and a code.
 */
export interface GitHubWebhookLogEntry {
  status: number;
  reason: string;
  deliveryId: string | null;
  event: string | null;
  /** Present only for a fault, redacted through the global secret redactor. */
  detail?: string;
}

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
  log?: (entry: GitHubWebhookLogEntry) => void;
}

/**
 * `POST /github/webhook`. Session-unauthenticated and CSRF-exempt by design: the
 * HMAC over the raw body is the authentication, and GitHub carries no cookie and
 * no token. Every answer is a short fixed JSON document — never the payload, and
 * never why a signature failed.
 */
export function createGitHubWebhookApp(options: GitHubWebhookAppOptions): Hono {
  const failedVerifications = options.failureWindow
    ?? new FailureWindow(FAILED_VERIFICATIONS_PER_ADDRESS, FAILED_VERIFICATION_WINDOW_MS);
  const verified = options.acceptedWindow
    ?? new FailureWindow(VERIFIED_DELIVERIES_PER_MINUTE, VERIFIED_WINDOW_MS);
  const app = new Hono();

  app.post(GITHUB_WEBHOOK_PATH, async (c) => {
    c.header("Cache-Control", "no-store");
    const trustProxy = options.trustProxy ?? trustsProxy();
    const address = clientIp(c, trustProxy);
    const event = c.req.header("X-GitHub-Event")?.trim() ?? "";
    const delivery = c.req.header("X-GitHub-Delivery")?.trim() ?? "";
    const signature = c.req.header("X-Hub-Signature-256")?.trim() ?? "";

    // `extra`, not `options`: shadowing the factory's own options would silently
    // drop the logger.
    const refuse = (status: number, reason: string, extra: { detail?: string; retryAfterMs?: number } = {}): Response => {
      const detail = extra.detail;
      report(options.log, {
        status,
        reason,
        deliveryId: delivery === "" ? null : delivery,
        event: event === "" ? null : event,
        ...(detail === undefined ? {} : { detail: redactText(detail) }),
      });
      // An operator reading the delivery log can then tell throttling from breakage.
      if (extra.retryAfterMs !== undefined) {
        c.header("Retry-After", String(Math.ceil(extra.retryAfterMs / 1000)));
      }
      return c.json({ error: reason }, status as 400);
    };

    // Before the body is read: an inert deployment must not buffer a mebibyte for
    // an anonymous caller.
    const dependencies = options.resolve();
    if (!dependencies) return refuse(503, "github_webhook_not_ready");

    // A declared length above the ceiling is refused before the body is read.
    const declared = Number(c.req.header("Content-Length") ?? "");
    if (Number.isFinite(declared) && declared > GITHUB_WEBHOOK_MAX_BODY_BYTES) {
      return refuse(413, "payload_too_large");
    }
    if (event === "" || delivery === "" || signature === "") {
      return refuse(400, "malformed_delivery");
    }
    // The ceiling bites on the request that follows the six-hundredth, so nothing
    // is recorded for the one that is refused and its body is never read. It is a
    // fixed window, deliberately: a flood ceiling, not an invariant.
    if (verified.blocked(GLOBAL_KEY) !== null) return refuse(429, "rate_limited", { retryAfterMs: VERIFIED_WINDOW_MS });

    const body = await readCappedBody(c);
    if (!body) return refuse(413, "payload_too_large");

    let result;
    try {
      result = await ingestGitHubWebhook({ body, headers: { event, delivery, signature } }, dependencies);
    } catch (error) {
      // The cause never reaches GitHub, but it must reach the operator: a 500 is
      // the only trace a lost delivery leaves on our side.
      return refuse(500, "webhook_failed", { detail: error instanceof Error ? error.message : String(error) });
    }

    if (result.outcome === "failed" && result.reason === "signature_invalid") {
      // Only a failed verification counts against the address. A delivery that did
      // verify is never refused for somebody else's wrong secret — GitHub sends
      // every connection's deliveries from the same handful of addresses — and it
      // does not clear the window either, so one accepted delivery cannot reset an
      // attacker's own budget.
      if (address !== null) {
        if (failedVerifications.blocked(address) !== null) {
          return refuse(429, "rate_limited", { retryAfterMs: FAILED_VERIFICATION_WINDOW_MS });
        }
        failedVerifications.fail(address);
      }
      return refuse(401, "signature_invalid");
    }
    verified.fail(GLOBAL_KEY);
    if (result.outcome === "failed") {
      return refuse(400, result.reason ?? "malformed_delivery");
    }
    if (result.outcome === "ignored") {
      return c.json({ status: "ignored", reason: result.reason }, 200);
    }
    return c.json({ status: result.outcome }, 200);
  });

  return app;
}

function report(
  log: ((entry: GitHubWebhookLogEntry) => void) | undefined,
  entry: GitHubWebhookLogEntry,
): void {
  if (log) {
    log(entry);
    return;
  }
  const suffix = entry.detail === undefined ? "" : `: ${entry.detail}`;
  console.warn(
    `[csb-api] github webhook refused ${entry.status} ${entry.reason}`
    + ` delivery=${entry.deliveryId ?? "-"} event=${entry.event ?? "-"}${suffix}`,
  );
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
