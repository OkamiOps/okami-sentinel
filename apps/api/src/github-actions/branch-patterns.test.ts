import assert from "node:assert/strict";
import test from "node:test";

import { matchesAnyBranchPattern, matchesBranchPattern } from "./branch-patterns.js";

test("matches a literal branch", () => {
  assert.ok(matchesBranchPattern("main", "main"));
  assert.ok(!matchesBranchPattern("main", "mainline"));
  assert.ok(!matchesBranchPattern("main", "MAIN"));
  assert.ok(!matchesBranchPattern("main", ""));
});

test("matches one segment with a single star", () => {
  assert.ok(matchesBranchPattern("release/*", "release/9"));
  assert.ok(!matchesBranchPattern("release/*", "release/9/rc1"));
  assert.ok(!matchesBranchPattern("release/*", "release/"));
  assert.ok(matchesBranchPattern("feature/*", "feature/login"));
  assert.ok(matchesBranchPattern("*", "main"));
  assert.ok(!matchesBranchPattern("*", "feature/login"));
  assert.ok(matchesBranchPattern("hotfix-*", "hotfix-12"));
});

test("matches across segments with a double star", () => {
  assert.ok(matchesBranchPattern("release/**", "release/9/rc1"));
  assert.ok(matchesBranchPattern("release/**", "release/9"));
  assert.ok(!matchesBranchPattern("release/**", "release"));
  assert.ok(matchesBranchPattern("**", "any/deep/branch"));
  assert.ok(matchesBranchPattern("**", "main"));
});

test("escapes regex metacharacters in the pattern", () => {
  assert.ok(matchesBranchPattern("fix.a+b", "fix.a+b"));
  assert.ok(!matchesBranchPattern("fix.a+b", "fixXaab"));
  assert.ok(matchesBranchPattern("fix(1)[2]", "fix(1)[2]"));
  assert.ok(!matchesBranchPattern("^main$", "main"));
});

test("a blank pattern or a blank branch never matches", () => {
  assert.ok(!matchesBranchPattern("", "main"));
  assert.ok(!matchesBranchPattern("   ", "main"));
  assert.ok(!matchesBranchPattern("main", "  "));
  assert.ok(!matchesAnyBranchPattern([], "main"));
});

test("any pattern in the list is enough", () => {
  assert.ok(matchesAnyBranchPattern(["main", "release/**"], "release/9/rc1"));
  assert.ok(matchesAnyBranchPattern(["main", "release/**"], "main"));
  assert.ok(!matchesAnyBranchPattern(["main", "release/**"], "feature/login"));
});

test("a fully qualified ref is matched by its short name, not by refs/heads", () => {
  // Push payloads carry `refs/heads/main`; the pattern language is about branch
  // names, so the caller may hand either form.
  assert.ok(matchesBranchPattern("main", "refs/heads/main"));
  assert.ok(matchesAnyBranchPattern(["release/**"], "refs/heads/release/9/rc1"));
});
