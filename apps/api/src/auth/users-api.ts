import type Database from "better-sqlite3";
import { Hono, type Context, type Next } from "hono";
import {
  DEFAULT_USER_LOCALE,
  type EmailQueueSkip,
  type InviteLinkResponse,
  type RepositoryGrant,
  type RepositoryRole,
  type UserLocale,
  type UserSessionSummary,
  type UserSummary,
} from "@csb/shared";
import { getDb } from "../db.js";
import { localeOf, resolveUserEmailAddress } from "../email/address.js";
import { enqueueEmail, type EmailEnqueueResult, type EnqueueEmailInput } from "../email/enqueue.js";
import { failureKind } from "../email/failure-kind.js";
import { countUserGrants, listRepositoryAccess, listUserGrants, replaceUserGrants, setRepositoryGrant } from "./grant-store.js";
import { createInvite, hasOpenInvite } from "./invite-store.js";
import { principalOf, ROLE_RANK } from "./principal.js";
import { listUserSessions, revokeUserSessions } from "./session-store.js";
import { countActiveAdmins, createUser, getUser, listUsers, updateUser, type UserRecord } from "./user-store.js";

function summary(user: UserRecord): UserSummary {
  return {
    id: user.id, username: user.username, displayName: user.displayName, email: user.email,
    isAdmin: user.isAdmin, status: user.status, hasPassword: user.passwordHash !== null,
    pendingInvite: hasOpenInvite(user.id), repositoryCount: countUserGrants(user.id),
    lastLoginAt: user.lastLoginAt, createdAt: user.createdAt,
  };
}

type GrantsInput = { ok: true; grants: RepositoryGrant[] } | { ok: false; error: "role_invalid" | "repository_duplicate" };

/**
 * A repeated repositoryKey would reach SQLite as a UNIQUE violation inside
 * `replaceUserGrants`, so it is rejected here while the request is still an
 * input-validation problem.
 */
function grantsFrom(value: unknown): GrantsInput {
  if (!Array.isArray(value)) return { ok: false, error: "role_invalid" };
  const grants: RepositoryGrant[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return { ok: false, error: "role_invalid" };
    const { repositoryKey, role } = entry as Record<string, unknown>;
    if (typeof repositoryKey !== "string" || !repositoryKey || typeof role !== "string" || !(role in ROLE_RANK)) {
      return { ok: false, error: "role_invalid" };
    }
    if (seen.has(repositoryKey)) return { ok: false, error: "repository_duplicate" };
    seen.add(repositoryKey);
    grants.push({ repositoryKey, role: role as RepositoryRole });
  }
  return { ok: true, grants };
}

