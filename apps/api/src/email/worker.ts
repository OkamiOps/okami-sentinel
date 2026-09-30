import type Database from "better-sqlite3";
import { OPS_NOTIFICATION_SCOPE } from "@csb/shared";
import { INVITE_TTL_MS } from "../auth/invite-store.js";
import { getUser } from "../auth/user-store.js";
import {
  createSystemEmailCredentialStore,
  type EmailCredentialStore,
} from "../credentials/system-email-credential-store.js";
import { getDb } from "../db.js";
import { globalSecretRedactor } from "../redaction.js";
import {
  claimDueEmails,
  deleteFinishedEmailsBefore,
  expireLinkBearingEmails,
  listInterruptedEmails,
  markEmailCancelled,
  markEmailFailed,
  markEmailSent,
  type EmailOutboxClaim,
} from "./outbox-store.js";
import { userSeesRepository } from "./recipients.js";
import { activeEmailTransportConfig } from "./transport-config.js";
import {
  createEmailTransport,
  EmailTransportError,
  type EmailTransport,
  type EmailTransportConfig,
} from "./transport.js";

/** Every five seconds, as the design fixes it. */
export const EMAIL_WORKER_INTERVAL_MS = 5_000;
/** One tick's bite of the queue, so a large backlog cannot hold the loop. */
export const EMAIL_WORKER_BATCH = 10;
/** 1 min, 5 min, 30 min, 2 h — and the fifth attempt is the last one. */
export const EMAIL_RETRY_DELAYS_MS: readonly number[] = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000];
export const EMAIL_MAX_ATTEMPTS = 5;
export const EMAIL_RETENTION_DAYS = 90;
const RETENTION_SWEEP_MS = 24 * 3_600_000;
/** What a row says after the process that was sending it went away. */
export const EMAIL_INTERRUPTED_ERROR = "The send was interrupted by a restart.";
/** What a link-bearing row says once its token is past `INVITE_TTL_MS`. */
export const EMAIL_LINK_EXPIRED_ERROR = "The link expired before the message could be sent.";

/**
 * When the next attempt is due, or `null` when there will not be one.
 *
 * `attempts` is what the row had recorded *before* the attempt that just failed,
 * so the fifth failure — `attempts` 4 — is the end of the road. A permanent
 * failure does not come through here: it counts as an attempt, like the design
 * says, and stops immediately, because retrying a refused address or a rejected
 * credential four more times is four more rejections and two more hours of a
 * message that will never arrive sitting in the queue looking alive.
 */
export function nextEmailAttemptAt(attempts: number, now: Date): string | null {
  if (attempts + 1 >= EMAIL_MAX_ATTEMPTS) return null;
  const delay = EMAIL_RETRY_DELAYS_MS[attempts] ?? EMAIL_RETRY_DELAYS_MS.at(-1)!;
  return new Date(now.getTime() + delay).toISOString();
}

/** What a row says when its recipient lost the access the message was about. */
export const EMAIL_ACCESS_LOST_ERROR = "The recipient no longer sees this repository.";
/** What an operational row says when its recipient is no longer an administrator. */
export const EMAIL_NOT_ADMIN_ERROR = "The recipient is no longer an administrator.";

/**
 * Why a claimed row must not be sent after all, or `null` when it still should.
 *
 * Re-checked at send time and not only at enqueue time, because a message can sit
 * in the queue for hours: the account may have been disabled, or may have lost the
 * repository the message is about. The design asks for exactly that — "o acesso é
 * verificado de novo no momento do envio" — and for the subscription row itself to
 * survive, in case the access comes back.
 *
 * The scope comes from the row's own `scope` column rather than from the event id
 * or the body. By the time a queued `gate.blocked` is sent, the gate may have been
 * deleted, so the event cannot be resolved back to a repository; and a rendered
 * body is not a place to look anything up.
 */
export function emailCancellationReason(
  row: EmailOutboxClaim,
  database: Database.Database,
): string | null {
  if (row.userId === null) return null;
  const user = getUser(row.userId, database);
  if (user === null) return "The account no longer exists.";
  if (user.status !== "active") return "The account is disabled.";
  if (row.scope === null) return null;
  if (row.scope === OPS_NOTIFICATION_SCOPE) {
    return user.isAdmin ? null : EMAIL_NOT_ADMIN_ERROR;
  }
  return userSeesRepository(row.userId, row.scope, database) ? null : EMAIL_ACCESS_LOST_ERROR;
}

