import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { emptySeverityCounts, type ScanEvent, type ScanProgress, type ScanRun } from "@csb/shared";
import * as runnerModule from "./runner.js";
import {
  SecretRedactor,
  globalSecretRedactor,
  processSecretValues,
  redactErrorMessage,
} from "./redaction.js";

type SanitizeScanEvent = (
  event: Omit<ScanEvent, "at"> & { at?: string },
) => ScanEvent;
type SanitizeScanRun = (run: ScanRun) => ScanRun;

const sanitizeScanEvent = (
  runnerModule as unknown as { sanitizeScanEvent?: SanitizeScanEvent }
).sanitizeScanEvent;
const sanitizeScanRun = (
  runnerModule as unknown as { sanitizeScanRun?: SanitizeScanRun }
).sanitizeScanRun;

test("redacts registered values and credential-shaped text", () => {
  const redactor = new SecretRedactor();
  redactor.register("connection/one", ["sk-live-abc123", "https://secret.example/v1"]);
  const output = redactor.redactText(
    "Authorization: Bearer sk-live-abc123 X-Api-Key=sk-live-abc123 " +
      "url=https://secret.example/v1?api_key=sk-live-abc123",
  );
  assert.equal(output.includes("sk-live-abc123"), false);
  assert.equal(output.includes("secret.example"), false);
  assert.match(output, /\[REDACTED\]/);
});

test("unregister removes only the requested scope", () => {
  const redactor = new SecretRedactor();
  redactor.register("one", ["same-secret"]);
  redactor.register("two", ["same-secret", "second-secret"]);
  redactor.unregister("one");
  assert.equal(redactor.redactText("same-secret second-secret"), "[REDACTED] [REDACTED]");
});

test("safe errors do not echo arbitrary payloads", () => {
  assert.equal(
    redactErrorMessage(new Error("request failed Authorization: Bearer sk-leak")),
    "request failed Authorization: [REDACTED]",
  );
});

test("worker environment discovery returns only sensitive names", () => {
  assert.deepEqual(
    processSecretValues({ NORMAL: "visible", XAI_API_KEY: "xai-secret", ACCESS_TOKEN: "token-value" }),
    ["xai-secret", "token-value"],
  );
});

test("redacts escaped JSON credential fields without corrupting JSON", () => {
  const marker = "escaped-json-secret-marker";
  const redactor = new SecretRedactor();
  const input = JSON.stringify({
    authorization: `Bearer \\"${marker}\\" at C:\\vault\\${marker}`,
    api_key: `prefix\\folder\\"${marker}\\"suffix`,
    normal: "visible",
  });

  const output = redactor.redactText(input);

  assert.doesNotMatch(output, new RegExp(marker));
  assert.doesNotThrow(() => JSON.parse(output));
  assert.deepEqual(JSON.parse(output), {
    authorization: "[REDACTED]",
    api_key: "[REDACTED]",
    normal: "visible",
  });
});

test("redacts quoted Bearer and Basic credentials through their closing quote", () => {
  const marker = "quoted-authorization-secret-marker";
  const redactor = new SecretRedactor();
  const inputs = [
    `Authorization: Bearer "prefix \\"${marker}\\" C:\\vault"`,
    `Authorization=Basic 'prefix \\'${marker}\\' C:\\vault'`,
  ];

  for (const input of inputs) {
    const output = redactor.redactText(input);
    assert.doesNotMatch(output, new RegExp(marker));
    assert.match(output, /^Authorization\s*[:=]\s*\[REDACTED\]$/);
  }
});

test("redacts a registered exact value after JSON escaping in a normal field", () => {
  const marker = "json-exact-secret-marker";
  const secret = `custom "${marker}\\value"`;
  const redactor = new SecretRedactor();
  redactor.register("test/json-exact", [secret]);
  const input = JSON.stringify({ message: `received ${secret} from provider` });

  const output = redactor.redactText(input);
  const parsed = JSON.parse(output) as { message: string };

  assert.doesNotMatch(output, new RegExp(marker));
  assert.equal(parsed.message.includes(secret), false);
  assert.equal(parsed.message, "received [REDACTED] from provider");
});

