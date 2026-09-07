import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  managedRuntimeDirectory, managedRuntimeEntryPath, packageName,
  readManagedRuntimeManifest, runtimeRecord, writeManagedRuntimeManifest,
} from "./scanners/managed-runtime-store.js";

test("verified managed runtimes switch live commands while explicit overrides keep ownership", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "csb-config-managed-"));
  const keys = ["CSB_DATA_DIR", "CODEX_BIN", "CODEX_SECURITY_BIN"] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.CSB_DATA_DIR = root;
  delete process.env.CODEX_BIN;
  delete process.env.CODEX_SECURITY_BIN;
  try {
    const config = await import(`./config.js?managed=${Date.now()}`);
    assert.deepEqual(config.CODEX_SECURITY_ARGS_PREFIX, ["--yes", "@openai/codex-security"]);
    const manifest = readManagedRuntimeManifest(root);
    for (const id of ["codex-cli", "codex-security"] as const) {
      const entry = managedRuntimeEntryPath(root, id, "1.2.3");
      fs.mkdirSync(path.dirname(entry), { recursive: true, mode: 0o700 });
      fs.writeFileSync(entry, "#!/usr/bin/env node\n", { mode: 0o700 });
      fs.writeFileSync(path.join(managedRuntimeDirectory(root, id, "1.2.3"), "node_modules", packageName(id), "package.json"), JSON.stringify({ name: packageName(id), version: "1.2.3" }));
      manifest.runtimes[id] = { active: runtimeRecord(id, "1.2.3"), previous: null };
    }
    writeManagedRuntimeManifest(root, manifest);
    config.refreshManagedRuntimeCommands();
    assert.equal(config.CODEX_BIN, managedRuntimeEntryPath(root, "codex-cli", "1.2.3"));
    assert.equal(config.CODEX_SECURITY_BIN, managedRuntimeEntryPath(root, "codex-security", "1.2.3"));
    assert.deepEqual(config.CODEX_SECURITY_ARGS_PREFIX, []);
    assert.equal(config.CODEX_SECURITY_MANAGED_VERSION, "1.2.3");

    process.env.CODEX_BIN = "/external/codex";
    process.env.CODEX_SECURITY_BIN = "/external/security";
    config.refreshManagedRuntimeCommands();
    assert.equal(config.CODEX_BIN, "/external/codex");
    assert.equal(config.CODEX_SECURITY_BIN, "/external/security");
    assert.deepEqual(config.CODEX_SECURITY_ARGS_PREFIX, []);
    assert.equal(config.CODEX_SECURITY_MANAGED_VERSION, null);
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

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
