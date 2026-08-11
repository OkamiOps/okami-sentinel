import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const sourceDirectory = resolve(scriptDirectory, "..", "src");
const entries = await readdir(sourceDirectory, { recursive: true });
const testFiles = entries
  .filter((entry) => typeof entry === "string" && entry.endsWith(".test.ts"))
  .map((entry) => resolve(sourceDirectory, entry))
  .sort();

const isolatedRoot = await mkdtemp(join(tmpdir(), "csb-api-tests-"));

const child = spawn(
  process.execPath,
  ["--import", "tsx", "--test", ...testFiles],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      CSB_DATA_DIR: join(isolatedRoot, "data"),
      CODEX_SECURITY_STATE_DIR: join(isolatedRoot, "codex-security-state"),
      CSB_NPM_CACHE_DIR: join(isolatedRoot, "npm-cache"),
    },
  },
);

const exitCode = await new Promise((resolveExit, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    resolveExit(code ?? (signal === null ? 1 : 1));
  });
});

await rm(isolatedRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
process.exitCode = exitCode;
