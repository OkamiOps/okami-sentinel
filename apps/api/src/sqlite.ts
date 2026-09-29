import Database from "better-sqlite3";

/**
 * How long a statement waits for another connection's write lock before it
 * fails. Nothing in this API owns its SQLite files alone: a local runtime
 * shares `benchmark.db` with the scanner workers it spawns, a server runtime
 * with whatever else runs against the same data directory, and the test runner
 * opens it from every parallel test process.
 *
 * This happens to be better-sqlite3's own default, and it is passed explicitly
 * so the value this API relies on is stated rather than inherited — while an
 * explicit `timeout` from the caller still wins.
 */
export const SQLITE_BUSY_TIMEOUT_MS = 5_000;

export function openSqliteFile(file: string, options: Database.Options = {}): Database.Database {
  const database = new Database(file, { timeout: SQLITE_BUSY_TIMEOUT_MS, ...options });
  defaultToImmediateTransactions(database);
  return database;
}

/**
 * `db.transaction(fn)()` runs a plain `BEGIN`, and SQLite deliberately does not
 * invoke the busy handler for a deferred transaction that asks for the write
 * lock only once it is already running — waiting there could deadlock two
 * connections against each other. The statement fails at once with SQLITE_BUSY,
 * or with SQLITE_BUSY_SNAPSHOT when the transaction read before it wrote and
 * another connection has committed since. No timeout can rescue either case.
 *
 * `BEGIN IMMEDIATE` takes the write lock up front, where waiting is safe and
 * the timeout applies, so every transaction that writes gets it by default —
 * which is what nine call sites already asked for by hand.
 *
 * A transaction that only reads MUST opt out with `.deferred()`: taking the
 * write lock would make it queue behind every concurrent writer and, worse,
 * wait out the whole busy timeout when one is mid-write. `listRunPage` in
 * `scan-list.ts` is the one such caller today. On a `readonly` connection the
 * default is inert either way, because such a connection never takes the write
 * lock.
 */
function defaultToImmediateTransactions(database: Database.Database): void {
  const build = database.transaction.bind(database);
  database.transaction = ((handler) => build(handler).immediate) as typeof database.transaction;
}
