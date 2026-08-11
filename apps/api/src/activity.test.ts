import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appendCliLog,
  cliLogPath,
  isManagedScanArtifactDirectory,
  purgeScanArtifacts,
  readCliLogSnapshot,
  readCliLogTail,
} from "./activity.js";

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

test("returns a byte cursor with the persisted telemetry snapshot", () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-activity-cursor-"));
  const scanDir = path.join(fixtureRoot, "csb-test-scan");
  fs.mkdirSync(scanDir);

  try {
    const firstCursor = appendCliLog(scanDir, "repeated event");
    const secondCursor = appendCliLog(scanDir, "repeated event");
    const snapshot = readCliLogSnapshot(scanDir, 500);

    assert.ok(firstCursor > 0);
    assert.ok(secondCursor > firstCursor);
    assert.equal(snapshot.cursor, secondCursor);
    assert.deepEqual(snapshot.lines, ["repeated event", "repeated event"]);
  } finally {
    fs.rmSync(cliLogPath(scanDir), { force: true });
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("purges a managed scan directory together with its runtime log", () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-cleanup-"));
  const managedRoot = path.join(fixtureRoot, "scans");
  const scanDir = path.join(managedRoot, "repository", "failed-scan");

  fs.mkdirSync(scanDir, { recursive: true });
  fs.writeFileSync(path.join(scanDir, "partial-result.json"), "{}", "utf8");
  appendCliLog(scanDir, "scan failed");

  try {
    purgeScanArtifacts(scanDir, [managedRoot]);

    assert.equal(fs.existsSync(scanDir), false);
    assert.equal(fs.existsSync(cliLogPath(scanDir)), false);
  } finally {
    fs.rmSync(cliLogPath(scanDir), { force: true });
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("refuses to purge a scan directory outside managed roots", () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-cleanup-"));
  const managedRoot = path.join(fixtureRoot, "managed-scans");
  const outsideDir = path.join(fixtureRoot, "outside", "failed-scan");

  fs.mkdirSync(outsideDir, { recursive: true });
  fs.writeFileSync(path.join(outsideDir, "keep.txt"), "keep", "utf8");

  try {
    assert.equal(isManagedScanArtifactDirectory(outsideDir, [managedRoot]), false);
    assert.throws(
      () => purgeScanArtifacts(outsideDir, [managedRoot]),
      /fora das raízes gerenciadas/,
    );
    assert.equal(fs.existsSync(path.join(outsideDir, "keep.txt")), true);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("refuses a managed path that escapes through a symbolic link", () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-cleanup-"));
  const managedRoot = path.join(fixtureRoot, "managed-scans");
  const outsideRoot = path.join(fixtureRoot, "outside");
  const outsideScan = path.join(outsideRoot, "failed-scan");
  const linkedRoot = path.join(managedRoot, "linked-root");

  fs.mkdirSync(outsideScan, { recursive: true });
  fs.mkdirSync(managedRoot, { recursive: true });
  fs.writeFileSync(path.join(outsideScan, "keep.txt"), "keep", "utf8");
  fs.symlinkSync(outsideRoot, linkedRoot, "dir");

  try {
    assert.equal(
      isManagedScanArtifactDirectory(path.join(linkedRoot, "failed-scan"), [managedRoot]),
      false,
    );
    assert.throws(
      () => purgeScanArtifacts(path.join(linkedRoot, "failed-scan"), [managedRoot]),
      /fora das raízes gerenciadas/,
    );
    assert.equal(fs.existsSync(path.join(outsideScan, "keep.txt")), true);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
