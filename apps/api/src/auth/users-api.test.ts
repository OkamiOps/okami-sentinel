import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { getDb } from "../db.js";
import { LOCAL_PRINCIPAL, type Principal } from "./principal.js";
import { createSession, getSessionById, resolveSession } from "./session-store.js";
import type { EmailEnqueueResult, EnqueueEmailInput } from "../email/enqueue.js";
import type { EmailMessageKind } from "../email/templates.js";
import { createUsersApi, type InviteEmailPort } from "./users-api.js";
import { createUser, findUserByUsername, listUsers, updateUser } from "./user-store.js";

const JSON_HEADERS = { "Content-Type": "application/json" };

function seedRepository(key: string): void {
  getDb().prepare(`INSERT OR IGNORE INTO guardrail_repositories
    (repository_key, repository_path, source, display_name, default_branch, default_executor, enabled, policy_path, created_at, updated_at)
    VALUES (?, ?, 'local', ?, 'main', 'sentinel-managed', 1, '.csb/guardrails.json', 'now', 'now')`).run(key, `/repos/${key}`, key);
}

/** Local runtime leaves `principalOf` at LOCAL_PRINCIPAL, which is an admin. */
function usersApi(publicOrigin: string | null = null): Hono {
  return new Hono().route("/", createUsersApi({ publicOrigin }));
}

/** Server mode installs the principal itself; this stands in for that middleware. */
function usersApiAs(principal: Partial<Principal>): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("principal" as never, { ...LOCAL_PRINCIPAL, kind: "user", ...principal } as never);
    await next();
  });
  return app.route("/", createUsersApi({ publicOrigin: null }));
}

async function patch(api: Hono, id: string, body: unknown): Promise<Response> {
  return api.request(`/users/${id}`, { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify(body) });
}

async function putGrants(api: Hono, id: string, grants: unknown): Promise<Response> {
  return api.request(`/users/${id}/grants`, { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify({ grants }) });
}

test("creates a user with grants and a single invite link, refusing duplicates", async () => {
  const api = usersApi("https://sentinel.example");
  const key = `local/users${Date.now()}`;
  seedRepository(key);
  const name = `bruno${Date.now()}`;
  const created = await api.request("/users", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({
    username: ` ${name.toUpperCase()} `, displayName: "Bruno", isAdmin: false, grants: [{ repositoryKey: key, role: "viewer" }],
  }) });
  assert.equal(created.status, 201);
  const body = await created.json();
  assert.equal(body.user.username, name);
  assert.equal(body.user.pendingInvite, true);
  assert.equal(body.user.repositoryCount, 1);
  assert.equal(body.user.hasPassword, false);
  assert.match(body.invite.inviteUrl, /^https:\/\/sentinel\.example\/invite\/[A-Za-z0-9_-]{43}$/);
  assert.ok(Date.parse(body.invite.expiresAt) > Date.now());
  const listed = await (await api.request("/users")).json();
  assert.ok(listed.users.some((user: { id: string }) => user.id === body.user.id));
  const duplicate = await api.request("/users", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ username: name, displayName: "Other", isAdmin: false, grants: [] }) });
  assert.equal(duplicate.status, 409);
  assert.deepEqual(await duplicate.json(), { error: "username_taken" });
});

test("rejects an invalid username without creating anything", async () => {
  const api = usersApi(null);
  const response = await api.request("/users", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ username: "a b!", displayName: "Nope", isAdmin: false, grants: [] }) });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "username_invalid" });
});

test("never leaks the stored invite hash in the invite URL", async () => {
  const api = usersApi(null);
  const name = `elisa${Date.now()}`;
  const created = await api.request("/users", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ username: name, displayName: "Elisa", isAdmin: false, grants: [] }) });
  assert.equal(created.status, 201);
  const { invite } = await created.json();
  const token = invite.inviteUrl.slice("/invite/".length);
  assert.equal(invite.inviteUrl, `/invite/${token}`);
  const user = findUserByUsername(name, getDb())!;
  const hash = getDb().prepare("SELECT token_hash FROM user_invites WHERE user_id = ? AND used_at IS NULL").get(user.id) as { token_hash: string };
  assert.notEqual(hash.token_hash, token);
  assert.equal(invite.inviteUrl.includes(hash.token_hash), false);
});

