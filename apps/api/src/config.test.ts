import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("honors an isolated data directory for test and ephemeral runtimes", async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csb-config-data-"));
  const previousDataDir = process.env.CSB_DATA_DIR;
  process.env.CSB_DATA_DIR = fixtureRoot;

  try {
    const config = await import(`./config.js?data=${Date.now()}`);
    assert.equal(config.DATA_DIR, fixtureRoot);
    assert.equal(config.BENCHMARK_DB_PATH, path.join(fixtureRoot, "benchmark.db"));
    assert.equal(config.RUNS_DIR, path.join(fixtureRoot, "runs"));
  } finally {
    if (previousDataDir === undefined) delete process.env.CSB_DATA_DIR;
    else process.env.CSB_DATA_DIR = previousDataDir;
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("falls back to app-local scanner state when the default Codex path is not writable", async () => {
  const previousCodexHome = process.env.CODEX_HOME;
  const previousStateDir = process.env.CODEX_SECURITY_STATE_DIR;

  process.env.CODEX_HOME = "/dev/null/csb-codex-home";
  delete process.env.CODEX_SECURITY_STATE_DIR;

  try {
    const config = await import(`./config.js?unwritable=${Date.now()}`);
    assert.equal(
      config.CODEX_SECURITY_STATE_DIR,
      path.join(config.DATA_DIR, "codex-security-state"),
    );
  } finally {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;

    if (previousStateDir === undefined) delete process.env.CODEX_SECURITY_STATE_DIR;
    else process.env.CODEX_SECURITY_STATE_DIR = previousStateDir;
  }
});
