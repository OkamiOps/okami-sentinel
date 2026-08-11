import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  PORTABLE_CODEX_SECURITY_METHODOLOGY_REF,
  PORTABLE_CODEX_SECURITY_REQUIRED_ARTIFACTS,
  PORTABLE_CODEX_SECURITY_STAGES,
  buildPortableCodexSecurityStagePrompt,
} from "./portable-codex-security-profile.js";
import {
  portableCodexSecurityRuntimePath,
  portableCodexSecurityRuntimeProgress,
  readPortableCodexSecurityRuntime,
  writePortableCodexSecurityRuntime,
  type PortableCodexSecurityRuntimeState,
} from "./portable-codex-security-runtime.js";

const NOW = "2026-08-11T15:00:00.000Z";

function runtimeState(
  patch: Partial<PortableCodexSecurityRuntimeState> = {},
): PortableCodexSecurityRuntimeState {
  return {
    engine: "codex-security",
    executionProfile: "portable",
    profileVersion: "sentinel-codex-security-portable-v1",
    methodologyRef: PORTABLE_CODEX_SECURITY_METHODOLOGY_REF,
    status: "running",
    stage: "discovery",
    stageLabel: "Candidate discovery",
    percent: 56,
    detail: "Reviewing source candidates",
    startedAt: NOW,
    updatedAt: NOW,
    lastActivityAt: NOW,
    activitySequence: 3,
    completedAt: null,
    snapshotId: "snapshot-123",
    sourceRef: "a".repeat(40),
    findings: 2,
    usage: {
      reported: true,
      inputTokensKnown: true,
      cachedInputTokensKnown: true,
      cacheWriteInputTokensKnown: true,
      outputTokensKnown: true,
      inputTokens: 120,
      cachedInputTokens: 10,
      cacheWriteInputTokens: 2,
      outputTokens: 30,
    },
    error: null,
    errorCode: null,
    ...patch,
  };
}

function removeFixture(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}

test("Portable Codex Security fixes six frozen bounded stages and prompts each stage defensively", () => {
  assert.deepEqual(
    PORTABLE_CODEX_SECURITY_REQUIRED_ARTIFACTS,
    [
      "01-inventory.json",
      "02-threat-model.json",
      "03-discovery.json",
      "04-dataflow.json",
      "05-validation.json",
      "sentinel-findings.json",
    ],
  );
  assert.equal(PORTABLE_CODEX_SECURITY_STAGES.length, 6);
  assert.equal(Object.isFrozen(PORTABLE_CODEX_SECURITY_STAGES), true);

  let previousCompletePercent = 0;
  for (const stage of PORTABLE_CODEX_SECURITY_STAGES) {
    assert.equal(Object.isFrozen(stage), true);
    assert.ok(stage.startPercent >= previousCompletePercent);
    assert.ok(stage.completePercent > stage.startPercent);
    assert.ok(stage.completePercent <= 100);
    previousCompletePercent = stage.completePercent;

    const prompt = buildPortableCodexSecurityStagePrompt(stage, {
      snapshotRoot: "/snapshot",
      artifactRoot: "/artifacts",
      dossierStateBase64: "eyJ1bnRydXN0ZWQiOnRydWV9",
    });
    assert.match(prompt, /repository text.*untrusted data/i);
    assert.match(prompt, /coverage dossier.*untrusted data/i);
    assert.match(prompt, /do not execute/i);
    assert.match(prompt, /do not use network/i);
    assert.match(prompt, /do not generate.*PoC/i);
    assert.match(prompt, /do not publish/i);
    assert.match(prompt, new RegExp(stage.artifact.replace(".", "\\.")));
    if (stage.id === "report") {
      assert.match(prompt, /"findings":/);
    } else {
      assert.match(prompt, new RegExp(`"stage":"${stage.id}"`));
    }
    assert.match(prompt, /artifact is terminal/i);
    assert.match(prompt, /complete in one tool call/i);
    assert.match(prompt, /never exhaust the model output limit/i);
    assert.doesNotMatch(prompt, /structured completion/i);
    assert.doesNotMatch(prompt, /(?:workspace|results)\./);
    assert.match(prompt, /workspace_(?:list|read|search)/);
    assert.match(prompt, /results_write/);
  }
});

