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
    assert.equal(
      config.LEGACY_SCANS_ROOT,
      path.join(fixtureRoot, "codex-security-state", "scans"),
    );
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

test("uses a source checkout main SHA only when the reusable workflow is published", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "csb-config-release-"));
  const gitDir = path.join(root, ".git");
  const head = "a".repeat(40);
  fs.mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
  fs.writeFileSync(path.join(root, ".github", "workflows", "security-change-gate.yml"), "name: gate\n");
  fs.mkdirSync(path.join(gitDir, "refs", "heads"), { recursive: true });
  fs.mkdirSync(path.join(gitDir, "refs", "remotes", "origin"), { recursive: true });
  fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(gitDir, "refs", "heads", "main"), `${head}\n`);
  fs.writeFileSync(path.join(gitDir, "refs", "remotes", "origin", "main"), `${head}\n`);
  try {
    const config = await import(`./config.js?release=${Date.now()}`);
    assert.equal(config.sourceCheckoutReleaseSha(root), head);
    fs.writeFileSync(path.join(gitDir, "refs", "heads", "main"), `${"b".repeat(40)}\n`);
    assert.equal(config.sourceCheckoutReleaseSha(root), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
