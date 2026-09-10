import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createProcessIdentityService,
  persistProcessIdentity,
  processIdentityPath,
  readProcessIdentity,
  type ProcessIdentityRuntime,
  type ProcessSignal,
  type ProcessSnapshot,
} from "./process-identity.js";
import { MANTIS_WORKER_ENTRY } from "./config.js";

function runtimeFixture(options: {
  candidates?: number[];
  snapshots?: Map<number, ProcessSnapshot>;
  currentPid?: number;
}) {
  const patterns: string[] = [];
  const signals: Array<{ pid: number; signal: ProcessSignal }> = [];
  const snapshots = options.snapshots ?? new Map<number, ProcessSnapshot>();
  const runtime: ProcessIdentityRuntime = {
    currentPid: options.currentPid ?? 900,
    findPidsByPattern(pattern) {
      patterns.push(pattern);
      return options.candidates ?? [];
    },
    inspect(pid) {
      return snapshots.get(pid) ?? null;
    },
    signal(pid, signal) {
      signals.push({ pid, signal });
    },
  };
  return { runtime, patterns, signals, snapshots };
}

test("discovers only identities whose command literally contains the absolute scan directory", () => {
  const scanDir = path.join(os.tmpdir(), "csb.$(not-a-shell)[worker]");
  const absoluteScanDir = path.resolve(scanDir);
  const workerConfig = path.join(absoluteScanDir, "mantis-run.json");
  const { runtime, patterns } = runtimeFixture({
    candidates: [41, 42, 900, 41],
    snapshots: new Map([
      [41, { pid: 41, startTime: "linux:boot:100", command: `tsx ${MANTIS_WORKER_ENTRY} ${workerConfig}` }],
      [42, { pid: 42, startTime: "linux:boot:101", command: "scanner --output /tmp/other" }],
      [900, { pid: 900, startTime: "linux:boot:102", command: `tsx ${MANTIS_WORKER_ENTRY} ${workerConfig}` }],
    ]),
  });
  const service = createProcessIdentityService(runtime);

  const identities = service.findProcessIdentitiesForScanDir(scanDir);

  assert.equal(patterns.length, 1);
  assert.equal(patterns[0], absoluteScanDir.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&"));
  assert.deepEqual(identities.map((identity) => identity.pid), [41]);
  assert.equal(identities[0]?.commandFingerprint.length, 64);
});

test("discovery rejects root, relative paths, sibling prefixes, editors, and inline scripts", () => {
  const scanDir = path.join(os.tmpdir(), "csb-process-one");
  const siblingDir = `${scanDir}-other`;
  const { runtime, patterns } = runtimeFixture({
    candidates: [61, 62, 63],
    snapshots: new Map([
      [61, {
        pid: 61,
        startTime: "linux:boot:201",
        command: `tsx ${MANTIS_WORKER_ENTRY} ${path.join(siblingDir, "mantis-run.json")}`,
      }],
      [62, {
        pid: 62,
        startTime: "linux:boot:202",
        command: `vim\0${MANTIS_WORKER_ENTRY}\0${path.join(scanDir, "mantis-run.json")}`,
      }],
      [63, {
        pid: 63,
        startTime: "linux:boot:203",
        command: `node\0--eval\0console.log(${JSON.stringify(MANTIS_WORKER_ENTRY)}, ${JSON.stringify(path.join(scanDir, "mantis-run.json"))})`,
      }],
    ]),
  });
  const service = createProcessIdentityService(runtime);

  assert.deepEqual(service.findProcessIdentitiesForScanDir(scanDir), []);
  assert.deepEqual(service.findProcessIdentitiesForScanDir("relative/scan"), []);
  assert.deepEqual(service.findProcessIdentitiesForScanDir(path.parse(scanDir).root), []);
  assert.equal(patterns.length, 1);
});

test("discovery preserves direct Node, tsx-loader, and MantisPython worker invocations", () => {
  const scanDir = path.join(os.tmpdir(), "csb-process-real-workers");
  const workerConfig = path.join(scanDir, "mantis-run.json");
  const { runtime } = runtimeFixture({
    candidates: [71, 72, 73, 74],
    snapshots: new Map([
      [71, { pid: 71, startTime: "linux:boot:301", command: `node\0${MANTIS_WORKER_ENTRY}\0${workerConfig}` }],
      [72, { pid: 72, startTime: "linux:boot:302", command: `node\0--import\0tsx\0${MANTIS_WORKER_ENTRY}\0${workerConfig}` }],
      [73, { pid: 73, startTime: "linux:boot:303", command: `node\0/opt/tsx/dist/cli.mjs\0${MANTIS_WORKER_ENTRY}\0${workerConfig}` }],
      [74, { pid: 74, startTime: "linux:boot:304", command: `MantisPython\0${MANTIS_WORKER_ENTRY}\0${workerConfig}` }],
    ]),
  });

  const identities = createProcessIdentityService(runtime).findProcessIdentitiesForScanDir(scanDir);

  assert.deepEqual(identities.map((identity) => identity.pid), [71, 72, 73, 74]);
});

test("discovers managed Codex Security after restart only as the actual script and exact scan output", () => {
  const scanDir = path.join(os.tmpdir(), "csb-managed-security-scan");
  const entry = path.join(os.tmpdir(), "engine-updates/versions/codex-security/0.1.25/node_modules/@openai/codex-security/bin/codex-security.mjs");
  const argv = [
    ["node", entry, "scan", "--output-dir", scanDir],
    [entry, "scan", "--output-dir", scanDir],
    ["node", "/other/script.mjs", entry, "scan", "--output-dir", scanDir],
    ["vim", entry, "scan", "--output-dir", scanDir],
    ["node", entry, "scan", "--output-dir", `${scanDir}-other`],
    ["node", entry, "--output-dir", scanDir],
    ["node", `${entry}.other`, "scan", "--output-dir", scanDir],
  ];
  const { runtime } = runtimeFixture({
    candidates: argv.map((_, index) => 101 + index),
    snapshots: new Map(argv.map((args, index) => [101 + index, {
      pid: 101 + index, startTime: `linux:boot:${index}`, command: args.join("\0"),
    }])),
  });
  assert.deepEqual(createProcessIdentityService(runtime).findProcessIdentitiesForScanDir(scanDir).map(({ pid }) => pid), [101, 102]);
});

test("never sends TERM or delayed KILL after the stored process identity changes", () => {
  const scanDir = path.join(os.tmpdir(), "csb-process-identity-test");
  const snapshot: ProcessSnapshot = {
    pid: 41,
    startTime: "linux:boot:100",
    command: `scanner --output ${scanDir}`,
  };
  const { runtime, signals, snapshots } = runtimeFixture({
    snapshots: new Map([[snapshot.pid, snapshot]]),
  });
  const service = createProcessIdentityService(runtime);
  const identity = service.captureProcessIdentity(snapshot.pid, scanDir);

  assert.ok(identity);
  assert.equal(service.signalVerifiedProcess(identity, scanDir, "SIGTERM"), true);

  snapshots.set(snapshot.pid, {
    ...snapshot,
    startTime: "linux:boot:101",
  });
  assert.equal(service.signalVerifiedProcess(identity, scanDir, "SIGKILL"), false);
  assert.deepEqual(signals, [{ pid: snapshot.pid, signal: "SIGTERM" }]);
});

test("rejects a matching PID when its command no longer identifies the scan", () => {
  const scanDir = path.join(os.tmpdir(), "csb-process-identity-command-test");
  const snapshot: ProcessSnapshot = {
    pid: 52,
    startTime: "ps:Sun Sep  7 12:00:00 2026",
    command: `scanner --output ${scanDir}`,
  };
  const { runtime, signals, snapshots } = runtimeFixture({
    snapshots: new Map([[snapshot.pid, snapshot]]),
  });
  const service = createProcessIdentityService(runtime);
  const identity = service.captureProcessIdentity(snapshot.pid, scanDir);

  assert.ok(identity);
  snapshots.set(snapshot.pid, {
    ...snapshot,
    command: "scanner --output /tmp/reused-pid",
  });
  assert.equal(service.isProcessIdentityCurrent(identity, scanDir), false);
  assert.equal(service.signalVerifiedProcess(identity, scanDir, "SIGTERM"), false);
  assert.deepEqual(signals, []);
});

test("persists only a verifiable identity sidecar, not the command line", () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-process-identity-"));
  const scanDir = path.join(fixtureRoot, "scan");
  const identity = {
    version: 1 as const,
    pid: 73,
    startTime: "linux:boot:200",
    commandFingerprint: "b".repeat(64),
  };

  try {
    assert.equal(persistProcessIdentity(scanDir, identity), true);
    assert.deepEqual(readProcessIdentity(scanDir), identity);
    const contents = fs.readFileSync(processIdentityPath(scanDir), "utf8");
    assert.equal(contents.includes(scanDir), false);
    assert.equal(contents.includes("scanner --output"), false);
  } finally {
    fs.rmSync(processIdentityPath(scanDir), { force: true });
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("discovers the actual tsx child loader pair but rejects injected or unrelated preload scripts", () => {
  const scanDir = path.join(os.tmpdir(), "csb-tsx-child");
  const config = path.join(scanDir, "mantis-run.json");
  const preflight = "/repo/node_modules/.pnpm/tsx@4.23.1/node_modules/tsx/dist/preflight.cjs";
  const loader = "file:///repo/node_modules/.pnpm/tsx@4.23.1/node_modules/tsx/dist/loader.mjs";
  const prefixes = [
    ["--require", preflight, "--import", loader],
    ["--require", "/tmp/evil.cjs", "--import", loader],
    ["--require", preflight, "--import", "file:///other/tsx/dist/loader.mjs"],
    ["--require", preflight, "--import", loader, "/tmp/another-script.js"],
  ];
  const { runtime } = runtimeFixture({ candidates: [301,302,303,304,305], snapshots: new Map([
    ...prefixes.map((prefix, i) => [301+i, {pid:301+i,startTime:`linux:boot:${301+i}`,command:["node",...prefix,MANTIS_WORKER_ENTRY,config].join("\0")}] as const),
    [305,{pid:305,startTime:"mac:boot:305",command:["node",...prefixes[0]!,MANTIS_WORKER_ENTRY,config].join(" ")}],
  ]) });
  assert.deepEqual(createProcessIdentityService(runtime).findProcessIdentitiesForScanDir(scanDir).map(identity=>identity.pid), [301,305]);
});
