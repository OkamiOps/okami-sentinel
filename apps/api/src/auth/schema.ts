import type Database from "better-sqlite3";

export function ensureAuthSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      email TEXT,
      password_hash TEXT,
      is_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1)),
      status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
      must_change_password INTEGER NOT NULL DEFAULT 0,
      failed_attempts INTEGER NOT NULL DEFAULT 0,
      locked_until TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_login_at TEXT
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      csrf_token TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      ip TEXT,
      user_agent TEXT,
      revoked_at TEXT
    );
    CREATE INDEX IF NOT EXISTS sessions_by_user ON sessions(user_id);
    CREATE TABLE IF NOT EXISTS user_invites (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      purpose TEXT NOT NULL CHECK (purpose IN ('invite', 'reset')),
      created_by TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT
    );
    CREATE TABLE IF NOT EXISTS repository_grants (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      repository_key TEXT NOT NULL REFERENCES guardrail_repositories(repository_key) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('viewer', 'analyst', 'operator', 'maintainer')),
      granted_by TEXT,
      granted_at TEXT NOT NULL,
      PRIMARY KEY (user_id, repository_key)
    );
  `);
  const runColumns = new Set(
    (database.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!runColumns.has("repository_key")) {
    database.exec("ALTER TABLE runs ADD COLUMN repository_key TEXT");
  }
  database.exec("CREATE INDEX IF NOT EXISTS runs_by_repository_key ON runs(repository_key)");
}
