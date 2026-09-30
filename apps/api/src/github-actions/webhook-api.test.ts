import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import path from "node:path";
import test from "node:test";

import type { GitHubAction, GitHubActionEvent, GitHubActionEventCreate, GuardrailRepository, WebhookDeliveryRecord } from "@csb/shared";

import { FailureWindow } from "../auth/rate-limit.js";
import { shortBranchName } from "./schema.js";
import {
  GITHUB_WEBHOOK_MAX_BODY_BYTES,
  createGitHubWebhookApp,
  type GitHubWebhookAppOptions,
} from "./webhook-api.js";
import type { GitHubWebhookIngestDependencies } from "./webhook-ingest.js";

const SECRET = "webhook-secret-of-connection-one";
const SHA_A = "a".repeat(40);
const URL = "http://localhost/github/webhook";
const TITLE = "Corrige a injeção no deploy";

const repository: GuardrailRepository = {
  repositoryKey: "github:1", repositoryPath: null, source: "github", displayName: "okami/sentinel",
  defaultBranch: "main", defaultExecutor: "sentinel-managed", remoteOwner: "okami", remoteName: "sentinel",
  githubConnectionId: "c1", githubInstallationId: "i1", githubRepositoryId: "1", enabled: true,
  policyPath: ".csb/guardrails.json", lastGateId: null, githubStatus: "ready",
};

const action: GitHubAction = {
  id: "a1", repositoryKey: "github:1", name: "PR", triggerKind: "pull_request", branchPatterns: ["main"],
  executor: "sentinel-managed", connectionId: "c1", installationId: "i1", repositoryId: "1", scanner: null,
  costCeilingUsd: 2, dailyCostCeilingUsd: 10, enabled: true, revision: 1, baselineInitializedAt: null,
  createdBy: "u1", lastEventAt: null, lastReconciledAt: null, lastError: null, migrationNote: null,
  createdAt: "2026-09-30T10:00:00.000Z", updatedAt: "2026-09-30T10:00:00.000Z",
};

const payload = (sha = SHA_A): Record<string, unknown> => ({
  action: "opened",
  number: 7,
  pull_request: { number: 7, base: { ref: "main" }, head: { ref: "topic", sha }, title: TITLE },
  repository: { id: 1 },
  installation: { id: 77 },
});

interface Recorder {
  deliveries: WebhookDeliveryRecord[];
  events: GitHubActionEvent[];
  dispatched: string[];
  dependencies: GitHubWebhookIngestDependencies;
}

function recorder(options: { secrets?: Array<{ connectionId: string; secret: string }> } = {}): Recorder {
  const deliveries: WebhookDeliveryRecord[] = [];
  const events: GitHubActionEvent[] = [];
  const dispatched: string[] = [];
  let clock = Date.parse("2026-09-30T12:00:00.000Z");
  const dependencies: GitHubWebhookIngestDependencies = {
    now: () => { clock += 3; return new Date(clock).toISOString(); },
    listSecrets: async () => options.secrets ?? [{ connectionId: "c1", secret: SECRET }],
    findRepository: (connectionId, repositoryId) =>
      connectionId === "c1" && repositoryId === "1" ? repository : null,
    listActions: () => [action],
    createEvent: (input: GitHubActionEventCreate) => {
      if (events.some((event) => event.targetIdentity === input.targetIdentity && event.actionId === input.actionId)) return null;
      const event: GitHubActionEvent = {
        id: `event-${events.length + 1}`, status: input.status ?? "queued", dispatchedAt: null, completedAt: null,
        ...input, headRef: shortBranchName(input.headRef),
      };
      events.push(event);
      return event;
    },
    supersede: () => 0,
    hasAnalysedCommit: () => false,
    recordDelivery: (input) => {
      if (deliveries.some((delivery) => delivery.deliveryId === input.deliveryId)) return "duplicate";
      deliveries.push(input);
      return "recorded";
    },
    disableActionsForRepository: () => {},
    disableActionsForInstallation: () => {},
    refreshInstallationRepositories: async () => {},
    dispatch: (id) => { dispatched.push(id); },
    rerunGate: () => null,
  };
  return { deliveries, events, dispatched, dependencies };
}

