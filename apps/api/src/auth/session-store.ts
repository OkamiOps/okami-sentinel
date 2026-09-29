import type Database from "better-sqlite3";
import { getDb } from "../db.js";
import { hashToken, newToken } from "./tokens.js";

export const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
export const SESSION_MAX_MS = 7 * 24 * 60 * 60 * 1000;
const TOUCH_INTERVAL_MS = 60 * 1000;

export interface SessionRecord {
  id: string;
  userId: string;
  csrfToken: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  ip: string | null;
  userAgent: string | null;
}

interface SessionRow {
  id: string; user_id: string; csrf_token: string; created_at: string; last_seen_at: string;
  expires_at: string; ip: string | null; user_agent: string | null; revoked_at: string | null;
}

function toRecord(row: SessionRow): SessionRecord {
  return {
    id: row.id, userId: row.user_id, csrfToken: row.csrf_token, createdAt: row.created_at,
    lastSeenAt: row.last_seen_at, expiresAt: row.expires_at, ip: row.ip, userAgent: row.user_agent,
  };
}

function valid(row: SessionRow | undefined, now: Date): row is SessionRow {
  if (!row || row.revoked_at !== null) return false;
  const time = now.getTime();
  return time < Date.parse(row.expires_at) && time - Date.parse(row.last_seen_at) < SESSION_IDLE_MS;
}

export function createSession(
  input: { userId: string; ip: string | null; userAgent: string | null; now?: Date },
  database: Database.Database = getDb(),
): { token: string; session: SessionRecord } {
  const now = input.now ?? new Date();
  const token = newToken();
  const id = hashToken(token);
  database.prepare(`
    INSERT INTO sessions (id, user_id, csrf_token, created_at, last_seen_at, expires_at, ip, user_agent)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, input.userId, newToken(), now.toISOString(), now.toISOString(),
    new Date(now.getTime() + SESSION_MAX_MS).toISOString(), input.ip?.slice(0, 64) ?? null,
    input.userAgent?.slice(0, 300) ?? null);
  return { token, session: getSessionById(id, now, database)! };
}

export function getSessionById(id: string, now: Date = new Date(), database: Database.Database = getDb()): SessionRecord | null {
  const row = database.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
  return valid(row, now) ? toRecord(row) : null;
}

export function resolveSession(token: string, now: Date = new Date(), database: Database.Database = getDb()): SessionRecord | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const id = hashToken(token);
  const row = database.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
  if (!valid(row, now)) return null;
  if (now.getTime() - Date.parse(row.last_seen_at) >= TOUCH_INTERVAL_MS) {
    database.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?").run(now.toISOString(), id);
    row.last_seen_at = now.toISOString();
  }
  return toRecord(row);
}

export function revokeSession(id: string, database: Database.Database = getDb()): void {
  database.prepare("UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
    .run(new Date().toISOString(), id);
}

export function revokeUserSessions(userId: string, exceptSessionId: string | null = null, database: Database.Database = getDb()): void {
  database.prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND id IS NOT ?")
    .run(new Date().toISOString(), userId, exceptSessionId);
}

export function listUserSessions(userId: string, now: Date = new Date(), database: Database.Database = getDb()): SessionRecord[] {
  return (database.prepare("SELECT * FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC").all(userId) as SessionRow[])
    .filter((row) => valid(row, now))
    .map(toRecord);
}
