import assert from "node:assert/strict";
import test from "node:test";

import {
  readGitHubInstallationScopes,
  type InstallationScopeDependencies,
} from "./installation-scope.js";

interface Fixture {
  connections?: Array<{ id: string; status: string }>;
  installations?: Record<string, Array<{ id: string; status: string }> | "throws">;
  repositories?: Record<string, string[] | "throws">;
}

function fixture(options: Fixture = {}) {
  const disabled: Array<{ installationId: string; reason: string }> = [];
  const asked: string[] = [];
  const deps: InstallationScopeDependencies = {
    listConnections: () => options.connections ?? [{ id: "c1", status: "ready" }],
    listInstallations: async (connectionId) => {
      const answer = options.installations?.[connectionId] ?? [{ id: "i1", status: "ready" }];
      if (answer === "throws") throw new Error("github_request_rejected");
      return answer;
    },
    listRepositories: async (installationId) => {
      asked.push(installationId);
      const answer = options.repositories?.[installationId] ?? ["1"];
      if (answer === "throws") throw new Error("github_installation_revoked");
      return answer.map((repositoryId) => ({ repositoryId }));
    },
    disableActionsForInstallation: (installationId, reason) => { disabled.push({ installationId, reason }); },
  };
  return { deps, disabled, asked };
}

test("reports every installation that answered, with the repositories it reaches", async () => {
  const f = fixture({ repositories: { i1: ["1", "2"] } });
  const report = await readGitHubInstallationScopes(f.deps);
  assert.deepEqual(report, {
    scopes: [{ installationId: "i1", repositoryIds: ["1", "2"] }],
    failures: 0,
  });
  assert.deepEqual(f.disabled, []);
});

/**
 * I-1. `listInstallations` keeps a vanished installation as a `revoked` row, and
 * `refreshRepositories` throws for anything that is not `ready`. One shared
 * `catch` turned that into "GitHub could not be asked" for ever: the backstop
 * disabled nothing again, for any connection, and every cycle reported an error.
 */
test("a revoked installation costs one installation, not the whole scope", async () => {
  const f = fixture({
    installations: {
      c1: [
        { id: "i-gone", status: "revoked" },
        { id: "i-suspended", status: "suspended" },
        { id: "i-live", status: "ready" },
      ],
    },
    repositories: { "i-live": ["7"] },
  });
  const report = await readGitHubInstallationScopes(f.deps);
  // The healthy installation is still reported, so the reachability check still
  // runs for every other repository.
  assert.deepEqual(report.scopes, [{ installationId: "i-live", repositoryIds: ["7"] }]);
  assert.equal(report.failures, 0, "a revoked installation is an answer, not a failure");
  // And an installation GitHub has taken away reaches nothing: its actions are
  // disabled, which is the `installation` deleted/suspend rule of the spec.
  assert.deepEqual(f.disabled, [
    { installationId: "i-gone", reason: "installation_unauthorized" },
    { installationId: "i-suspended", reason: "installation_unauthorized" },
  ]);
  // Neither one is even asked for its repositories.
  assert.deepEqual(f.asked, ["i-live"]);
});

test("a repository listing that failed counts one failure and leaves its actions alone", async () => {
  const f = fixture({
    installations: { c1: [{ id: "i1", status: "ready" }, { id: "i2", status: "ready" }] },
    repositories: { i1: "throws", i2: ["9"] },
  });
  const report = await readGitHubInstallationScopes(f.deps);
  assert.deepEqual(report.scopes, [{ installationId: "i2", repositoryIds: ["9"] }]);
  assert.equal(report.failures, 1);
  // Absent from the report is "not observed", which the reconciler leaves alone;
  // disabling on a transient read would stop the operator's automation.
  assert.deepEqual(f.disabled, []);
});

test("a connection that could not be listed is one failure, and the others still answer", async () => {
  const f = fixture({
    connections: [{ id: "c1", status: "ready" }, { id: "c2", status: "ready" }],
    installations: { c1: "throws", c2: [{ id: "i2", status: "ready" }] },
    repositories: { i2: ["3"] },
  });
  const report = await readGitHubInstallationScopes(f.deps);
  assert.deepEqual(report.scopes, [{ installationId: "i2", repositoryIds: ["3"] }]);
  assert.equal(report.failures, 1);
});

test("a revoked connection is never asked at all", async () => {
  const f = fixture({ connections: [{ id: "c1", status: "revoked" }] });
  const report = await readGitHubInstallationScopes(f.deps);
  assert.deepEqual(report, { scopes: [], failures: 0 });
  assert.deepEqual(f.asked, []);
  assert.deepEqual(f.disabled, []);
});
