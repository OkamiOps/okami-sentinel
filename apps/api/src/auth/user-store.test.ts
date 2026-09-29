import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { ensureAuthSchema } from "./schema.js";
import { countActiveAdmins, createUser, findUserByUsername, listUsers, normalizeUsername, updateUser } from "./user-store.js";

function db() {
  const database = new Database(":memory:");
  database.exec("CREATE TABLE runs (id TEXT PRIMARY KEY, repository_path TEXT)");
  database.exec("CREATE TABLE guardrail_repositories (repository_key TEXT PRIMARY KEY)");
  ensureAuthSchema(database);
  return database;
}

test("normalizes usernames so case and spaces cannot create a second account", () => {
  const database = db();
  assert.equal(normalizeUsername("  Ana.Silva "), "ana.silva");
  assert.equal(normalizeUsername("a"), null);
  assert.equal(normalizeUsername("ana silva"), null);
  createUser({ username: "Ana.Silva", displayName: "Ana", isAdmin: false }, database);
  assert.throws(() => createUser({ username: " ana.silva ", displayName: "Other", isAdmin: false }, database), /username_taken/);
  assert.equal(findUserByUsername("ANA.SILVA ", database)?.displayName, "Ana");
});

/**
 * Teams identify people by their work email, so the login name is allowed to be
 * one: `@` and `+` are accepted, and the address still normalizes to one
 * account whatever case it was typed in.
 */
test("an email address is a usable username and still normalizes to one account", () => {
  const database = db();
  assert.equal(normalizeUsername(" Marcos@OkamiOps.com "), "marcos@okamiops.com");
  assert.equal(normalizeUsername("marcos+alerts@okamiops.com"), "marcos+alerts@okamiops.com");
  // Spaces and anything outside the character set stay refused.
  assert.equal(normalizeUsername("marcos @okamiops.com"), null);
  assert.equal(normalizeUsername("marcos!@okamiops.com"), null);
  const created = createUser({ username: "Marcos@OkamiOps.com", displayName: "Marcos", isAdmin: false }, database);
  assert.equal(created.username, "marcos@okamiops.com");
  assert.throws(
    () => createUser({ username: "marcos@okamiops.com", displayName: "Impostor", isAdmin: false }, database),
    /username_taken/,
  );
  assert.equal(findUserByUsername(" MARCOS@OKAMIOPS.COM ", database)?.id, created.id);
});

test("counts only active administrators", () => {
  const database = db();
  const admin = createUser({ username: "root", displayName: "Root", isAdmin: true }, database);
  createUser({ username: "ana", displayName: "Ana", isAdmin: false }, database);
  assert.equal(countActiveAdmins(database), 1);
  updateUser(admin.id, { status: "disabled" }, database);
  assert.equal(countActiveAdmins(database), 0);
  assert.deepEqual(listUsers(database).map((u) => u.username), ["ana", "root"]);
});