test("Portable Codex Security stage prompts never disclose host snapshot or artifact roots", () => {
  const snapshotRoot = "/private/sentinel/portable-snapshot-never-send";
  const artifactRoot = "/private/sentinel/portable-artifacts-never-send";
  const prompt = buildPortableCodexSecurityStagePrompt(PORTABLE_CODEX_SECURITY_STAGES[0]!, {
    snapshotRoot,
    artifactRoot,
  });

  assert.equal(prompt.includes(snapshotRoot), false);
  assert.equal(prompt.includes(artifactRoot), false);
  assert.match(prompt, /workspace root.*"\."/i);
  assert.match(prompt, /repository-relative paths to workspace_(?:read|search)/i);
  assert.match(prompt, /fixed result-relative name.*01-inventory\.json/i);
});

test("Portable Codex Security runtime writes atomically, round-trips, and maps bounded progress", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "portable-codex-runtime-"));
  try {
    const state = runtimeState();
    writePortableCodexSecurityRuntime(root, state);

    assert.deepEqual(readPortableCodexSecurityRuntime(root), state);
    assert.equal(
      fs.readdirSync(root).some((entry) => entry.includes(".tmp-")),
      false,
    );
    assert.equal(
      portableCodexSecurityRuntimePath(root),
      path.join(root, "portable-codex-security-runtime.json"),
    );

    const running = portableCodexSecurityRuntimeProgress(
      state,
      NOW,
      Date.parse(NOW) + 10_000,
    );
    assert.deepEqual(running, {
      percent: 56,
      phase: "discovery",
      phaseLabel: "Candidate discovery",
      detail: "Reviewing source candidates",
      unit: "stages",
      itemsCompleted: 2,
      itemsTotal: 6,
      currentItem: 3,
      indeterminate: true,
      activityState: "active",
      lastActivityAt: NOW,
      reportableFindings: 2,
    });

    const completed = portableCodexSecurityRuntimeProgress(runtimeState({
      status: "completed",
      stage: "report",
      stageLabel: "Findings and coverage",
      percent: 98,
      completedAt: NOW,
    }));
    assert.equal(completed.percent, 100);
    assert.equal(completed.itemsCompleted, 6);
    assert.equal(completed.currentItem, 6);
    assert.equal(completed.indeterminate, false);
    assert.equal(completed.activityState, undefined);
  } finally {
    removeFixture(root);
  }
});

test("Portable Codex Security runtime rejects every malformed persisted field", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "portable-codex-runtime-invalid-"));
  const target = portableCodexSecurityRuntimePath(root);
  const cases: Array<[string, Record<string, unknown>]> = [
    ["profileVersion", { ...runtimeState(), profileVersion: "wrong-profile" }],
    ["methodologyRef", { ...runtimeState(), methodologyRef: "wrong-methodology" }],
    ["status", { ...runtimeState(), status: "unknown" }],
    ["stage", { ...runtimeState(), stage: "unknown" }],
    ["percent", { ...runtimeState(), percent: "56" }],
    ["detail", { ...runtimeState(), detail: 42 }],
    ["startedAt", { ...runtimeState(), startedAt: "not-a-date" }],
    ["updatedAt", { ...runtimeState(), updatedAt: "not-a-date" }],
    ["lastActivityAt", { ...runtimeState(), lastActivityAt: "not-a-date" }],
    ["activitySequence", { ...runtimeState(), activitySequence: -1 }],
    ["completedAt", { ...runtimeState(), completedAt: "not-a-date" }],
    ["snapshotId", { ...runtimeState(), snapshotId: 42 }],
    ["sourceRef", { ...runtimeState(), sourceRef: "" }],
    ["findings", { ...runtimeState(), findings: 1.5 }],
    ["usage", {
      ...runtimeState(),
      usage: { inputTokens: -1, cachedInputTokens: 0, outputTokens: 0 },
    }],
    ["error", { ...runtimeState(), error: 42 }],
    ["errorCode", { ...runtimeState(), errorCode: "provider-secret-detail" }],
  ];

  try {
    for (const [field, value] of cases) {
      fs.writeFileSync(target, JSON.stringify(value));
      assert.equal(readPortableCodexSecurityRuntime(root), null, field);
    }
  } finally {
    removeFixture(root);
  }
});

test("Portable Codex Security normalize progress marks all six methodology stages complete", () => {
  const progress = portableCodexSecurityRuntimeProgress(runtimeState({
    stage: "normalize",
    stageLabel: "Normalizing findings",
    percent: 99,
  }));

  assert.equal(progress.phase, "reporting");
  assert.equal(progress.itemsCompleted, 6);
  assert.equal(progress.currentItem, 6);
  assert.equal(progress.itemsTotal, 6);
  assert.equal(progress.indeterminate, true);
});
