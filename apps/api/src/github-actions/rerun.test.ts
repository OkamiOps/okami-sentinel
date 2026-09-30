import assert from "node:assert/strict";
import test from "node:test";

import type { GitHubAction, GitHubActionEvent, GitHubActionEventCreate } from "@csb/shared";

import { rerunGitHubActionGate, type RerunGateDependencies } from "./rerun.js";

const SHA = "a".repeat(40);

function fixture(overrides: {
  action?: Partial<GitHubAction>;
  event?: Partial<GitHubActionEvent>;
} = {}) {
  const action = {
    id: "action-1", repositoryKey: "github:1", connectionId: "c1", installationId: "i1",
    repositoryId: "1", revision: 3, enabled: true, includeForks: false, costCeilingUsd: 2,
    triggerKind: "pull_request",
    ...overrides.action,
  } as GitHubAction;
  const event = {
    id: "event-1", actionId: action.id, repositoryKey: "github:1", actionRevision: 2,
    kind: "pull_request", headSha: "b".repeat(40), baseRef: "main", headRef: "topic",
    pullRequestNumber: 7, title: "Login", gateId: "gate-1",
    ...overrides.event,
  } as GitHubActionEvent;
  const created: GitHubActionEventCreate[] = [];
  const deps: RerunGateDependencies = {
    now: () => "2026-09-30T12:00:00.000Z",
    findEventByGateId: (gateId) => (gateId === "gate-1" ? event : null),
    getAction: (id) => (id === action.id ? action : null),
    createEvent: (input) => {
      created.push(input);
      return { ...input, id: "event-2", status: input.status ?? "queued" } as GitHubActionEvent;
    },
  };
  return { action, event, created, deps };
}

const request = {
  connectionId: "c1", repositoryKey: "github:1", externalId: "gate-1",
  headSha: SHA, checkRunId: "9001",
};

test("a rerequested check run mints a manual event exempt from the repeated commit rule", () => {
  const f = fixture();
  const event = rerunGitHubActionGate(request, f.deps);
  assert.ok(event);
  const [input] = f.created;
  assert.equal(input!.origin, "manual");
  assert.equal(input!.status, "queued");
  assert.equal(input!.deliveryId, null);
  assert.equal(input!.headSha, SHA);
  // The current revision, not the one the old gate ran under.
  assert.equal(input!.actionRevision, 3);
  assert.equal(input!.targetIdentity, `pr:7@${SHA}#rerun:9001`);
  assert.equal(input!.reason, "check_run_rerequested");
  assert.equal(input!.costCeilingUsd, 2);
});

test("a gate of another repository or another connection is never rerun", () => {
  assert.equal(rerunGitHubActionGate({ ...request, repositoryKey: "github:2" }, fixture().deps), null);
  assert.equal(rerunGitHubActionGate({ ...request, connectionId: "c2" }, fixture().deps), null);
  assert.equal(rerunGitHubActionGate({ ...request, externalId: "gate-absent" }, fixture().deps), null);
});

test("a disabled action does not spend on a rerun", () => {
  const f = fixture({ action: { enabled: false } });
  assert.equal(rerunGitHubActionGate(request, f.deps), null);
  assert.deepEqual(f.created, []);
});

test("a fork head is rerun only while the opt-in holds", () => {
  const closed = fixture({ event: { headRef: "pull/7/head" } });
  assert.equal(rerunGitHubActionGate(request, closed.deps), null);
  const open = fixture({ action: { includeForks: true }, event: { headRef: "pull/7/head" } });
  const event = rerunGitHubActionGate(request, open.deps);
  assert.ok(event);
  assert.equal(open.created[0]!.headRef, "pull/7/head");
});
