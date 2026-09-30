import type Database from "better-sqlite3";
import { getDb } from "../db.js";
import { isUnfamiliarLogin, notifyAccountEvent, notifyNewLogin } from "../email/account-notifications.js";
import { listUserGrants } from "./grant-store.js";
import { consumeInvite, peekInvite } from "./invite-store.js";
import { hashPassword, passwordPolicyError, verifyPassword } from "./passwords.js";
import type { Principal } from "./principal.js";
import { FailureWindow } from "./rate-limit.js";
import { createSession, revokeSession, revokeUserSessions, type SessionRecord } from "./session-store.js";
import { countActiveAdmins, createUser, findUserByUsername, getUser, updateUser, type UserRecord } from "./user-store.js";

const LOGIN_RATE_LIMIT = 30;
const LOGIN_RATE_WINDOW_MS = 60_000;
let ipFailures = new FailureWindow(LOGIN_RATE_LIMIT, LOGIN_RATE_WINDOW_MS);
const LOCK_BASE_MS = 15 * 60_000;
const LOCK_MAX_MS = 24 * 3600_000;

// Test-only escape hatch: the limiter is a module singleton (shared across every
// call to login), so tests that need to exercise it deterministically must be
// able to clear it between runs instead of reaching into module internals.
export function resetLoginRateLimit(): void {
  ipFailures = new FailureWindow(LOGIN_RATE_LIMIT, LOGIN_RATE_WINDOW_MS);
}

export type LoginResult =
  | { ok: true; token: string; session: SessionRecord; user: UserRecord }
  | { ok: false; error: "invalid_credentials" }
  | { ok: false; error: "account_locked"; retryAfterSeconds: number }
  | { ok: false; error: "rate_limited"; retryAfterSeconds: number };

export function lockoutMs(failedAttempts: number): number {
  if (failedAttempts < 5) return 0;
  return Math.min(LOCK_MAX_MS, LOCK_BASE_MS * 2 ** (Math.floor(failedAttempts / 5) - 1));
}

export async function login(
  input: { username: string; password: string; ip: string | null; userAgent: string | null; now?: Date },
  database: Database.Database = getDb(),
): Promise<LoginResult> {
  const now = input.now ?? new Date();
  const ipKey = input.ip ?? "unknown";
  const ipWait = ipFailures.blocked(ipKey);
  if (ipWait !== null) return { ok: false, error: "rate_limited", retryAfterSeconds: ipWait };
  const user = findUserByUsername(input.username, database);
  if (user?.lockedUntil && Date.parse(user.lockedUntil) > now.getTime()) {
    // Polling a locked account still costs an IP-limiter strike, even though it
    // never touches the user's own failedAttempts/lockedUntil, so it can't be
    // used to confirm the account exists at zero cost.
    ipFailures.fail(ipKey);
    return { ok: false, error: "account_locked", retryAfterSeconds: Math.ceil((Date.parse(user.lockedUntil) - now.getTime()) / 1000) };
  }
  const matches = await verifyPassword(input.password, user?.passwordHash ?? null);
  if (!user || !matches || user.status !== "active") {
    ipFailures.fail(ipKey);
    if (user && !matches) {
      const failedAttempts = user.failedAttempts + 1;
      const lock = failedAttempts % 5 === 0 ? lockoutMs(failedAttempts) : 0;
      const lockedUntil = lock > 0 ? new Date(now.getTime() + lock).toISOString() : user.lockedUntil;
      updateUser(user.id, { failedAttempts, lockedUntil }, database);
      // Only a lock applied now is news; the attempts before it are not, and a
      // poll against an already-locked account is not either.
      if (lock > 0) {
        notifyAccountEvent(database, user, {
          kind: "account.locked",
          data: { at: now, retryAfterSeconds: Math.ceil(lock / 1000) },
          reference: lockedUntil!,
          now,
        });
      }
    }
    return { ok: false, error: "invalid_credentials" };
  }
  // Asked before the new session exists, or it would recognise itself.
  const unfamiliar = isUnfamiliarLogin(database, user.id, { ip: input.ip, userAgent: input.userAgent, now });
  updateUser(user.id, { failedAttempts: 0, lockedUntil: null, lastLoginAt: now.toISOString() }, database);
  const { token, session } = createSession({ userId: user.id, ip: input.ip, userAgent: input.userAgent, now }, database);
  // `notifyNewLogin` owns the noise control: one alert per account per hour, and
  // one per device per day.
  if (unfamiliar) notifyNewLogin(database, user, { ip: input.ip, userAgent: input.userAgent, now });
  return { ok: true, token, session, user: getUser(user.id, database)! };
}