async function json(c: Context): Promise<Record<string, unknown>> {
  try {
    const value = await c.req.json();
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/** Task 11's policy already gates these paths; this is the defense in depth. */
async function adminOnly(c: Context, next: Next): Promise<Response | void> {
  if (principalOf(c).isAdmin) return next();
  return c.json({ error: "forbidden" }, 403);
}

/**
 * The one thing these routes need from the outbox. Narrow on purpose: an invite
 * and a reset are the only messages an administrator's action here produces, and
 * a port this small is trivial to stand in for.
 */
export type InviteEmailPort = (
  database: Database.Database,
  input: EnqueueEmailInput<"account.invite"> | EnqueueEmailInput<"account.reset">,
) => EmailEnqueueResult;

export interface UsersApiDependencies {
  publicOrigin: string | null;
  enqueue: InviteEmailPort;
  now: () => Date;
}

export function createUsersApi(supplied: { publicOrigin: string | null } & Partial<UsersApiDependencies>): Hono {
  const deps: UsersApiDependencies = {
    publicOrigin: supplied.publicOrigin,
    enqueue: supplied.enqueue ?? ((database, input) => enqueueEmail(database, input)),
    now: supplied.now ?? (() => new Date()),
  };
  const api = new Hono();

  /**
   * Queues the invite or the reset, and reports what happened without ever
   * getting in the way: the link in the response is what an administrator can
   * always fall back on, so no outcome here is an error. The address is the
   * user's own — the e-mail on file, or the username when the team signs in with
   * work addresses.
   */
  const queueLink = (
    purpose: "invite" | "reset",
    user: UserRecord,
    link: { token: string; expiresAt: string },
    locale: UserLocale,
    inviterName: string | null,
  ): Pick<InviteLinkResponse, "emailQueued" | "emailSkipped" | "emailTo"> => {
    const answer = (emailQueued: boolean, emailSkipped: EmailQueueSkip | null, emailTo: string | null) =>
      ({ emailQueued, emailSkipped, emailTo });
    const to = resolveUserEmailAddress(user);
    if (to === null) return answer(false, "no_address", null);
    try {
      const result = deps.enqueue(getDb(), purpose === "invite"
        ? {
          event: "account.invite", userId: user.id, toAddress: to, locale,
          dedupeKey: `account.${user.id}.invite.${link.expiresAt}`,
          data: { inviterName, inviteToken: link.token, expiresAt: new Date(link.expiresAt) },
          now: deps.now(),
        }
        : {
          event: "account.reset", userId: user.id, toAddress: to, locale,
          dedupeKey: `account.${user.id}.reset.${link.expiresAt}`,
          data: { resetToken: link.token, expiresAt: new Date(link.expiresAt) },
          now: deps.now(),
        });
      return result.status === "queued" ? answer(true, null, to) : answer(false, result.reason, to);
    } catch (error) {
      // The account exists, the link works, and the only thing lost is the
      // message. Say so instead of failing the request — and say it by kind: the
      // exception's own message is written by whoever threw it, and this one is
      // thrown next to an address and an invitation token.
      console.warn(`[csb-api] Could not queue the ${purpose} e-mail for ${user.id}: ${failureKind(error)}`);
      return answer(false, "error", to);
    }
  };

  // Local mode has no public origin, so the link stays relative to the UI.
  const inviteLink = (
    token: string,
    expiresAt: string,
    email: Pick<InviteLinkResponse, "emailQueued" | "emailSkipped" | "emailTo">,
  ): InviteLinkResponse => ({
    inviteUrl: `${deps.publicOrigin ?? ""}/invite/${token}`, expiresAt, ...email,
  });
  for (const path of ["/users", "/users/*", "/repository-access", "/repository-access/*"]) api.use(path, adminOnly);

  api.get("/users", (c) => c.json({ users: listUsers().map(summary) }));

  api.post("/users", async (c) => {
    const input = await json(c);
    const parsed = grantsFrom(input.grants ?? []);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const actor = principalOf(c).userId;
    // The invite speaks the inviter's language, as the design says: it is the
    // only message whose recipient has never chosen one.
    const inviter = actor ? getUser(actor) : null;
    const locale = inviter ? localeOf(inviter) : DEFAULT_USER_LOCALE;
    try {
      // One transaction, so a rejected grant or invite leaves no half-built user,
      // and so the queued invite commits with the account it belongs to.
      const { user, token, expiresAt, email } = getDb().transaction(() => {
        const created = createUser({
          username: String(input.username ?? ""), displayName: String(input.displayName ?? ""),
          email: typeof input.email === "string" ? input.email : null, isAdmin: input.isAdmin === true,
        });
        replaceUserGrants(created.id, parsed.grants, actor);
        const link = createInvite({ userId: created.id, purpose: "invite", createdBy: actor });
        return {
          user: created, token: link.token, expiresAt: link.invite.expiresAt,
          email: queueLink("invite", created, { token: link.token, expiresAt: link.invite.expiresAt },
            locale, inviter?.displayName ?? null),
        };
      })();
      return c.json({ user: summary(user), invite: inviteLink(token, expiresAt, email) }, 201);
    } catch (error) {
      const code = error instanceof Error ? error.message : "user_create_failed";
      return c.json({ error: code }, code === "username_taken" ? 409 : 400);
    }
  });

  api.patch("/users/:id", async (c) => {
    const user = getUser(c.req.param("id"));
    if (!user) return c.json({ error: "not_found" }, 404);
    const input = await json(c);
    // Only an active administrator can be the last one, including the caller.
    const lastAdminAtRisk = user.isAdmin && user.status === "active"
      && (input.isAdmin === false || input.status === "disabled");
    if (lastAdminAtRisk && countActiveAdmins() <= 1) return c.json({ error: "last_admin" }, 409);
    const patch: Parameters<typeof updateUser>[1] = {};
    if (typeof input.displayName === "string" && input.displayName.trim()) patch.displayName = input.displayName.trim().slice(0, 120);
    if (typeof input.email === "string" || input.email === null) patch.email = (input.email as string | null)?.trim() || null;
    if (typeof input.isAdmin === "boolean") patch.isAdmin = input.isAdmin;
    if (input.status === "active" || input.status === "disabled") patch.status = input.status;
    const updated = updateUser(user.id, patch);
    if (patch.status === "disabled") revokeUserSessions(user.id);
    return c.json(summary(updated));
  });

  api.post("/users/:id/reset", (c) => {
    const user = getUser(c.req.param("id"));
    if (!user) return c.json({ error: "not_found" }, 404);
    const actor = principalOf(c).userId;
    // One transaction for the three writes: a reset that revoked the sessions but
    // queued no message, or queued one for a link that was rolled back, would be
    // worse than either failure on its own.
    const { link, email } = getDb().transaction(() => {
      const created = createInvite({ userId: user.id, purpose: "reset", createdBy: actor });
      revokeUserSessions(user.id);
      return {
        link: created,
        // The reset speaks the recipient's own language; they have an account.
        email: queueLink("reset", user, { token: created.token, expiresAt: created.invite.expiresAt },
          localeOf(user), null),
      };
    })();
    return c.json(inviteLink(link.token, link.invite.expiresAt, email));
  });

  api.delete("/users/:id/sessions", (c) => {
    if (!getUser(c.req.param("id"))) return c.json({ error: "not_found" }, 404);
    revokeUserSessions(c.req.param("id"));
    return c.body(null, 204);
  });

  api.get("/users/:id/sessions", (c) => {
    if (!getUser(c.req.param("id"))) return c.json({ error: "not_found" }, 404);
    const sessions: UserSessionSummary[] = listUserSessions(c.req.param("id")).map((session) => ({
      id: session.id, createdAt: session.createdAt, lastSeenAt: session.lastSeenAt,
      ip: session.ip, userAgent: session.userAgent, current: false,
    }));
    return c.json({ sessions });
  });

  api.get("/users/:id/grants", (c) => {
    if (!getUser(c.req.param("id"))) return c.json({ error: "not_found" }, 404);
    return c.json({ grants: listUserGrants(c.req.param("id")) });
  });

  api.put("/users/:id/grants", async (c) => {
    const id = c.req.param("id");
    if (!getUser(id)) return c.json({ error: "not_found" }, 404);
    const parsed = grantsFrom((await json(c)).grants);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    try {
      replaceUserGrants(id, parsed.grants, principalOf(c).userId);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "grant_failed" }, 400);
    }
    return c.json({ grants: listUserGrants(id) });
  });

  api.get("/repository-access", (c) => c.json({ repositories: listRepositoryAccess() }));

  api.put("/repository-access/:repositoryKey/users/:userId", async (c) => {
    if (!getUser(c.req.param("userId"))) return c.json({ error: "not_found" }, 404);
    const role = (await json(c)).role;
    if (role !== null && (typeof role !== "string" || !(role in ROLE_RANK))) return c.json({ error: "role_invalid" }, 400);
    try {
      // Hono already percent-decodes the path parameter.
      setRepositoryGrant(c.req.param("userId"), c.req.param("repositoryKey"), role as RepositoryRole | null, principalOf(c).userId);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "grant_failed" }, 400);
    }
    return c.body(null, 204);
  });

  return api;
}
