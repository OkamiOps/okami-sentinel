import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import path from "node:path";
import test from "node:test";

import type { GitHubAction, GitHubActionEvent, GitHubActionEventCreate, GuardrailRepository, WebhookDeliveryRecord } from "@csb/shared";

import { FailureWindow } from "../auth/rate-limit.js";
import { globalSecretRedactor } from "../redaction.js";
import { shortBranchName } from "./schema.js";
import {
  GITHUB_WEBHOOK_MAX_BODY_BYTES,
  createGitHubWebhookApp,
  type GitHubWebhookAppOptions,
  type GitHubWebhookLogEntry,
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
  costCeilingUsd: 2, dailyCostCeilingUsd: 10, enabled: true, includeForks: false,
  revision: 1, baselineInitializedAt: null,
  createdBy: "u1", lastEventAt: null, lastReconciledAt: null, lastError: null, migrationNote: null,
  createdAt: "2026-09-30T10:00:00.000Z", updatedAt: "2026-09-30T10:00:00.000Z",
};

const payload = (sha = SHA_A): Record<string, unknown> => ({
  action: "opened",
  number: 7,
  pull_request: {
    number: 7,
    // The head repository is the base repository: a branch of the enrolled
    // repository, not a fork. Omitting either id now fails closed.
    base: { ref: "main", repo: { id: 1 } },
    head: { ref: "topic", sha, repo: { id: 1 } },
    title: TITLE,
    draft: false,
    updated_at: "2026-09-30T11:59:00.000Z",
  },
  repository: { id: 1, pushed_at: "2026-09-30T11:59:00.000Z" },
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
    newestObservedAt: () => null,
    hasAnalysedCommit: () => false,
    claimDelivery: (input) => {
      if (deliveries.some((delivery) => delivery.deliveryId === input.deliveryId)) return "duplicate";
      deliveries.push(input);
      return "recorded";
    },
    completeDelivery: (deliveryId, patch) => {
      const index = deliveries.findIndex((delivery) => delivery.deliveryId === deliveryId);
      if (index !== -1) deliveries[index] = { ...deliveries[index]!, ...patch };
    },
    disableActionsForRepository: () => {},
    disableActionsForInstallation: () => {},
    refreshInstallationRepositories: async () => {},
    dispatch: (id) => { dispatched.push(id); },
    connectionAppId: () => "4242",
    rerunGate: () => null,
    runInTransaction: (work) => work(),
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

const logged: GitHubWebhookLogEntry[] = [];

const appFor = (record: Recorder, overrides: Partial<GitHubWebhookAppOptions> = {}) => {
  logged.length = 0;
  return createGitHubWebhookApp({
    resolve: () => record.dependencies,
    failureWindow: new FailureWindow(30, 5 * 60_000),
    acceptedWindow: new FailureWindow(600, 60_000),
    trustProxy: true,
    log: (entry) => { logged.push(entry); },
    ...overrides,
  });
};

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
  let clock = 0;
  const app = appFor(record, { throttleIntervalMs: 1_000, now: () => clock });
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
  assert.equal(blocked.headers.get("Retry-After"), "300");
  // The window counts failed verifications only. GitHub delivers from a small set
  // of addresses, so one misconfigured secret must never make the product deaf to
  // the connection that is configured correctly — it is throttled, not blocked, so
  // the next interval serves a correctly signed delivery.
  clock += 1_000;
  const valid = await app.request(URL, from("203.0.113.7", signedRequest({ delivery: "good-1" })));
  assert.equal(valid.status, 200);
  assert.deepEqual(await valid.json(), { status: "processed" });
  // A verified delivery does not clear the window either: an attacker who can have
  // one delivery accepted must not be able to reset its own budget.
  clock += 1_000;
  const stillBlocked = await app.request(URL, from("203.0.113.7", signedRequest({ secret: "wrong", delivery: "bad-31" })));
  assert.equal(stillBlocked.status, 429);
  // Another address keeps its own budget, and never entered the throttle.
  const elsewhere = await app.request(URL, from("198.51.100.4", signedRequest({ delivery: "good-2" })));
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
  assert.equal(blocked.headers.get("Retry-After"), "60");
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
    claimDelivery: () => { throw new Error("database is locked"); },
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
  const forbidden = ["store.js", "migrate-monitor-rules.js"];
  // The whole local graph below `webhook-api.ts`, not one file: a value import of
  // the store reached through a third module would be just as fatal.
  const visited = new Set<string>();
  const queue = ["webhook-api.ts"];
  const valueImports: Array<{ file: string; specifier: string }> = [];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    const absolute = path.join(here, file);
    if (!fs.existsSync(absolute)) continue;
    const source = fs.readFileSync(absolute, "utf8");
    // A dynamic import is a load-time reach too, as soon as the handler runs.
    for (const match of source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) {
      valueImports.push({ file, specifier: match[1]! });
    }
    // Statements only, with their (possibly multi-line) clause, so `import type`
    // is distinguished from a value import however the clause is wrapped.
    for (const match of source.matchAll(/^import(\s+type)?\s+([\s\S]*?)from\s*["']([^"']+)["'];/gm)) {
      const [, typeOnly, clause, specifier] = match as unknown as [string, string | undefined, string, string];
      if (!specifier.startsWith("./")) continue;
      // `import type …` is erased; a mixed clause (`{ a, type B }`) is not.
      if (typeOnly !== undefined || /^\s*type\s/.test(clause)) continue;
      valueImports.push({ file, specifier });
      queue.push(specifier.replace(/^\.\//, "").replace(/\.js$/, ".ts"));
    }
  }
  assert.ok(visited.has("webhook-ingest.ts"), "the graph walk found nothing");
  assert.ok(visited.has("branch-patterns.ts"));
  const reaching = valueImports.filter((entry) => forbidden.some((name) => entry.specifier.endsWith(name)));
  assert.deepEqual(reaching, [], "the actions store must stay out of the boot path until task 1.4");
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
    scanner: null, costCeilingUsd: 2, dailyCostCeilingUsd: 10, enabled: true,
    includeForks: false, createdBy: "u1",
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
    newestObservedAt: (input) => store.newestObservedEventAt(input, db),
    hasAnalysedCommit: (actionId, headSha) => store.hasAnalysedCommit(actionId, headSha, db),
    claimDelivery: (input) => store.recordWebhookDelivery(input, db),
    completeDelivery: (deliveryId, patch) => store.completeWebhookDelivery(deliveryId, patch, db),
    disableActionsForRepository: () => {},
    disableActionsForInstallation: () => {},
    refreshInstallationRepositories: async () => {},
    dispatch: (id) => { dispatched.push(id); },
    connectionAppId: () => "4242",
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

/**
 * I-3. GitHub does not retry a webhook: a refused delivery is a lost event until a
 * human presses *Redeliver*. Every refusal therefore has to leave a trace that
 * names the delivery, and never the payload or the secret.
 */
test("logs every refusal with the delivery id and a reason code, and nothing else", async () => {
  const record = recorder();
  const app = appFor(record);
  await app.request(URL, signedRequest({ delivery: "log-400", signature: null }));
  await app.request(URL, signedRequest({ delivery: "log-401", secret: "wrong" }));
  await app.request(URL, signedRequest({ delivery: "log-413", contentLength: String(GITHUB_WEBHOOK_MAX_BODY_BYTES + 1) }));
  await app.request(URL, signedRequest({ delivery: "log-parse", body: `{"title":"${TITLE}"` }));
  assert.deepEqual(logged.map((entry) => [entry.status, entry.reason]), [
    [400, "malformed_delivery"],
    [401, "signature_invalid"],
    [413, "payload_too_large"],
    [400, "malformed_payload"],
  ]);
  // The delivery id travels so the operator can correlate with GitHub's own list.
  assert.deepEqual(logged.map((entry) => entry.deliveryId), ["log-400", "log-401", "log-413", "log-parse"]);
  assert.deepEqual(new Set(logged.map((entry) => entry.event)), new Set(["pull_request"]));
  const serialised = JSON.stringify(logged);
  assert.ok(!serialised.includes(TITLE), serialised);
  assert.ok(!serialised.includes(SECRET), serialised);
});

test("logs a fault and the not-ready refusal without leaking the cause", async () => {
  // Exactly what `SystemGitHubAppCredentialStore` does on every read of a bundle.
  globalSecretRedactor.register("scm/github-app/c1", [SECRET]);
  const record = recorder();
  const broken: GitHubWebhookIngestDependencies = {
    ...record.dependencies,
    claimDelivery: () => { throw new Error(`database is locked for ${SECRET}`); },
  };
  const entries: GitHubWebhookLogEntry[] = [];
  const app = createGitHubWebhookApp({
    resolve: () => broken, trustProxy: true, log: (entry) => { entries.push(entry); },
  });
  assert.equal((await app.request(URL, signedRequest({ delivery: "fault" }))).status, 500);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.status, 500);
  assert.equal(entries[0]!.reason, "webhook_failed");
  assert.equal(entries[0]!.deliveryId, "fault");
  // The message is kept, because a 500 is the operator's only clue, and it goes
  // through the same redactor the credential store registers the secret with.
  assert.ok(entries[0]!.detail);
  assert.ok(entries[0]!.detail!.includes("[REDACTED]"), entries[0]!.detail);
  assert.ok(!entries[0]!.detail!.includes(SECRET), entries[0]!.detail);

  const inert: GitHubWebhookLogEntry[] = [];
  const notReady = createGitHubWebhookApp({
    resolve: () => null, trustProxy: true, log: (entry) => { inert.push(entry); },
  });
  assert.equal((await notReady.request(URL, signedRequest({ delivery: "inert" }))).status, 503);
  assert.deepEqual(inert.map((entry) => [entry.status, entry.reason]), [[503, "github_webhook_not_ready"]]);
  globalSecretRedactor.unregister("scm/github-app/c1");
});

test("refuses before reading the body while the schema is not wired yet", async () => {
  // M-1: an anonymous caller must not be able to make an inert deployment buffer a
  // mebibyte per request.
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      controller.enqueue(new Uint8Array(1024));
    },
  });
  const app = createGitHubWebhookApp({ resolve: () => null, trustProxy: true });
  const response = await app.request(URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-GitHub-Event": "pull_request",
      "X-GitHub-Delivery": "unread",
      "X-Hub-Signature-256": `sha256=${"0".repeat(64)}`,
    },
    body,
    duplex: "half",
  } as RequestInit);
  assert.equal(response.status, 503);
  // The stream is offered to the Request eagerly; what matters is that the handler
  // never drained it, which would have pulled a mebibyte in 1 KiB chunks.
  assert.ok(pulls <= 2, `the body was read in ${pulls} chunks`);
});

