import type Database from "better-sqlite3";
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
  markEmailCancelled,
  markEmailFailed,
  markEmailSent,
  requeueSendingEmails,
  type EmailOutboxClaim,
} from "./outbox-store.js";
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

/**
 * Why a claimed row must not be sent after all, or `null` when it still should.
 *
 * Re-checked at send time and not only at enqueue time, because a message can
 * sit in the queue for hours: the account may have been disabled or deleted in
 * between. Task 3 extends this with the repository check the design asks for —
 * "the recipient still sees the repository" — by looking at the row's `event` and
 * its scope; account events have no scope to lose.
 */
export function emailCancellationReason(
  row: EmailOutboxClaim,
  database: Database.Database,
): string | null {
  if (row.userId === null) return null;
  const user = getUser(row.userId, database);
  if (user === null) return "The account no longer exists.";
  if (user.status !== "active") return "The account is disabled.";
  return null;
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
 * One pass over the queue: claim, send, record. Nothing is claimed while the
 * provider is off or incomplete — a claimed row would have to be resolved, and
 * the only honest resolution would be a failed attempt the administrator did not
 * cause.
 */
export async function runEmailWorkerTick(
  supplied: Partial<EmailWorkerDependencies> = {},
): Promise<EmailWorkerTick> {
  const deps = dependencies(supplied);
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
 * never be the reason a process stays alive.
 *
 * Starting it is also the recovery step: rows a previous process left `sending`
 * are nobody's now, so they go back to the queue before the first tick.
 */
export function startEmailWorker(
  supplied: Partial<EmailWorkerDependencies> & { intervalMs?: number } = {},
): EmailWorkerHandle {
  const deps = dependencies(supplied);
  const requeued = requeueSendingEmails(deps.now(), deps.database);
  if (requeued > 0) deps.log(`Requeued ${requeued} e-mail(s) left claimed by a previous process`);

  let stopped = false;
  let inFlight: Promise<EmailWorkerTick | null> | null = null;
  let lastSweep = 0;

  const tick = async (): Promise<EmailWorkerTick | null> => {
    if (stopped || inFlight !== null) return null;
    inFlight = (async () => {
      try {
        const now = deps.now();
        if (now.getTime() - lastSweep >= RETENTION_SWEEP_MS) {
          lastSweep = now.getTime();
          const removed = sweepEmailRetention(now, deps.database);
          if (removed > 0) deps.log(`Deleted ${removed} e-mail(s) past the ${EMAIL_RETENTION_DAYS}-day retention window`);
        }
        return await runEmailWorkerTick(deps);
      } catch (error) {
        // A locked database, a closed handle during shutdown, a provider module
        // that failed to load: the loop survives all three and tries again.
        if (!stopped) deps.log(`E-mail worker tick failed: ${error instanceof Error ? error.message : "unknown_error"}`);
        return null;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
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
