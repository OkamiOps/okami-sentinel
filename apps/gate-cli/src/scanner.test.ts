import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { defaultGuardrailPolicy } from "@csb/gate-core";

import { createScannerAdapter, type SpawnCommand } from "./scanner.js";

const validManifest = {
  documentType: "codex-security.scan-manifest",
  schemaVersion: "1.0",
  scan: {
    id: "scan-42",
    status: "completed",
    findingsRef: "findings.json",
    producer: { name: "codex-security-plugin", version: "0.1.29" },
  },
};

test("a target .npmrc cannot select a replacement scanner or receive inherited secrets", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "csb-scanner-npmrc-"));
  const repositoryPath = path.join(root, "head");
  const outputDir = path.join(root, "results");
  const scannerPath = path.join(root, "trusted-scanner.mjs");
  fs.mkdirSync(repositoryPath, { recursive: true });

  let requests = 0;
  const registry = createServer((_request, response) => {
    requests += 1;
    response.writeHead(500);
    response.end();
  });
  await listen(registry);
  const address = registry.address();
  assert.ok(address !== null && typeof address !== "string");
  fs.writeFileSync(
    path.join(repositoryPath, ".npmrc"),
    `@openai:registry=http://127.0.0.1:${address.port}\n`,
  );
  writeTrustedScanner(scannerPath);

  const previousSecret = process.env.CSB_TEST_DUMMY_SECRET;
  process.env.CSB_TEST_DUMMY_SECRET = "must-not-reach-scanner";
  try {
    const result = await createScannerAdapter(undefined, () => scannerPath).run({
      repositoryPath,
      paths: [],
      policy: defaultGuardrailPolicy(),
      outputDir,
    });
    assert.equal(result.status, "completed");
    assert.equal(result.scanId, "scan-42");
    assert.equal(requests, 0);
  } finally {
    if (previousSecret === undefined) delete process.env.CSB_TEST_DUMMY_SECRET;
    else process.env.CSB_TEST_DUMMY_SECRET = previousSecret;
    await close(registry);
  }
});

test("rejects malformed scanner findings before they can be completed", async () => {
  const cases: Array<{ name: string; findings: string }> = [
    {
      name: "missing findings",
      findings: JSON.stringify({
        documentType: "codex-security.findings",
        schemaVersion: "1.0",
        scanId: "scan-42",
      }),
    },
    {
      name: "null findings",
      findings: JSON.stringify({
        documentType: "codex-security.findings",
        schemaVersion: "1.0",
        scanId: "scan-42",
        findings: null,
      }),
    },
    {
      name: "object findings",
      findings: JSON.stringify({
        documentType: "codex-security.findings",
        schemaVersion: "1.0",
        scanId: "scan-42",
        findings: { malformed: true },
      }),
    },
    {
      name: "finding without identity and severity",
      findings: JSON.stringify({
        documentType: "codex-security.findings",
        schemaVersion: "1.0",
        scanId: "scan-42",
        findings: [{ findingId: "finding-1", occurrenceId: "occurrence-1", title: "Incomplete" }],
      }),
    },
    { name: "truncated JSON", findings: "{\"findings\":" },
  ];

  for (const scenario of cases) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "csb-scanner-contract-"));
    const repositoryPath = path.join(root, "head");
    const outputDir = path.join(root, "results");
    fs.mkdirSync(repositoryPath);
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, "scan-manifest.json"), JSON.stringify(validManifest));
    fs.writeFileSync(path.join(outputDir, "findings.json"), scenario.findings);

    await assert.rejects(
      createScannerAdapter(successfulSpawn, () => "/trusted/codex-security.mjs").run({
        repositoryPath,
        paths: [],
        policy: defaultGuardrailPolicy(),
        outputDir,
      }),
      /Security scanner produced invalid|Security scanner produced unsupported/,
      scenario.name,
    );
  }
});

test("accepts the official informational severity as info", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "csb-scanner-informational-"));
  const repositoryPath = path.join(root, "head");
  const outputDir = path.join(root, "results");
  fs.mkdirSync(repositoryPath);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, "scan-manifest.json"), JSON.stringify(validManifest));
  fs.writeFileSync(path.join(outputDir, "findings.json"), JSON.stringify({
    documentType: "codex-security.findings",
    schemaVersion: "1.0",
    scanId: "scan-42",
    findings: [{
      findingId: "finding-1",
      occurrenceId: "occurrence-1",
      identity: { anchor: "source:1" },
      fingerprints: { primary: "sha256:finding" },
      title: "Version disclosure",
      severity: { level: "informational" },
    }],
  }));

  const result = await createScannerAdapter(successfulSpawn, () => "/trusted/codex-security.mjs").run({
    repositoryPath,
    paths: [],
    policy: defaultGuardrailPolicy(),
    outputDir,
  });
  assert.equal(result.findings[0]?.severity, "info");
});

test("the locked 0.1.29 CLI mock scan satisfies the gate contract", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "csb-scanner-real-contract-"));
  const repositoryPath = path.join(root, "head");
  const outputDir = path.join(root, "results");
  fs.mkdirSync(repositoryPath);
  fs.writeFileSync(path.join(repositoryPath, "example.ts"), "export const value = 1;\n");

  let stderr = "";
  const spawnMockScanner: SpawnCommand = (command, args, options) => {
    const child = spawn(command, [...args, "--mock"], options);
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    return child as unknown as ReturnType<SpawnCommand>;
  };
  let result;
  try {
    result = await createScannerAdapter(spawnMockScanner).run({
      repositoryPath,
      paths: ["example.ts"],
      policy: defaultGuardrailPolicy(),
      outputDir,
    });
  } catch (error) {
    assert.fail(`${String(error)}\n${stderr}`);
  }

  assert.equal(result.status, "completed");
  assert.ok(result.findings.some((finding) => finding.severity === "info"));
  assert.equal(result.scannerVersion, "0.1.29");
});

const successfulSpawn: SpawnCommand = () => {
  const emitter = new EventEmitter();
  const child = Object.assign(emitter, {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  }) as unknown as ReturnType<SpawnCommand>;
  queueMicrotask(() => emitter.emit("close", 0));
  return child;
};

function writeTrustedScanner(scannerPath: string): void {
  const findings = {
    documentType: "codex-security.findings",
    schemaVersion: "1.0",
    scanId: "scan-42",
    findings: [],
  };
  fs.writeFileSync(scannerPath, [
    'import fs from "node:fs";',
    'import path from "node:path";',
    'if (process.env.CSB_TEST_DUMMY_SECRET !== undefined) process.exit(91);',
    'const outputIndex = process.argv.indexOf("--output-dir");',
    'const outputDir = process.argv[outputIndex + 1];',
    `fs.writeFileSync(path.join(outputDir, "scan-manifest.json"), ${JSON.stringify(JSON.stringify(validManifest))});`,
    `fs.writeFileSync(path.join(outputDir, "findings.json"), ${JSON.stringify(JSON.stringify(findings))});`,
  ].join("\n"));
}

async function listen(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}
