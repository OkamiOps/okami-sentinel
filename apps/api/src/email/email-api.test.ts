import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { EmailDeliveriesResponse, EmailSettingsResponse, EmailTestResult } from "@csb/shared";
import { authorize } from "../auth/route-policy.js";
import { LOCAL_PRINCIPAL, type Principal } from "../auth/principal.js";
import { createUser } from "../auth/user-store.js";
import type { EmailCredentialStore, EmailProviderSecret } from "../credentials/system-email-credential-store.js";
import { getDb } from "../db.js";
import { createEmailApi, parseEmailSettings, transportConfigFor } from "./email-api.js";
import { DEFAULT_EMAIL_SETTINGS, getEmailSettings } from "./settings-store.js";
import { emailTransportError, type EmailMessage, type EmailTransport, type EmailTransportConfig } from "./transport.js";

class MemorySecrets implements EmailCredentialStore {
  readonly values = new Map<string, string>();
  failWrites = false;

  async put(ref: string, value: EmailProviderSecret) {
    if (this.failWrites) throw new Error("vault down");
    this.values.set(ref, value.secret);
  }

  async get(ref: string) {
    const secret = this.values.get(ref);
    return secret === undefined ? null : { secret };
  }

  async delete(ref: string) {
    this.values.delete(ref);
  }
}

interface Harness {
  app: Hono;
  secrets: MemorySecrets;
  sent: Array<{ config: EmailTransportConfig; message: EmailMessage }>;
  failNextSend: (code: "auth_rejected" | "sender_not_verified" | "rate_limited" | null) => void;
  admin: Principal;
}

function harness(overrides: { principal?: Partial<Principal>; publicOrigin?: string | null } = {}): Harness {
  const secrets = new MemorySecrets();
  const sent: Array<{ config: EmailTransportConfig; message: EmailMessage }> = [];
  let failure: "auth_rejected" | "sender_not_verified" | "rate_limited" | null = null;
  const admin: Principal = { ...LOCAL_PRINCIPAL, kind: "user", isAdmin: true, ...overrides.principal };

  const transport = (config: EmailTransportConfig): EmailTransport => ({
    async send(message) {
      if (failure !== null) throw emailTransportError(failure, "provider said no");
      sent.push({ config, message });
      return { providerMessageId: "provider-id-1" };
    },
  });

  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("principal" as never, admin as never);
    await next();
  });
  app.route("/", createEmailApi({
    secrets,
    transport,
    publicOrigin: overrides.publicOrigin === undefined ? "https://sentinel.example" : overrides.publicOrigin,
  }));
  return { app, secrets, sent, failNextSend: (code) => { failure = code; }, admin };
}

function resetSettings(): void {
  getDb().prepare("DELETE FROM email_settings").run();
  getDb().prepare("DELETE FROM email_outbox").run();
}

const completeSmtp = {
  provider: "smtp", enabled: true, fromName: "Okami Sentinel",
  fromAddress: "sentinel@okami.example", smtpHost: "smtp.resend.com", smtpPort: 465,
  smtpSecurity: "tls", smtpUsername: "resend", secret: "re_live_key",
};

test("an unconfigured installation reports the defaults and the preset table", async () => {
  resetSettings();
  const { app } = harness();
  const response = await app.request("/email/settings");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const body = await response.json() as EmailSettingsResponse;
  assert.deepEqual(body.settings, {
    provider: "smtp", enabled: false, fromName: DEFAULT_EMAIL_SETTINGS.fromName,
    fromAddress: null, replyTo: null, smtpHost: null, smtpPort: null,
    smtpSecurity: "tls", smtpUsername: null, secretConfigured: false,
    updatedAt: null, updatedBy: null,
  });
  assert.equal(body.presets.length, 7);
  assert.equal(body.publicOrigin, "https://sentinel.example");
});

test("the secret is stored in the vault and never returned by any route", async () => {
  resetSettings();
  const { app, secrets } = harness();
  const saved = await app.request("/email/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(completeSmtp),
  });
  assert.equal(saved.status, 200);
  const body = await saved.json() as EmailSettingsResponse;
  assert.equal(body.settings.secretConfigured, true);
  assert.equal(body.settings.enabled, true);
  assert.equal(body.settings.smtpHost, "smtp.resend.com");

  // Neither the save response nor a later read mentions the value or its slot.
  for (const payload of [JSON.stringify(body), await (await harness().app.request("/email/settings")).text()]) {
    assert.ok(!payload.includes("re_live_key"), payload);
    assert.ok(!payload.includes("secretRef"), payload);
    assert.ok(!payload.includes("secret_ref"), payload);
  }
  assert.deepEqual([...secrets.values.values()], ["re_live_key"]);
  assert.match(getEmailSettings().secretRef ?? "", /^email-/);
});

