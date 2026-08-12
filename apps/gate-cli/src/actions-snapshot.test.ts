import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { defaultGuardrailPolicy } from "@csb/gate-core";

import { inspectActionsSnapshots, type ActionsSnapshotCommand } from "./actions-snapshot.js";

const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);

test("compares two exact clean checkout indexes and declares incomplete Git metadata", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "csb-actions-base-"));
  const head = fs.mkdtempSync(path.join(os.tmpdir(), "csb-actions-head-"));
  fs.mkdirSync(path.join(head, "src"));
  fs.writeFileSync(path.join(head, "src", "app.ts"), "export const safe = true;\n");
  fs.writeFileSync(
    path.join(head, "model.bin"),
    "version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 12\n",
  );
  const command = fixtureCommand(base, head, {
    base: [entry("100644", "1", "src/app.ts")],
    head: [
      entry("100644", "2", "src/app.ts"),
      entry("100644", "3", "model.bin"),
      entry("160000", "4", "vendor/sdk"),
    ],
  });

  const result = inspectActionsSnapshots({
    baseRoot: base,
    headRoot: head,
    baseRef: "main",
    headRef: "feature/security",
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    policy: defaultGuardrailPolicy(),
  }, command);

  assert.deepEqual(result.changeSet.files.map((value) => [value.status, value.path]), [
    ["added", "model.bin"],
    ["modified", "src/app.ts"],
    ["added", "vendor/sdk"],
  ]);
  assert.deepEqual(result.changeSet.scanPaths, ["model.bin", "src/app.ts"]);
  assert.equal(result.coverage.status, "partial");
  assert.deepEqual(result.coverage.submodules, ["vendor/sdk"]);
  assert.deepEqual(result.coverage.lfsPointers, ["model.bin"]);
  assert.match(result.identity, /^sha256:[0-9a-f]{64}$/);
});

test("rejects a moved checkout revision and never accepts one root for policy and head", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "csb-actions-pin-"));
  const head = fs.mkdtempSync(path.join(os.tmpdir(), "csb-actions-pin-head-"));
  const policy = defaultGuardrailPolicy();

  assert.throws(
    () => inspectActionsSnapshots({
      baseRoot: base,
      headRoot: head,
      baseRef: "main",
      headRef: "feature",
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      policy,
    }, fixtureCommand(base, head, { base: [], head: [], wrongHead: true })),
    /revision_mismatch/,
  );
  assert.throws(
    () => inspectActionsSnapshots({
      baseRoot: base,
      headRoot: base,
      baseRef: "main",
      headRef: "main",
      baseSha: BASE_SHA,
      headSha: BASE_SHA,
      policy,
    }, fixtureCommand(base, head, { base: [], head: [] })),
    /roots_must_be_distinct/,
  );
});

function entry(mode: string, oidDigit: string, filePath: string): string {
  return `${mode} ${oidDigit.repeat(40)} 0\t${filePath}\0`;
}

function fixtureCommand(
  base: string,
  head: string,
  entries: { base: string[]; head: string[]; wrongHead?: boolean },
): ActionsSnapshotCommand {
  const resolvedBase = fs.realpathSync(base);
  const resolvedHead = fs.realpathSync(head);
  return (args, cwd) => {
    if (args[0] === "rev-parse") {
      return Buffer.from(cwd === resolvedBase ? `${BASE_SHA}\n` : `${entries.wrongHead ? BASE_SHA : HEAD_SHA}\n`);
    }
    if (args[0] === "status") return Buffer.alloc(0);
    if (args[0] === "ls-files") {
      return Buffer.from((cwd === resolvedBase ? entries.base : entries.head).join(""));
    }
    throw new Error(`unexpected git command: ${args.join(" ")}`);
  };
}