function signedRequest(options: {
  secret?: string;
  body?: string | Uint8Array;
  event?: string;
  delivery?: string;
  signature?: string | null;
  headers?: Record<string, string>;
  contentLength?: string;
} = {}): RequestInit {
  const raw = options.body ?? JSON.stringify(payload());
  const bytes = typeof raw === "string" ? new TextEncoder().encode(raw) : raw;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.event === undefined ? { "X-GitHub-Event": "pull_request" } : options.event === "" ? {} : { "X-GitHub-Event": options.event }),
    ...(options.delivery === undefined ? { "X-GitHub-Delivery": "d1" } : options.delivery === "" ? {} : { "X-GitHub-Delivery": options.delivery }),
    ...(options.signature === null
      ? {}
      : { "X-Hub-Signature-256": options.signature
        ?? `sha256=${createHmac("sha256", options.secret ?? SECRET).update(bytes).digest("hex")}` }),
    ...(options.contentLength ? { "Content-Length": options.contentLength } : {}),
    ...options.headers,
  };
  // `BodyInit` wants a plain ArrayBuffer view, not a Uint8Array over any buffer.
  return { method: "POST", headers, body: bytes.slice().buffer as ArrayBuffer };
}

const appFor = (record: Recorder, overrides: Partial<GitHubWebhookAppOptions> = {}) =>
  createGitHubWebhookApp({
    resolve: () => record.dependencies,
    failureWindow: new FailureWindow(30, 5 * 60_000),
    acceptedWindow: new FailureWindow(600, 60_000),
    trustProxy: true,
    ...overrides,
  });

test("answers 200 processed for a signed delivery", async () => {
  const record = recorder();
  const response = await appFor(record).request(URL, signedRequest());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "processed" });
  assert.equal(record.deliveries.length, 1);
  assert.equal(record.events.length, 1);
  assert.deepEqual(record.dispatched, ["event-1"]);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});

test("answers 200 ignored with the reason for an event it does not handle", async () => {
  const record = recorder();
  const response = await appFor(record).request(URL, signedRequest({
    event: "star", body: JSON.stringify({ action: "created" }),
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ignored", reason: "event_not_handled" });
});

test("answers 401 signature_invalid with no secret configured", async () => {
  const record = recorder({ secrets: [] });
  const response = await appFor(record).request(URL, signedRequest());
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "signature_invalid" });
  assert.equal(record.deliveries.length, 0);
});

test("answers 401 for a signature from the wrong secret and records nothing", async () => {
  const record = recorder();
  const response = await appFor(record).request(URL, signedRequest({ secret: "another-secret-entirely" }));
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "signature_invalid" });
  assert.equal(record.deliveries.length, 0);
});

test("answers 400 for a missing delivery id, event name or signature", async () => {
  const record = recorder();
  const app = appFor(record);
  for (const request of [
    signedRequest({ delivery: "" }),
    signedRequest({ event: "" }),
    signedRequest({ signature: null }),
  ]) {
    const response = await app.request(URL, request);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "malformed_delivery" });
  }
  assert.equal(record.deliveries.length, 0);
});

test("answers 400 malformed_payload for a body that is not a JSON object", async () => {
  const record = recorder();
  const response = await appFor(record).request(URL, signedRequest({ body: "{not json" }));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "malformed_payload" });
  // The signature was valid, so the delivery is on the books.
  assert.equal(record.deliveries.length, 1);
  assert.equal(record.deliveries[0]!.outcome, "failed");
});

test("answers 413 above one mebibyte and records nothing", async () => {
  assert.equal(GITHUB_WEBHOOK_MAX_BODY_BYTES, 1_048_576);
  const record = recorder();
  const app = appFor(record);
  const big = new TextEncoder().encode(JSON.stringify({ action: "opened", pad: "x".repeat(GITHUB_WEBHOOK_MAX_BODY_BYTES) }));
  const oversized = await app.request(URL, signedRequest({ body: big }));
  assert.equal(oversized.status, 413);
  assert.deepEqual(await oversized.json(), { error: "payload_too_large" });
  // A lying Content-Length is refused before the body is read at all.
  const claimed = await app.request(URL, signedRequest({ contentLength: String(GITHUB_WEBHOOK_MAX_BODY_BYTES + 1) }));
  assert.equal(claimed.status, 413);
  assert.equal(record.deliveries.length, 0);
});

test("answers 429 after thirty bad signatures from one address", async () => {
  const record = recorder();
  const app = appFor(record);
  const from = (ip: string, request: RequestInit): RequestInit => ({
    ...request,
    headers: { ...(request.headers as Record<string, string>), "X-Forwarded-For": ip },
  });
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await app.request(URL, from("203.0.113.7", signedRequest({ secret: "wrong", delivery: `bad-${attempt}` })));
    assert.equal(response.status, 401, `attempt ${attempt}`);
  }
  const blocked = await app.request(URL, from("203.0.113.7", signedRequest({ secret: "wrong", delivery: "bad-30" })));
  assert.equal(blocked.status, 429);
  assert.deepEqual(await blocked.json(), { error: "rate_limited" });
  // A valid delivery from the same address is blocked too: the window is the
  // address, not the signature.
  const valid = await app.request(URL, from("203.0.113.7", signedRequest()));
  assert.equal(valid.status, 429);
  // Another address keeps its own budget.
  const elsewhere = await app.request(URL, from("198.51.100.4", signedRequest()));
  assert.equal(elsewhere.status, 200);
});

