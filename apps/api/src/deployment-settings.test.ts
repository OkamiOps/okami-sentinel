import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { loadServerSettings, trustsProxy } from "./deployment-settings.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "csb-settings-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const passwordFile = path.join(root, "admin_password");
const vaultKeyFile = path.join(root, "vault_key");
fs.writeFileSync(passwordFile, "a-server-admin-password-of-24-plus\n");
fs.writeFileSync(vaultKeyFile, "f".repeat(64));

function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    CSB_RUNTIME_MODE: "server",
    CSB_PUBLIC_ORIGIN: "https://sentinel.example",
    CSB_ADMIN_PASSWORD_FILE: passwordFile,
    CSB_VAULT_KEY_FILE: vaultKeyFile,
    CSB_REPOSITORY_ROOTS: "/repos",
    ...overrides,
  };
}

test("the administrator username must be long enough for the account store to accept it", () => {
  // `normalizeUsername` refuses a single character, so a one-character setting
  // used to load here and then crash the process during admin bootstrap.
  for (const username of ["a", "1", "."]) {
    assert.throws(() => loadServerSettings(env({ CSB_ADMIN_USER: username })), /CSB_ADMIN_USER/, username);
  }
  for (const username of ["ab", "admin", "a".repeat(64)]) {
    assert.equal(loadServerSettings(env({ CSB_ADMIN_USER: username })).username, username);
  }
  assert.throws(() => loadServerSettings(env({ CSB_ADMIN_USER: "a".repeat(65) })), /CSB_ADMIN_USER/);
  assert.throws(() => loadServerSettings(env({ CSB_ADMIN_USER: "wrong user" })), /CSB_ADMIN_USER/);
  // An empty setting is not a rejection; it selects the documented default.
  assert.equal(loadServerSettings(env({ CSB_ADMIN_USER: "   " })).username, "admin");
  assert.equal(loadServerSettings(env()).username, "admin");
});

test("the proxy trust flag is opt-in and refuses anything but 0 or 1", () => {
  assert.equal(trustsProxy({}), false);
  assert.equal(trustsProxy({ CSB_TRUST_PROXY: "" }), false);
  assert.equal(trustsProxy({ CSB_TRUST_PROXY: "0" }), false);
  assert.equal(trustsProxy({ CSB_TRUST_PROXY: " 1 " }), true);
  for (const value of ["true", "yes", "2", "01"]) {
    assert.throws(() => trustsProxy({ CSB_TRUST_PROXY: value }), /CSB_TRUST_PROXY/, value);
  }
  assert.equal(loadServerSettings(env()).trustProxy, false);
  assert.equal(loadServerSettings(env({ CSB_TRUST_PROXY: "1" })).trustProxy, true);
  assert.equal(loadServerSettings({ CSB_RUNTIME_MODE: "local", CSB_TRUST_PROXY: "1" }).trustProxy, false);
});
