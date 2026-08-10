import assert from "node:assert/strict";
import test from "node:test";

import {
  appendTelemetryEvent,
  mergeTelemetrySnapshot,
  telemetrySnapshot,
} from "./telemetry.js";

test("hydrates persisted telemetry and appends only events after its byte cursor", () => {
  const hydrated = telemetrySnapshot(["same", "same"], 42);

  const replayed = appendTelemetryEvent(hydrated, { message: "same", cursor: 42 });
  assert.deepEqual(replayed.lines, ["same", "same"]);

  const live = appendTelemetryEvent(replayed, { message: "same", cursor: 48 });
  assert.deepEqual(live.lines, ["same", "same", "same"]);
  assert.equal(live.cursor, 48);
});

test("keeps cursorless live diagnostics without pretending they were persisted", () => {
  const state = appendTelemetryEvent(telemetrySnapshot(["persisted"], 12), {
    message: "live diagnostic",
  });
  assert.deepEqual(state.lines, ["persisted", "live diagnostic"]);
  assert.equal(state.cursor, 12);
});

test("does not let an older polling snapshot overwrite a newer SSE event", () => {
  const live = appendTelemetryEvent(telemetrySnapshot(["persisted"], 12), {
    message: "arrived over SSE",
    cursor: 29,
  });

  const merged = mergeTelemetrySnapshot(live, ["persisted"], 12);

  assert.deepEqual(merged.lines, ["persisted", "arrived over SSE"]);
  assert.equal(merged.cursor, 29);
});

test("replaces telemetry with a newer complete polling snapshot", () => {
  const merged = mergeTelemetrySnapshot(
    telemetrySnapshot(["old"], 12),
    ["old", "new from disk"],
    31,
  );

  assert.deepEqual(merged.lines, ["old", "new from disk"]);
  assert.equal(merged.cursor, 31);
});

test("a newer disk snapshot does not erase a cursorless live diagnostic", () => {
  const live = appendTelemetryEvent(telemetrySnapshot(["persisted"], 12), {
    message: "disk write failed but the UI received this",
  });

  const merged = mergeTelemetrySnapshot(live, ["persisted", "new from disk"], 31);

  assert.deepEqual(merged.lines, [
    "persisted",
    "new from disk",
    "disk write failed but the UI received this",
  ]);
  assert.equal(merged.cursor, 31);
});
