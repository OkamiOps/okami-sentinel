import type Database from "better-sqlite3";
import type { RepositoryAccessEntry, RepositoryGrant, RepositoryRole } from "@csb/shared";
import { getDb } from "../db.js";
import { ROLE_RANK } from "./principal.js";

function assertRole(role: string): asserts role is RepositoryRole {
  if (!(role in ROLE_RANK)) throw new Error("role_invalid");
}

function assertRepository(repositoryKey: string, database: Database.Database): void {
  if (!database.prepare("SELECT 1 FROM guardrail_repositories WHERE repository_key = ?").get(repositoryKey)) {
    throw new Error("repository_unknown");
  }
}

export function listUserGrants(userId: string, database: Database.Database = getDb()): RepositoryGrant[] {
  return (database.prepare("SELECT repository_key, role FROM repository_grants WHERE user_id = ? ORDER BY repository_key")
    .all(userId) as Array<{ repository_key: string; role: RepositoryRole }>)
    .map((row) => ({ repositoryKey: row.repository_key, role: row.role }));
}

export function replaceUserGrants(userId: string, grants: RepositoryGrant[], grantedBy: string | null, database: Database.Database = getDb()): void {
  database.transaction(() => {
    for (const grant of grants) {
      assertRole(grant.role);
      assertRepository(grant.repositoryKey, database);
    }
    database.prepare("DELETE FROM repository_grants WHERE user_id = ?").run(userId);
    const insert = database.prepare("INSERT INTO repository_grants (user_id, repository_key, role, granted_by, granted_at) VALUES (?, ?, ?, ?, ?)");
    const now = new Date().toISOString();
    for (const grant of grants) insert.run(userId, grant.repositoryKey, grant.role, grantedBy, now);
  })();
}

export function setRepositoryGrant(userId: string, repositoryKey: string, role: RepositoryRole | null, grantedBy: string | null, database: Database.Database = getDb()): void {
  if (role === null) {
    database.prepare("DELETE FROM repository_grants WHERE user_id = ? AND repository_key = ?").run(userId, repositoryKey);
    return;
  }
  assertRole(role);
  assertRepository(repositoryKey, database);
  database.prepare(`
    INSERT INTO repository_grants (user_id, repository_key, role, granted_by, granted_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, repository_key) DO UPDATE SET role = excluded.role, granted_by = excluded.granted_by, granted_at = excluded.granted_at
  `).run(userId, repositoryKey, role, grantedBy, new Date().toISOString());
}

export function countUserGrants(userId: string, database: Database.Database = getDb()): number {
  return (database.prepare("SELECT COUNT(*) AS n FROM repository_grants WHERE user_id = ?").get(userId) as { n: number }).n;
}

export function listRepositoryAccess(database: Database.Database = getDb()): RepositoryAccessEntry[] {
  const repositories = database.prepare("SELECT repository_key, display_name, source FROM guardrail_repositories ORDER BY display_name")
    .all() as Array<{ repository_key: string; display_name: string; source: "local" | "github" }>;
  const grants = database.prepare(`
    SELECT g.repository_key, g.role, u.id, u.username, u.display_name
    FROM repository_grants g JOIN users u ON u.id = g.user_id ORDER BY u.username
  `).all() as Array<{ repository_key: string; role: RepositoryRole; id: string; username: string; display_name: string }>;
  return repositories.map((repository) => ({
    repositoryKey: repository.repository_key,
    displayName: repository.display_name,
    source: repository.source,
    grants: grants.filter((g) => g.repository_key === repository.repository_key)
      .map((g) => ({ userId: g.id, username: g.username, displayName: g.display_name, role: g.role })),
  }));
}
