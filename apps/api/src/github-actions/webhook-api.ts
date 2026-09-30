import { Hono, type Context } from "hono";

import { clientIp } from "../auth/login-client-ip.js";
import { FailureWindow } from "../auth/rate-limit.js";
import { trustsProxy } from "../deployment-settings.js";
import { GITHUB_WEBHOOK_PATH } from "../github-app/manifest-flow.js";
import { redactText } from "../redaction.js";
import { ingestGitHubWebhook, type GitHubWebhookIngestDependencies } from "./webhook-ingest.js";
import {
  isWellFormedSignatureHeader,
  namesKnownWebhookApp,
  verifyGitHubSignature,
  webhookSecretSelection,
  type VerifyGitHubSignatureInput,
} from "./webhook-signature.js";
import { WorkSlots } from "./work-slots.js";

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

/**
 * Two budgets, because they bound two different things. A body read is paced by
 * the caller's socket, so its excess is **shed** — refusing costs nothing we have
 * already spent. Hashing is our own CPU on bytes already in memory, so its excess
 * **waits**: throwing a completed read away would be the more expensive answer.
 *
 * Metering both with one counter was the whole of N-6: eight connections that
 * trickled a body held every verification slot, and GitHub's own signed delivery
 * was refused while the process sat idle.
 */
const MAX_CONCURRENT_BODY_READS = 16;
const MAX_CONCURRENT_VERIFICATIONS = 4;

/**
 * A body that does not finish inside this is not a delivery. GitHub sends 1 MiB in
 * well under a second; the deadline exists so a stalled socket cannot hold a read
 * slot for Node's default request timeout of five minutes.
 */
const READ_TIMEOUT_MS = 10_000;

/** Header values are caller-supplied and can be kilobytes; the log takes 64. */
const MAX_LOGGED_HEADER = 64;

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
  maxConcurrentBodyReads?: number;
  maxConcurrentVerifications?: number;
  readTimeoutMs?: number;
  /** Stands in for the hash in tests; the budget is held around this call alone. */
  verify?: (input: VerifyGitHubSignatureInput) => Promise<{ connectionId: string } | null> | { connectionId: string } | null;
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
  const readTimeoutMs = options.readTimeoutMs ?? READ_TIMEOUT_MS;
  const reads = new WorkSlots(options.maxConcurrentBodyReads ?? MAX_CONCURRENT_BODY_READS);
  const hashes = new WorkSlots(options.maxConcurrentVerifications ?? MAX_CONCURRENT_VERIFICATIONS);
  const verify = options.verify ?? verifyGitHubSignature;
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
        deliveryId: delivery === "" ? null : delivery.slice(0, MAX_LOGGED_HEADER),
        event: event === "" ? null : event.slice(0, MAX_LOGGED_HEADER),
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
    // The shape of the signature header is decided here, by regex, because a
    // header that cannot possibly be a signature must not cost a body read.
    if (event === "" || delivery === "" || !isWellFormedSignatureHeader(signature)) {
      return refuse(400, "malformed_delivery");
    }
    // The ceiling bites on the request that follows the six-hundredth, so nothing
    // is recorded for the one that is refused and its body is never read. It is a
    // fixed window, deliberately: a flood ceiling, not an invariant.
    if (verified.blocked(GLOBAL_KEY) !== null) return refuse(429, "rate_limited", { retryAfterMs: VERIFIED_WINDOW_MS });
    // Past the failure threshold, what an address may still cost us depends on
    // whether it can name one of our Apps. A delivery that names a known App id is
    // read and verified with exactly one hash, so a correctly signed delivery is
    // never refused for another connection's wrong secret — whatever second it
    // arrives in. Anything else from that address is shed here, before the body.
    const appId = c.req.header("X-GitHub-Hook-Installation-Target-ID")?.trim() || undefined;
    if (address !== null) {
      const blockedFor = failedVerifications.blocked(address);
      if (blockedFor !== null && !namesKnownWebhookApp(await dependencies.listSecrets(), appId)) {
        return refuse(429, "rate_limited", { retryAfterMs: blockedFor * 1_000 });
      }
    }

    // The read budget is shed, not queued: a caller-paced socket must not be able
    // to occupy anything by waiting.
    if (!reads.tryAcquire()) return refuse(429, "rate_limited", { retryAfterMs: readTimeoutMs });
    let body: Uint8Array | "too_large" | "timeout";
    try {
      body = await readCappedBody(c, readTimeoutMs);
    } finally {
      reads.release();
    }
    if (body === "too_large") return refuse(413, "payload_too_large");
    if (body === "timeout") return refuse(408, "request_timeout");

    let result;
    try {
      result = await ingestGitHubWebhook({
        body,
        // Names the App, so the normal delivery costs exactly one hash.
        headers: { event, delivery, signature, installationTargetId: appId },
      }, {
        ...dependencies,
        verifySignature: async (input) => {
          const selection = webhookSecretSelection(input.secrets, input.appId);
          // A recorded App id can be wrong (the installation id, the client id, the
          // slug). Falling back to the capped loop keeps such a connection working,
          // and the line is what tells the operator to fix the record.
          if (selection.unmatchedAppId) report(options.log, {
            status: 200,
            reason: "webhook_app_id_unmatched",
            deliveryId: delivery.slice(0, MAX_LOGGED_HEADER),
            event: event.slice(0, MAX_LOGGED_HEADER),
          });
          // The budget is held around the hash and the compare, never across I/O.
          await hashes.acquire();
          try {
            return await verify(input);
          } finally {
            hashes.release();
          }
        },
      });
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
 * before the ceiling is applied. The deadline is the other half: a body that
 * stalls is abandoned, the socket's reader cancelled, and the read slot returned,
 * so trickling bytes cannot occupy anything.
 */
async function readCappedBody(
  c: Context,
  timeoutMs: number,
): Promise<Uint8Array | "too_large" | "timeout"> {
  const stream = c.req.raw.body;
  if (!stream) {
    const buffered = new Uint8Array(await c.req.arrayBuffer());
    return buffered.byteLength > GITHUB_WEBHOOK_MAX_BODY_BYTES ? "too_large" : buffered;
  }
  const reader = stream.getReader();
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  const read = (async (): Promise<Uint8Array | "too_large"> => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > GITHUB_WEBHOOK_MAX_BODY_BYTES) return "too_large";
      chunks.push(value);
    }
    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return body;
  })();
  try {
    const outcome = await Promise.race([read, expired]);
    // Either way the reader is done with: cancelling releases the socket and lets
    // the abandoned read settle instead of leaking.
    if (outcome === "timeout" || outcome === "too_large") await reader.cancel().catch(() => {});
    return outcome;
  } finally {
    clearTimeout(timer);
    read.catch(() => {});
    try {
      reader.releaseLock();
    } catch {
      // Already released by `cancel()`; nothing to undo.
    }
  }
}
