import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("uses the app-local npm cache for Codex Security child processes", async () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "csb-codex-info-"));
  const executable = path.join(fixtureDir, "fake-codex-security");
  const npmCacheDir = path.join(fixtureDir, "npm-cache");
  const previous = {
    bin: process.env.CODEX_SECURITY_BIN,
    state: process.env.CODEX_SECURITY_STATE_DIR,
    cache: process.env.CSB_NPM_CACHE_DIR,
    inheritedCache: process.env.npm_config_cache,
  };

  fs.writeFileSync(
    executable,
    "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ npmCache: process.env.npm_config_cache }));\n",
    { mode: 0o700 },
  );
  process.env.CODEX_SECURITY_BIN = executable;
  process.env.CODEX_SECURITY_STATE_DIR = path.join(fixtureDir, "state");
  process.env.CSB_NPM_CACHE_DIR = npmCacheDir;
  delete process.env.npm_config_cache;

  try {
    const { getCodexInfo } = await import(`./codex-info.js?npm-cache=${Date.now()}`);
    const info = await getCodexInfo();
    assert.equal(info?.raw.npmCache, npmCacheDir);
  } finally {
    restoreEnvironment("CODEX_SECURITY_BIN", previous.bin);
    restoreEnvironment("CODEX_SECURITY_STATE_DIR", previous.state);
    restoreEnvironment("CSB_NPM_CACHE_DIR", previous.cache);
    restoreEnvironment("npm_config_cache", previous.inheritedCache);
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