test("rolls back the user when the initial grants name an unknown repository", async () => {
  const api = usersApi(null);
  const name = `fabio${Date.now()}`;
  const response = await api.request("/users", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({
    username: name, displayName: "Fabio", isAdmin: false, grants: [{ repositoryKey: "local/missing", role: "viewer" }],
  }) });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "repository_unknown" });
  assert.equal(findUserByUsername(name, getDb()), null);
});

test("rejects a duplicated repository in the grants payload", async () => {
  const api = usersApi(null);
  const key = `local/dupe${Date.now()}`;
  seedRepository(key);
  const name = `gina${Date.now()}`;
  const created = await api.request("/users", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({
    username: name, displayName: "Gina", isAdmin: false,
    grants: [{ repositoryKey: key, role: "viewer" }, { repositoryKey: key, role: "operator" }],
  }) });
  assert.equal(created.status, 400);
  assert.deepEqual(await created.json(), { error: "repository_duplicate" });
  assert.equal(findUserByUsername(name, getDb()), null);

  const user = createUser({ username: `hugo${Date.now()}`, displayName: "Hugo", isAdmin: false }, getDb());
  const replaced = await putGrants(api, user.id, [{ repositoryKey: key, role: "viewer" }, { repositoryKey: key, role: "operator" }]);
  assert.equal(replaced.status, 400);
  assert.deepEqual(await replaced.json(), { error: "repository_duplicate" });
  const grants = await (await api.request(`/users/${user.id}/grants`)).json();
  assert.deepEqual(grants.grants, []);
});

test("refuses to demote or disable the last active administrator", async () => {
  const api = usersApi(null);
  const only = createUser({ username: `root${Date.now()}`, displayName: "Root", isAdmin: true }, getDb());
  for (const user of listUsers(getDb())) if (user.id !== only.id && user.isAdmin) updateUser(user.id, { isAdmin: false }, getDb());
  const demote = await patch(api, only.id, { isAdmin: false });
  assert.equal(demote.status, 409);
  assert.deepEqual(await demote.json(), { error: "last_admin" });
  const disable = await patch(api, only.id, { status: "disabled" });
  assert.equal(disable.status, 409);
  assert.deepEqual(await disable.json(), { error: "last_admin" });
  const second = createUser({ username: `root2${Date.now()}`, displayName: "Root 2", isAdmin: true }, getDb());
  assert.equal((await patch(api, only.id, { isAdmin: false })).status, 200);
  assert.ok(second);
});

test("refuses a self-demotion that would remove the last administrator", async () => {
  const only = createUser({ username: `solo${Date.now()}`, displayName: "Solo", isAdmin: true }, getDb());
  for (const user of listUsers(getDb())) if (user.id !== only.id && user.isAdmin) updateUser(user.id, { isAdmin: false }, getDb());
  const api = usersApiAs({ userId: only.id, username: only.username, displayName: only.displayName, isAdmin: true });
  const response = await patch(api, only.id, { isAdmin: false });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "last_admin" });
  assert.equal((await patch(api, only.id, { status: "disabled" })).status, 409);
});

test("demotes an already disabled administrator without tripping the last-admin guard", async () => {
  const api = usersApi(null);
  const active = createUser({ username: `alive${Date.now()}`, displayName: "Alive", isAdmin: true }, getDb());
  const dormant = createUser({ username: `dormant${Date.now()}`, displayName: "Dormant", isAdmin: true }, getDb());
  for (const user of listUsers(getDb())) {
    if (user.id !== active.id && user.id !== dormant.id && user.isAdmin) updateUser(user.id, { isAdmin: false }, getDb());
  }
  updateUser(dormant.id, { status: "disabled" }, getDb());
  const response = await patch(api, dormant.id, { isAdmin: false });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).isAdmin, false);
});

test("updates the editable profile fields and reports 404 for an unknown user", async () => {
  const api = usersApi(null);
  const user = createUser({ username: `iris${Date.now()}`, displayName: "Iris", email: "iris@example.com", isAdmin: false }, getDb());
  const response = await patch(api, user.id, { displayName: "  Iris Costa  ", email: " iris.costa@example.com " });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.displayName, "Iris Costa");
  assert.equal(body.email, "iris.costa@example.com");
  assert.equal(body.status, "active");
  const cleared = await patch(api, user.id, { email: null });
  assert.equal((await cleared.json()).email, null);
  assert.equal((await patch(api, "missing-user-id", { displayName: "Nope" })).status, 404);
});

