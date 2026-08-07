import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

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