test("answers 429 once the global accepted-delivery ceiling is reached", async () => {
  const record = recorder();
  const app = appFor(record, { acceptedWindow: new FailureWindow(2, 60_000) });
  for (const delivery of ["g1", "g2"]) {
    const response = await app.request(URL, signedRequest({ delivery }));
    assert.equal(response.status, 200, delivery);
  }
  const blocked = await app.request(URL, signedRequest({ delivery: "g3" }));
  assert.equal(blocked.status, 429);
  assert.deepEqual(await blocked.json(), { error: "rate_limited" });
  assert.equal(record.deliveries.length, 2);
});

test("answers 200 duplicate on a redelivery", async () => {
  const record = recorder();
  const app = appFor(record);
  assert.equal((await app.request(URL, signedRequest({ delivery: "same" }))).status, 200);
  const again = await app.request(URL, signedRequest({ delivery: "same" }));
  assert.equal(again.status, 200);
  assert.deepEqual(await again.json(), { status: "duplicate" });
  assert.equal(record.deliveries.length, 1);
  assert.equal(record.dispatched.length, 1);
});

test("never echoes the payload", async () => {
  const record = recorder();
  const app = appFor(record);
  for (const request of [
    signedRequest(),
    signedRequest({ secret: "wrong" }),
    signedRequest({ body: `{"title":"${TITLE}"`, delivery: "d2" }),
  ]) {
    const response = await app.request(URL, request);
    const body = await response.text();
    assert.ok(body.length <= 200, `body of ${body.length} bytes`);
    assert.ok(!body.includes(TITLE), body);
  }
});

test("answers 503 while the schema is not wired yet", async () => {
  const app = createGitHubWebhookApp({ resolve: () => null, trustProxy: true });
  const response = await app.request(URL, signedRequest());
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "github_webhook_not_ready" });
});

test("answers 500 without a body when the ingestion itself faults", async () => {
  const record = recorder();
  const broken: GitHubWebhookIngestDependencies = {
    ...record.dependencies,
    recordDelivery: () => { throw new Error("database is locked"); },
  };
  const app = createGitHubWebhookApp({ resolve: () => broken, trustProxy: true });
  const response = await app.request(URL, signedRequest());
  assert.equal(response.status, 500);
  const body = await response.text();
  assert.deepEqual(JSON.parse(body), { error: "webhook_failed" });
  assert.ok(!body.includes("locked"));
});

test("the limiter cannot be split by a forwarded header behind an untrusted proxy", async () => {
  const record = recorder();
  const app = appFor(record, { trustProxy: false });
  // No socket peer and no trusted proxy means no attributable bucket, so the
  // per-IP window must not be keyed off the caller's own header.
  for (let attempt = 0; attempt < 31; attempt += 1) {
    const response = await app.request(URL, {
      ...signedRequest({ secret: "wrong", delivery: `x-${attempt}` }),
      headers: {
        ...(signedRequest({ secret: "wrong" }).headers as Record<string, string>),
        "X-Forwarded-For": `203.0.113.${attempt}`,
      },
    });
    assert.equal(response.status, 401, `attempt ${attempt}`);
  }
});

/**
 * Until task 1.4 removes the legacy poller, no boot path may reach the actions
 * store: its first call runs the migration that renames `github_monitor_*` out
 * from under the running poller. `app.ts` imports this module, so the module
 * graph below it must not hold a *value* import of the store.
 */
test("the webhook module graph never imports the actions store at load time", async () => {
  const fs = await import("node:fs");
  const url = await import("node:url");
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  for (const file of ["webhook-api.ts", "webhook-ingest.ts", "webhook-signature.ts", "branch-patterns.ts"]) {
    const source = fs.readFileSync(path.join(here, file), "utf8");
    for (const line of source.split("\n")) {
      if (!/^import .*"\.\/(store|migrate-monitor-rules)\.js"/.test(line)) continue;
      assert.match(line, /^import type /, `${file}: ${line}`);
    }
  }
});

/**
 * The spec's integration case: a signed delivery through the Hono application and
 * into the real SQLite store — the delivery recorded, the event created with the
 * action's own authority and revision, and the dispatch called once, after the
 * transaction. It also pins the dependency shapes against the store's real
 * signatures, so task 1.4's wiring cannot drift from them silently.
 */
