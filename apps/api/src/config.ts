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

export const CODEX_SECURITY_STATE_DIR =
  process.env.CODEX_SECURITY_STATE_DIR?.trim() ||
  path.join(CODEX_HOME, "state", "plugins", "codex-security");

export const WORKBENCH_DB_PATH = path.join(
  CODEX_SECURITY_STATE_DIR,
  "workbench.sqlite3",
);

export const SCANS_ROOT = path.join(CODEX_SECURITY_STATE_DIR, "scans");

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
