import type Database from "better-sqlite3";
import { getDb } from "../db.js";
import { hashToken, newToken } from "./tokens.js";

export const INVITE_TTL_MS = 72 * 60 * 60 * 1000;

export interface InviteRecord {
  tokenHash: string;
  userId: string;
  purpose: "invite" | "reset";
  createdBy: string | null;
  createdAt: string;
  expiresAt: string;
}

interface InviteRow {
  token_hash: string; user_id: string; purpose: "invite" | "reset"; created_by: string | null;
  created_at: string; expires_at: string; used_at: string | null;
}

function toRecord(row: InviteRow): InviteRecord {
  return {
    tokenHash: row.token_hash, userId: row.user_id, purpose: row.purpose, createdBy: row.created_by,
    createdAt: row.created_at, expiresAt: row.expires_at,
  };
}

export function createInvite(
  input: { userId: string; purpose: "invite" | "reset"; createdBy: string | null; now?: Date },
  database: Database.Database = getDb(),
): { token: string; invite: InviteRecord } {
  const now = input.now ?? new Date();
  const token = newToken();
  database.transaction(() => {
    database.prepare("UPDATE user_invites SET used_at = ? WHERE user_id = ? AND used_at IS NULL")
      .run(now.toISOString(), input.userId);
    database.prepare(`
      INSERT INTO user_invites (token_hash, user_id, purpose, created_by, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(hashToken(token), input.userId, input.purpose, input.createdBy, now.toISOString(),
      new Date(now.getTime() + INVITE_TTL_MS).toISOString());
  })();
  return { token, invite: peekInvite(token, now, database)! };
}

export function peekInvite(token: string, now: Date = new Date(), database: Database.Database = getDb()): InviteRecord | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const row = database.prepare("SELECT * FROM user_invites WHERE token_hash = ?").get(hashToken(token)) as InviteRow | undefined;
  if (!row || row.used_at !== null || now.getTime() >= Date.parse(row.expires_at)) return null;
  return toRecord(row);
}

export function consumeInvite(token: string, now: Date = new Date(), database: Database.Database = getDb()): InviteRecord | null {
  const invite = peekInvite(token, now, database);
  if (!invite) return null;
  const result = database.prepare("UPDATE user_invites SET used_at = ? WHERE token_hash = ? AND used_at IS NULL")
    .run(now.toISOString(), invite.tokenHash);
  return result.changes === 1 ? invite : null;
}

export function hasOpenInvite(userId: string, now: Date = new Date(), database: Database.Database = getDb()): boolean {
  return database.prepare("SELECT 1 FROM user_invites WHERE user_id = ? AND used_at IS NULL AND expires_at > ?")
    .get(userId, now.toISOString()) !== undefined;
}
