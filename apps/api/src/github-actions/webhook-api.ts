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
import { KeyedWorkSlots, WorkSlots } from "./work-slots.js";

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
 * Three budgets, because they bound three different things.
 *
 * **Body reads, globally** — a read is paced by the caller's socket, and holding
 * one costs at most 1 MiB of memory, so the ceiling is set well above any honest
 * concurrency instead of being a boundary. It is *not* a security control: the
 * `X-GitHub-Hook-Installation-Target-ID` header an admission check could key off
 * is not a secret — GitHub sends it in every delivery and it is readable on the
 * App itself — so anyone can present a delivery that looks admissible. A small
 * global ceiling was therefore the whole of N-6b: sixteen sockets that offered a
 * body and never finished it made GitHub's own signed delivery answer `429`.
 *
 * **Body reads, per calling address** — this is the boundary. A flood is charged
 * to whoever caused it, so no single address (and no handful of them) can consume
 * the global pool, whatever it names. Excess here **waits** rather than being shed
 * immediately, because the address that a flood shares might be GitHub's own egress
 * and a shed delivery is a lost event: GitHub does not retry. The wait is bounded
 * and a freed slot passes to the waiter ahead of any fresh arrival, so a stalled
 * flood costs a legitimate delivery the idle deadline and not the event.
 *
 * The queue is also depth-capped, and that cap is a **loss**, not a delay: past
 * four waiters the fifth delivery is answered `429` and is gone. The bound has to
 * exist — an unbounded queue of waiters is the memory the flood was shed to protect
 * — so the honest accounting is that a sustained flood from GitHub's own egress can
 * cost events, and the reconciliation loop below is what recovers them.
 *
 * **Hashes** — our own CPU over bytes already in memory, so its excess waits in a
 * depth-capped queue rather than throwing a completed read away, and the slot is
 * taken around the hash alone, never around I/O.
 *
 * **Residual, accepted:** a *distributed* slowloris — hundreds of addresses, each
 * within its own per-address budget, each trickling a byte just often enough to
 * beat the idle deadline — can still fill the global read ceiling. No per-address
 * accounting can distinguish that from honest traffic, and this endpoint cannot
 * ask the caller to prove anything before the body arrives. It is mitigated, not
 * prevented: deliveries refused in the meantime are recovered by the
 * reconciliation loop, which re-lists installations and open pull requests and
 * creates the events the lost deliveries would have created. That, and not the
 * read ceiling, is what makes a lost webhook survivable.
 */
export const GITHUB_WEBHOOK_MAX_CONCURRENT_READS = 64;
export const GITHUB_WEBHOOK_MAX_READS_PER_ADDRESS = 4;
/** Waiters for one address's read budget. Each holds its headers and nothing else. */
const MAX_READ_WAITERS_PER_ADDRESS = 4;
const MAX_CONCURRENT_VERIFICATIONS = 4;
/**
 * Queued bodies waiting for a hash. Outpacing four concurrent HMAC passes over
 * 1 MiB needs gigabytes per second of upload, so this is not expected to bite —
 * it is here so the bound is in the code instead of in that arithmetic (N-11).
 */
const MAX_HASH_QUEUE_DEPTH = 64;
const HASH_WAIT_MS = 5_000;

/**
 * A body that does not finish inside this is not a delivery. GitHub sends 1 MiB in
 * well under a second; the deadline exists so a stalled socket cannot hold a read
 * slot for Node's default request timeout of five minutes.
 */
const READ_TIMEOUT_MS = 10_000;
/**
 * Ten seconds is the ceiling for a read that is *making progress*. A socket that
 * has sent nothing — not its first byte, or nothing since its last one — has no
 * claim on a slot for that long: GitHub starts sending immediately. This is what
 * makes the per-address wait below short enough to be a delay.
 */
const READ_IDLE_TIMEOUT_MS = 2_000;

/** How long a delivery waits for its address's read budget before it is shed. */
const READ_ADMISSION_WAIT_FACTOR = 2;

/**
 * A wrong recorded App id is a standing misconfiguration, not an event: one line
 * per connection per window, not one per delivery (N-10).
 */
const APP_ID_NOTICE_WINDOW_MS = 10 * 60_000;

/** Header values are caller-supplied and can be kilobytes; the log takes 64. */
const MAX_LOGGED_HEADER = 64;

const GLOBAL_KEY = "verified";

/**
 * The bucket for a caller whose address cannot be attributed: `CSB_TRUST_PROXY=1`
 * with no `X-Forwarded-For`, which means the proxy in front of us is not appending
 * it. Those requests share **one** pool rather than bypassing the limiter
 * altogether, which is what they used to do — an attacker who stripped the header
 * got an unmetered endpoint. One shared pool is the deliberate trade: a
 * misconfigured proxy makes every delivery compete for one address's budget, which
 * is visible as throttling, instead of silently removing the boundary (N-14). The
 * requirement is documented in the spec's reverse-proxy section.
 */
