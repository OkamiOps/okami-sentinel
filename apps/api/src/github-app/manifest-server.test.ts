import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GitHubAppManifestFlow } from "./manifest-flow.js";

test("HTTPS manifest uses /api and persists single-use state across restarts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "csb-manifest-server-"));
  let now = new Date("2026-09-08T00:00:00Z");
  const config = {
    callbackUrl: "https://sentinel.example/api/guardrails/github-app/manifest/callback",
    localOrigin: "https://sentinel.example", serverOrigin: "https://sentinel.example",
    stateFile: path.join(root, "flows.json"), now: () => now,
  };
  try {
    const first = new GitHubAppManifestFlow(config);
    const started = first.start();
    assert.match(started.authorizeUrl, /^https:\/\/sentinel.example\/api\/guardrails/);
    const authorization = first.authorization(started.flowId);
    assert.match(authorization.manifest.redirect_url, /\/api\/guardrails.*callback\?flowId=/);
    const restarted = new GitHubAppManifestFlow(config);
    assert.equal(restarted.beginCallback(started.flowId, authorization.state, null).status, "exchanging");
    assert.throws(() => new GitHubAppManifestFlow(config).beginCallback(started.flowId, authorization.state, null));
    restarted.complete(started.flowId, "connection-1");
    assert.deepEqual(new GitHubAppManifestFlow(config).publicState(started.flowId), { status: "completed", connectionId: "connection-1" });
    const expiring = restarted.start();
    now = new Date("2026-09-08T00:11:00Z");
    assert.deepEqual(new GitHubAppManifestFlow(config).publicState(expiring.flowId), { status: "expired" });
    assert.equal(fs.statSync(config.stateFile).mode & 0o777, 0o600);
    assert.throws(() => new GitHubAppManifestFlow({ ...config, callbackUrl: "https://other.example/api/guardrails/github-app/manifest/callback" }));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
