import type Database from "better-sqlite3";

/**
 * The e-mail side of the schema: one configuration row, the outbox every
 * notification is rendered into, and the per-user subscription matrix.
 *
 * Kept idempotent the same way `ensureAuthSchema` is, because `getDb()` runs it
 * on every process that opens `benchmark.db` — the API, the scanner workers and
 * every parallel test process.
 *
 * `email_settings` is a singleton: `CHECK (id = 1)` makes a second provider
 * configuration unrepresentable rather than merely unused, which is what the
 * design means by "one active provider at a time".
 *
 * `email_outbox.user_id` is `ON DELETE SET NULL`, not `CASCADE`: a delivery that
 * already happened is history, and history must not disappear because the
 * account was later removed. `notification_subscriptions` does cascade, because
 * a preference without its owner means nothing.
 *
 * `ops_alert_state` is the memory that keeps the operational alerts quiet: one
 * row per `(event, target)` with when the condition started, when the last alert
 * about it went out, and when it ended. Persisted rather than in-memory so a
 * restart during a three-hour outage does not start the six-hour window over.
 */
export function ensureEmailSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS email_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      provider TEXT NOT NULL CHECK (provider IN ('smtp', 'resend')),
      enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
      from_name TEXT NOT NULL DEFAULT '',
      from_address TEXT,
      reply_to TEXT,
      smtp_host TEXT,
      smtp_port INTEGER,
      smtp_security TEXT NOT NULL DEFAULT 'tls' CHECK (smtp_security IN ('tls', 'starttls', 'none')),
      smtp_username TEXT,
      secret_ref TEXT,
      updated_at TEXT,
      updated_by TEXT
    );
    CREATE TABLE IF NOT EXISTS email_outbox (
      id TEXT PRIMARY KEY,
      event TEXT NOT NULL,
      dedupe_key TEXT NOT NULL UNIQUE,
      user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      to_address TEXT NOT NULL,
      locale TEXT NOT NULL,
      subject TEXT NOT NULL,
      html TEXT NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'cancelled')),
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      last_error TEXT,
      provider_message_id TEXT,
      created_at TEXT NOT NULL,
      sent_at TEXT
    );
    CREATE INDEX IF NOT EXISTS email_outbox_due ON email_outbox(status, next_attempt_at);
    CREATE INDEX IF NOT EXISTS email_outbox_recent ON email_outbox(created_at DESC, id DESC);
    CREATE TABLE IF NOT EXISTS notification_subscriptions (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      scope TEXT NOT NULL,
      event TEXT NOT NULL,
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      PRIMARY KEY (user_id, scope, event)
    );
    CREATE TABLE IF NOT EXISTS ops_alert_state (
      event TEXT NOT NULL,
      target TEXT NOT NULL,
      active_since TEXT NOT NULL,
      last_sent_at TEXT,
      resolved_at TEXT,
      PRIMARY KEY (event, target)
    );
  `);
  const outboxColumns = new Set(
    (database.prepare("PRAGMA table_info(email_outbox)").all() as Array<{ name: string }>).map((c) => c.name),
  );
  // The subscription scope the message belongs to — a repository key, or `ops`.
  // The worker re-checks access right before it sends, and the event id alone
  // cannot tell it *which* repository a `gate.blocked` row was about: the gate
  // may have been deleted by then, and a body is not something to parse. Null on
  // account messages, which have no scope to lose.
  if (!outboxColumns.has("scope")) {
    database.exec("ALTER TABLE email_outbox ADD COLUMN scope TEXT");
  }
  const userColumns = new Set(
    (database.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>).map((c) => c.name),
  );
  // Nullable on purpose: an account that never picked a language is not the same
  // as one that picked the default, and the renderer falls back to `pt-BR`.
  if (!userColumns.has("locale")) {
    database.exec("ALTER TABLE users ADD COLUMN locale TEXT");
  }
}
