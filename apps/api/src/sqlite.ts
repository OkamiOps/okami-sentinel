import Database from "better-sqlite3";

/**
 * SQLite serializes writers per file, and nothing in this API owns its files
 * alone: a local runtime shares `benchmark.db` with the scanner workers it
 * spawns, a server runtime with whatever else runs against the same data
 * directory, and the test runner opens it from every parallel test process.
 *
 * The default busy timeout is zero, so the loser of a write-lock race fails
 * immediately with SQLITE_BUSY instead of waiting out the few milliseconds the
 * winner needs. Every connection opened against a file therefore waits; only
 * `:memory:` databases, which no other connection can reach, do not need it.
 */
export const SQLITE_BUSY_TIMEOUT_MS = 5_000;

export function openSqliteFile(file: string, options?: Database.Options): Database.Database {
  const database = new Database(file, options);
  // Before any other statement: changing `journal_mode` itself takes a lock
  // that a concurrent writer can be holding.
  database.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  alwaysStartTransactionsImmediate(database);
  return database;
}

/**
 * The timeout alone is not enough, because `db.transaction(fn)()` runs a plain
 * `BEGIN`. SQLite deliberately does not invoke the busy handler for a deferred
 * transaction that only asks for the write lock once it is already running —
 * waiting there could deadlock two connections against each other — so the
 * statement fails at once with SQLITE_BUSY, or with SQLITE_BUSY_SNAPSHOT when
 * the transaction read before it wrote and another connection has committed
 * since. No timeout can rescue either case.
 *
 * `BEGIN IMMEDIATE` takes the write lock up front, where waiting is safe and
 * the busy timeout applies. Making it the default is what several call sites
 * already ask for by hand; `.deferred()` stays available on the returned
 * transaction for a caller that genuinely wants read-only semantics.
 */
function alwaysStartTransactionsImmediate(database: Database.Database): void {
  const build = database.transaction.bind(database);
  database.transaction = ((handler) => build(handler).immediate) as typeof database.transaction;
}