test("replacing grants with an unknown repository writes nothing", async () => {
  const api = usersApi(null);
  const key = `local/grants${Date.now()}`;
  seedRepository(key);
  const user = createUser({ username: `carla${Date.now()}`, displayName: "Carla", isAdmin: false }, getDb());
  await putGrants(api, user.id, [{ repositoryKey: key, role: "operator" }]);
  const bad = await putGrants(api, user.id, [{ repositoryKey: key, role: "viewer" }, { repositoryKey: "local/missing", role: "viewer" }]);
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { error: "repository_unknown" });
  const grants = await (await api.request(`/users/${user.id}/grants`)).json();
  assert.deepEqual(grants.grants, [{ repositoryKey: key, role: "operator" }]);
  const access = await (await api.request("/repository-access")).json();
  const entry = access.repositories.find((r: { repositoryKey: string }) => r.repositoryKey === key);
  assert.deepEqual(entry.grants.map((g: { userId: string; role: string }) => [g.userId, g.role]), [[user.id, "operator"]]);
  assert.equal(entry.source, "local");
});

test("rejects an unknown role and a malformed grants payload", async () => {
  const api = usersApi(null);
  const user = createUser({ username: `joana${Date.now()}`, displayName: "Joana", isAdmin: false }, getDb());
  assert.equal((await putGrants(api, user.id, [{ repositoryKey: "local/x", role: "owner" }])).status, 400);
  assert.deepEqual(await (await putGrants(api, user.id, [{ repositoryKey: "local/x", role: "owner" }])).json(), { error: "role_invalid" });
  assert.equal((await putGrants(api, user.id, "nope")).status, 400);
  assert.equal((await putGrants(api, "missing-user-id", [])).status, 404);
});

test("sets and clears a single repository grant", async () => {
  const api = usersApi(null);
  const key = `local/single ${Date.now()}`;
  seedRepository(key);
  const user = createUser({ username: `lia${Date.now()}`, displayName: "Lia", isAdmin: false }, getDb());
  const path = `/repository-access/${encodeURIComponent(key)}/users/${user.id}`;
  assert.equal((await api.request(path, { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify({ role: "analyst" }) })).status, 204);
  assert.deepEqual((await (await api.request(`/users/${user.id}/grants`)).json()).grants, [{ repositoryKey: key, role: "analyst" }]);
  assert.equal((await api.request(path, { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify({ role: "root" }) })).status, 400);
  assert.equal((await api.request(path, { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify({ role: null }) })).status, 204);
  assert.deepEqual((await (await api.request(`/users/${user.id}/grants`)).json()).grants, []);
  const unknown = await api.request(`/repository-access/${encodeURIComponent("local/missing")}/users/${user.id}`, {
    method: "PUT", headers: JSON_HEADERS, body: JSON.stringify({ role: "viewer" }),
  });
  assert.equal(unknown.status, 400);
  assert.deepEqual(await unknown.json(), { error: "repository_unknown" });
});

test("disabling a user revokes their sessions", async () => {
  const api = usersApi(null);
  const admin2 = createUser({ username: `keep${Date.now()}`, displayName: "Keep", isAdmin: true }, getDb());
  const user = createUser({ username: `dora${Date.now()}`, displayName: "Dora", isAdmin: false }, getDb());
  const { token } = createSession({ userId: user.id, ip: null, userAgent: null }, getDb());
  const response = await patch(api, user.id, { status: "disabled" });
  assert.equal(response.status, 200);
  assert.equal(resolveSession(token, undefined, getDb()), null);
  assert.ok(admin2);
});

test("lists sessions without marking any as current and revokes them on request", async () => {
  const api = usersApi(null);
  const user = createUser({ username: `nina${Date.now()}`, displayName: "Nina", isAdmin: false }, getDb());
  const { session } = createSession({ userId: user.id, ip: "10.0.0.9", userAgent: "probe", now: new Date() }, getDb());
  const listed = await (await api.request(`/users/${user.id}/sessions`)).json();
  assert.deepEqual(listed.sessions.map((s: { id: string; current: boolean; ip: string | null }) => [s.id, s.current, s.ip]),
    [[session.id, false, "10.0.0.9"]]);
  assert.equal((await api.request(`/users/${user.id}/sessions`, { method: "DELETE" })).status, 204);
  assert.equal(getSessionById(session.id, undefined, getDb()), null);
  assert.equal((await api.request("/users/missing-user-id/sessions", { method: "DELETE" })).status, 404);
});