test("omitting the secret keeps it, a new value replaces it, and null clears it", async () => {
  resetSettings();
  const { app, secrets } = harness();
  const put = (payload: unknown) => app.request("/email/settings", {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });

  await put(completeSmtp);
  const firstRef = getEmailSettings().secretRef;

  // No `secret` key at all: the stored one survives an unrelated edit.
  const kept = await put({ ...completeSmtp, secret: undefined, fromName: "Sentinel Ops" });
  assert.equal(((await kept.json()) as EmailSettingsResponse).settings.secretConfigured, true);
  assert.equal(getEmailSettings().secretRef, firstRef);
  assert.deepEqual([...secrets.values.values()], ["re_live_key"]);

  // A new value replaces it and the superseded slot is emptied.
  await put({ ...completeSmtp, secret: "re_live_rotated" });
  const secondRef = getEmailSettings().secretRef;
  assert.notEqual(secondRef, firstRef);
  assert.deepEqual([...secrets.values.values()], ["re_live_rotated"]);

  // An explicit clear removes the secret, which also forces `enabled` off.
  const cleared = await put({ ...completeSmtp, enabled: false, secret: null });
  assert.equal(cleared.status, 200);
  assert.equal(((await cleared.json()) as EmailSettingsResponse).settings.secretConfigured, false);
  assert.equal(getEmailSettings().secretRef, null);
  assert.equal(secrets.values.size, 0);
});

test("a vault that cannot be written leaves the previous configuration intact", async () => {
  resetSettings();
  const { app, secrets } = harness();
  await app.request("/email/settings", {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(completeSmtp),
  });
  const before = getEmailSettings();
  secrets.failWrites = true;
  const response = await app.request("/email/settings", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...completeSmtp, smtpHost: "smtp.zoho.com", secret: "new" }),
  });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "secret_storage_unavailable" });
  assert.deepEqual(getEmailSettings(), before);
  assert.deepEqual([...secrets.values.values()], ["re_live_key"]);
});

