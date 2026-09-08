import { randomBytes } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";

const image = process.argv[2];
if (!image) throw new Error("Usage: node scripts/docker/smoke.mjs <image>");

const name = `csb-docker-smoke-${process.pid}-${randomBytes(4).toString("hex")}`;
const volume = `${name}-data`;
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "csb-docker-smoke-"));
const passwordPath = path.join(workDir, "admin_password");
const vaultKeyPath = path.join(workDir, "vault_key");
const password = randomBytes(32).toString("base64url");
const vaultKey = randomBytes(32).toString("hex");
const hostPort = await availableLoopbackPort();
fs.writeFileSync(passwordPath, `${password}\n`, { mode: 0o444 });
fs.writeFileSync(vaultKeyPath, `${vaultKey}\n`, { mode: 0o444 });
fs.chmodSync(passwordPath, 0o444);
fs.chmodSync(vaultKeyPath, 0o444);

let containerStarted = false;
try {
  docker(["volume", "create", volume]);
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
    "--env", "NODE_ENV=production",
    "--env", "CSB_RUNTIME_MODE=server",
    "--env", "CSB_HOST=0.0.0.0",
    "--env", "CSB_PORT=8787",
    "--env", `CSB_PUBLIC_ORIGIN=http://127.0.0.1:${hostPort}`,
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
  containerStarted = true;

  const baseUrl = `http://127.0.0.1:${hostPort}`;
  await waitForReady(baseUrl);

  const uid = docker(["exec", name, "id", "-u"]).trim();
  if (uid !== "1000") throw new Error(`container did not run as UID 1000 (received ${uid})`);
  docker([
    "exec", name, "sh", "-ec",
    "test -f /app/apps/api/src/scanners/mantis-worker.ts\n"
      + "test -f /app/apps/api/node_modules/@csb/shared/src/index.ts\n"
      + "test ! -e /app/apps/api/src/activity.test.ts\n"
      + "test ! -e /app/apps/api/src/fixtures/attack-path/findings.json\n"
      + "test ! -e /app/apps/api/node_modules/@csb/gate-core/src/decision-graph.test.ts",
  ]);

  const unauthenticated = await fetch(`${baseUrl}/`);
  if (unauthenticated.status !== 401) {
    throw new Error(`root route must require authentication (received HTTP ${unauthenticated.status})`);
  }
  const authorization = `Basic ${Buffer.from(`admin:${password}`).toString("base64")}`;
  for (const route of ["/", "/scans/does-not-exist"]) {
    const response = await fetch(`${baseUrl}${route}`, {
      headers: { authorization, Accept: "text/html" },
    });
    if (!response.ok) throw new Error(`${route} failed with HTTP ${response.status}`);
    const body = await response.text();
    if (!body.includes("<div id=\"root\">") && !body.includes("<div id='root'>")) {
      throw new Error(`${route} did not return the compiled web application`);
    }
  }
  console.log(`Docker smoke passed for ${image} on ${baseUrl}`);
} catch (error) {
  if (containerStarted) {
    const logs = spawnSync("docker", ["logs", name], { encoding: "utf8" });
    const output = `${logs.stdout ?? ""}${logs.stderr ?? ""}`.trim();
    if (output) process.stderr.write(`Container logs for ${name}:\n${output}\n`);
  }
  throw error;
} finally {
  if (containerStarted) runDocker(["rm", "--force", name]);
  runDocker(["volume", "rm", "--force", volume]);
  fs.rmSync(workDir, { recursive: true, force: true });
}

function docker(arguments_) {
  return execFileSync("docker", arguments_, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function runDocker(arguments_) {
  spawnSync("docker", arguments_, { stdio: "ignore" });
}

async function waitForReady(baseUrl) {
  const deadline = Date.now() + 45_000;
  let lastError = "not attempted";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/readyz`);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`server did not become ready: ${lastError}`);
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
