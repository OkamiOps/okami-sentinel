import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { defaultGuardrailPolicy } from "@csb/gate-core";

import {
  GuardrailPolicyError,
  readGuardrailPolicy,
  writeGuardrailPolicy,
} from "./guardrail-policy-file.js";

function repo(prefix = "csb-policy-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function repoWithPolicy(value: unknown): string {
  const repositoryPath = repo("csb-policy-json-");
  fs.mkdirSync(path.join(repositoryPath, ".csb"));
  fs.writeFileSync(path.join(repositoryPath, ".csb", "guardrails.json"), JSON.stringify(value));
  return repositoryPath;
}

test("writes and reads schema v1 policy atomically", () => {
  const repositoryPath = repo();
  writeGuardrailPolicy(repositoryPath, defaultGuardrailPolicy());
  assert.deepEqual(readGuardrailPolicy(repositoryPath), defaultGuardrailPolicy());
  assert.equal(fs.existsSync(path.join(repositoryPath, ".csb", "guardrails.json.tmp")), false);
  assert.equal(fs.readFileSync(path.join(repositoryPath, ".csb", "guardrails.json"), "utf8").endsWith("\n"), true);
});

test("returns the default policy without writing when the policy file is absent", () => {
  const repositoryPath = repo("csb-policy-missing-");
  assert.deepEqual(readGuardrailPolicy(repositoryPath), defaultGuardrailPolicy());
  assert.equal(fs.existsSync(path.join(repositoryPath, ".csb", "guardrails.json")), false);
});

test("reports malformed JSON and future schemas with a field path", () => {
  const malformed = repo("csb-policy-malformed-");
  fs.mkdirSync(path.join(malformed, ".csb"));
  fs.writeFileSync(path.join(malformed, ".csb", "guardrails.json"), "{");
  assert.throws(
    () => readGuardrailPolicy(malformed),
    (error: unknown) => error instanceof GuardrailPolicyError && error.path === "policy",
  );

  const future = { ...defaultGuardrailPolicy(), schemaVersion: 2 };
  assert.throws(
    () => readGuardrailPolicy(repoWithPolicy(future)),
    (error: unknown) => error instanceof GuardrailPolicyError && error.path === "schemaVersion",
  );
});

test("validates schema v1 policy fields exactly", () => {
  const cases: Array<[string, (policy: Record<string, any>) => void]> = [
    ["protectedBranches", (policy) => { policy.protectedBranches = []; }],
    ["protectedBranches[0]", (policy) => { policy.protectedBranches = [""]; }],
    ["scope.mode", (policy) => { policy.scope.mode = "diff"; }],
    ["scope.maxChangedPaths", (policy) => { policy.scope.maxChangedPaths = 0; }],
    ["scope.maxChangedPaths", (policy) => { policy.scope.maxChangedPaths = 1.5; }],
    ["scope.fallback", (policy) => { policy.scope.fallback = "ignore"; }],
    ["scan.model", (policy) => { policy.scan.model = ""; }],
    ["scan.effort", (policy) => { policy.scan.effort = ""; }],
    ["scan.mode", (policy) => { policy.scan.mode = "fast"; }],
    ["scan.maxCostUsd", (policy) => { policy.scan.maxCostUsd = Number.POSITIVE_INFINITY; }],
    ["scan.maxCostUsd", (policy) => { policy.scan.maxCostUsd = 0; }],
    ["rules[0].severity[0]", (policy) => { policy.rules[0].severity = ["urgent"]; }],
    ["rules[0].lifecycle[0]", (policy) => { policy.rules[0].lifecycle = ["regressed"]; }],
    ["rules[0].decision", (policy) => { policy.rules[0].decision = "ignore"; }],
    ["policy.extra", (policy) => { policy.extra = true; }],
    ["scan.extra", (policy) => { policy.scan.extra = true; }],
  ];

  for (const [expectedPath, mutate] of cases) {
    const policy = structuredClone(defaultGuardrailPolicy()) as unknown as Record<string, any>;
    mutate(policy);
    assert.throws(
      () => readGuardrailPolicy(repoWithPolicy(policy)),
      (error: unknown) => error instanceof GuardrailPolicyError && error.path === expectedPath,
      expectedPath,
    );
  }
});

test("validates policies before writing them", () => {
  const repositoryPath = repo("csb-policy-write-");
  const policy = defaultGuardrailPolicy();
  policy.scan.maxCostUsd = -1;
  assert.throws(
    () => writeGuardrailPolicy(repositoryPath, policy),
    (error: unknown) => error instanceof GuardrailPolicyError && error.path === "scan.maxCostUsd",
  );
  assert.equal(fs.existsSync(path.join(repositoryPath, ".csb", "guardrails.json")), false);
});

