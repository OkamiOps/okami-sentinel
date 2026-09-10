import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyScannerTerminationLine,
  hasPortableWorkerResumeCheckpoint,
  scanStatusAfterClose,
  shouldAutoRecoverPortableWorkerInterruption,
} from "./runner.js";

test("native Codex usage exhaustion is an incomplete scan rather than an engine failure", () => {
  const reason = classifyScannerTerminationLine(
    "You've hit your usage limit for GPT-5.3-Codex-Spark. Switch to another model now, or try again later.",
  );
  assert.equal(reason, "usage_limit_exceeded");
  assert.equal(scanStatusAfterClose("running", 2, reason), "incomplete");
  assert.equal(
    classifyScannerTerminationLine("You've hit your usage li" + "mit for GPT-5.3-Codex-Spark."),
    "usage_limit_exceeded",
  );
});

test("ordinary nonzero scanner exits remain failures", () => {
  assert.equal(classifyScannerTerminationLine("scanner internal error"), null);
  assert.equal(scanStatusAfterClose("running", 2, null), "failed");
  assert.equal(scanStatusAfterClose("completed", 2, "usage_limit_exceeded"), "completed");
});

test("Portable close recovery requires a live checkpoint and excludes quota termination", () => {
  const resumable = { status: "running" as const, snapshotId: "content:checkpoint" };
  assert.equal(scanStatusAfterClose("running", null, null), "cancelled");
  assert.equal(hasPortableWorkerResumeCheckpoint(resumable, null), true);
  assert.equal(shouldAutoRecoverPortableWorkerInterruption("incomplete", resumable, null), true);
  assert.equal(shouldAutoRecoverPortableWorkerInterruption("incomplete", {
    status: "preparing",
    snapshotId: "content:checkpoint",
  }, null), true);
  assert.equal(shouldAutoRecoverPortableWorkerInterruption("incomplete", resumable, "usage_limit_exceeded"), false);
  assert.equal(hasPortableWorkerResumeCheckpoint(resumable, "usage_limit_exceeded"), false);
  assert.equal(shouldAutoRecoverPortableWorkerInterruption("incomplete", {
    status: "failed",
    snapshotId: "content:checkpoint",
  }, null), false);
  assert.equal(shouldAutoRecoverPortableWorkerInterruption("incomplete", {
    status: "running",
    snapshotId: null,
  }, null), false);
  assert.equal(shouldAutoRecoverPortableWorkerInterruption("cancelled", resumable, null), false);
});
