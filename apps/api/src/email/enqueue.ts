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

export interface EnqueueEmailInput<K extends EmailMessageKind> {
  /** The message kind, which is also the outbox row's `event`. */
  event: K;
  /** `account.<userId>.<event>.<reference>`, `gate.<gateId>.<event>`, `scan.<scanId>.<event>`. */
  dedupeKey: string;
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
export function enqueueEmail<K extends EmailMessageKind>(
  database: Database.Database,
  input: EnqueueEmailInput<K>,
): EmailEnqueueResult {
  if (!getEmailSettings(database).enabled) return { status: "skipped", reason: "disabled" };
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
