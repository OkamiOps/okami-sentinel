import assert from "node:assert/strict";
import test from "node:test";
import { canSeeRepository, hasRepositoryRole, inScope, LOCAL_PRINCIPAL, scopeOf, type Principal } from "./principal.js";
import { scopeSql } from "./scope-sql.js";

const member: Principal = {
  kind: "user", userId: "u1", sessionId: "s1", username: "ana", displayName: "Ana", isAdmin: false,
  grants: new Map([["github:1", "analyst"]]),
};

test("roles are cumulative and scoped to one repository", () => {
  assert.equal(hasRepositoryRole(member, "github:1", "viewer"), true);
  assert.equal(hasRepositoryRole(member, "github:1", "analyst"), true);
  assert.equal(hasRepositoryRole(member, "github:1", "operator"), false);
  assert.equal(hasRepositoryRole(member, "github:2", "viewer"), false);
  assert.equal(canSeeRepository(member, null), false);
  assert.equal(canSeeRepository(LOCAL_PRINCIPAL, null), true);
});

test("scopes translate to SQL without trusting keys as SQL", () => {
  assert.deepEqual(scopeSql(scopeOf(LOCAL_PRINCIPAL), "runs.repository_key"), { sql: "", params: [] });
  assert.deepEqual(scopeSql(scopeOf(member), "runs.repository_key"), { sql: " AND runs.repository_key IN (?)", params: ["github:1"] });
  assert.deepEqual(scopeSql({ kind: "repositories", keys: new Set() }, "x"), { sql: " AND 0", params: [] });
  assert.equal(inScope(scopeOf(member), null), false);
});
