import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeUsername } from "./username.js";

test("normalizes exactly as the server stores the username", () => {
  assert.equal(normalizeUsername(" Bruno.Lima "), "bruno.lima");
  assert.equal(normalizeUsername("ANA"), "ana");
  assert.equal(normalizeUsername("a_b-c.9"), "a_b-c.9");
  assert.equal(normalizeUsername("x".repeat(64)), "x".repeat(64));
});

test("refuses what the server would refuse", () => {
  assert.equal(normalizeUsername("a"), null);
  assert.equal(normalizeUsername(""), null);
  assert.equal(normalizeUsername("with space"), null);
  assert.equal(normalizeUsername("acentuação"), null);
  assert.equal(normalizeUsername("x".repeat(65)), null);
});