test("global redactor initializes with bare process secrets", () => {
  const marker = "bare-process-secret-marker";
  const moduleUrl = new URL("./redaction.ts", import.meta.url).href;
  const script = [
    `import { redactText } from ${JSON.stringify(moduleUrl)};`,
    `process.stdout.write(redactText(process.env.XAI_API_KEY ?? "missing"));`,
  ].join("\n");
  const probe = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    {
      cwd: process.cwd(),
      env: { ...process.env, XAI_API_KEY: marker },
      encoding: "utf8",
    },
  );

  assert.equal(probe.status, 0, probe.stderr);
  assert.doesNotMatch(probe.stdout, new RegExp(marker));
  assert.equal(probe.stdout, "[REDACTED]");
});

test("runner redacts a registered bare key from direct scanner output", () => {
  const marker = "bare-direct-scanner-key-marker";
  const scope = "test/direct-scanner";
  globalSecretRedactor.register(scope, [marker]);
  try {
    const raw = { type: "log" as const, message: `[stdout] ${marker}` };
    const event = sanitizeScanEvent
      ? sanitizeScanEvent(raw)
      : { ...raw, at: new Date().toISOString() };

    assert.doesNotMatch(JSON.stringify(event), new RegExp(marker));
    assert.equal(event.message, "[stdout] [REDACTED]");
  } finally {
    globalSecretRedactor.unregister(scope);
  }
});

test("runner redacts nested progress before an event can be serialized to SSE", () => {
  const marker = "nested-progress-secret-marker";
  const scope = "test/progress";
  const progress: ScanProgress = {
    percent: 42,
    phase: `discovery-${marker}`,
    phaseLabel: `Discovery ${marker}`,
    detail: `reviewing ${marker}`,
    unit: `items-${marker}`,
    itemsCompleted: 1,
    itemsTotal: 2,
    deepPhase: `deep-${marker}`,
    lastActivityAt: marker,
  };
  const scan: ScanRun = {
    id: "redaction-progress-test",
    displayName: "fixture",
    repositoryPath: null,
    revision: null,
    scanDir: "/tmp/redaction-progress-test",
    status: "running",
    model: null,
    effort: null,
    mode: "standard",
    engine: "codex-security",
    provider: "openai",
    authMode: "api-key",
    scannerVersion: null,
    recipeHash: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
    cost: null,
    severity: emptySeverityCounts(),
    source: "benchmark",
    pid: null,
    execution: null,
    progress,
  };
  globalSecretRedactor.register(scope, [marker]);
  try {
    const raw = { type: "progress" as const, progress, scan };
    const event = sanitizeScanEvent
      ? sanitizeScanEvent(raw)
      : { ...raw, at: new Date().toISOString() };
    const serialized = JSON.stringify(event);

    assert.doesNotMatch(serialized, new RegExp(marker));
    assert.equal(event.progress?.detail, "reviewing [REDACTED]");
    assert.equal(event.scan?.progress?.detail, "reviewing [REDACTED]");
  } finally {
    globalSecretRedactor.unregister(scope);
  }
});

test("runner redacts progress restored before the first detached SSE event", () => {
  const marker = "restored-progress-secret-marker";
  const scope = "test/restored-progress";
  const run = {
    progress: {
      percent: 20,
      phase: "discovery",
      phaseLabel: "Discovery",
      detail: `restored ${marker}`,
      unit: null,
      itemsCompleted: 0,
      itemsTotal: 1,
    },
  } as ScanRun;
  globalSecretRedactor.register(scope, [marker]);
  try {
    const restored = sanitizeScanRun ? sanitizeScanRun(run) : run;

    assert.doesNotMatch(JSON.stringify(restored.progress), new RegExp(marker));
    assert.equal(restored.progress?.detail, "restored [REDACTED]");
  } finally {
    globalSecretRedactor.unregister(scope);
  }
});

test("worker error conversion discards thrown strings and objects", () => {
  const marker = "worker-error-secret-marker";
  const redactor = new SecretRedactor();
  redactor.register("test/worker", [marker]);
  const capture = (payload: unknown): string => {
    try {
      throw payload;
    } catch (error) {
      return redactErrorMessage(error, redactor);
    }
  };

  assert.equal(capture(`string ${marker}`), "Unexpected provider error");
  assert.equal(capture({ marker }), "Unexpected provider error");
  assert.equal(capture(new Error(`request failed: ${marker}`)), "request failed: [REDACTED]");
});

