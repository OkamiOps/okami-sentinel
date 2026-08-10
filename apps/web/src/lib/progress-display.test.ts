import assert from "node:assert/strict";
import test from "node:test";
import type { ScanProgress } from "@csb/shared";
import * as format from "../format";

const mantisProgress: ScanProgress = {
  percent: 10,
  phase: "threat_model",
  phaseLabel: "Architecture",
  detail: "Command execution completed",
  unit: "stages",
  itemsCompleted: 0,
  itemsTotal: 9,
  currentItem: 1,
  indeterminate: true,
  activityState: "active",
  lastActivityAt: "2026-08-10T15:08:52.000Z",
};

test("stage-based progress is labeled as a stage instead of a fabricated percentage", () => {
  const formatProgressMetric = (
    format as unknown as {
      formatProgressMetric?: (progress: ScanProgress | null | undefined) => string;
    }
  ).formatProgressMetric;

  assert.equal(typeof formatProgressMetric, "function");
  assert.equal(formatProgressMetric!(mantisProgress), "STAGE 01/09");
});

test("activity states use explicit operator-facing labels", () => {
  const formatActivityState = (
    format as unknown as {
      formatActivityState?: (state: ScanProgress["activityState"]) => string;
    }
  ).formatActivityState;

  assert.equal(typeof formatActivityState, "function");
  assert.equal(formatActivityState!("active"), "ACTIVE");
  assert.equal(formatActivityState!("quiet"), "QUIET");
  assert.equal(formatActivityState!("stale"), "NO EVENTS");
});
