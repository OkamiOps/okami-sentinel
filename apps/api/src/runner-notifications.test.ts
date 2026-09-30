import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test, { after } from "node:test";

import type { ScanRun, ScannerCapability } from "@csb/shared";

// Its own data directory: this file asserts which runs produced a notification,
// and other test files create and finish scans in the shared database.
const isolatedData = fs.mkdtempSync(path.join(os.tmpdir(), "csb-runner-notify-data-"));
process.env.CSB_DATA_DIR = isolatedData;

const { MANTIS_SOURCE_REF } = await import("./config.js");
const { deleteRun, listRuns } = await import("./db.js");
const { startScan, cancelScan } = await import("./runner.js");
type ScanLaunchPlan = import("./connections/launch-plan.js").ScanLaunchPlan;

after(() => fs.rmSync(isolatedData, { recursive: true, force: true }));

const scanner: ScannerCapability = {
  engine: "mantis", name: "Google Mantis", enabled: true, available: true, maturity: "preview",
  reason: null, sourceUrl: "https://github.com/google/mantis", authModes: [], models: [],
  efforts: ["high"], modes: ["standard"], stageCount: 9, writesTarget: false,
  executesGeneratedCode: false,
};

function localPlan(scanId: string): ScanLaunchPlan {
  return {
    engine: "mantis", connectionId: "claude-local", providerKind: "anthropic",
    routeKind: "claude-code-local", runnerKind: "local-agent-session", protocol: "claude-code-cli",
    model: null, capabilityCheckId: null, execution: null, scannerAuthMode: "existing-session",
    snapshot: {
      scanId, connectionId: "claude-local", routeKind: "claude-code-local",
      modelSelectionMode: "runtime-default", modelId: null, capabilityCheckId: null,
      executionProfile: null, profileVersion: null, methodologyRef: null,
      protocol: "claude-code-cli", authKind: "existing-session",
      capturedAt: "2026-08-11T16:00:00.000Z",
    },
  } as ScanLaunchPlan;
}

interface Launch {
  displayName: string;
  notified: ScanRun[];
  dependencies: Record<string, unknown>;
  child(): ChildProcess;
  cleanup(): void;
}

function launch(options: {
  spawnThrows?: boolean;
  notifyThrows?: boolean;
} = {}): Launch {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runner-notify-"));
  const repositoryPath = path.join(root, "repository");
  fs.mkdirSync(repositoryPath);
  const displayName = `notify-${randomUUID()}`;
  const notified: ScanRun[] = [];
  let spawned: ChildProcess | null = null;
  return {
    displayName,
    notified,
    child: () => {
      assert.ok(spawned !== null, "the scanner was never spawned");
      return spawned;
    },
    cleanup() {
      const run = listRuns().find((item) => item.displayName === displayName);
      if (run) {
        deleteRun(run.id);
        fs.rmSync(run.scanDir, { recursive: true, force: true });
      }
      fs.rmSync(root, { recursive: true, force: true });
    },
    dependencies: {
      validateScannerRequest: async () => scanner,
      providerRuntime: {
        launchPlans: { resolve: ({ scanId }: { scanId: string }) => localPlan(scanId) },
        store: {} as never,
        vault: {} as never,
      },
      resolveMantisLocalSource: async () => ({
        sourceCacheDir: root, skillsRoot: root, ref: MANTIS_SOURCE_REF,
      }),
      spawn: () => {
        if (options.spawnThrows) throw new Error("fixture spawn failed");
        const child = new EventEmitter() as ChildProcess;
        Object.assign(child, { pid: 91_337, stdout: new PassThrough(), stderr: new PassThrough() });
        spawned = child;
        return child;
      },
      notifyScanOutcome: (run: ScanRun) => {
        notified.push(structuredClone(run));
        if (options.notifyThrows) throw new Error("the outbox is unwritable");
      },
    },
    get repositoryPath() {
      return repositoryPath;
    },
  } as Launch & { repositoryPath: string };
}

function request(repositoryPath: string, displayName: string) {
  return {
    repositoryPath, displayName, engine: "mantis" as const,
    connection: { connectionId: "claude-local", modelSelectionMode: "runtime-default" as const, modelId: null },
  };
}

test("a launch that never reached a child still notifies, exactly once, as failed", async () => {
  const fixture = launch({ spawnThrows: true }) as Launch & { repositoryPath: string };
  try {
    await assert.rejects(
      startScan(request(fixture.repositoryPath, fixture.displayName), { dependencies: fixture.dependencies as never }),
      /fixture spawn failed/,
    );
    const run = listRuns().find((item) => item.displayName === fixture.displayName);
    assert.equal(run?.status, "failed");
    assert.deepEqual(fixture.notified.map((notified) => notified.status), ["failed"]);
    // The persisted row, not the in-flight one: the message points at a scan the
    // reader has to be able to open.
    assert.equal(fixture.notified[0]!.id, run?.id);
    assert.equal(fixture.notified[0]!.pid, null);
    assert.ok(fixture.notified[0]!.completedAt !== null);
  } finally {
    fixture.cleanup();
  }
});

test("a notification that throws changes neither the scan's status nor the caller's error", async () => {
  const fixture = launch({ spawnThrows: true, notifyThrows: true }) as Launch & { repositoryPath: string };
  try {
    // The spawn's error, not the notifier's: a failing notification must not
    // become the failure the caller is told about.
    await assert.rejects(
      startScan(request(fixture.repositoryPath, fixture.displayName), { dependencies: fixture.dependencies as never }),
      /fixture spawn failed/,
    );
    assert.equal(listRuns().find((item) => item.displayName === fixture.displayName)?.status, "failed");
    assert.equal(fixture.notified.length, 1);
  } finally {
    fixture.cleanup();
  }
});

test("a scanner that exits notifies with the terminal status the row ended on", async () => {
  const fixture = launch() as Launch & { repositoryPath: string };
  try {
    const started = await startScan(
      request(fixture.repositoryPath, fixture.displayName),
      { dependencies: fixture.dependencies as never },
    );
    assert.equal(started.status, "running");
    assert.equal(fixture.notified.length, 0);

    fixture.child().emit("close", 0);
    await new Promise((resolve) => setImmediate(resolve));

    const run = listRuns().find((item) => item.displayName === fixture.displayName);
    assert.equal(fixture.notified.length, 1);
    assert.equal(fixture.notified[0]!.status, run?.status);
    assert.ok(["completed", "failed", "incomplete"].includes(String(run?.status)), String(run?.status));
    // Counts and cost are read from the notified row, so it has to be the one the
    // close handler refreshed rather than the one the launch wrote.
    assert.equal(fixture.notified[0]!.pid, null);
    assert.ok(fixture.notified[0]!.completedAt !== null);
  } finally {
    fixture.cleanup();
  }
});

test("a cancellation reaches the notifier only as a cancellation", async () => {
  const fixture = launch() as Launch & { repositoryPath: string };
  try {
    const started = await startScan(
      request(fixture.repositoryPath, fixture.displayName),
      { dependencies: fixture.dependencies as never },
    );
    // `cancelScan` itself notifies nobody. The close that follows reports the
    // persisted cancellation, which the notifier turns into no message at all —
    // `scanNotificationEvent` in `email/repository-notifications.test.ts` pins that.
    assert.equal(cancelScan(started.id), true);
    assert.equal(fixture.notified.length, 0);
    assert.equal(listRuns().find((item) => item.displayName === fixture.displayName)?.status, "cancelled");
  } finally {
    fixture.cleanup();
  }
});
