import assert from "node:assert/strict";
import test from "node:test";
import { hashPassword, passwordPolicyError, verifyPassword } from "./passwords.js";
import { hashToken, newToken } from "./tokens.js";

test("hashes with scrypt parameters and verifies only the right password", async () => {
  const stored = await hashPassword("correct horse battery");
  assert.match(stored, /^scrypt\$32768\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  assert.notEqual(stored, await hashPassword("correct horse battery"));
  assert.equal(await verifyPassword("correct horse battery", stored), true);
  assert.equal(await verifyPassword("correct horse batterY", stored), false);
});

test("treats missing or malformed hashes as a failed verification", async () => {
  assert.equal(await verifyPassword("anything", null), false);
  assert.equal(await verifyPassword("anything", "plain"), false);
  assert.equal(await verifyPassword("anything", "scrypt$1$1$1$x$y"), false);
});

test("enforces the password policy", () => {
  assert.equal(passwordPolicyError("short", "ana"), "password_too_short");
  assert.equal(passwordPolicyError("x".repeat(257), "ana"), "password_too_long");
  assert.equal(passwordPolicyError("Ana.Silva.123", "ana.silva.123"), "password_matches_username");
  assert.equal(passwordPolicyError("a long enough pass", "ana"), null);
});

test("tokens are random and hashed deterministically", () => {
  const token = newToken();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(token, newToken());
  assert.equal(hashToken(token), hashToken(token));
  assert.match(hashToken(token), /^[0-9a-f]{64}$/);
});
