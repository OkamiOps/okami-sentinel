/**
 * The notification catalogue both runtimes agree on: which events exist, which
 * group they belong to, what a user receives when they have never touched the
 * matrix, and the shape of `GET`/`PUT /account/notifications`.
 *
 * The event ids are also the `event` column of `email_outbox` and the `event`
 * column of `notification_subscriptions`, so a subscription, a queued message
 * and a template can never disagree about which event they are about.
 */

import type { UserLocale } from "./email.js";
// Type-only, so this module and `index.ts` can reference each other without a
// runtime cycle.
import type { RepositoryRole } from "./index.js";

/**
 * Events about one repository. Sent to everybody with `viewer` or above on it,
 * filtered by that person's subscription for that repository.
 */
export const REPOSITORY_NOTIFICATION_EVENTS = [
  "gate.blocked",
  "gate.error",
  "gate.passed",
  "scan.failed",
  "scan.completed",
] as const;

export type RepositoryNotificationEvent = (typeof REPOSITORY_NOTIFICATION_EVENTS)[number];

/** Events about the installation itself. Administrators only. */
export const OPS_NOTIFICATION_EVENTS = [
  "ops.engine_unavailable",
  "ops.connection_attention",
  "ops.daily_cost",
  "ops.github_publish_failed",
] as const;

export type OpsNotificationEvent = (typeof OPS_NOTIFICATION_EVENTS)[number];

/**
 * Security notices about one account. Always on: they are the messages that tell
 * somebody their account was locked, reset or used from a new device, and a
 * switch for those would be a switch for an attacker to find.
 */
export const ACCOUNT_NOTIFICATION_EVENTS = [
  "account.invite",
  "account.reset",
  "account.new_login",
  "account.locked",
  "account.password_changed",
] as const;

export type AccountNotificationEvent = (typeof ACCOUNT_NOTIFICATION_EVENTS)[number];

/** Everything a row in `notification_subscriptions` may be about. */
export type NotificationEvent = RepositoryNotificationEvent | OpsNotificationEvent;

/** The `scope` value the operational row uses. */
export const OPS_NOTIFICATION_SCOPE = "ops";

/**
 * The `scope` value for scans that belong to no repository — a filesystem scan,
 * or one started before the repository was enrolled. The design sends those to
 * administrators only; they still have to be filtered by a subscription, and a
 * subscription needs a scope, so they get this one.
 */
export const UNASSIGNED_NOTIFICATION_SCOPE = "unassigned";

/**
 * Scopes that are not repository keys. A repository key can never be one of
 * these — every key the product mints is `github.com/<owner>/<name>` or
 * `local/<name>`, so it always contains a separator — and
 * `isReservedNotificationScope` is what states that rather than assuming it.
 */
export const RESERVED_NOTIFICATION_SCOPES: readonly string[] = Object.freeze([
  OPS_NOTIFICATION_SCOPE,
  UNASSIGNED_NOTIFICATION_SCOPE,
]);

export function isReservedNotificationScope(scope: string): boolean {
  return RESERVED_NOTIFICATION_SCOPES.includes(scope);
}

/**
 * The events a repository-less scan can produce. A gate always names a
 * repository, so only the two scan events reach the reserved scope.
 */
export const UNASSIGNED_NOTIFICATION_EVENTS = ["scan.failed", "scan.completed"] as const;

export type UnassignedNotificationEvent = (typeof UNASSIGNED_NOTIFICATION_EVENTS)[number];

/**
 * What the absence of a row means, straight from the design's event table: the
 * results that need somebody's attention are on, and the two that merely say
 * "nothing happened" are off.
 */
export const NOTIFICATION_DEFAULTS: Readonly<Record<NotificationEvent, boolean>> = Object.freeze({
  "gate.blocked": true,
  "gate.error": true,
  "gate.passed": false,
  "scan.failed": true,
  "scan.completed": false,
  "ops.engine_unavailable": true,
  "ops.connection_attention": true,
  "ops.daily_cost": true,
  "ops.github_publish_failed": true,
});

export function isRepositoryNotificationEvent(value: unknown): value is RepositoryNotificationEvent {
  return typeof value === "string"
    && (REPOSITORY_NOTIFICATION_EVENTS as readonly string[]).includes(value);
}

export function isOpsNotificationEvent(value: unknown): value is OpsNotificationEvent {
  return typeof value === "string" && (OPS_NOTIFICATION_EVENTS as readonly string[]).includes(value);
}

export function isAccountNotificationEvent(value: unknown): value is AccountNotificationEvent {
  return typeof value === "string"
    && (ACCOUNT_NOTIFICATION_EVENTS as readonly string[]).includes(value);
}

export function isNotificationEvent(value: unknown): value is NotificationEvent {
  return isRepositoryNotificationEvent(value) || isOpsNotificationEvent(value);
}

/** One cell of the matrix: what is in force, and whether that is still the default. */
export interface NotificationEventState {
  event: NotificationEvent;
  enabled: boolean;
  /** `true` while no row exists, so the screen can show "default" honestly. */
  isDefault: boolean;
}

export interface NotificationRepositoryScope {
  repositoryKey: string;
  displayName: string;
  source: "local" | "github";
  /** The caller's own grant, or `null` when they see it as an administrator. */
  role: RepositoryRole | null;
  events: NotificationEventState[];
}

export interface NotificationOpsScope {
  events: NotificationEventState[];
}

/** The row for scans with no repository; administrators only, like `ops`. */
export interface NotificationUnassignedScope {
  events: NotificationEventState[];
}

/**
 * The effective matrix for one caller. `address` is `null` when nothing can be
 * sent to this account, which is the warning Minha conta shows.
 */
export interface AccountNotificationsResponse {
  address: string | null;
  locale: UserLocale;
  repositories: NotificationRepositoryScope[];
  /** Present only for administrators. */
  ops: NotificationOpsScope | null;
  /**
   * Scans that belong to no repository. Present only for administrators, because
   * they are the only recipients those scans have.
   */
  unassigned: NotificationUnassignedScope | null;
  /** Shown as always on; never editable. */
  accountEvents: readonly AccountNotificationEvent[];
}

export interface AccountNotificationsUpdateEntry {
  /** A repository key, `ops`, or `unassigned`. */
  scope: string;
  event: NotificationEvent;
  enabled: boolean;
}

export interface AccountNotificationsUpdateRequest {
  subscriptions: AccountNotificationsUpdateEntry[];
}

/**
 * Why `PUT /account/notifications` refused. `scope_unknown` deliberately covers
 * both "no such repository" and "not shared with you", so the error cannot be
 * used to find out which repositories exist.
 */
export type AccountNotificationsError =
  | "subscriptions_invalid"
  | "scope_unknown"
  | "ops_forbidden"
  | "unassigned_forbidden"
  | "event_invalid"
  | "event_not_editable"
  | "enabled_invalid";