const UNATTRIBUTED_KEY = "unattributed";

/**
 * What a refused delivery leaves behind. GitHub does not retry a webhook, so every
 * 4xx and 5xx is a lost event: without this line the operator sees a red row in
 * GitHub's *Recent Deliveries* and nothing at all on our side. The payload and the
 * secret never appear here — only the delivery id, the event name and a code.
 */
export interface GitHubWebhookLogEntry {
  /**
   * A refusal is a lost delivery and belongs in the warning stream; a notice is
   * about a delivery that was **accepted** and belongs in the informational one.
   * Formatting both as `refused` made `refused 200 …` a line an operator grepping
   * for refusals had to learn to discard (N-10).
   */
  kind: "refused" | "notice";
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
  /** One `webhook_app_id_unmatched` notice per connection per window. */
  noticeWindow?: FailureWindow;
  trustProxy?: boolean;
  log?: (entry: GitHubWebhookLogEntry) => void;
  maxConcurrentBodyReads?: number;
  maxBodyReadsPerAddress?: number;
  maxConcurrentVerifications?: number;
  maxHashQueueDepth?: number;
  readTimeoutMs?: number;
  /** No bytes at all within this, first or subsequent, ends the read with `408`. */
  readIdleTimeoutMs?: number;
  /** How long a delivery may wait for its address's read budget. */
  readAdmissionWaitMs?: number;
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
  const notices = options.noticeWindow ?? new FailureWindow(1, APP_ID_NOTICE_WINDOW_MS);
  const readTimeoutMs = options.readTimeoutMs ?? READ_TIMEOUT_MS;
  const readIdleTimeoutMs = options.readIdleTimeoutMs ?? READ_IDLE_TIMEOUT_MS;
  const readAdmissionWaitMs = options.readAdmissionWaitMs ?? readIdleTimeoutMs * READ_ADMISSION_WAIT_FACTOR;
  const reads = new WorkSlots(options.maxConcurrentBodyReads ?? GITHUB_WEBHOOK_MAX_CONCURRENT_READS);
  const addressReads = new KeyedWorkSlots(
    options.maxBodyReadsPerAddress ?? GITHUB_WEBHOOK_MAX_READS_PER_ADDRESS,
    MAX_READ_WAITERS_PER_ADDRESS,
  );
  const hashes = new WorkSlots(
    options.maxConcurrentVerifications ?? MAX_CONCURRENT_VERIFICATIONS,
    options.maxHashQueueDepth ?? MAX_HASH_QUEUE_DEPTH,
  );
  const verify = options.verify ?? verifyGitHubSignature;
  const app = new Hono();

