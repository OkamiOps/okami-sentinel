import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT_DIR = path.resolve(__dirname, "../../..");
export const DATA_DIR = path.join(ROOT_DIR, "data");
export const BENCHMARK_DB_PATH = path.join(DATA_DIR, "benchmark.db");
export const RUNS_DIR = path.join(DATA_DIR, "runs");
export const GATES_DIR = path.join(DATA_DIR, "gates");

export const CODEX_HOME =
  process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");

const configuredStateDir = process.env.CODEX_SECURITY_STATE_DIR?.trim();
const defaultStateDir = path.join(
  CODEX_HOME,
  "state",
  "plugins",
  "codex-security",
);

export const CODEX_SECURITY_STATE_DIR =
  configuredStateDir ||
  (hasWritableDirectory(defaultStateDir)
    ? defaultStateDir
    : path.join(DATA_DIR, "codex-security-state"));

export const WORKBENCH_DB_PATH = path.join(
  CODEX_SECURITY_STATE_DIR,
  "workbench.sqlite3",
);

export const SCANS_ROOT = path.join(CODEX_SECURITY_STATE_DIR, "scans");
export const CODEX_SECURITY_SESSIONS_DIR = path.join(
  CODEX_SECURITY_STATE_DIR,
  "codex-home",
  "sessions",
);
export const CODEX_SECURITY_NPM_CACHE_DIR =
  process.env.CSB_NPM_CACHE_DIR?.trim() || path.join(DATA_DIR, "npm-cache");

const BUNDLED_CODEX_CANDIDATES =
  process.platform === "darwin"
    ? ["/Applications/ChatGPT.app/Contents/Resources/codex"]
    : [];

function isExecutableFile(candidate: string): boolean {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

export function resolveCodexBin(
  explicit: string | undefined = process.env.CODEX_BIN,
  bundledCandidates: string[] = BUNDLED_CODEX_CANDIDATES,
  isExecutable: (candidate: string) => boolean = isExecutableFile,
): string {
  const configured = explicit?.trim();
  if (configured) return configured;
  return bundledCandidates.find(isExecutable) ?? "codex";
}

export const CODEX_BIN = resolveCodexBin();

export const MANTIS_REPOSITORY_URL =
  process.env.MANTIS_REPOSITORY_URL?.trim() ||
  "https://github.com/google/mantis.git";

/** Reviewed upstream revision. Updates are deliberate so scans stay reproducible. */
export const MANTIS_SOURCE_REF =
  process.env.MANTIS_SOURCE_REF?.trim() ||
  "876a0c8c6b92c92f34e0041b7dbbc0e4cccddc52";

export const MANTIS_CACHE_DIR =
  process.env.MANTIS_CACHE_DIR?.trim() || path.join(DATA_DIR, "mantis-cache");

export const MANTIS_WORKER_BIN =
  process.env.MANTIS_WORKER_BIN?.trim() ||
  path.join(ROOT_DIR, "apps", "api", "node_modules", ".bin", "tsx");

export const MANTIS_WORKER_ENTRY = path.join(
  ROOT_DIR,
  "apps",
  "api",
  "src",
  "scanners",
  "mantis-worker.ts",
);

export const API_HOST = process.env.CSB_HOST || "127.0.0.1";
export const API_PORT = Number(process.env.CSB_PORT || 8787);

/** Soft cap so a click-storm doesn't spawn unbounded Codex jobs. */
export const MAX_CONCURRENT_SCANS = Math.max(
  1,
  Number(process.env.CSB_MAX_CONCURRENT_SCANS || 8) || 8,
);

export const CODEX_SECURITY_BIN =
  process.env.CODEX_SECURITY_BIN?.trim() || "npx";

export const CODEX_SECURITY_ARGS_PREFIX =
  process.env.CODEX_SECURITY_BIN?.trim()
    ? []
    : ["--yes", "@openai/codex-security"];

export function codexSecurityEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...source,
    CODEX_SECURITY_STATE_DIR,
    npm_config_cache: CODEX_SECURITY_NPM_CACHE_DIR,
    CI: "1",
    NO_COLOR: "1",
  };
}

function hasWritableDirectory(targetPath: string): boolean {
  let current = path.resolve(targetPath);

  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }

  try {
    if (!fs.statSync(current).isDirectory()) return false;
    fs.accessSync(current, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}