test("does not follow a pre-existing temporary-file symlink", () => {
  const repositoryPath = repo("csb-policy-temp-symlink-");
  const outside = repo("csb-policy-outside-");
  const outsideFile = path.join(outside, "sentinel.txt");
  fs.writeFileSync(outsideFile, "do-not-overwrite");
  fs.mkdirSync(path.join(repositoryPath, ".csb"));

  const mutableFs = fs as unknown as { openSync: typeof fs.openSync };
  const originalOpenSync = fs.openSync;
  let planted = false;
  mutableFs.openSync = ((...args: unknown[]) => {
    const candidate = String(args[0]);
    if (!planted && candidate.endsWith(".tmp")) {
      fs.symlinkSync(outsideFile, candidate);
      planted = true;
    }
    return Reflect.apply(originalOpenSync, fs, args) as number;
  }) as typeof fs.openSync;

  try {
    assert.throws(() => writeGuardrailPolicy(repositoryPath, defaultGuardrailPolicy()));
  } finally {
    mutableFs.openSync = originalOpenSync;
  }
  assert.equal(planted, true);
  assert.equal(fs.readFileSync(outsideFile, "utf8"), "do-not-overwrite");
  assert.equal(fs.existsSync(path.join(repositoryPath, ".csb", "guardrails.json")), false);
});

test("rejects a .csb directory symlink before writing outside the repository", () => {
  const repositoryPath = repo("csb-policy-dir-symlink-");
  const outside = repo("csb-policy-dir-outside-");
  fs.symlinkSync(outside, path.join(repositoryPath, ".csb"));

  assert.throws(
    () => writeGuardrailPolicy(repositoryPath, defaultGuardrailPolicy()),
    (error: unknown) => error instanceof GuardrailPolicyError && error.path === "policyPath",
  );
  assert.equal(fs.existsSync(path.join(outside, "guardrails.json")), false);
  assert.equal(fs.existsSync(path.join(outside, "guardrails.json.tmp")), false);
});

test("validates the opened temporary before writing when .csb is swapped during open", () => {
  const repositoryPath = repo("csb-policy-open-race-");
  const policyDirectory = path.join(repositoryPath, ".csb");
  const parkedDirectory = path.join(repositoryPath, ".csb-parked");
  const outside = repo("csb-policy-open-race-outside-");
  fs.mkdirSync(policyDirectory);

  const mutableFs = fs as unknown as {
    openSync: typeof fs.openSync;
    writeFileSync: typeof fs.writeFileSync;
  };
  const originalOpenSync = fs.openSync;
  const originalWriteFileSync = fs.writeFileSync;
  let swapped = false;
  let observedOutsideContent: string | null = null;

  mutableFs.openSync = ((...args: unknown[]) => {
    const candidate = String(args[0]);
    if (!swapped && candidate.startsWith(`${policyDirectory}${path.sep}`) && candidate.endsWith(".tmp")) {
      fs.renameSync(policyDirectory, parkedDirectory);
      fs.symlinkSync(outside, policyDirectory);
      swapped = true;
    }
    return Reflect.apply(originalOpenSync, fs, args) as number;
  }) as typeof fs.openSync;
  mutableFs.writeFileSync = ((...args: unknown[]) => {
    Reflect.apply(originalWriteFileSync, fs, args);
    if (swapped && typeof args[0] === "number") {
      const outsideTemporary = fs.readdirSync(outside).find((entry) => entry.endsWith(".tmp"));
      if (outsideTemporary !== undefined) {
        observedOutsideContent = fs.readFileSync(path.join(outside, outsideTemporary), "utf8");
      }
    }
  }) as typeof fs.writeFileSync;

  try {
    assert.throws(
      () => writeGuardrailPolicy(repositoryPath, defaultGuardrailPolicy()),
      (error: unknown) => error instanceof GuardrailPolicyError && error.path === "policyPath",
    );
  } finally {
    mutableFs.openSync = originalOpenSync;
    mutableFs.writeFileSync = originalWriteFileSync;
  }

  assert.equal(swapped, true);
  assert.equal(observedOutsideContent, null, "policy content must not be written through the swapped parent");
  assert.deepEqual(fs.readdirSync(outside), [], "an empty temporary created by the race should be safely removed");
});