export function logout(sessionId: string, database: Database.Database = getDb()): void {
  revokeSession(sessionId, database);
}

export function principalForSession(session: SessionRecord, database: Database.Database = getDb()): Principal | null {
  const user = getUser(session.userId, database);
  if (!user || user.status !== "active") return null;
  return {
    kind: "user",
    userId: user.id,
    sessionId: session.id,
    username: user.username,
    displayName: user.displayName,
    isAdmin: user.isAdmin,
    grants: new Map(listUserGrants(user.id, database).map((grant) => [grant.repositoryKey, grant.role])),
  };
}

export async function acceptInvite(
  input: { token: string; password: string; ip: string | null; userAgent: string | null; now?: Date },
  database: Database.Database = getDb(),
): Promise<
  | { ok: true; token: string; session: SessionRecord }
  | { ok: false; error: "invite_invalid" | "password_too_short" | "password_too_long" | "password_matches_username" }
> {
  const now = input.now ?? new Date();
  const invite = peekInvite(input.token, now, database);
  const user = invite ? getUser(invite.userId, database) : null;
  if (!invite || !user || user.status !== "active") return { ok: false, error: "invite_invalid" };
  const policy = passwordPolicyError(input.password, user.username);
  if (policy) return { ok: false, error: policy };
  const passwordHash = await hashPassword(input.password);
  if (!consumeInvite(input.token, now, database)) return { ok: false, error: "invite_invalid" };
  updateUser(user.id, { passwordHash, failedAttempts: 0, lockedUntil: null, lastLoginAt: now.toISOString() }, database);
  revokeUserSessions(user.id, null, database);
  const { token, session } = createSession({ userId: user.id, ip: input.ip, userAgent: input.userAgent, now }, database);
  // Accepting an invite or a reset *is* a password change, and it is the one the
  // account's owner most needs to hear about if it was not them who did it.
  notifyAccountEvent(database, user, {
    kind: "account.password_changed", data: { at: now }, reference: now.toISOString(), now,
  });
  return { ok: true, token, session };
}

export async function changePassword(
  input: { userId: string; sessionId: string; currentPassword: string; newPassword: string; now?: Date },
  database: Database.Database = getDb(),
): Promise<{ ok: true } | { ok: false; error: "invalid_credentials" | "password_too_short" | "password_too_long" | "password_matches_username" }> {
  const user = getUser(input.userId, database);
  if (!user || !(await verifyPassword(input.currentPassword, user.passwordHash))) return { ok: false, error: "invalid_credentials" };
  const policy = passwordPolicyError(input.newPassword, user.username);
  if (policy) return { ok: false, error: policy };
  // Whoever proved the current password owns the account; leaving a lockout or a
  // failure streak behind would punish them for an attacker's attempts.
  const now = input.now ?? new Date();
  updateUser(user.id, { passwordHash: await hashPassword(input.newPassword), failedAttempts: 0, lockedUntil: null }, database);
  revokeUserSessions(user.id, input.sessionId, database);
  notifyAccountEvent(database, user, {
    kind: "account.password_changed", data: { at: now }, reference: now.toISOString(), now,
  });
  return { ok: true };
}

/**
 * A single-administrator instance can lock itself out: five wrong attempts and
 * nobody is left who could clear the lock from the interface. A restart of the
 * container the operator controls therefore clears the counters on the account
 * named by `CSB_ADMIN_USER` — never its password, which stays whatever the
 * administrator last chose.
 */
export async function bootstrapAdmin(
  settings: { username: string; password: string },
  database: Database.Database = getDb(),
  now: Date = new Date(),
): Promise<"created" | "recovered" | "unlocked" | "unchanged"> {
  const existing = findUserByUsername(settings.username, database);
  const anyUser = database.prepare("SELECT 1 FROM users LIMIT 1").get() !== undefined;
  if (!anyUser) {
    createUser({ username: settings.username, displayName: settings.username, isAdmin: true, passwordHash: await hashPassword(settings.password) }, database);
    return "created";
  }
  if (countActiveAdmins(database) > 0) {
    const locked = existing !== null
      && (existing.failedAttempts > 0
        || (existing.lockedUntil !== null && Date.parse(existing.lockedUntil) > now.getTime()));
    if (!locked) return "unchanged";
    updateUser(existing!.id, { failedAttempts: 0, lockedUntil: null }, database);
    return "unlocked";
  }
  const passwordHash = await hashPassword(settings.password);
  if (existing) {
    updateUser(existing.id, { isAdmin: true, status: "active", passwordHash, failedAttempts: 0, lockedUntil: null }, database);
  } else {
    createUser({ username: settings.username, displayName: settings.username, isAdmin: true, passwordHash }, database);
  }
  return "recovered";
}
