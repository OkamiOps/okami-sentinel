import assert from "node:assert/strict";
import test from "node:test";
import {
  ACCOUNT_NOTIFICATION_EVENTS,
  EMAIL_PROVIDER_PRESETS,
  OPS_NOTIFICATION_EVENTS,
  REPOSITORY_NOTIFICATION_EVENTS,
  type EmailErrorCode,
  type EmailOutboxStatus,
} from "@csb/shared";
import { translate, type Locale } from "../i18n";
import { accessMessages } from "../i18n/access";
import { emailMessages } from "../i18n/email";
import { translateScoped } from "../i18n/scoped";
import { describeEmailEvent, emailEventLabel } from "./email-events";
import { EMAIL_ERROR_CODES } from "./email-settings-form";

const LOCALES: readonly Locale[] = ["pt-BR", "en", "es", "de", "fr"];
const placeholders = (message: string) => [...new Set(message.match(/\{\w+\}/g) ?? [])].sort();

for (const [name, messages] of Object.entries({ email: emailMessages, access: accessMessages })) {
  test(`${name} translations cover all five languages and preserve dynamic fields`, () => {
    const source = messages["pt-BR"] as Record<string, string>;
    assert.deepEqual(Object.keys(messages).sort(), ["de", "en", "es", "fr", "pt-BR"]);
    for (const [locale, dictionary] of Object.entries(messages)) {
      const entries = dictionary as Record<string, string>;
      assert.deepEqual(Object.keys(entries).sort(), Object.keys(source).sort(), locale);
      for (const [key, text] of Object.entries(entries)) {
        assert.ok(text.trim(), `${locale}: ${key} must not be empty`);
        assert.deepEqual(placeholders(text), placeholders(source[key]), `${locale}: ${key}`);
        if (locale !== "pt-BR" && key.startsWith("email.error.")) {
          assert.notEqual(text, source[key], `${locale}: ${key} was never translated`);
        }
      }
    }
  });
}

test("every code the e-mail screens can receive has a sentence in every language", () => {
  const statuses: readonly EmailOutboxStatus[] = ["queued", "sending", "sent", "failed", "cancelled"];
  const failures: readonly EmailErrorCode[] = [
    "not_configured", "auth_rejected", "tls_failed", "connection_refused", "connection_timeout",
    "sender_not_verified", "recipient_rejected", "message_rejected", "rate_limited", "provider_unavailable",
  ];
  const dictionary = emailMessages["pt-BR"] as Record<string, string>;
  for (const code of EMAIL_ERROR_CODES) assert.ok(`email.error.${code}` in dictionary, code);
  for (const code of failures) assert.ok(`email.code.${code}` in dictionary, code);
  for (const status of statuses) assert.ok(`email.status.${status}` in dictionary, status);
  for (const preset of EMAIL_PROVIDER_PRESETS) assert.ok(`email.preset.${preset.id}` in dictionary, preset.id);
  for (const hint of ["api-key", "app-password", "password"]) assert.ok(`email.secret.${hint}` in dictionary, hint);
  for (const hint of ["fixed", "mailbox", "unknown"]) assert.ok(`email.usernameHint.${hint}` in dictionary, hint);
  for (const security of ["tls", "starttls", "none"]) assert.ok(`email.security.${security}` in dictionary, security);
});

test("every notification event is named, in all five languages, once", () => {
  const events = [...REPOSITORY_NOTIFICATION_EVENTS, ...OPS_NOTIFICATION_EVENTS, ...ACCOUNT_NOTIFICATION_EVENTS];
  for (const locale of LOCALES) {
    const seen = new Map<string, string>();
    for (const event of events) {
      const label = translateScoped(emailMessages, locale, `notifications.event.${event}` as never);
      assert.ok(label.trim(), `${locale}: ${event}`);
      assert.equal(label.includes("notifications.event."), false, `${locale}: ${event} fell through`);
      // Two events sharing one label would make the matrix unreadable.
      assert.equal(seen.has(label), false, `${locale}: ${event} repeats ${seen.get(label)}`);
      seen.set(label, event);
    }
  }
});

test("a resolved operational alert is named as the same event, resolved", () => {
  assert.deepEqual(describeEmailEvent("ops.engine_unavailable.resolved"), {
    key: "notifications.event.ops.engine_unavailable", resolved: true, raw: "ops.engine_unavailable.resolved",
  });
  assert.deepEqual(describeEmailEvent("account.test"), { key: "email.event.account.test", resolved: false, raw: "account.test" });
  assert.deepEqual(describeEmailEvent("something.new"), { key: null, resolved: false, raw: "something.new" });
  for (const locale of LOCALES) {
    const t = (key: string) => translateScoped(emailMessages, locale, key as never);
    const base = emailEventLabel("ops.engine_unavailable", t);
    const resolved = emailEventLabel("ops.engine_unavailable.resolved", t);
    assert.ok(resolved.startsWith(base));
    assert.notEqual(resolved, base);
    // An id this build has never heard of is printed, not hidden.
    assert.equal(emailEventLabel("something.new", t), "something.new");
  }
});

test("the e-mail catalogue still falls back to the shared translations", () => {
  for (const locale of LOCALES) {
    assert.equal(translateScoped(emailMessages, locale, "common.retry"), translate(locale, "common.retry"));
    assert.equal(translateScoped(accessMessages, locale, "common.retry"), translate(locale, "common.retry"));
  }
});

test("the settings tab bar names the e-mail section in every language", () => {
  for (const locale of LOCALES) {
    const label = translate(locale, "settings.emailSection");
    assert.ok(label.trim());
  }
  assert.equal(translate("pt-BR", "settings.emailSection"), "E-mail");
  assert.equal(translate("es", "settings.emailSection"), "Correo");
  assert.equal(translate("de", "settings.emailSection"), "E-Mail");
});
