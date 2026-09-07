import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const repositoryRoot = requiredEnvironment("CSB_E2E_REPOSITORY_ROOT");
const fixtureRoot = requiredEnvironment("CSB_E2E_FIXTURE_ROOT");
const pidPath = path.join(fixtureRoot, "api.pid");
const apiEntry = path.join(repositoryRoot, "apps", "api", "src", "index.ts");
const tsx = path.join(repositoryRoot, "apps", "api", "node_modules", ".bin", "tsx");
const networkGuard = path.join(repositoryRoot, "scripts", "e2e", "no-external-network.mjs");
const restartDelayMs = 750;
let stopping = false;
let api = null;

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required by the real API E2E supervisor`);
  return value;
}

function appendNodeImport(existing, modulePath) {
  const option = `--import=${modulePath}`;
  return existing?.trim() ? `${existing} ${option}` : option;
}

function startApi() {
  api = spawn(tsx, [apiEntry], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      NODE_OPTIONS: appendNodeImport(process.env.NODE_OPTIONS, networkGuard),
    },
    stdio: "inherit",
  });
  fs.writeFileSync(pidPath, `${api.pid}\n`, { mode: 0o600 });
  api.once("exit", () => {
    api = null;
    if (stopping) return;
    fs.writeFileSync(pidPath, "\n", { mode: 0o600 });
    // Keep the supervisor alive while it performs the intentional API restart.
    // This is the process lifecycle exercised by the browser test.
    setTimeout(startApi, restartDelayMs);
  });
}

function stop(signal) {
  stopping = true;
  if (api?.pid) {
    try {
      process.kill(api.pid, signal);
    } catch {
      // The API process already exited.
    }
  }
}

process.once("SIGTERM", () => stop("SIGTERM"));
process.once("SIGINT", () => stop("SIGINT"));
startApi();