test("every field is validated, and enabling requires a complete configuration", async () => {
  resetSettings();
  const { app } = harness();
  const put = async (payload: unknown) => {
    const response = await app.request("/email/settings", {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    return { status: response.status, body: await response.json() as { error?: string } };
  };

  const cases: Array<[Record<string, unknown>, string]> = [
    [{ provider: "sendgrid" }, "provider_invalid"],
    [{ enabled: "yes" }, "enabled_invalid"],
    [{ fromAddress: "not-an-address" }, "from_address_invalid"],
    [{ fromAddress: "ana@example.com\r\nBcc: eve@example.com" }, "from_address_invalid"],
    [{ replyTo: "nope" }, "reply_to_invalid"],
    [{ smtpHost: "not a host" }, "smtp_host_invalid"],
    [{ smtpHost: "smtp.example.com/../evil" }, "smtp_host_invalid"],
    [{ smtpPort: 0 }, "smtp_port_invalid"],
    [{ smtpPort: 65_536 }, "smtp_port_invalid"],
    [{ smtpPort: 465.5 }, "smtp_port_invalid"],
    [{ smtpPort: "465" }, "smtp_port_invalid"],
    [{ smtpSecurity: "ssl" }, "smtp_security_invalid"],
    [{ smtpUsername: "user\u0000name" }, "smtp_username_invalid"],
    [{ secret: 42 }, "secret_invalid"],
    [{ secret: "line\nbreak" }, "secret_invalid"],
    // Turning the switch on is only possible with an address and a secret.
    [{ enabled: true }, "from_address_required"],
    [{ enabled: true, fromAddress: "sentinel@okami.example" }, "secret_required"],
    [{ enabled: true, fromAddress: "sentinel@okami.example", secret: "k" }, "smtp_host_required"],
    [{ enabled: true, fromAddress: "sentinel@okami.example", secret: "k", smtpHost: "smtp.example.com" }, "smtp_port_required"],
  ];
  for (const [payload, error] of cases) {
    const result = await put(payload);
    assert.equal(result.status, 400, JSON.stringify(payload));
    assert.deepEqual(result.body, { error }, JSON.stringify(payload));
  }
  // Nothing was written by any rejected request.
  assert.deepEqual(getEmailSettings(), { ...DEFAULT_EMAIL_SETTINGS });

  // The ports at both ends of the allowed range are accepted.
  for (const port of [1, 65_535]) {
    const ok = await put({ ...completeSmtp, smtpPort: port });
    assert.equal(ok.status, 200, String(port));
  }
});

test("Resend needs no host, and a saved Resend configuration keeps its own fields", async () => {
  resetSettings();
  const { app } = harness();
  const response = await app.request("/email/settings", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: "resend", enabled: true, fromName: "Okami Sentinel",
      fromAddress: "sentinel@okami.example", secret: "re_live_api_key",
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.json() as EmailSettingsResponse;
  assert.equal(body.settings.provider, "resend");
  assert.equal(body.settings.enabled, true);
  assert.equal(body.settings.smtpHost, null);
  assert.equal(body.settings.secretConfigured, true);
});

test("the test send goes to the administrator's resolved address and lands in the history", async () => {
  resetSettings();
  const stamp = Date.now();
  const user = createUser(
    { username: `emailadmin${stamp}`, displayName: "Ana", email: "ana@example.com", isAdmin: true },
    getDb(),
  );
  const { app, sent } = harness({ principal: { userId: user.id, username: user.username } });
  await app.request("/email/settings", {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(completeSmtp),
  });

  const response = await app.request("/email/test", { method: "POST" });
  assert.equal(response.status, 200);
  const result = await response.json() as EmailTestResult;
  assert.deepEqual(result, {
    ok: true, to: "ana@example.com", code: null, message: null, providerMessageId: "provider-id-1",
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.message.to, "ana@example.com");
  assert.equal(sent[0]!.config.secret, "re_live_key");
  assert.equal(sent[0]!.config.smtp?.host, "smtp.resend.com");
  assert.ok(sent[0]!.message.subject.length > 0);
  assert.ok(sent[0]!.message.html.includes("Okami Sentinel"));
  assert.ok(sent[0]!.message.text.length > 0);
  // The idempotency key is the outbox row, so a retry cannot become a second e-mail.
  assert.match(sent[0]!.message.idempotencyKey, /^out_/);

  const history = await (await app.request("/email/deliveries")).json() as EmailDeliveriesResponse;
  assert.equal(history.deliveries.length, 1);
  assert.deepEqual(
    { ...history.deliveries[0], id: "…", createdAt: "…", sentAt: "…" },
    {
      id: "…", event: "account.test", toAddress: "ana@example.com", locale: "pt-BR",
      subject: history.deliveries[0]!.subject, status: "sent", attempts: 0,
      nextAttemptAt: null, lastError: null, providerMessageId: "provider-id-1",
      createdAt: "…", sentAt: "…",
    },
  );
  // The rendered bodies stay out of the history payload.
  const raw = JSON.stringify(history);
  assert.ok(!raw.includes("<!doctype html"), raw.slice(0, 200));
  assert.ok(!raw.includes("\"html\""));
  assert.ok(!raw.includes("\"text\""));
});

test("a provider failure is reported verbatim and recorded against the message", async () => {
  resetSettings();
  const stamp = Date.now();
  const user = createUser(
    { username: `emailfail${stamp}`, displayName: "Bob", email: "bob@example.com", isAdmin: true },
    getDb(),
  );
  const { app, failNextSend } = harness({ principal: { userId: user.id, username: user.username } });
  await app.request("/email/settings", {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(completeSmtp),
  });
  failNextSend("auth_rejected");

  const result = await (await app.request("/email/test", { method: "POST" })).json() as EmailTestResult;
  assert.equal(result.ok, false);
  assert.equal(result.to, "bob@example.com");
  assert.equal(result.code, "auth_rejected");
  assert.match(result.message ?? "", /rejected the credentials.*provider said no/);
  assert.equal(result.providerMessageId, null);

  const history = await (await app.request("/email/deliveries")).json() as EmailDeliveriesResponse;
  assert.equal(history.deliveries[0]!.status, "failed");
  assert.equal(history.deliveries[0]!.attempts, 1);
  assert.match(history.deliveries[0]!.lastError ?? "", /rejected the credentials/);
});

test("an administrator with no usable address is told so before anything is sent", async () => {
  resetSettings();
  const stamp = Date.now();
  const user = createUser(
    { username: `emailnoaddr${stamp}`, displayName: "Cid", isAdmin: true },
    getDb(),
  );
  const { app, sent } = harness({ principal: { userId: user.id, username: user.username } });
  await app.request("/email/settings", {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(completeSmtp),
  });

  const response = await app.request("/email/test", { method: "POST" });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "no_recipient_address" });
  assert.equal(sent.length, 0);
});

test("a test send without a configured provider is refused, not attempted", async () => {
  resetSettings();
  const stamp = Date.now();
  const user = createUser(
    { username: `emailunconf${stamp}`, displayName: "Dee", email: "dee@example.com", isAdmin: true },
    getDb(),
  );
  const { app, sent } = harness({ principal: { userId: user.id, username: user.username } });
  const response = await app.request("/email/test", { method: "POST" });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "email_not_configured" });
  assert.equal(sent.length, 0);
});