test("issues a reset link that revokes the existing sessions", async () => {
  const api = usersApi("https://sentinel.example");
  const user = createUser({ username: `otto${Date.now()}`, displayName: "Otto", isAdmin: false }, getDb());
  const { token } = createSession({ userId: user.id, ip: null, userAgent: null }, getDb());
  const response = await api.request(`/users/${user.id}/reset`, { method: "POST" });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.match(body.inviteUrl, /^https:\/\/sentinel\.example\/invite\/[A-Za-z0-9_-]{43}$/);
  assert.ok(Date.parse(body.expiresAt) > Date.now());
  assert.equal(resolveSession(token, undefined, getDb()), null);
  const listed = await (await api.request("/users")).json();
  assert.equal(listed.users.find((u: { id: string }) => u.id === user.id).pendingInvite, true);
  assert.equal((await api.request("/users/missing-user-id/reset", { method: "POST" })).status, 404);
});

test("forbids every administration route for a non-administrator principal", async () => {
  const api = usersApiAs({ userId: "viewer-principal", username: "viewer", displayName: "Viewer", isAdmin: false });
  const requests: Array<[string, RequestInit]> = [
    ["/users", {}],
    ["/users", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ username: "zed", displayName: "Zed", isAdmin: true, grants: [] }) }],
    ["/users/any-id", { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ isAdmin: true }) }],
    ["/users/any-id/reset", { method: "POST" }],
    ["/users/any-id/sessions", {}],
    ["/users/any-id/sessions", { method: "DELETE" }],
    ["/users/any-id/grants", {}],
    ["/users/any-id/grants", { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify({ grants: [] }) }],
    ["/repository-access", {}],
    ["/repository-access/local%2Fx/users/any-id", { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify({ role: "viewer" }) }],
  ];
  for (const [path, init] of requests) {
    const response = await api.request(path, init);
    assert.equal(response.status, 403, `${init.method ?? "GET"} ${path}`);
    assert.deepEqual(await response.json(), { error: "forbidden" });
  }
  assert.equal(findUserByUsername("zed", getDb()), null);
});


/**
 * A stand-in for the outbox. The real one is exercised in `enqueue.test.ts`
 * against its own database; here the question is what the routes ask it for and
 * what they tell the administrator about the answer.
 */
function spyPort(result: EmailEnqueueResult = { status: "queued", id: "out_spy" }): {
  port: InviteEmailPort;
  calls: Array<EnqueueEmailInput<EmailMessageKind>>;
  answer: (next: EmailEnqueueResult) => void;
  throwNext: () => void;
} {
  const calls: Array<EnqueueEmailInput<EmailMessageKind>> = [];
  let answer = result;
  let throwing = false;
  return {
    calls,
    answer: (next) => { answer = next; },
    throwNext: () => { throwing = true; },
    port: (_database, input) => {
      calls.push(input as EnqueueEmailInput<EmailMessageKind>);
      if (throwing) throw new Error("the outbox is unavailable");
      return answer;
    },
  };
}

function usersApiWith(enqueue: InviteEmailPort, publicOrigin: string | null = "https://sentinel.example"): Hono {
  return new Hono().route("/", createUsersApi({
    publicOrigin, enqueue, now: () => new Date("2026-09-30T10:00:00.000Z"),
  }));
}

