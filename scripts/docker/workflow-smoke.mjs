#!/usr/bin/env node
/**
 * Runs the bundled HTTP scanner workflows against a disposable server image.
 *
 * The OpenAI-compatible provider is bind-mounted only for this QA run. It is
 * deliberately not part of the runtime image and uses no external account.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const image = process.argv[2];
if (!image || process.argv.length !== 3) {
  throw new Error("Usage: node scripts/docker/workflow-smoke.mjs <image>");
}
assertHostNodeVersion();

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const providerPath = path.join(scriptDirectory, "test-provider.mjs");
if (!fs.statSync(providerPath).isFile()) throw new Error("Docker QA test provider is missing");

const name = `csb-docker-workflow-${process.pid}-${randomBytes(4).toString("hex")}`;
const volume = `${name}-data`;
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "csb-docker-workflow-"));
const repositoryPath = path.join(workDir, "fixture-repository");
const passwordPath = path.join(workDir, "admin_password");
const vaultKeyPath = path.join(workDir, "vault_key");
const password = randomBytes(32).toString("base64url");
const vaultKey = randomBytes(32).toString("hex");
const fixtureApiKey = "docker-qa-fixture-key";
const authorization = `Basic ${Buffer.from(`admin:${password}`).toString("base64")}`;
const sensitiveValues = [password, vaultKey, fixtureApiKey, authorization];
const providerPort = 8788;
const scanRepositoryPath = "/repos/fixture";
// This is an existing runtime file, so Docker can bind-mount the QA provider
// before the read-only root filesystem is applied. The image never copies the
// provider itself and does not invoke this helper as its application command.
const providerRuntimePath = "/app/scripts/docker/healthcheck.mjs";

let hostPort;
let baseUrl;
let csrfToken;
let volumeCreated = false;
let containerCreated = false;

try {
  hostPort = await availableLoopbackPort();
  baseUrl = `http://127.0.0.1:${hostPort}`;
  createFixtureRepository();
  createSecretFile(passwordPath, password);
  createSecretFile(vaultKeyPath, vaultKey);

  docker(["volume", "create", volume]);
  volumeCreated = true;
  docker([
    "run", "--rm", "--user", "0:0",
    "--mount", `type=volume,source=${volume},target=/var/lib/sentinel`,
    image,
    "node", "/app/scripts/docker/init-volume.mjs",
  ]);

  docker([
    "run", "--detach", "--name", name,
    "--user", "1000:1000",
    "--read-only",
    "--publish", `127.0.0.1:${hostPort}:8787`,
    "--mount", `type=volume,source=${volume},target=/var/lib/sentinel`,
    "--mount", `type=bind,source=${passwordPath},target=/run/secrets/admin_password,readonly`,
    "--mount", `type=bind,source=${vaultKeyPath},target=/run/secrets/vault_key,readonly`,
    "--mount", `type=bind,source=${repositoryPath},target=${scanRepositoryPath},readonly`,
    "--mount", `type=bind,source=${providerPath},target=${providerRuntimePath},readonly`,
    "--env", "NODE_ENV=production",
    "--env", "CSB_RUNTIME_MODE=server",
    "--env", "CSB_HOST=0.0.0.0",
    "--env", "CSB_PORT=8787",
    "--env", `CSB_PUBLIC_ORIGIN=${baseUrl}`,
    "--env", "CSB_ADMIN_USER=admin",
    "--env", "CSB_ADMIN_PASSWORD_FILE=/run/secrets/admin_password",
    "--env", "CSB_VAULT_KEY_FILE=/run/secrets/vault_key",
    "--env", "CSB_DATA_DIR=/var/lib/sentinel/data",
    "--env", "CSB_REPOSITORY_ROOTS=/repos",
    "--env", "CSB_MAX_CONCURRENT_SCANS=1",
    "--env", "HOME=/var/lib/sentinel/home",
    "--env", "TMPDIR=/var/lib/sentinel/tmp",
    "--env", "CODEX_HOME=/var/lib/sentinel/codex-home",
    "--env", "CODEX_SECURITY_STATE_DIR=/var/lib/sentinel/codex-security-state",
    image,
  ]);
  containerCreated = true;

  await waitForReady();
  assertContainerSecurity();
  await assertApiAuthenticationAndCsrf();
  await startProvider();
  await loadSecuritySession();

  const connectionId = await createAndVerifyConnection();
  await completeScans(connectionId);
  await verifyCancellationAndCapacity(connectionId);
  await verifyHardStopRecovery(connectionId);

  console.log(`Docker workflow smoke passed for ${image}`);
} catch (error) {
  printSafeContainerLogs();
  throw sanitizedError(error);
} finally {
  if (containerCreated) runDocker(["rm", "--force", name]);
  if (volumeCreated) runDocker(["volume", "rm", "--force", volume]);
  fs.rmSync(workDir, { recursive: true, force: true });
}

function createFixtureRepository() {
  fs.mkdirSync(path.join(repositoryPath, "src"), { recursive: true, mode: 0o755 });
  fs.writeFileSync(
    path.join(repositoryPath, "src", "auth.ts"),
    'export const getAccount = (id: string) => ({ id, owner: "fixture" });\n',
    { mode: 0o644 },
  );
  fs.chmodSync(repositoryPath, 0o755);
  command("git", ["init", "--quiet", repositoryPath]);
  command("git", ["-C", repositoryPath, "config", "user.name", "Docker QA"]);
  command("git", ["-C", repositoryPath, "config", "user.email", "docker-qa@example.invalid"]);
  command("git", ["-C", repositoryPath, "add", "src/auth.ts"]);
  command("git", ["-C", repositoryPath, "commit", "--quiet", "-m", "Docker QA fixture"]);
}

function createSecretFile(filePath, value) {
  fs.writeFileSync(filePath, `${value}\n`, { mode: 0o444 });
  fs.chmodSync(filePath, 0o444);
}

function assertContainerSecurity() {
  assert.equal(docker(["exec", name, "id", "-u"]).trim(), "1000", "application must run as UID 1000");
  const inspected = JSON.parse(docker(["inspect", name]));
  assert.equal(inspected[0]?.HostConfig?.ReadonlyRootfs, true, "application root filesystem must be read-only");
}

async function assertApiAuthenticationAndCsrf() {
  const unauthenticated = await fetch(`${baseUrl}/api/scans`);
  assert.equal(unauthenticated.status, 401, "API must require Basic authentication");

  const sessionResponse = await fetch(`${baseUrl}/api/security-session`, {
    headers: { Authorization: authorization, Origin: baseUrl },
  });
  assert.equal(sessionResponse.status, 200, "authenticated security session must be available");
  const session = await sessionResponse.json();
  assert.equal(typeof session.csrfToken, "string");
  assert.ok(session.csrfToken.length >= 32);

  const csrfDenied = await fetch(`${baseUrl}/api/connections`, {
    method: "POST",
    headers: { Authorization: authorization, Origin: baseUrl, "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(csrfDenied.status, 403, "mutating API request without CSRF token must fail");
  assert.equal((await csrfDenied.json()).error, "csrf_invalid");
}

async function loadSecuritySession() {
  const session = await api("/security-session");
  assert.equal(session.runtimeMode, "server");
  assert.ok(Array.isArray(session.repositoryRoots) && session.repositoryRoots.includes("/repos"));
  assert.equal(typeof session.csrfToken, "string");
  assert.ok(session.csrfToken.length >= 32);
  csrfToken = session.csrfToken;
}

async function startProvider() {
  docker([
    "exec", "--detach", "--user", "1000:1000", name,
    "node", providerRuntimePath, "--port", String(providerPort),
  ]);
  const deadline = Date.now() + 10_000;
  let lastError = "not attempted";
  while (Date.now() < deadline) {
    try {
      docker([
        "exec", "--user", "1000:1000", name, "node", "-e",
        `fetch('http://127.0.0.1:${providerPort}/v1/models').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))`,
      ]);
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await sleep(200);
    }
  }
  throw new Error(`test provider did not become ready: ${redact(lastError)}`);
}

async function createAndVerifyConnection() {
  const created = await api("/connections", {
    method: "POST",
    expected: 201,
    body: {
      name: "Docker QA provider",
      providerKind: "custom",
      routeKind: "custom-openai-compatible",
      transport: "http-inference",
      authKind: "api-key",
      protocol: "openai-chat",
      modelSelectionMode: "catalog",
      secret: {
        apiKey: fixtureApiKey,
        baseUrl: `http://127.0.0.1:${providerPort}/v1`,
        allowInsecureLocalhost: true,
      },
    },
  });
  const connectionId = created.connection?.id;
  assert.equal(typeof connectionId, "string", "connection creation must return an id");

  const inspected = await api(`/connections/${encodeURIComponent(connectionId)}/inspect`, { method: "POST", body: {} });
  assert.equal(inspected.connection?.status, "ready", "custom connection must inspect as ready");

  const refreshed = await api(`/connections/${encodeURIComponent(connectionId)}/models/refresh`, { method: "POST", body: {} });
  assert.ok(refreshed.discovery?.models?.some((model) => model.id === "docker-fixture"));
  assert.ok(refreshed.discovery?.models?.some((model) => model.id === "docker-fixture-slow"));

  await assertServerRejectsLegacyAndNativeRequests(connectionId);
  await probeConnection(connectionId, "docker-fixture");
  return connectionId;
}

async function assertServerRejectsLegacyAndNativeRequests(connectionId) {
  const legacy = await api("/scans", {
    method: "POST",
    expected: 400,
    body: { repositoryPath: scanRepositoryPath, engine: "codex-security" },
  });
  assert.equal(legacy.error, "server_http_connection_required");

  const native = await api("/scans", {
    method: "POST",
    expected: 400,
    body: {
      ...scanRequest("codex-security", modelSelection(connectionId, "docker-fixture")),
      executionProfilePreference: "native",
    },
  });
  assert.equal(native.error, "codex_native_contract_unavailable");
}

async function completeScans(connectionId) {
  for (const engine of ["codex-security", "mantis", "vulnhunter"]) {
    const selection = modelSelection(connectionId, "docker-fixture");
    const compatibility = await api("/connections/compatibility", { method: "POST", body: { engine, selection } });
    assert.equal(compatibility.eligible, true, `${engine} must be compatible with the deterministic provider`);

    const scan = await startScan(engine, selection);
    await assertSseDeliversEvent(scan.id);
    const result = await waitForTerminalScan(scan.id, 120_000);
    assert.equal(result.scan?.status, "completed", `${engine} scan must complete`);
    assert.equal(result.findings?.length, 1, `${engine} scan must produce one fixture finding`);

    const report = await api(`/scans/${encodeURIComponent(scan.id)}/report`);
    assert.equal(report.findings?.length, 1, `${engine} report must retain the finding`);
    assert.match(JSON.stringify(report.findings[0]), /src\/auth\.ts/);
  }
}

async function verifyCancellationAndCapacity(connectionId) {
  const selection = modelSelection(connectionId, "docker-fixture-slow");
  await probeConnection(connectionId, "docker-fixture-slow");

  for (const engine of ["codex-security", "mantis", "vulnhunter"]) {
    const scan = await startScan(engine, selection);
    await waitForScanStatus(scan.id, "running", 15_000);

    const blocked = await api("/scans", {
      method: "POST",
      expected: 400,
      body: scanRequest(engine, selection),
    });
    assert.match(blocked.error ?? "", /Limite de scans simultâneos atingido/);

    await api(`/scans/${encodeURIComponent(scan.id)}/cancel`, { method: "POST", body: {} });
    const result = await waitForTerminalScan(scan.id, 15_000);
    assert.equal(result.scan?.status, "cancelled", `${engine} slow scan must cancel`);
  }
}

async function verifyHardStopRecovery(connectionId) {
  const scan = await startScan("mantis", modelSelection(connectionId, "docker-fixture-slow"));
  await waitForScanStatus(scan.id, "running", 15_000);

  docker(["kill", name]);
  docker(["start", name]);
  await waitForReady();
  csrfToken = undefined;
  await loadSecuritySession();
  await startProvider();

  const recovered = await waitForTerminalScan(scan.id, 15_000);
  assert.equal(
    recovered.scan?.status,
    "incomplete",
    `hard-stop scan must reconcile as incomplete within 15 seconds (received ${recovered.scan?.status})`,
  );
}

async function probeConnection(connectionId, modelId) {
  const response = await api(`/connections/${encodeURIComponent(connectionId)}/probe`, {
    method: "POST",
    body: modelSelection(connectionId, modelId),
  });
  assert.equal(response.report?.status, "passed", `capability probe for ${modelId} must pass`);
}

function modelSelection(connectionId, modelId) {
  return { connectionId, modelSelectionMode: "catalog", modelId };
}

function scanRequest(engine, connection) {
  return {
    repositoryPath: scanRepositoryPath,
    engine,
    mode: "standard",
    displayName: `Docker workflow ${engine}`,
    connection,
  };
}

async function startScan(engine, connection) {
  const response = await api("/scans", { method: "POST", expected: 201, body: scanRequest(engine, connection) });
  assert.equal(typeof response.scan?.id, "string", `${engine} scan creation must return an id`);
  return response.scan;
}

async function assertSseDeliversEvent(scanId) {
  const response = await fetch(`${baseUrl}/api/scans/${encodeURIComponent(scanId)}/events`, {
    headers: { Authorization: authorization, Origin: baseUrl },
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.status, 200, "scan event stream must be available");
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  assert.ok(response.body, "scan event stream must have a body");
  const reader = response.body.getReader();
  try {
    const first = await reader.read();
    assert.ok(first.value?.length, "scan event stream must deliver an event");
  } finally {
    await reader.cancel();
  }
}

async function waitForScanStatus(scanId, expectedStatus, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus;
  while (Date.now() < deadline) {
    const current = await api(`/scans/${encodeURIComponent(scanId)}`);
    lastStatus = current.scan?.status;
    if (lastStatus === expectedStatus) return current;
    if (!["queued", "running"].includes(lastStatus)) break;
    await sleep(250);
  }
  throw new Error(`scan ${scanId} did not reach ${expectedStatus}; last status was ${lastStatus ?? "unknown"}`);
}

async function waitForTerminalScan(scanId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let current;
  while (Date.now() < deadline) {
    current = await api(`/scans/${encodeURIComponent(scanId)}`);
    if (!["queued", "running"].includes(current.scan?.status)) return current;
    await sleep(250);
  }
  throw new Error(`scan ${scanId} did not finish within ${timeoutMs}ms; last status was ${current?.scan?.status ?? "unknown"}`);
}

async function api(endpoint, { method = "GET", body, expected = 200 } = {}) {
  const mutation = !["GET", "HEAD"].includes(method);
  const headers = { Authorization: authorization, Origin: baseUrl };
  if (mutation) {
    headers["X-CSRF-Token"] = csrfToken;
    headers["Content-Type"] = "application/json";
  }
  const response = await fetch(`${baseUrl}/api${endpoint}`, {
    method,
    headers,
    ...(mutation ? { body: JSON.stringify(body ?? {}) } : {}),
    signal: AbortSignal.timeout(180_000),
  });
  const text = await response.text();
  let payload;
  try {
    payload = text === "" ? null : JSON.parse(text);
  } catch {
    payload = { text: text.slice(0, 300) };
  }
  if (response.status !== expected) {
    throw new Error(`${method} ${endpoint} expected HTTP ${expected}, received ${response.status}: ${safeJson(payload)}`);
  }
  return payload;
}

async function waitForReady() {
  const deadline = Date.now() + 45_000;
  let lastError = "not attempted";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/readyz`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(250);
  }
  throw new Error(`server did not become ready: ${redact(lastError)}`);
}

function docker(arguments_) {
  return command("docker", arguments_);
}

function command(binary, arguments_) {
  return execFileSync(binary, arguments_, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 4 * 1024 * 1024,
  });
}

function runDocker(arguments_) {
  spawnSync("docker", arguments_, { stdio: "ignore" });
}

function printSafeContainerLogs() {
  if (!containerCreated) return;
  const result = spawnSync("docker", ["logs", "--tail", "200", name], { encoding: "utf8" });
  const output = redact(`${result.stdout ?? ""}${result.stderr ?? ""}`.trim());
  if (output) process.stderr.write(`Container logs for ${name}:\n${output}\n`);
}

function sanitizedError(error) {
  const message = redact(error instanceof Error ? error.stack ?? error.message : String(error));
  return new Error(message);
}

function redact(value) {
  let safe = String(value);
  for (const sensitive of sensitiveValues) safe = safe.split(sensitive).join("[REDACTED]");
  return safe;
}

function safeJson(value) {
  try {
    return redact(JSON.stringify(value));
  } catch {
    return "[unserializable response]";
  }
}

function assertHostNodeVersion() {
  const major = Number(process.versions.node.split(".")[0]);
  if (!Number.isInteger(major) || major < 20) throw new Error("Docker workflow smoke requires Node.js 20 or newer");
}

function availableLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("could not reserve a loopback port")));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
