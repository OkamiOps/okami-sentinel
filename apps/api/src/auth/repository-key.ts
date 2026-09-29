import type Database from "better-sqlite3";
import { getDb } from "../db.js";

export function resolveRunRepositoryKey(repositoryPath: string | null, database: Database.Database = getDb()): string | null {
  if (!repositoryPath) return null;
  const github = /^github:(\d+)@/.exec(repositoryPath);
  if (github) {
    const row = database.prepare("SELECT repository_key FROM guardrail_repositories WHERE github_repository_id = ?")
      .get(github[1]) as { repository_key: string } | undefined;
    return row?.repository_key ?? null;
  }
  if (!repositoryPath.startsWith("/")) return null;
  const candidates = database.prepare("SELECT repository_key, repository_path FROM guardrail_repositories WHERE repository_path IS NOT NULL")
    .all() as Array<{ repository_key: string; repository_path: string }>;
  let best: { key: string; length: number } | null = null;
  for (const candidate of candidates) {
    const root = candidate.repository_path.replace(/\/+$/, "");
    if (repositoryPath === root || repositoryPath.startsWith(`${root}/`)) {
      if (!best || root.length > best.length) best = { key: candidate.repository_key, length: root.length };
    }
  }
  return best?.key ?? null;
}

export function backfillRunRepositoryKeys(database: Database.Database = getDb()): number {
  const rows = database.prepare("SELECT id, repository_path FROM runs WHERE repository_key IS NULL AND repository_path IS NOT NULL")
    .all() as Array<{ id: string; repository_path: string }>;
  const update = database.prepare("UPDATE runs SET repository_key = ? WHERE id = ?");
  let updated = 0;
  database.transaction(() => {
    for (const row of rows) {
      const key = resolveRunRepositoryKey(row.repository_path, database);
      if (key !== null) { update.run(key, row.id); updated += 1; }
    }
  })();
  return updated;
}

export function getRunRepositoryKey(runId: string, database: Database.Database = getDb()): string | null | undefined {
  const row = database.prepare("SELECT repository_key FROM runs WHERE id = ?").get(runId) as { repository_key: string | null } | undefined;
  return row === undefined ? undefined : row.repository_key;
}