async function createUserVia(api: Hono, body: Record<string, unknown>): Promise<Record<string, never>> {
  const response = await api.request("/users", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
  assert.equal(response.status, 201);
  return await response.json() as Record<string, never>;
}

test("an invite is queued to the invited address, in the inviter's language, and the link stays", async () => {
  const spy = spyPort();
  const inviter = createUser({ username: `marcos${Date.now()}`, displayName: "Marcos", isAdmin: true }, getDb());
  updateUser(inviter.id, { locale: "de" }, getDb());
  const api = new Hono();
  api.use("*", async (c, next) => {
    c.set("principal" as never, { ...LOCAL_PRINCIPAL, kind: "user", userId: inviter.id, isAdmin: true } as never);
    await next();
  });
  api.route("/", createUsersApi({ publicOrigin: "https://sentinel.example", enqueue: spy.port }));

  const name = `bruno${Date.now()}`;
  const body = await createUserVia(api, {
    username: name, displayName: "Bruno", email: "bruno@example.com", isAdmin: false, grants: [],
  }) as unknown as { user: { id: string }; invite: Record<string, unknown> };

  assert.equal(body.invite.emailQueued, true);
  assert.equal(body.invite.emailSkipped, null);
  assert.equal(body.invite.emailTo, "bruno@example.com");
  assert.match(String(body.invite.inviteUrl), /^https:\/\/sentinel\.example\/invite\/[A-Za-z0-9_-]{43}$/);

  assert.equal(spy.calls.length, 1);
  const queued = spy.calls[0]!;
  assert.equal(queued.event, "account.invite");
  assert.equal(queued.userId, body.user.id);
  assert.equal(queued.toAddress, "bruno@example.com");
  // The invited person has never chosen a language, so the invite uses the
  // inviter's, as the design says.
  assert.equal(queued.locale, "de");
  assert.equal(queued.dedupeKey, `account.${body.user.id}.invite.${body.invite.expiresAt}`);
  assert.deepEqual(
    { inviterName: (queued.data as { inviterName: string }).inviterName },
    { inviterName: "Marcos" },
  );
  // The token in the message is the token in the copyable link, and nothing else
  // in the response names it.
  assert.ok(String(body.invite.inviteUrl).endsWith((queued.data as { inviteToken: string }).inviteToken));
});

test("with no address, e-mail off, or a broken outbox, the user is still created and the link still works", async () => {
  const spy = spyPort();
  const api = usersApiWith(spy.port);

  const nameless = `nomail${Date.now()}`;
  const withoutAddress = await createUserVia(api, { username: nameless, displayName: "No Mail", isAdmin: false, grants: [] }) as
    unknown as { invite: Record<string, unknown> };
  assert.deepEqual(
    { queued: withoutAddress.invite.emailQueued, skipped: withoutAddress.invite.emailSkipped, to: withoutAddress.invite.emailTo },
    { queued: false, skipped: "no_address", to: null },
  );
  assert.equal(spy.calls.length, 0);
  assert.ok(String(withoutAddress.invite.inviteUrl).includes("/invite/"));

  // A username that is an address is an address.
  const asUsername = await createUserVia(api, { username: `carla${Date.now()}@example.com`, displayName: "Carla", isAdmin: false, grants: [] }) as
    unknown as { invite: Record<string, unknown> };
  assert.equal(asUsername.invite.emailQueued, true);
  assert.match(String(asUsername.invite.emailTo), /@example\.com$/);

  spy.answer({ status: "skipped", reason: "disabled" });
  const disabled = await createUserVia(api, { username: `dora${Date.now()}@example.com`, displayName: "Dora", isAdmin: false, grants: [] }) as
    unknown as { invite: Record<string, unknown> };
  assert.equal(disabled.invite.emailQueued, false);
  assert.equal(disabled.invite.emailSkipped, "disabled");
  assert.match(String(disabled.invite.emailTo), /@example\.com$/);

  spy.throwNext();
  const broken = await createUserVia(api, { username: `elias${Date.now()}@example.com`, displayName: "Elias", isAdmin: false, grants: [] }) as
    unknown as { user: { id: string }; invite: Record<string, unknown> };
  assert.equal(broken.invite.emailQueued, false);
  assert.equal(broken.invite.emailSkipped, "error");
  assert.ok(String(broken.invite.inviteUrl).includes("/invite/"));
  assert.ok(listUsers(getDb()).some((user) => user.id === broken.user.id));
});

test("a reset queues its own message, to the user, in the user's language", async () => {
  const spy = spyPort();
  const api = usersApiWith(spy.port);
  const user = createUser({
    username: `frida${Date.now()}`, displayName: "Frida", email: "frida@example.com", isAdmin: false,
  }, getDb());
  updateUser(user.id, { locale: "fr" }, getDb());

  const response = await api.request(`/users/${user.id}/reset`, { method: "POST" });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.emailQueued, true);
  assert.equal(body.emailTo, "frida@example.com");
  assert.equal(body.emailSkipped, null);

  assert.equal(spy.calls.length, 1);
  const queued = spy.calls[0]!;
  assert.equal(queued.event, "account.reset");
  assert.equal(queued.userId, user.id);
  assert.equal(queued.locale, "fr");
  assert.equal(queued.dedupeKey, `account.${user.id}.reset.${body.expiresAt}`);
  assert.ok(String(body.inviteUrl).endsWith((queued.data as { resetToken: string }).resetToken));
});
