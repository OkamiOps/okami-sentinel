import {
  ACCOUNT_NOTIFICATION_EVENTS,
  OPS_NOTIFICATION_EVENTS,
  REPOSITORY_NOTIFICATION_EVENTS,
} from "@csb/shared";
import type { EmailMessageKey } from "../i18n/email";

/**
 * The delivery history shows whatever event id the outbox holds, which is a
 * wider set than the subscription matrix: the test send, and the `.resolved`
 * counterpart of the operational alerts. Both are named out of the same event
 * labels the matrix uses, so the two screens cannot disagree, and an id this
 * build has never heard of is printed verbatim instead of being hidden.
 */
const KNOWN_EVENTS: readonly string[] = Object.freeze([
  ...REPOSITORY_NOTIFICATION_EVENTS,
  ...OPS_NOTIFICATION_EVENTS,
  ...ACCOUNT_NOTIFICATION_EVENTS,
]);

const RESOLVED_SUFFIX = ".resolved";

export interface EmailEventDescription {
  /** The translation key for the base event, or `null` when unknown. */
  key: EmailMessageKey | null;
  /** True for the "the condition ended" counterpart of an ops alert. */
  resolved: boolean;
  /** The id itself, for the fallback and for a title attribute. */
  raw: string;
}

export function describeEmailEvent(event: string): EmailEventDescription {
  const resolved = event.endsWith(RESOLVED_SUFFIX);
  const base = resolved ? event.slice(0, -RESOLVED_SUFFIX.length) : event;
  if (base === "account.test") return { key: "email.event.account.test", resolved, raw: event };
  if (!KNOWN_EVENTS.includes(base)) return { key: null, resolved, raw: event };
  return { key: `notifications.event.${base}` as EmailMessageKey, resolved, raw: event };
}

/** `Engine unavailable · resolved`, or the raw id when nothing is known. */
export function emailEventLabel(event: string, t: (key: EmailMessageKey) => string): string {
  const description = describeEmailEvent(event);
  if (description.key === null) return description.raw;
  const base = t(description.key);
  return description.resolved ? `${base} · ${t("email.resolvedSuffix")}` : base;
}
