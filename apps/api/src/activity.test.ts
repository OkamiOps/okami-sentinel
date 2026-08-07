import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { appendCliLog, cliLogPath, readCliLogTail } from "./activity.js";

test("persists runtime telemetry without writing into the scanner output directory", () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-activity-"));
  const scanDir = path.join(fixtureRoot, "csb-test-scan");
  fs.mkdirSync(scanDir);

  try {
    appendCliLog(scanDir, "scan started");

    assert.deepEqual(fs.readdirSync(scanDir), []);
    assert.deepEqual(readCliLogTail(scanDir), ["scan started"]);
  } finally {
    fs.rmSync(cliLogPath(scanDir), { force: true });
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
