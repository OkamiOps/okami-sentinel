import assert from "node:assert/strict";
import test from "node:test";
import { inviteEmailTarget, looksLikeEmailAddress } from "./email-address";

test("an address is one local@domain pair and nothing else", () => {
  assert.equal(looksLikeEmailAddress("ana@okami.test"), true);
  assert.equal(looksLikeEmailAddress("  ana@okami.test  "), true);
  assert.equal(looksLikeEmailAddress("ana+alerts@mail.okami.test"), true);
  assert.equal(looksLikeEmailAddress("ana"), false);
  assert.equal(looksLikeEmailAddress("ana@localhost"), false);
  assert.equal(looksLikeEmailAddress("ana@okami.test, bea@okami.test"), false);
  assert.equal(looksLikeEmailAddress("Ana <ana@okami.test>"), false);
  assert.equal(looksLikeEmailAddress("ana@okami.test\nBcc: bea@okami.test"), false);
  assert.equal(looksLikeEmailAddress(""), false);
  assert.equal(looksLikeEmailAddress(`${"a".repeat(250)}@okami.test`), false);
});

test("the invite goes to the typed address, or to a username that is one", () => {
  assert.equal(inviteEmailTarget("ana@okami.test", "ana"), "ana@okami.test");
  assert.equal(inviteEmailTarget("", "bea@okami.test"), "bea@okami.test");
  assert.equal(inviteEmailTarget("   ", "bea@okami.test"), "bea@okami.test");
  assert.equal(inviteEmailTarget("", "bea"), null);
  // A filled but unusable field is not a reason to promise delivery to the
  // handle: that request is about to be refused, not redirected.
  assert.equal(inviteEmailTarget("not an address", "bea@okami.test"), null);
});