/**
 * N-1. The endpoint is unauthenticated, so what one address can make the process
 * *do* is the defence that matters. Past the failure threshold a delivery is shed
 * before the body is read — no 1 MiB buffer, no hash — while GitHub's own valid
 * deliveries still get through, one per interval.
 */
test("sheds a flooding address before reading the body, and still lets a valid delivery through", async () => {
  const record = recorder();
  let clock = 0;
  const app = appFor(record, { throttleIntervalMs: 1_000, now: () => clock });
  const streamed = (): { request: RequestInit; pulls: () => number } => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(1024));
      },
    });
    return {
      request: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-GitHub-Event": "pull_request",
          "X-GitHub-Delivery": `flood-${pulls}`,
          "X-Hub-Signature-256": `sha256=${"0".repeat(64)}`,
          "X-Forwarded-For": "203.0.113.9",
        },
        body,
        duplex: "half",
      } as RequestInit,
      pulls: () => pulls,
    };
  };
  const from = (request: RequestInit): RequestInit => ({
    ...request,
    headers: { ...(request.headers as Record<string, string>), "X-Forwarded-For": "203.0.113.9" },
  });

  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await app.request(URL, from(signedRequest({ secret: "wrong", delivery: `bad-${attempt}` })));
    assert.equal(response.status, 401, `attempt ${attempt}`);
  }
  // The first delivery past the threshold spends the interval's single slot.
  const spent = await app.request(URL, from(signedRequest({ secret: "wrong", delivery: "bad-30" })));
  assert.equal(spent.status, 429);
  // Over the threshold and inside the interval: refused without touching the body.
  const shed = streamed();
  const refused = await app.request(URL, shed.request);
  assert.equal(refused.status, 429);
  assert.deepEqual(await refused.json(), { error: "rate_limited" });
  assert.ok(shed.pulls() <= 2, `read ${shed.pulls()} chunks`);

  // The next interval buys exactly one verification, and a valid delivery uses it.
  clock += 1_000;
  const valid = await app.request(URL, from(signedRequest({ delivery: "good-after-flood" })));
  assert.equal(valid.status, 200);
  assert.deepEqual(await valid.json(), { status: "processed" });
  // And the one after it, in the same interval, is shed again.
  const again = await app.request(URL, from(signedRequest({ delivery: "good-too-soon" })));
  assert.equal(again.status, 429);
  // A different address never entered the throttle at all.
  const elsewhere = await app.request(URL, {
    ...signedRequest({ delivery: "elsewhere" }),
    headers: { ...(signedRequest().headers as Record<string, string>), "X-Forwarded-For": "198.51.100.8" },
  });
  assert.equal(elsewhere.status, 200);
});

