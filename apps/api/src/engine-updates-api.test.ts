import assert from "node:assert/strict";
import test from "node:test";
import type { EngineUpdatesResponse } from "@csb/shared";
import { createEngineUpdatesApp } from "./engine-updates-api.js";
import { EngineUpdateError } from "./scanners/engine-updates.js";

const snapshot: EngineUpdatesResponse = { items: [], busy: null, blockedReason: null, lastOperation: null };
function fixture() {
  const calls: string[] = [];
  const app = createEngineUpdatesApp({
    status: async () => snapshot,
    check: async () => { calls.push("check"); return snapshot; },
    update: async (id, version) => { calls.push(`${id}:${version}`); return snapshot; },
    rollback: async (id) => { calls.push(`rollback:${id}`); return snapshot; },
  });
  return { app, calls };
}

test("updater mutations require a session token even on the loopback API", async () => {
  const { app, calls } = fixture();
  for (const endpoint of ["check", "codex-cli/update", "codex-security/rollback"]) {
    const response = await app.request(`http://localhost/engine-updates/${endpoint}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "csrf_invalid" });
  }
  assert.deepEqual(calls, []);
  const status = await app.request("http://localhost/engine-updates");
  assert.equal(status.status, 200);
  assert.equal(status.headers.get("Cache-Control"), "no-store");
});

test("updater rejects rebinding and foreign origins for status and token reads", async () => {
  const { app } = fixture();
  for (const url of ["http://attacker.example/engine-updates", "http://attacker.example/engine-updates/security-session"]) {
    assert.equal((await app.request(url)).status, 403);
  }
  assert.equal((await app.request("http://localhost/engine-updates/security-session", { headers: { Origin: "https://attacker.example" } })).status, 403);
  assert.equal((await app.request("http://localhost/engine-updates", { headers: { "Sec-Fetch-Site": "cross-site" } })).status, 403);
  assert.equal((await app.request("http://127.0.0.1:8787/engine-updates", { headers: { Origin: "http://127.0.0.1:5173" } })).status, 200);
});

test("only fixed runtime ids and small exact JSON commands reach the updater", async () => {
  const { app, calls } = fixture();
  const { csrfToken } = await (await app.request("http://localhost/engine-updates/security-session")).json() as { csrfToken: string };
  const headers = { "Content-Type": "application/json", "X-CSRF-Token": csrfToken };
  const post = (endpoint: string, value: unknown) => app.request(`http://localhost/engine-updates/${endpoint}`, { method: "POST", headers, body: JSON.stringify(value) });
  assert.equal((await post("codex-cli/update", { version: "0.153.4", command: "echo injected" })).status, 400);
  assert.equal((await post("mantis/update", { version: "latest" })).status, 400);
  assert.equal((await post("codex-cli/update", { version: "a".repeat(5000) })).status, 400);
  assert.equal((await post("check", [])).status, 400);
  assert.equal((await post("check", {})).status, 200);
  assert.equal((await post("codex-cli/update", { version: "0.153.4" })).status, 200);
  assert.equal((await post("codex-security/rollback", {})).status, 200);
  assert.deepEqual(calls, ["check", "codex-cli:0.153.4", "rollback:codex-security"]);
});

test("scan/update conflicts expose safe codes without installer diagnostics", async () => {
  const app = createEngineUpdatesApp({
    status: async () => snapshot, check: async () => snapshot,
    update: async () => { throw new EngineUpdateError("scan_active"); },
    rollback: async () => { throw new EngineUpdateError("verification_failed"); },
  });
  const { csrfToken } = await (await app.request("http://localhost/engine-updates/security-session")).json() as { csrfToken: string };
  const headers = { "Content-Type": "application/json", "X-CSRF-Token": csrfToken };
  const response = await app.request("http://localhost/engine-updates/codex-cli/update", { method: "POST", headers, body: '{"version":"0.153.4"}' });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "scan_active" });
  const rollback = await app.request("http://localhost/engine-updates/codex-cli/rollback", { method: "POST", headers, body: "{}" });
  assert.equal(rollback.status, 502);
  assert.deepEqual(await rollback.json(), { error: "verification_failed" });
});
