import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeUsername } from "./username.js";

test("normalizes exactly as the server stores the username", () => {
  assert.equal(normalizeUsername(" Bruno.Lima "), "bruno.lima");
  assert.equal(normalizeUsername("ANA"), "ana");
  assert.equal(normalizeUsername("a_b-c.9"), "a_b-c.9");
  assert.equal(normalizeUsername("x".repeat(64)), "x".repeat(64));
  // An email address is a usable login name, so the invite preview shows it
  // lowercased rather than refusing it.
  assert.equal(normalizeUsername(" Marcos@OkamiOps.com "), "marcos@okamiops.com");
  assert.equal(normalizeUsername("marcos+alerts@okamiops.com"), "marcos+alerts@okamiops.com");
});

test("refuses what the server would refuse", () => {
  assert.equal(normalizeUsername("a"), null);
  assert.equal(normalizeUsername(""), null);
  assert.equal(normalizeUsername("with space"), null);
  assert.equal(normalizeUsername("acentuação"), null);
  assert.equal(normalizeUsername("marcos @okamiops.com"), null);
  assert.equal(normalizeUsername("marcos!@okamiops.com"), null);
  assert.equal(normalizeUsername("x".repeat(65)), null);
});