test("the username is the fallback destination and the stored locale picks the language", async () => {
  resetSettings();
  const stamp = Date.now();
  const user = createUser(
    { username: `email.fr${stamp}@corp.example`, displayName: "Eve", isAdmin: true },
    getDb(),
  );
  getDb().prepare("UPDATE users SET locale = 'fr' WHERE id = ?").run(user.id);
  const { app, sent } = harness({ principal: { userId: user.id, username: user.username } });
  await app.request("/email/settings", {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(completeSmtp),
  });

  const result = await (await app.request("/email/test", { method: "POST" })).json() as EmailTestResult;
  assert.equal(result.ok, true);
  assert.equal(result.to, user.username);
  assert.match(sent[0]!.message.subject, /e-mail de test/);
  assert.ok(sent[0]!.message.html.includes('lang="fr"'));
});

test("with no public origin the test message carries no link", async () => {
  resetSettings();
  const stamp = Date.now();
  const user = createUser(
    { username: `emaillocal${stamp}`, displayName: "Fay", email: "fay@example.com", isAdmin: true },
    getDb(),
  );
  const { app, sent } = harness({
    principal: { userId: user.id, username: user.username }, publicOrigin: null,
  });
  await app.request("/email/settings", {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(completeSmtp),
  });
  await app.request("/email/test", { method: "POST" });
  assert.ok(!sent[0]!.message.html.includes("<a href"), sent[0]!.message.html);
  assert.ok(!sent[0]!.message.text.includes("http"));
});

test("the history is newest first and never longer than 200 rows", async () => {
  resetSettings();
  const insert = getDb().prepare(`INSERT INTO email_outbox
    (id, event, dedupe_key, to_address, locale, subject, html, text, status, attempts, created_at)
    VALUES (?, 'gate.blocked', ?, 'ana@example.com', 'pt-BR', 'Gate', '<p>x</p>', 'x', 'queued', 0, ?)`);
  getDb().transaction(() => {
    for (let index = 0; index < 205; index += 1) {
      insert.run(`hist-${index}`, `gate.h${index}.gate.blocked`, `2026-09-${String((index % 28) + 1).padStart(2, "0")}T00:00:0${index % 10}.000Z`);
    }
  })();

  const { app } = harness();
  const history = await (await app.request("/email/deliveries")).json() as EmailDeliveriesResponse;
  assert.equal(history.deliveries.length, 200);
  const dates = history.deliveries.map((entry) => entry.createdAt);
  assert.deepEqual([...dates].sort().reverse(), dates);
});

test("a member reaches none of the e-mail routes", async () => {
  const member: Principal = { ...LOCAL_PRINCIPAL, kind: "user", userId: "member-1", isAdmin: false };
  const probe = new Hono();
  probe.use("*", async (c, next) => {
    c.set("principal" as never, member as never);
    await next();
  });
  probe.use("*", authorize());
  probe.route("/", createEmailApi({ secrets: new MemorySecrets(), publicOrigin: null }));

  for (const [method, path] of [
    ["GET", "/email/settings"], ["PUT", "/email/settings"],
    ["POST", "/email/test"], ["GET", "/email/deliveries"],
  ] as const) {
    const response = await probe.request(path, {
      method, headers: { "Content-Type": "application/json" },
      body: method === "GET" ? undefined : "{}",
    });
    assert.equal(response.status, 403, `${method} ${path}`);
    assert.deepEqual(await response.json(), { error: "forbidden" }, `${method} ${path}`);
  }
});

test("the sub-app refuses a member even with the policy middleware absent", async () => {
  const member: Principal = { ...LOCAL_PRINCIPAL, kind: "user", userId: "member-2", isAdmin: false };
  const probe = new Hono();
  probe.use("*", async (c, next) => {
    c.set("principal" as never, member as never);
    await next();
  });
  probe.route("/", createEmailApi({ secrets: new MemorySecrets(), publicOrigin: null }));
  const response = await probe.request("/email/settings");
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "forbidden" });
});

test("the parser and the transport builder agree on what counts as complete", () => {
  const current = { ...DEFAULT_EMAIL_SETTINGS };
  const parsed = parseEmailSettings({ ...completeSmtp }, current);
  assert.equal(parsed.ok, true);
  assert.ok(parsed.ok && parsed.parsed.secret.kind === "replace");

  // A record without a secret, a sender or an SMTP endpoint cannot be sent with.
  assert.equal(transportConfigFor({ ...current, fromAddress: "a@b.io" }, null), null);
  assert.equal(transportConfigFor({ ...current, fromAddress: null }, "k"), null);
  assert.equal(transportConfigFor({ ...current, fromAddress: "a@b.io", smtpHost: "smtp.b.io" }, "k"), null);
  assert.deepEqual(
    transportConfigFor({ ...current, provider: "resend", fromAddress: "a@b.io" }, "k"),
    { provider: "resend", fromName: current.fromName, fromAddress: "a@b.io", replyTo: null, smtp: null, secret: "k" },
  );
});