export interface EmailWorkerDependencies {
  database: Database.Database;
  now: () => Date;
  secrets: EmailCredentialStore;
  transport: (config: EmailTransportConfig) => EmailTransport;
  /** Never given a body, a token or an address: the outbox already has those. */
  log: (message: string) => void;
}

export interface EmailWorkerTick {
  /** Why the tick sent nothing, when it sent nothing. */
  skipped: "disabled" | "not_configured" | "secret_unavailable" | "empty" | null;
  sent: number;
  retried: number;
  failed: number;
  cancelled: number;
}

const EMPTY_TICK: EmailWorkerTick = { skipped: "empty", sent: 0, retried: 0, failed: 0, cancelled: 0 };

function dependencies(supplied: Partial<EmailWorkerDependencies> = {}): EmailWorkerDependencies {
  return {
    database: supplied.database ?? getDb(),
    now: supplied.now ?? (() => new Date()),
    secrets: supplied.secrets ?? createSystemEmailCredentialStore({ redactor: globalSecretRedactor }),
    transport: supplied.transport ?? ((config) => createEmailTransport(config)),
    log: supplied.log ?? ((message) => console.warn(`[csb-api] ${message}`)),
  };
}

/**
 * What a starting worker does about the rows a dead process left claimed.
 *
 * A requeue costs the message an attempt and the next backoff step, because the
 * process may have died *because* of this message: handing it straight back would
 * let one poisonous row restart the API forever. A test send is not requeued at
 * all — the settings screen sends it inside the request and the worker never
 * claims it, so returning it to the queue would leave it there for good.
 */
export function recoverInterruptedEmails(
  now: Date,
  database: Database.Database,
): { requeued: number; abandoned: number } {
  let requeued = 0;
  let abandoned = 0;
  for (const row of listInterruptedEmails(database)) {
    const nextAttemptAt = row.event === "account.test" ? null : nextEmailAttemptAt(row.attempts, now);
    markEmailFailed(row.id, EMAIL_INTERRUPTED_ERROR, nextAttemptAt, database);
    if (nextAttemptAt === null) abandoned += 1;
    else requeued += 1;
  }
  return { requeued, abandoned };
}

/**
 * Cancels the invites and resets whose link died in the queue. Run on every tick
 * and before the provider is even looked at: a dead token must not be delivered
 * just because e-mail came back on four days later.
 */
export function expireStaleLinkEmails(now: Date, database: Database.Database): number {
  return expireLinkBearingEmails(new Date(now.getTime() - INVITE_TTL_MS), EMAIL_LINK_EXPIRED_ERROR, database);
}

/**
 * A failure named by its kind and nothing else. An exception's message is written
 * by whoever threw it — a provider, a driver, a module loader — so only the parts
 * that cannot carry an address, a subject or a token reach the log.
 */
export function describeWorkerFailure(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error
    ? (error as { code: unknown }).code
    : undefined;
  const name = error instanceof Error ? error.name : "unknown_error";
  return typeof code === "string" && code !== "" ? `${name}/${code}` : name;
}

/**
 * One pass over the queue: claim, send, record. Nothing is claimed while the
 * provider is off or incomplete — a claimed row would have to be resolved, and
 * the only honest resolution would be a failed attempt the administrator did not
 * cause.
 */
export async function runEmailWorkerTick(
  supplied: Partial<EmailWorkerDependencies> = {},
): Promise<EmailWorkerTick> {
  const deps = dependencies(supplied);
  const expired = expireStaleLinkEmails(deps.now(), deps.database);
  if (expired > 0) deps.log(`Cancelled ${expired} e-mail(s) whose invitation link had expired`);
  const active = await activeEmailTransportConfig(deps.secrets, deps.database);
  if (active.status !== "ready") return { ...EMPTY_TICK, skipped: active.status };

  const rows = claimDueEmails(EMAIL_WORKER_BATCH, deps.now(), deps.database);
  if (rows.length === 0) return { ...EMPTY_TICK };

  const transport = deps.transport(active.config);
  const tick: EmailWorkerTick = { skipped: null, sent: 0, retried: 0, failed: 0, cancelled: 0 };
  for (const row of rows) {
    const cancellation = emailCancellationReason(row, deps.database);
    if (cancellation !== null) {
      markEmailCancelled(row.id, cancellation, deps.database);
      tick.cancelled += 1;
      continue;
    }
    try {
      const result = await transport.send({
        to: row.toAddress,
        subject: row.subject,
        html: row.html,
        text: row.text,
        // The outbox id, so a retry of this row is the same message to the
        // provider and not a second copy of it.
        idempotencyKey: row.id,
      });
      markEmailSent(row.id, result.providerMessageId, deps.now(), deps.database);
      tick.sent += 1;
    } catch (error) {
      const failure = error instanceof EmailTransportError
        ? { code: error.code, message: error.message, permanent: error.permanent }
        : { code: "provider_unavailable" as const, message: "The provider is unavailable.", permanent: false };
      const nextAttemptAt = failure.permanent ? null : nextEmailAttemptAt(row.attempts, deps.now());
      markEmailFailed(row.id, failure.message, nextAttemptAt, deps.database);
      if (nextAttemptAt === null) tick.failed += 1;
      else tick.retried += 1;
      // The row id and the provider's error code; never the recipient, the
      // subject or the body.
      deps.log(`E-mail ${row.id} (${row.event}) ${nextAttemptAt === null ? "failed" : "will retry"}: ${failure.code}`);
    }
  }
  return tick;
}

