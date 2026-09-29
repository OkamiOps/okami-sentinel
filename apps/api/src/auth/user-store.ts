import type Database from "better-sqlite3";
import { nanoid } from "nanoid";
import { getDb } from "../db.js";

export interface UserRecord {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  passwordHash: string | null;
  isAdmin: boolean;
  status: "active" | "disabled";
  failedAttempts: number;
  lockedUntil: string | null;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
}

interface UserRow {
  id: string; username: string; display_name: string; email: string | null;
  password_hash: string | null; is_admin: number; status: "active" | "disabled";
  failed_attempts: number; locked_until: string | null;
  created_at: string; updated_at: string; last_login_at: string | null;
}

function toRecord(row: UserRow): UserRecord {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    email: row.email,
    passwordHash: row.password_hash,
    isAdmin: row.is_admin === 1,
    status: row.status,
    failedAttempts: row.failed_attempts,
    lockedUntil: row.locked_until,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at,
  };
}

/**
 * Trimmed and lowercased, so case and stray spaces can never open a second
 * account for the same person. `@` and `+` are part of the set because a team
 * identifies people by their work email, which is then usable as the login name
 * itself; everything else — spaces, accents, control characters — stays out.
 */
export function normalizeUsername(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return /^[a-z0-9._@+-]{2,64}$/.test(normalized) ? normalized : null;
}

export function createUser(
  input: { username: string; displayName: string; email?: string | null; passwordHash?: string | null; isAdmin: boolean },
  database: Database.Database = getDb(),
): UserRecord {
  const username = normalizeUsername(input.username);
  if (username === null) throw new Error("username_invalid");
  if (findUserByUsername(username, database)) throw new Error("username_taken");
  const now = new Date().toISOString();
  const id = nanoid(16);
  database.prepare(`
    INSERT INTO users (id, username, display_name, email, password_hash, is_admin, status, failed_attempts, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'active', 0, ?, ?)
  `).run(id, username, input.displayName.trim().slice(0, 120) || username, input.email?.trim() || null,
    input.passwordHash ?? null, input.isAdmin ? 1 : 0, now, now);
  return getUser(id, database)!;
}

export function getUser(id: string, database: Database.Database = getDb()): UserRecord | null {
  const row = database.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
  return row ? toRecord(row) : null;
}

export function findUserByUsername(username: string, database: Database.Database = getDb()): UserRecord | null {
  const normalized = normalizeUsername(username);
  if (normalized === null) return null;
  const row = database.prepare("SELECT * FROM users WHERE username = ?").get(normalized) as UserRow | undefined;
  return row ? toRecord(row) : null;
}

export function listUsers(database: Database.Database = getDb()): UserRecord[] {
  return (database.prepare("SELECT * FROM users ORDER BY username").all() as UserRow[]).map(toRecord);
}

const columns = {
  displayName: "display_name",
  email: "email",
  passwordHash: "password_hash",
  isAdmin: "is_admin",
  status: "status",
  failedAttempts: "failed_attempts",
  lockedUntil: "locked_until",
  lastLoginAt: "last_login_at",
} as const;

export function updateUser(
  id: string,
  patch: Partial<Pick<UserRecord, keyof typeof columns>>,
  database: Database.Database = getDb(),
): UserRecord {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, column] of Object.entries(columns) as Array<[keyof typeof columns, string]>) {
    if (!(key in patch)) continue;
    const value = patch[key];
    sets.push(`${column} = ?`);
    values.push(typeof value === "boolean" ? (value ? 1 : 0) : value ?? null);
  }
  sets.push("updated_at = ?");
  values.push(new Date().toISOString(), id);
  database.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  const updated = getUser(id, database);
  if (!updated) throw new Error("user_not_found");
  return updated;
}

export function countActiveAdmins(database: Database.Database = getDb()): number {
  return (database.prepare("SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND status = 'active'")
    .get() as { n: number }).n;
}