  app.post(GITHUB_WEBHOOK_PATH, async (c) => {
    c.header("Cache-Control", "no-store");
    const trustProxy = options.trustProxy ?? trustsProxy();
    const address = clientIp(c, trustProxy) ?? UNATTRIBUTED_KEY;
    const event = c.req.header("X-GitHub-Event")?.trim() ?? "";
    const delivery = c.req.header("X-GitHub-Delivery")?.trim() ?? "";
    const signature = c.req.header("X-Hub-Signature-256")?.trim() ?? "";

    // `extra`, not `options`: shadowing the factory's own options would silently
    // drop the logger.
    const refuse = (status: number, reason: string, extra: { detail?: string; retryAfterMs?: number } = {}): Response => {
      const detail = extra.detail;
      report(options.log, {
        kind: "refused",
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
    const blockedFor = failedVerifications.blocked(address);
    if (blockedFor !== null && !namesKnownWebhookApp(await dependencies.listSecrets(), appId)) {
      return refuse(429, "rate_limited", { retryAfterMs: blockedFor * 1_000 });
    }

    // The read budget is charged to the calling address first and to the process
    // second. Per address the excess *waits*, briefly: the address a flood comes
    // from may be GitHub's own egress, and shedding there would lose the delivery
    // outright. A stalled read is cut off at the idle deadline and its slot passes
    // straight to the waiter, so the flood costs the genuine delivery a delay
    // rather than the event. The global ceiling behind it is shed, not queued: a
    // caller-paced socket must not be able to occupy anything by waiting, and by
    // then the per-address budgets have already made a single flood harmless.
    const admitted = await addressReads.acquire(address, readAdmissionWaitMs);
    if (admitted !== "acquired") return refuse(429, "rate_limited", { retryAfterMs: readIdleTimeoutMs });
    let body: Uint8Array | "too_large" | "timeout" | "no_read_slot" = "no_read_slot";
    try {
      if (reads.tryAcquire()) {
        try {
          body = await readCappedBody(c, { idleMs: readIdleTimeoutMs, totalMs: readTimeoutMs });
        } finally {
          reads.release();
        }
      }
    } finally {
      addressReads.release(address);
    }
    if (body === "no_read_slot") return refuse(429, "rate_limited", { retryAfterMs: readIdleTimeoutMs });
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
          // The budget is held around the hash and the compare, never across I/O.
          // A queue this deep means the process is saturated, which is a state that
          // will pass: `503` with `Retry-After`, not a verdict on the request.
          const slot = await hashes.acquire(HASH_WAIT_MS);
          if (slot !== "acquired") throw new HashQueueBusy();
          let verified: { connectionId: string } | null;
          try {
            verified = await verify(input);
          } finally {
            hashes.release();
          }
          // A recorded App id can be wrong (the installation id, the client id, the
          // slug). Falling back to the capped loop keeps such a connection working,
          // and the notice is what tells the operator to fix the record. It is
          // written only when the delivery *did* verify: that is the actionable
          // case, it names the connection to fix, and it cannot be provoked by an
          // anonymous caller inventing App ids. Once per connection per window,
          // because the condition is a static misconfiguration — the screen's
          // `delivery_verified` step is the standing signal.
          if (selection.unmatchedAppId && verified && notices.blocked(verified.connectionId) === null) {
            notices.fail(verified.connectionId);
            report(options.log, {
              kind: "notice",
              status: 200,
              reason: "webhook_app_id_unmatched",
              deliveryId: delivery.slice(0, MAX_LOGGED_HEADER),
              event: event.slice(0, MAX_LOGGED_HEADER),
            });
          }
          return verified;
        },
      });
    } catch (error) {
      if (error instanceof HashQueueBusy) {
        return refuse(503, "hash_queue_busy", { retryAfterMs: HASH_WAIT_MS });
      }
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
      if (failedVerifications.blocked(address) !== null) {
        return refuse(429, "rate_limited", { retryAfterMs: FAILED_VERIFICATION_WINDOW_MS });
      }
      failedVerifications.fail(address);
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

/**
 * Raised inside the verification callback, which can only answer "verified" or
 * "not verified", to carry a *third* answer out to the HTTP layer: the process is
 * saturated. It is thrown before the delivery is claimed, so nothing is recorded.
 */
class HashQueueBusy extends Error {
  constructor() {
    super("hash_queue_busy");
    this.name = "HashQueueBusy";
  }
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
  const line = `[csb-api] github webhook ${entry.kind === "notice" ? "notice" : "refused"} ${entry.status}`
    + ` ${entry.reason} delivery=${entry.deliveryId ?? "-"} event=${entry.event ?? "-"}${suffix}`;
  // A notice is about a delivery that was accepted: it must not land in the stream
  // an operator reads to find lost events.
  if (entry.kind === "notice") console.info(line);
  else console.warn(line);
}

/**
 * The cap is enforced while reading, not after: a caller that omits
 * `Content-Length` must not be able to make the process buffer an arbitrary body
 * before the ceiling is applied. The two deadlines are the other half.
 *
 * `totalMs` bounds a read that is making progress; `idleMs` bounds one that is
 * not — no first byte, or no byte since the last one. Without the idle deadline a
 * socket that sends *nothing* still held its slot for the full ten seconds, which
 * is what let a flood sustain itself by reconnecting (N-6b). Either way the reader
 * is cancelled, the socket released, and the slots returned.
 */
async function readCappedBody(
  c: Context,
  deadlines: { idleMs: number; totalMs: number },
): Promise<Uint8Array | "too_large" | "timeout"> {
  const stream = c.req.raw.body;
  if (!stream) {
    const buffered = new Uint8Array(await c.req.arrayBuffer());
    return buffered.byteLength > GITHUB_WEBHOOK_MAX_BODY_BYTES ? "too_large" : buffered;
  }
  const reader = stream.getReader();
  let idleTimer: NodeJS.Timeout | undefined;
  let totalTimer: NodeJS.Timeout | undefined;
  let expire: (outcome: "timeout") => void = () => {};
  const expired = new Promise<"timeout">((resolve) => { expire = resolve; });
  // Rearmed on every chunk, so the deadline measures silence rather than duration.
  const armIdle = (): void => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { expire("timeout"); }, deadlines.idleMs);
  };
  armIdle();
  totalTimer = setTimeout(() => { expire("timeout"); }, deadlines.totalMs);
  const read = (async (): Promise<Uint8Array | "too_large"> => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      armIdle();
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
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    if (totalTimer !== undefined) clearTimeout(totalTimer);
    read.catch(() => {});
    try {
      reader.releaseLock();
    } catch {
      // Already released by `cancel()`; nothing to undo.
    }
  }
}