/** Deletes delivered and cancelled messages older than the retention window. */
export function sweepEmailRetention(
  now: Date,
  database: Database.Database = getDb(),
): number {
  return deleteFinishedEmailsBefore(
    new Date(now.getTime() - EMAIL_RETENTION_DAYS * 24 * 3_600_000),
    database,
  );
}

export interface EmailWorkerHandle {
  /** Stops the timer and resolves once the tick in flight has finished. */
  stop(): Promise<void>;
  /** For tests: runs one tick now, respecting the no-overlap rule. */
  tick(): Promise<EmailWorkerTick | null>;
}

/**
 * The in-process loop. One timer, never two ticks at once — a slow provider must
 * delay the queue, not multiply the workers reading it — and `unref`ed so it can
 * never be the reason a process stays alive. Building it touches nothing, so it
 * cannot fail; the first tick does the recovery.
 */
export function startEmailWorker(
  supplied: Partial<EmailWorkerDependencies> & { intervalMs?: number } = {},
): EmailWorkerHandle {
  const deps = dependencies(supplied);
  let stopped = false;
  // Two separate things: `running` is the overlap guard and must be cleared by a
  // tick that throws before its first `await` — which a promise's own `finally`
  // cannot do, because it runs before the assignment that stored the promise.
  // `inFlight` exists only so `stop()` can wait for the work to finish.
  let running = false;
  let inFlight: Promise<EmailWorkerTick | null> | null = null;
  let recovered = false;
  let lastSweep = 0;

  const tick = async (): Promise<EmailWorkerTick | null> => {
    if (stopped || running) return null;
    running = true;
    const run = (async (): Promise<EmailWorkerTick | null> => {
      try {
        const now = deps.now();
        // Recovery belongs to the first tick that manages it, not to the process's
        // startup: a locked database at boot must not be able to stop the API, and
        // a failure here is simply retried five seconds later.
        if (!recovered) {
          const { requeued, abandoned } = recoverInterruptedEmails(now, deps.database);
          recovered = true;
          if (requeued > 0 || abandoned > 0) {
            deps.log(`Recovered ${requeued} and abandoned ${abandoned} e-mail(s) left claimed by a previous process`);
          }
        }
        if (now.getTime() - lastSweep >= RETENTION_SWEEP_MS) {
          lastSweep = now.getTime();
          const removed = sweepEmailRetention(now, deps.database);
          if (removed > 0) deps.log(`Deleted ${removed} e-mail(s) past the ${EMAIL_RETENTION_DAYS}-day retention window`);
        }
        return await runEmailWorkerTick(deps);
      } catch (error) {
        // A locked database, a closed handle during shutdown, a provider module
        // that failed to load: the loop survives all three and tries again.
        if (!stopped) deps.log(`E-mail worker tick failed: ${describeWorkerFailure(error)}`);
        return null;
      } finally {
        running = false;
      }
    })();
    inFlight = run;
    void run.then(() => { if (inFlight === run) inFlight = null; });
    return run;
  };

  const timer = setInterval(() => { void tick(); }, supplied.intervalMs ?? EMAIL_WORKER_INTERVAL_MS);
  timer.unref();

  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      // Awaited rather than abandoned: the store is closed right after this, and
      // a send resolving into a closed database would lose the `sent` mark.
      await inFlight?.catch(() => undefined);
    },
    tick,
  };
}