test("refuses a malformed signature header before reading the body", async () => {
  const record = recorder();
  const app = appFor(record);
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      controller.enqueue(new Uint8Array(1024));
    },
  });
  const response = await app.request(URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-GitHub-Event": "pull_request",
      "X-GitHub-Delivery": "shapeless",
      // Right length, not hex: it cannot be a signature, so it costs nothing.
      "X-Hub-Signature-256": `sha256=${"z".repeat(64)}`,
    },
    body,
    duplex: "half",
  } as RequestInit);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "malformed_delivery" });
  assert.ok(pulls <= 2, `read ${pulls} chunks`);
  assert.equal(record.deliveries.length, 0);
});

test("caps the number of verifications running at once", async () => {
  const record = recorder();
  const gates: Array<() => void> = [];
  let open = false;
  const gated: GitHubWebhookIngestDependencies = {
    ...record.dependencies,
    listSecrets: async () => {
      if (!open) await new Promise<void>((resolve) => { gates.push(resolve); });
      return [{ connectionId: "c1", secret: SECRET, appId: "4242" }];
    },
  };
  const app = createGitHubWebhookApp({
    resolve: () => gated, trustProxy: true, maxConcurrentVerifications: 1,
  });
  const first = app.request(URL, signedRequest({ delivery: "concurrent-1" }));
  // Let the first request reach the gate before the second arrives.
  await new Promise((resolve) => { setTimeout(resolve, 5); });
  // Raced against a deadline: with no cap the second request blocks on the gate
  // too, and the failure has to be an assertion rather than a hung test.
  const second = await Promise.race([
    app.request(URL, signedRequest({ delivery: "concurrent-2" })),
    new Promise<"blocked">((resolve) => { setTimeout(() => resolve("blocked"), 1_000); }),
  ]);
  assert.notEqual(second, "blocked", "the second verification was admitted and blocked on the gate");
  assert.equal((second as Response).status, 429);
  assert.deepEqual(await (second as Response).json(), { error: "rate_limited" });
  open = true;
  for (const release of gates) release();
  assert.equal((await first).status, 200);
  // The slot is given back, so the endpoint is not wedged.
  const third = await app.request(URL, signedRequest({ delivery: "concurrent-3" }));
  assert.equal(third.status, 200);
});

test("caps the header values it writes to the log", async () => {
  const record = recorder();
  const app = appFor(record);
  await app.request(URL, signedRequest({
    secret: "wrong",
    delivery: "d".repeat(4096),
    event: "e".repeat(4096),
  }));
  assert.equal(logged.length, 1);
  assert.equal(logged[0]!.deliveryId!.length, 64);
  assert.equal(logged[0]!.event!.length, 64);
});
