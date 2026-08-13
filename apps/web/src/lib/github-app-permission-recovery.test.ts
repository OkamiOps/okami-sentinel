import assert from "node:assert/strict";
import test from "node:test";

import type { GitHubAppConnection, GitHubAppInstallation } from "../api.js";
import { githubPermissionRecovery } from "./github-app-permission-recovery.js";

const connection: GitHubAppConnection = {
  id: "connection-1",
  appId: "4575081",
  appSlug: "okami-sentinel-guardrails",
  clientId: "Iv1.client",
  installationUrl: "https://github.com/apps/okami-sentinel-guardrails/installations/new",
  status: "ready",
  createdAt: "2026-08-13T00:00:00.000Z",
  updatedAt: "2026-08-13T00:00:00.000Z",
};

function installation(accountType: GitHubAppInstallation["accountType"]): GitHubAppInstallation {
  return {
    id: "153304907",
    connectionId: connection.id,
    accountLogin: accountType === "Organization" ? "aitherion-labs" : "msant262",
    accountType,
    status: "ready",
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
  };
}

test("builds the exact app and organization installation permission URLs", () => {
  assert.deepEqual(githubPermissionRecovery(connection, installation("Organization")), {
    appSettingsUrl: "https://github.com/settings/apps/okami-sentinel-guardrails/permissions",
    installationSettingsUrl: "https://github.com/organizations/aitherion-labs/settings/installations/153304907",
  });
});

test("uses personal installation settings and rejects a mismatched connection", () => {
  assert.equal(
    githubPermissionRecovery(connection, { ...installation("User"), connectionId: "other" }),
    null,
  );
  assert.equal(
    githubPermissionRecovery(connection, installation("User"))?.installationSettingsUrl,
    "https://github.com/settings/installations/153304907",
  );
});
