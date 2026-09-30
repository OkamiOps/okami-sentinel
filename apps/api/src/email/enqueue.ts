import type Database from "better-sqlite3";
import type { EmailQueueSkip, UserLocale } from "@csb/shared";
import { emailPublicOrigin } from "./origin.js";
import { insertOutboxRow } from "./outbox-store.js";
import { getEmailSettings } from "./settings-store.js";
import { renderEmail, type EmailMessageDataMap, type EmailMessageKind } from "./templates.js";

/**
 * The two reasons this function can decline: the global switch, and the unique
 * `dedupe_key` doing its job. The other members of `EmailQueueSkip` belong to the
 * caller — `no_address` is known before this function is reached, and `error` is
 * what a caller reports when it chose to swallow a failure.
 */
export type EmailEnqueueResult =
  | { status: "queued"; id: string }
  | { status: "skipped"; reason: Extract<EmailQueueSkip, "disabled" | "duplicate"> };

export interface EnqueueEmailOptions {
  /**
   * The global switch, already read by the caller. Only an optimisation: the
   * result is identical either way.
   */
  enabled?: boolean;
}

export interface EnqueueEmailInput<K extends EmailMessageKind> {
  /** The message kind, which is also the outbox row's `event`. */
  event: K;
  /** `account.<userId>.<event>.<reference>`, `gate.<gateId>.<event>`, `scan.<scanId>.<event>`. */
  dedupeKey: string;
  /**
   * The subscription scope the message belongs to — a repository key, or `ops` —
   * stored so the worker can re-check the recipient's access right before it
   * sends. Omitted by account messages, which have no scope to lose.
   */
  scope?: string | null;
  /** The account the message belongs to, or `null` for an address with no account yet. */
  userId: string | null;
  toAddress: string;
  locale: UserLocale;
  data: EmailMessageDataMap[K];
  now?: Date;
  /**
   * Overrides the deployment's public origin. Only tests pass it; production
   * reads `CSB_PUBLIC_ORIGIN` so every message agrees on where the Sentinel is.
   */
  origin?: string | null;
}

/**
 * Renders a message and writes it to the outbox — nothing else. No provider is
 * contacted, no network call is made, and the write lands in whatever
 * transaction the caller is already in, which is the point: the notification and
 * the event that caused it commit together or not at all. A gate result that
 * rolled back must not leave an e-mail behind, and an e-mail must not be lost
 * because the process died between the two writes.
 *
 * The global switch is honoured here rather than in the worker, so a disabled
 * installation accumulates nothing: turning e-mail on should not release a month
 * of backlog into someone's inbox.
 */
export function emailQueueEnabled(database: Database.Database): boolean {
  return getEmailSettings(database).enabled;
}

/**
 * Whether this dedupe key already has a row.
 *
 * `insertOutboxRow` would discard the duplicate anyway, but only after the body was
 * rendered — and the repeated-enqueue callers are the periodic ones: an operational
 * condition re-sampled every sixty seconds, a daily ceiling that stays crossed for
 * the rest of the day. Asking the unique index first turns that into one indexed
 * lookup. The insert's own `ON CONFLICT` is still what makes it correct; this only
 * makes it cheap.
 */
function dedupeKeyTaken(database: Database.Database, dedupeKey: string): boolean {
  return database.prepare("SELECT 1 FROM email_outbox WHERE dedupe_key = ?").get(dedupeKey) !== undefined;
}

export function enqueueEmail<K extends EmailMessageKind>(
  database: Database.Database,
  input: EnqueueEmailInput<K>,
  options: EnqueueEmailOptions = {},
): EmailEnqueueResult {
  // `enabled` lets a caller queuing for many recipients read the switch once
  // instead of once per recipient; omitted, it is read here.
  const enabled = options.enabled ?? emailQueueEnabled(database);
  if (!enabled) return { status: "skipped", reason: "disabled" };
  if (dedupeKeyTaken(database, input.dedupeKey)) return { status: "skipped", reason: "duplicate" };
  const now = input.now ?? new Date();
  const rendered = renderEmail({
    kind: input.event,
    data: input.data,
    locale: input.locale,
    origin: input.origin === undefined ? emailPublicOrigin() : input.origin,
  });
  const id = insertOutboxRow({
    event: input.event,
    dedupeKey: input.dedupeKey,
    scope: input.scope ?? null,
    userId: input.userId,
    toAddress: input.toAddress,
    locale: input.locale,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
  }, now, database);
  // A taken dedupe key is the expected outcome of the same event being observed
  // twice, not an error: the first row already carries the message.
  return id === null ? { status: "skipped", reason: "duplicate" } : { status: "queued", id };
}
