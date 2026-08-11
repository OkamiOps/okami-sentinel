import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import type { ScannerCapability } from "@csb/shared";

import {
  MANTIS_LOCAL_WORKER_BIN,
  MANTIS_LOCAL_WORKER_ENTRY,
  MANTIS_SOURCE_REF,
  SCANS_ROOT,
} from "./config.js";
import { deleteRun } from "./db.js";
import type { ScanLaunchPlan } from "./connections/launch-plan.js";
import { MantisSourceError } from "./scanners/mantis-source.js";
import { CodexSecurityApiBridgeError } from "./scanners/codex-security-api-bridge.js";
import { startScan } from "./runner.js";

const scanner: ScannerCapability = {
  engine: "mantis",
  name: "Google Mantis",
  enabled: true,
  available: true,
  maturity: "preview",
  reason: null,
  sourceUrl: "https://github.com/google/mantis",
  authModes: [],
  models: [],
  efforts: ["high"],
  modes: ["standard"],
  stageCount: 9,
  writesTarget: false,
  executesGeneratedCode: false,
};

function localPlan(scanId: string): ScanLaunchPlan {
  return {
    engine: "mantis",
    connectionId: "claude-local",
    providerKind: "anthropic",
    routeKind: "claude-code-local",
    runnerKind: "local-agent-session",
    protocol: "claude-code-cli",
    model: null,
    capabilityCheckId: null,
    scannerAuthMode: "existing-session",
    snapshot: {
      scanId,
      connectionId: "claude-local",
      routeKind: "claude-code-local",
      modelSelectionMode: "runtime-default",
      modelId: null,
      capabilityCheckId: null,
      capturedAt: "2026-08-11T16:00:00.000Z",
    },
  };
}

function fakeChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, {
    pid: 91_337,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  queueMicrotask(() => child.emit("close", 0));
  return child;
}

function waitForClose(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("startScan launches only the dedicated local Mantis worker with a null runtime-default model and no API keys", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runner-mantis-local-"));
  const repositoryPath = path.join(root, "repository");
  fs.mkdirSync(repositoryPath);
  const displayName = `mantis-local-${randomUUID()}`;
  const launches: Array<{ command: unknown; args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
  let sourceCalls = 0;
  const run = await startScan({
    repositoryPath,
    displayName,
    engine: "mantis",
    provider: "browser-injected-provider",
    model: "browser-injected-model",
    authMode: "api-key",
    connection: {
      connectionId: "claude-local",
      modelSelectionMode: "runtime-default",
      modelId: null,
    },
  }, {
    dependencies: {
      validateScannerRequest: async () => scanner,
      providerRuntime: {
        launchPlans: { resolve: ({ scanId }) => localPlan(scanId) },
        store: {} as never,
        vault: {} as never,
      },
      resolveMantisLocalSource: async () => {
        sourceCalls += 1;
        return {
          sourceCacheDir: "/private/server-only/mantis-cache",
          skillsRoot: `/private/server-only/mantis-cache/${MANTIS_SOURCE_REF.slice(0, 12)}`,
          ref: MANTIS_SOURCE_REF,
        };
      },
      spawn: (command, args, options) => {
        launches.push({ command, args: [...args], env: { ...options.env } });
        return fakeChild();
      },
      environment: {
        OPENAI_API_KEY: "must-not-reach-local-mantis",
        CODEX_API_KEY: "must-not-reach-local-mantis",
        ANTHROPIC_API_KEY: "must-not-reach-local-mantis",
        XAI_API_KEY: "must-not-reach-local-mantis",
        CURSOR_API_KEY: "must-not-reach-local-mantis",
        CLAUDE_CONFIG_DIR: "/private/claude-existing-session",
      },
    },
  });

  try {
    await waitForClose();
    assert.equal(sourceCalls, 1);
    assert.equal(run.model, null);
    assert.equal(run.effort, null);
    assert.equal(run.cost, null);
    assert.equal(run.provider, "anthropic");
    assert.equal(run.authMode, "existing-session");
    assert.equal(launches.length, 1);
    assert.equal(launches[0]?.command, MANTIS_LOCAL_WORKER_BIN);
    assert.equal(launches[0]?.args[0], MANTIS_LOCAL_WORKER_ENTRY);
    assert.doesNotMatch(String(launches[0]?.args[0]), /mantis-(?:http-)?worker/);
    for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY", "ANTHROPIC_API_KEY", "XAI_API_KEY", "CURSOR_API_KEY"] as const) {
      assert.equal(launches[0]?.env[key], undefined, `${key} must not reach the worker`);
    }
    assert.equal(launches[0]?.env.CLAUDE_CONFIG_DIR, "/private/claude-existing-session");
    const configPath = launches[0]?.args[1];
    assert.equal(typeof configPath, "string");
    const config = JSON.parse(fs.readFileSync(configPath!, "utf8")) as Record<string, unknown>;
    assert.deepEqual(Object.keys(config).sort(), [
      "outputDir", "paths", "providerPlan", "repositoryPath", "sourceCacheDir", "sourceRef",
    ]);
    assert.equal("model" in config, false);
    assert.equal(fs.statSync(configPath!).mode & 0o077, 0);
  } finally {
    deleteRun(run.id);
    fs.rmSync(run.scanDir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("startScan rejects an invalid local Mantis source before it writes a worker config or starts a child", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runner-mantis-local-invalid-source-"));
  const repositoryPath = path.join(root, "repository");
  const displayName = `mantis-source-${randomUUID()}`;
  fs.mkdirSync(repositoryPath);
  let children = 0;
  try {
    await assert.rejects(
      startScan({
        repositoryPath,
        displayName,
        engine: "mantis",
        connection: {
          connectionId: "claude-local",
          modelSelectionMode: "runtime-default",
          modelId: null,
        },
      }, {
        dependencies: {
          validateScannerRequest: async () => scanner,
          providerRuntime: { launchPlans: { resolve: ({ scanId }) => localPlan(scanId) }, store: {} as never, vault: {} as never },
          resolveMantisLocalSource: async () => { throw new MantisSourceError("source_invalid"); },
          spawn: () => {
            children += 1;
            return fakeChild();
          },
        },
      }),
      (error: unknown) => error instanceof MantisSourceError && error.code === "source_invalid",
    );
    assert.equal(children, 0);
    assert.equal(fs.existsSync(path.join(SCANS_ROOT, displayName)), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("startScan honors an already-aborted local Mantis request before source preflight or child creation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runner-mantis-local-abort-"));
  const repositoryPath = path.join(root, "repository");
  fs.mkdirSync(repositoryPath);
  const controller = new AbortController();
  controller.abort();
  let sourceCalls = 0;
  let children = 0;
  try {
    await assert.rejects(
      startScan({ repositoryPath, engine: "mantis" }, {
        signal: controller.signal,
        dependencies: {
          resolveMantisLocalSource: async () => {
            sourceCalls += 1;
            throw new Error("unreachable");
          },
          spawn: () => {
            children += 1;
            return fakeChild();
          },
        },
      }),
      (error: unknown) => error instanceof CodexSecurityApiBridgeError && error.code === "credential_unavailable",
    );
    assert.equal(sourceCalls, 0);
    assert.equal(children, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