test("scanner workers route arbitrary failures through the safe error helper", () => {
  for (const worker of ["mantis-worker.ts", "vulnhunter-worker.ts"]) {
    const source = fs.readFileSync(new URL(`./scanners/${worker}`, import.meta.url), "utf8");
    assert.match(source, /const safeErrorMessage/);
    assert.match(source, /redactErrorMessage/);
    assert.doesNotMatch(
      source,
      /String\((?:error|normalizationError|boundaryError)\)/,
    );
  }
});

test("cancel keeps launch secrets registered through trailing child output", () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-cancel-redaction-"));
  const repositoryPath = path.join(fixtureRoot, "repository");
  const stateDir = path.join(fixtureRoot, "state");
  const fakeScanner = path.join(fixtureRoot, "fake-scanner.mjs");
  const marker = "cancel-trailing-secret-marker";
  fs.mkdirSync(repositoryPath);
  fs.mkdirSync(stateDir);
  fs.writeFileSync(
    fakeScanner,
    `#!/usr/bin/env node
const marker = ${JSON.stringify(marker)};
if (!process.argv.includes("scan")) {
  process.stdout.write("{}\\n");
  process.exit(0);
}
process.on("SIGTERM", () => {
  setTimeout(() => {
    process.stdout.write(marker + "\\n");
    setTimeout(() => process.exit(143), 40);
  }, 20);
});
setInterval(() => undefined, 1_000);
`,
    { mode: 0o700 },
  );

  const runnerUrl = new URL("./runner.ts", import.meta.url).href;
  const dbUrl = new URL("./db.ts", import.meta.url).href;
  const activityUrl = new URL("./activity.ts", import.meta.url).href;
  const harness = `
import fs from "node:fs";
const { startScan, cancelScan, subscribe } = await import(${JSON.stringify(runnerUrl)});
const { deleteRun } = await import(${JSON.stringify(dbUrl)});
const { cliLogPath } = await import(${JSON.stringify(activityUrl)});
process.env.OPENAI_API_KEY = ${JSON.stringify(marker)};
let run;
let unsubscribe = () => undefined;
try {
  run = await startScan({
    repositoryPath: ${JSON.stringify(repositoryPath)},
    engine: "codex-security",
    provider: "openai",
    authMode: "api-key",
    mode: "standard",
  });
  const events = [];
  unsubscribe = subscribe(run.id, (event) => events.push(event));
  await new Promise((resolve) => setTimeout(resolve, 150));
  const cancelled = cancelScan(run.id);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const logFile = cliLogPath(run.scanDir);
  const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
  const payload = JSON.stringify({ cancelled, events, log });
  unsubscribe();
  deleteRun(run.id);
  fs.rmSync(logFile, { force: true });
  fs.rmSync(run.scanDir, { recursive: true, force: true });
  process.stdout.write(payload + "\\n", () => process.exit(0));
} catch (error) {
  unsubscribe();
  if (run) {
    deleteRun(run.id);
    fs.rmSync(cliLogPath(run.scanDir), { force: true });
    fs.rmSync(run.scanDir, { recursive: true, force: true });
  }
  process.stderr.write(String(error) + "\\n", () => process.exit(1));
}
`;

  try {
    const probe = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", harness],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          CODEX_BIN: fakeScanner,
          CODEX_SECURITY_BIN: fakeScanner,
          CODEX_SECURITY_STATE_DIR: stateDir,
          OPENAI_API_KEY: "bootstrap-process-key",
        },
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    assert.equal(probe.status, 0, probe.stderr || probe.stdout);
    const result = JSON.parse(probe.stdout.trim()) as {
      cancelled: boolean;
      events: ScanEvent[];
      log: string;
    };
    const exposed = JSON.stringify({ events: result.events, log: result.log });

    assert.equal(result.cancelled, true);
    assert.doesNotMatch(exposed, new RegExp(marker));
    assert.match(exposed, /\[REDACTED\]/);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
