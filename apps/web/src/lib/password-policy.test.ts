import assert from "node:assert/strict";
import { test } from "node:test";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, passwordIssue } from "./password-policy.js";

test("names the first rule a password breaks, in the order the server checks them", () => {
  assert.equal(passwordIssue("short", "short", "ana"), "tooShort");
  assert.equal(passwordIssue("x".repeat(PASSWORD_MAX_LENGTH + 1), "y", "ana"), "tooLong");
  assert.equal(passwordIssue("AdministratorX", "AdministratorX", "administratorx"), "matchesUsername");
  assert.equal(passwordIssue("a good long password", "a good long passwerd", "ana"), "mismatch");
});

test("accepts a confirmed password at the minimum length", () => {
  const password = "p".repeat(PASSWORD_MIN_LENGTH);
  assert.equal(passwordIssue(password, password, "ana"), null);
});
