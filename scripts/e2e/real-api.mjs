import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "okami-sentinel-real-api-e2e-"));
const invocationId = path.basename(fixtureRoot);
const outputDir = path.join(repositoryRoot, "output", "playwright", "real-api", invocationId);
const scannerPath = path.join(fixtureRoot, "controlled-codex-security.mjs");
const scannerPidsPath = path.join(fixtureRoot, "scanner-pids");
const networkLog = path.join(fixtureRoot, "network.jsonl");
const [apiPort, webPort] = await Promise.all([availablePort(), availablePort()]);

prepareFixture();
const child = spawn(
  "pnpm",
  ["--filter", "@csb/web", "exec", "playwright", "test", "--config", "playwright.real-api.config.ts"],
  {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      CSB_E2E_REPOSITORY_ROOT: repositoryRoot,
      CSB_E2E_FIXTURE_ROOT: fixtureRoot,
      CSB_E2E_API_PORT: String(apiPort),
      CSB_E2E_WEB_PORT: String(webPort),
      CSB_E2E_OUTPUT_DIR: outputDir,
      CSB_PORT: String(apiPort),
      CSB_E2E_NETWORK_LOG: networkLog,
      CSB_DATA_DIR: path.join(fixtureRoot, "data"),
      CODEX_SECURITY_STATE_DIR: path.join(fixtureRoot, "state"),
      CSB_NPM_CACHE_DIR: path.join(fixtureRoot, "npm-cache"),
      CODEX_SECURITY_BIN: scannerPath,
      CODEX_BIN: scannerPath,
      CSB_MAX_CONCURRENT_SCANS: "2",
    },
    stdio: "inherit",
  },
);
const [exitCode, signal] = await once(child, "exit");
terminateControlledScanners();
if (exitCode === 0) {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
  fs.rmSync(outputDir, { recursive: true, force: true });
  process.exit(0);
}
console.error(`Real API E2E fixture preserved for failure inspection: ${fixtureRoot}`);
process.exitCode = typeof exitCode === "number" ? exitCode || 1 : signal ? 1 : 1;

function prepareFixture() {
  fs.mkdirSync(path.join(fixtureRoot, "repository", "src"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(fixtureRoot, "repository", "src", "e2e.ts"),
    "export const controlledFixture = true;\n",
    { mode: 0o600 },
  );
  fs.writeFileSync(scannerPath, controlledScannerSource(), { mode: 0o700 });
  fs.chmodSync(scannerPath, 0o700);
}

function controlledScannerSource() {
  return `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
if (args[0] === "info") {
  process.stdout.write(JSON.stringify({ name: "controlled-codex-security", version: "e2e" }) + "\\n");
  process.exit(0);
}

if (args[0] === "login" && args[1] === "status") {
  process.stdout.write("Logged in using ChatGPT (controlled E2E fixture)\\n");
  process.exit(0);
}
if (args[0] === "--version") {
  process.stdout.write("controlled-codex-security e2e\\n");
  process.exit(0);
}
if (args[0] !== "scan") {
  process.stderr.write("unsupported controlled scanner command\\n");
  process.exit(2);
}
const outputIndex = args.indexOf("--output-dir");
const outputDir = outputIndex >= 0 ? args[outputIndex + 1] : null;
if (!outputDir) {
  process.stderr.write("missing controlled scanner output directory\\n");
  process.exit(2);
}
fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(outputDir, "findings.json"), JSON.stringify({
  documentType: "codex-security.findings",
  schemaVersion: "e2e-controlled",
  findings: [{
    findingId: "controlled-evidence",
    title: "Controlled scanner evidence",
    severity: { level: "high" },
    confidence: { level: "high" },
    ruleId: "e2e/controlled-evidence",
    summary: "A local fixture writes evidence without executing a provider request.",
    remediation: "Keep this fixture isolated from production scanner routes.",
    locations: [{ path: "src/e2e.ts", role: "primary", startLine: 1, endLine: 1 }],
    codeEvidence: [],
    taxonomy: { category: "Fixture validation", cwe: ["CWE-20"] },
  }],
}, null, 2) + "\\n", { mode: 0o600 });
const pidFile = path.join(${JSON.stringify(scannerPidsPath)});
fs.appendFileSync(pidFile, process.pid + "\\n", { mode: 0o600 });
process.stdout.write("E2E scanner fixture active\\n");
const heartbeat = setInterval(() => process.stdout.write("E2E scanner fixture active\\n"), 1_000);
process.once("SIGTERM", () => {
  clearInterval(heartbeat);
  process.stdout.write("E2E scanner fixture cancelled\\n");
  setTimeout(() => process.exit(143), 25);
});
`;
}

async function availablePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to allocate a local E2E port");
  const { port } = address;
  server.close();
  await once(server, "close");
  return port;
}

function terminateControlledScanners() {
  if (!fs.existsSync(scannerPidsPath)) return;
  for (const value of new Set(fs.readFileSync(scannerPidsPath, "utf8").split(/\s+/))) {
    const pid = Number(value);
    if (!Number.isSafeInteger(pid) || pid < 1 || !isControlledScanner(pid)) continue;
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // It has already exited.
    }
  }
}

function isControlledScanner(pid) {
  try {
    const command = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
    return command.includes(scannerPath) && command.includes(fixtureRoot);
  } catch {
    try {
      const command = String(execFileSync("ps", ["-ww", "-p", String(pid), "-o", "command="], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }));
      return command.includes(scannerPath) && command.includes(fixtureRoot);
    } catch {
      return false;
    }
  }
}
