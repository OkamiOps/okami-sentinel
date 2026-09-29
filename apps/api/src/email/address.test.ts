import assert from "node:assert/strict";
import test from "node:test";
import { isEmailAddress, localeOf, resolveUserEmailAddress } from "./address.js";

test("an address has to be one header-safe local@domain", () => {
  for (const good of [
    "ana@example.com", "ana.paula+gate@sub.example.co.uk", "a@b.io", "a-b_c@example-host.com",
  ]) {
    assert.ok(isEmailAddress(good), good);
  }
  for (const bad of [
    "", "ana", "ana@", "@example.com", "ana@localhost", "ana@example", "ana@@example.com",
    "ana example@example.com", "ana@example.com, eve@example.com", "ana@example.c",
    "ana@exa mple.com", "ana@example.com\r\nBcc: eve@example.com", "ana\n@example.com",
    ".ana@example.com", "ana.@example.com", "ana@-example.com", `${"a".repeat(250)}@example.com`,
    null, 42, undefined,
  ]) {
    assert.equal(isEmailAddress(bad), false, JSON.stringify(bad));
  }
});

test("the explicit address wins, the username is the fallback, and neither may be invented", () => {
  assert.equal(
    resolveUserEmailAddress({ email: "ana@example.com", username: "ana.b@corp.example" }),
    "ana@example.com",
  );
  assert.equal(resolveUserEmailAddress({ email: null, username: "ana.b@corp.example" }), "ana.b@corp.example");
  assert.equal(resolveUserEmailAddress({ email: "  ana@example.com  ", username: "ana" }), "ana@example.com");
  // A stored value that is not an address falls through to the username.
  assert.equal(resolveUserEmailAddress({ email: "not-an-address", username: "ana@example.com" }), "ana@example.com");
  assert.equal(resolveUserEmailAddress({ email: null, username: "ana" }), null);
  assert.equal(resolveUserEmailAddress({ email: "   ", username: "ana" }), null);
});

test("an unset or unknown locale reads as the default", () => {
  assert.equal(localeOf({ locale: "fr" }), "fr");
  assert.equal(localeOf({ locale: null }), "pt-BR");
  assert.equal(localeOf({ locale: "kl" }), "pt-BR");
});
