import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  GuardrailExceptionsError,
  readGuardrailExceptions,
} from "./guardrail-exceptions-file.js";

function repo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "csb-exceptions-"));
}

function tempRepoWithExceptions(value: unknown): string {
  const repositoryPath = repo();
  fs.mkdirSync(path.join(repositoryPath, ".csb"));
  fs.writeFileSync(path.join(repositoryPath, ".csb", "guardrails-exceptions.json"), JSON.stringify(value));
  return repositoryPath;
}

function validException(): Record<string, unknown> {
  return {
    findingIdentity: "finding-1",
    reason: "Migração com prazo definido",
    owner: "marcos",
    createdAt: "2026-08-01T00:00:00Z",
    expiresAt: "2026-08-30T00:00:00Z",
    branches: ["main"],
    ruleIndexes: [],
  };
}

test("returns an empty array when the exception file is absent", () => {
  const repositoryPath = repo();
  assert.deepEqual(readGuardrailExceptions(repositoryPath), []);
  assert.equal(fs.existsSync(path.join(repositoryPath, ".csb", "guardrails-exceptions.json")), false);
});

test("reads versioned exceptions and rejects incomplete entries", () => {
  const repositoryPath = tempRepoWithExceptions({ schemaVersion: 1, exceptions: [validException()] });
  assert.equal(readGuardrailExceptions(repositoryPath)[0]?.findingIdentity, "finding-1");

  assert.throws(
    () => readGuardrailExceptions(tempRepoWithExceptions({ schemaVersion: 1, exceptions: [{ reason: "missing identity" }] })),
    (error: unknown) => error instanceof GuardrailExceptionsError && error.path === "exceptions[0].findingIdentity",
  );
});

test("defaults omitted target arrays and requires at least one target", () => {
  const branchOnly = validException();
  delete branchOnly.ruleIndexes;
  assert.deepEqual(
    readGuardrailExceptions(tempRepoWithExceptions({ schemaVersion: 1, exceptions: [branchOnly] }))[0]?.ruleIndexes,
    [],
  );

  const ruleOnly = validException();
  delete ruleOnly.branches;
  ruleOnly.ruleIndexes = [0, 2];
  assert.deepEqual(
    readGuardrailExceptions(tempRepoWithExceptions({ schemaVersion: 1, exceptions: [ruleOnly] }))[0]?.branches,
    [],
  );

  const noTargets = validException();
  noTargets.branches = [];
  noTargets.ruleIndexes = [];
  assert.throws(
    () => readGuardrailExceptions(tempRepoWithExceptions({ schemaVersion: 1, exceptions: [noTargets] })),
    (error: unknown) => error instanceof GuardrailExceptionsError && error.path === "exceptions[0].targets",
  );
});

test("reports malformed documents with exact paths", () => {
  const cases: Array<[string, unknown]> = [
    ["schemaVersion", { schemaVersion: 2, exceptions: [] }],
    ["exceptions", { schemaVersion: 1, exceptions: {} }],
    ["exceptions[0].reason", { schemaVersion: 1, exceptions: [{ ...validException(), reason: "" }] }],
    ["exceptions[0].owner", { schemaVersion: 1, exceptions: [{ ...validException(), owner: 3 }] }],
    ["exceptions[0].createdAt", { schemaVersion: 1, exceptions: [{ ...validException(), createdAt: "yesterday" }] }],
    ["exceptions[0].expiresAt", { schemaVersion: 1, exceptions: [{ ...validException(), expiresAt: "2026-99-99" }] }],
    ["exceptions[0].branches[0]", { schemaVersion: 1, exceptions: [{ ...validException(), branches: [""] }] }],
    ["exceptions[0].ruleIndexes[0]", { schemaVersion: 1, exceptions: [{ ...validException(), ruleIndexes: [-1] }] }],
    ["exceptions[0].ruleIndexes[0]", { schemaVersion: 1, exceptions: [{ ...validException(), ruleIndexes: [1.5] }] }],
    ["exceptions[0].extra", { schemaVersion: 1, exceptions: [{ ...validException(), extra: true }] }],
  ];

  for (const [expectedPath, document] of cases) {
    assert.throws(
      () => readGuardrailExceptions(tempRepoWithExceptions(document)),
      (error: unknown) => error instanceof GuardrailExceptionsError && error.path === expectedPath,
      expectedPath,
    );
  }
});

test("reports malformed JSON as a typed document error", () => {
  const repositoryPath = repo();
  fs.mkdirSync(path.join(repositoryPath, ".csb"));
  fs.writeFileSync(path.join(repositoryPath, ".csb", "guardrails-exceptions.json"), "{");
  assert.throws(
    () => readGuardrailExceptions(repositoryPath),
    (error: unknown) => error instanceof GuardrailExceptionsError && error.path === "exceptions",
  );
});
