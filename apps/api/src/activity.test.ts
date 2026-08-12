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

test("purges Codex sessions rooted at a scan without touching a sibling scan", () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-cleanup-sessions-"));
  const managedRoot = path.join(fixtureRoot, "scans");
  const sessionsRoot = path.join(fixtureRoot, "sessions");
  const scanDir = path.join(managedRoot, "repository", "csb-target");
  const siblingDir = path.join(managedRoot, "repository", "csb-target-other");
  const exactSession = path.join(sessionsRoot, "exact.jsonl");
  const workerSession = path.join(sessionsRoot, "worker.jsonl");
  const siblingSession = path.join(sessionsRoot, "sibling.jsonl");

  fs.mkdirSync(scanDir, { recursive: true });
  fs.mkdirSync(siblingDir, { recursive: true });
  fs.mkdirSync(sessionsRoot, { recursive: true });
  const writeSession = (file: string, cwd: string) => fs.writeFileSync(
    file,
    `${JSON.stringify({ type: "session_meta", payload: { cwd } })}\n`,
    "utf8",
  );
  writeSession(exactSession, scanDir);
  writeSession(
    workerSession,
    path.join(scanDir, "artifacts", "deep_discovery", "workers", "discovery-0001", "output"),
  );
  writeSession(siblingSession, siblingDir);

  try {
    const result = purgeScanArtifacts(scanDir, [managedRoot], sessionsRoot);

    assert.equal(result.sessionsDeleted, 2);
    assert.equal(fs.existsSync(exactSession), false);
    assert.equal(fs.existsSync(workerSession), false);
    assert.equal(fs.existsSync(siblingSession), true);
    assert.equal(fs.existsSync(siblingDir), true);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("purges a managed Portable snapshot after it was locked read-only", () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-cleanup-readonly-"));
  const managedRoot = path.join(fixtureRoot, "scans");
  const scanDir = path.join(managedRoot, "repository", "failed-scan");
  const snapshotDir = path.join(scanDir, "portable-codex-security-snapshot", "src");
  const snapshotFile = path.join(snapshotDir, "index.ts");

  fs.mkdirSync(snapshotDir, { recursive: true });
  fs.writeFileSync(snapshotFile, "export {};\n", "utf8");
  fs.chmodSync(snapshotFile, 0o400);
  fs.chmodSync(snapshotDir, 0o500);
  fs.chmodSync(path.dirname(snapshotDir), 0o500);

  try {
    purgeScanArtifacts(scanDir, [managedRoot]);

    assert.equal(fs.existsSync(scanDir), false);
  } finally {
    if (fs.existsSync(path.dirname(snapshotDir))) fs.chmodSync(path.dirname(snapshotDir), 0o700);
    if (fs.existsSync(snapshotDir)) fs.chmodSync(snapshotDir, 0o700);
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("purging a managed snapshot never follows a descendant symbolic link", () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-cleanup-link-"));
  const managedRoot = path.join(fixtureRoot, "scans");
  const scanDir = path.join(managedRoot, "repository", "failed-scan");
  const snapshotDir = path.join(scanDir, "portable-codex-security-snapshot");
  const outsideDir = path.join(fixtureRoot, "outside");
  const outsideFile = path.join(outsideDir, "keep.txt");

  fs.mkdirSync(snapshotDir, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.writeFileSync(outsideFile, "keep", "utf8");
  fs.chmodSync(outsideFile, 0o400);
  fs.symlinkSync(outsideDir, path.join(snapshotDir, "outside-link"), "dir");
  fs.chmodSync(snapshotDir, 0o500);

  try {
    purgeScanArtifacts(scanDir, [managedRoot]);

    assert.equal(fs.existsSync(scanDir), false);
    assert.equal(fs.readFileSync(outsideFile, "utf8"), "keep");
    assert.equal(fs.statSync(outsideFile).mode & 0o777, 0o400);
  } finally {
    if (fs.existsSync(snapshotDir)) fs.chmodSync(snapshotDir, 0o700);
    fs.chmodSync(outsideFile, 0o600);
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
