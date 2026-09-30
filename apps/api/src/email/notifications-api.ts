import type Database from "better-sqlite3";
import { Hono, type Context } from "hono";
import {
  ACCOUNT_NOTIFICATION_EVENTS,
  isAccountNotificationEvent,
  isNotificationEvent,
  isOpsNotificationEvent,
  isRepositoryNotificationEvent,
  NOTIFICATION_DEFAULTS,
  OPS_NOTIFICATION_EVENTS,
  OPS_NOTIFICATION_SCOPE,
  REPOSITORY_NOTIFICATION_EVENTS,
  type AccountNotificationsError,
  type AccountNotificationsResponse,
  type NotificationEvent,
  type NotificationEventState,
  type NotificationRepositoryScope,
} from "@csb/shared";
import { principalOf } from "../auth/principal.js";
import { getUser } from "../auth/user-store.js";
import { getDb } from "../db.js";
import type { ServerSettings } from "../deployment-settings.js";
import { listGuardrailRepositories } from "../gate-store.js";
import { localeOf, resolveUserEmailAddress } from "./address.js";
import { replaceSubscriptions, subscriptionOverrides } from "./subscription-store.js";

/**
 * Minha conta → Notificações, both directions.
 *
 * The matrix the caller gets is *effective*: one row per repository they can see
 * right now, the operational row only when they are an administrator, and every
 * cell resolved against the defaults so the screen never has to know which of
 * them came from a stored row. `PUT` accepts only the cells the same rules make
 * editable, and rejects the whole batch rather than writing half of it.
 */

function cells(
  scope: string,
  events: readonly NotificationEvent[],
  overrides: ReadonlyMap<string, boolean>,
): NotificationEventState[] {
  return events.map((event) => {
    const stored = overrides.get(`${scope}\n${event}`);
    return {
      event,
      enabled: stored ?? NOTIFICATION_DEFAULTS[event],
      isDefault: stored === undefined,
    };
  });
}

interface VisibleRepository {
  repositoryKey: string;
  displayName: string;
  source: "local" | "github";
  role: NotificationRepositoryScope["role"];
}

/**
 * The repositories one caller may subscribe to. An administrator sees every
 * registered repository, because an administrator can already read every one of
 * them; anybody else sees exactly their grants, and a grant naming a repository
 * that no longer exists contributes nothing.
 */
function visibleRepositories(
  principal: { isAdmin: boolean; grants: ReadonlyMap<string, NonNullable<NotificationRepositoryScope["role"]>> },
  database: Database.Database,
): VisibleRepository[] {
  return listGuardrailRepositories(database)
    .filter((repository) => principal.isAdmin || principal.grants.has(repository.repositoryKey))
    .map((repository) => ({
      repositoryKey: repository.repositoryKey,
      displayName: repository.displayName,
      source: repository.source,
      role: principal.grants.get(repository.repositoryKey) ?? null,
    }));
}

export function accountNotificationsMatrix(
  userId: string,
  database: Database.Database,
): AccountNotificationsResponse {
  const user = getUser(userId, database);
  if (user === null) throw new Error("user_missing");
  const principal = principalFromUser(userId, database);
  const overrides = subscriptionOverrides(userId, database);
  return {
    address: resolveUserEmailAddress(user),
    locale: localeOf(user),
    repositories: visibleRepositories(principal, database).map((repository) => ({
      ...repository,
      events: cells(repository.repositoryKey, REPOSITORY_NOTIFICATION_EVENTS, overrides),
    })),
    ops: principal.isAdmin
      ? { events: cells(OPS_NOTIFICATION_SCOPE, OPS_NOTIFICATION_EVENTS, overrides) }
      : null,
    accountEvents: ACCOUNT_NOTIFICATION_EVENTS,
  };
}

/**
 * The caller's access read from the store rather than from their session. A grant
 * revoked a minute ago must not still be editable because the cookie predates the
 * revocation.
 */
function principalFromUser(
  userId: string,
  database: Database.Database,
): { isAdmin: boolean; grants: ReadonlyMap<string, NonNullable<NotificationRepositoryScope["role"]>> } {
  const user = database.prepare("SELECT is_admin FROM users WHERE id = ?")
    .get(userId) as { is_admin: number } | undefined;
  const rows = database.prepare("SELECT repository_key, role FROM repository_grants WHERE user_id = ?")
    .all(userId) as Array<{ repository_key: string; role: NonNullable<NotificationRepositoryScope["role"]> }>;
  return {
    isAdmin: user?.is_admin === 1,
    grants: new Map(rows.map((row) => [row.repository_key, row.role])),
  };
}

