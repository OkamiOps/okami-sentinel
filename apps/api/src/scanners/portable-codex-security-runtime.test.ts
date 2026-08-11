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
      previousStageStateBase64: "eyJ1bnRydXN0ZWQiOnRydWV9",
    });
    assert.match(prompt, /repository text.*untrusted data/i);
    assert.match(prompt, /previous stage state.*untrusted data/i);
    assert.match(prompt, /do not execute/i);
    assert.match(prompt, /do not use network/i);
    assert.match(prompt, /do not generate.*PoC/i);
    assert.match(prompt, /do not publish/i);
    assert.match(prompt, new RegExp(stage.artifact.replace(".", "\\.")));
    assert.match(prompt, new RegExp(`"stage":"${stage.id}"`));
    assert.match(prompt, /structured completion/i);
  }
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