test("a signed delivery reaches the real store, once", async () => {
  const Database = (await import("better-sqlite3")).default;
  const store = await import("./store.js");
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec("CREATE TABLE guardrail_repositories (repository_key TEXT PRIMARY KEY)");
  db.prepare("INSERT INTO guardrail_repositories VALUES ('github:1')").run();
  store.ensureGitHubActionsSchema(db);
  const created = store.createGitHubAction({
    repositoryKey: "github:1", name: "PR", triggerKind: "pull_request", branchPatterns: ["main"],
    connectionId: "c1", installationId: "i1", repositoryId: "1", executor: "sentinel-managed",
    scanner: null, costCeilingUsd: 2, dailyCostCeilingUsd: 10, enabled: true, createdBy: "u1",
  }, db);

  const dispatched: string[] = [];
  const dependencies: GitHubWebhookIngestDependencies = {
    now: () => new Date().toISOString(),
    listSecrets: async () => [{ connectionId: "c1", secret: SECRET }],
    findRepository: (connectionId, repositoryId) =>
      connectionId === "c1" && repositoryId === "1" ? repository : null,
    listActions: (repositoryKey) => store.listGitHubActions({ repositoryKey }, db),
    createEvent: (input) => store.createGitHubActionEvent(input, db),
    supersede: (input) => store.supersedeQueuedEvents(input, db),
    hasAnalysedCommit: (actionId, headSha) => store.hasAnalysedCommit(actionId, headSha, db),
    recordDelivery: (input) => store.recordWebhookDelivery(input, db),
    disableActionsForRepository: () => {},
    disableActionsForInstallation: () => {},
    refreshInstallationRepositories: async () => {},
    dispatch: (id) => { dispatched.push(id); },
    rerunGate: () => null,
    runInTransaction: (work) => db.transaction(work).immediate(),
  };
  const app = createGitHubWebhookApp({ resolve: () => dependencies, trustProxy: true });

  const first = await app.request(URL, signedRequest({ delivery: "real-1" }));
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { status: "processed" });
  const events = store.listGitHubActionEvents({ actionId: created.id }, db);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.targetIdentity, `pr:7@${SHA_A}`);
  assert.equal(events[0]!.status, "queued");
  assert.equal(events[0]!.origin, "webhook");
  assert.equal(events[0]!.deliveryId, "real-1");
  assert.equal(events[0]!.actionRevision, created.revision);
  assert.equal(events[0]!.costCeilingUsd, created.costCeilingUsd);
  assert.deepEqual(dispatched, [events[0]!.id]);
  const deliveries = store.listWebhookDeliveries(10, db);
  assert.equal(deliveries.length, 1);
  assert.deepEqual(deliveries[0]!.eventIds, [events[0]!.id]);
  assert.deepEqual(deliveries[0]!.matchedActionIds, [created.id]);
  assert.equal(deliveries[0]!.repositoryKey, "github:1");

  // The same delivery id again: nothing new, and the transaction rolled back.
  const again = await app.request(URL, signedRequest({ delivery: "real-1" }));
  assert.deepEqual(await again.json(), { status: "duplicate" });
  assert.equal(store.listGitHubActionEvents({ actionId: created.id }, db).length, 1);
  assert.equal(dispatched.length, 1);

  // A new commit on the same pull request supersedes the queued event.
  const newer = await app.request(URL, signedRequest({ delivery: "real-2", body: JSON.stringify(payload("b".repeat(40))) }));
  assert.equal(newer.status, 200);
  const all = store.listGitHubActionEvents({ actionId: created.id }, db);
  assert.equal(all.length, 2);
  const superseded = all.find((event) => event.headSha === SHA_A)!;
  assert.equal(superseded.status, "superseded");
  assert.equal(superseded.reason, "head_superseded");
  assert.ok(superseded.completedAt);
  assert.equal(dispatched.length, 2);
  db.close();
});

test("refuses an oversized body that declares no length, without buffering it whole", async () => {
  const record = recorder();
  const app = appFor(record);
  const chunk = new Uint8Array(64 * 1024).fill(0x20);
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      // Twice the ceiling is offered; the reader must stop asking after the cap.
      if (sent >= GITHUB_WEBHOOK_MAX_BODY_BYTES * 2) return controller.close();
      sent += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
  const response = await app.request(URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-GitHub-Event": "pull_request",
      "X-GitHub-Delivery": "streamed",
      "X-Hub-Signature-256": `sha256=${"0".repeat(64)}`,
    },
    body,
    duplex: "half",
  } as RequestInit);
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: "payload_too_large" });
  assert.ok(sent <= GITHUB_WEBHOOK_MAX_BODY_BYTES + chunk.byteLength, `read ${sent} bytes`);
  assert.equal(record.deliveries.length, 0);
});
