import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { scanOutputDirectory } from "./runner.js";

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

test("keeps dot-segment display names inside the scan root", () => {
  const root = path.join(path.sep, "private", "scans");
  const output = scanOutputDirectory(root, "..", "scan-1");

  assert.equal(output, path.join(root, "repo", "csb-repo-scan-1"));
  assert.equal(isWithin(root, output), true);
});

test("keeps scan identifiers and display names as single safe directory segments", () => {
  const root = path.join(path.sep, "private", "scans");
  const output = scanOutputDirectory(root, "../customer/repo", "../scan-id");

  assert.equal(isWithin(root, output), true);
  assert.equal(path.relative(root, output).split(path.sep).length, 2);
  assert.doesNotMatch(path.relative(root, output), /(^|[\\/])\.\.([\\/]|$)/);
});