type ParsedUpdate =
  | { ok: true; entries: Array<{ scope: string; event: NotificationEvent; enabled: boolean }> }
  | { ok: false; error: AccountNotificationsError; scope?: string; event?: string };

/**
 * Validates the whole batch before anything is written. The cheap structural
 * checks come first and the access checks last, so a malformed body is named as
 * malformed instead of as a permission problem.
 */
export function parseNotificationUpdate(
  input: unknown,
  access: { isAdmin: boolean; visibleRepositoryKeys: ReadonlySet<string> },
): ParsedUpdate {
  const value = input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>).subscriptions
    : undefined;
  if (!Array.isArray(value)) return { ok: false, error: "subscriptions_invalid" };
  const entries: Array<{ scope: string; event: NotificationEvent; enabled: boolean }> = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "subscriptions_invalid" };
    const { scope, event, enabled } = raw as Record<string, unknown>;
    if (typeof scope !== "string" || scope === "") return { ok: false, error: "subscriptions_invalid" };
    if (typeof enabled !== "boolean") return { ok: false, error: "enabled_invalid", scope, event: String(event) };
    // An account event is a security notice, not a preference. Named separately
    // from an unknown event so the screen can explain the difference.
    if (isAccountNotificationEvent(event)) {
      return { ok: false, error: "event_not_editable", scope, event };
    }
    if (!isNotificationEvent(event)) return { ok: false, error: "event_invalid", scope, event: String(event) };
    if (scope === OPS_NOTIFICATION_SCOPE) {
      if (!isOpsNotificationEvent(event)) return { ok: false, error: "event_invalid", scope, event };
      if (!access.isAdmin) return { ok: false, error: "ops_forbidden", scope, event };
    } else {
      if (!isRepositoryNotificationEvent(event)) return { ok: false, error: "event_invalid", scope, event };
      // One code for "no such repository" and for "not shared with you": the
      // difference would be an enumeration oracle for a member.
      if (!access.visibleRepositoryKeys.has(scope)) return { ok: false, error: "scope_unknown", scope, event };
    }
    const key = `${scope}\n${event}`;
    if (seen.has(key)) return { ok: false, error: "subscriptions_invalid", scope, event };
    seen.add(key);
    entries.push({ scope, event, enabled });
  }
  return { ok: true, entries };
}

async function body(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

export interface NotificationsApiDependencies {
  settings: ServerSettings;
  /** Injected so a test can hold its own database instead of the shared file. */
  database: () => Database.Database;
}

export function createNotificationsApi(supplied: {
  settings: ServerSettings;
  database?: () => Database.Database;
}): Hono {
  const deps: NotificationsApiDependencies = {
    settings: supplied.settings,
    database: supplied.database ?? (() => getDb()),
  };
  const api = new Hono();
  const server = deps.settings.mode === "server";

  // The matrix names repositories and an address; a shared cache would hand one
  // account's answer to the next.
  api.use("/account/notifications", async (c, next) => {
    c.header("Cache-Control", "no-store");
    return next();
  });

  api.get("/account/notifications", (c) => {
    const principal = principalOf(c);
    // Local mode has no accounts, so there is nothing to subscribe and nobody to
    // subscribe it — the same answer `/account/profile` gives.
    if (!server || !principal.userId) return c.json({ error: "not_found" }, 404);
    return c.json(accountNotificationsMatrix(principal.userId, deps.database()));
  });

  api.put("/account/notifications", async (c) => {
    const principal = principalOf(c);
    if (!server || !principal.userId) return c.json({ error: "not_found" }, 404);
    const userId = principal.userId;
    const database = deps.database();
    const access = principalFromUser(userId, database);
    const parsed = parseNotificationUpdate(await body(c), {
      isAdmin: access.isAdmin,
      visibleRepositoryKeys: new Set(
        visibleRepositories(access, database).map((repository) => repository.repositoryKey),
      ),
    });
    if (!parsed.ok) {
      return c.json({
        error: parsed.error,
        ...(parsed.scope === undefined ? {} : { scope: parsed.scope }),
        ...(parsed.event === undefined ? {} : { event: parsed.event }),
      }, 400);
    }
    replaceSubscriptions(userId, parsed.entries, database);
    return c.json(accountNotificationsMatrix(userId, database));
  });

  return api;
}
