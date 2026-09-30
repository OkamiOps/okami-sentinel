import assert from "node:assert/strict";
import test from "node:test";
import { USER_LOCALES, type UserLocale } from "@csb/shared";
import {
  EMAIL_MESSAGE_KINDS,
  emailMessageGroup,
  escapeHtml,
  formatMoment,
  renderEmail,
  type EmailMessageDataMap,
  type EmailMessageKind,
} from "./templates.js";

const AT = new Date("2026-09-30T14:05:09.000Z");
const ORIGIN = "https://sentinel.okami.example";

/** One sample per kind, so a new kind cannot be added without a fixture. */
const SAMPLES: { [K in EmailMessageKind]: EmailMessageDataMap[K] } = {
  "account.test": { to: "ana@example.com", at: AT },
  "account.invite": {
    inviterName: "Marcos", inviteToken: "Tk0000000000000000000000000000000000000000x",
    expiresAt: new Date("2026-10-03T14:05:09.000Z"),
  },
  "account.reset": {
    resetToken: "Rs0000000000000000000000000000000000000000y",
    expiresAt: new Date("2026-10-03T14:05:09.000Z"),
  },
  "account.new_login": { at: AT, ip: "203.0.113.7", browser: "Firefox · macOS" },
  "account.locked": { at: AT, retryAfterSeconds: 900 },
  "account.password_changed": { at: AT },
};

function render(kind: EmailMessageKind, locale: UserLocale, origin: string | null = ORIGIN) {
  return renderEmail({ kind, data: SAMPLES[kind], locale, origin } as never);
}

test("every kind renders a subject, an HTML body and a text twin in all five locales", () => {
  assert.deepEqual(EMAIL_MESSAGE_KINDS.sort(), Object.keys(SAMPLES).sort());
  for (const kind of EMAIL_MESSAGE_KINDS) {
    const subjects = new Set<string>();
    for (const locale of USER_LOCALES) {
      const message = render(kind, locale);
      assert.ok(message.subject.length > 0, `${kind}/${locale} subject`);
      assert.ok(message.text.trim().length > 0, `${kind}/${locale} text`);
      assert.ok(message.html.startsWith("<!doctype html>"), `${kind}/${locale} html`);
      assert.ok(message.html.includes(`lang="${locale}"`));
      // The brand and the reason are the two things every message carries.
      assert.ok(message.html.includes("Okami Sentinel"));
      assert.ok(message.text.includes("Okami Sentinel"));
      subjects.add(message.subject);
    }
    // Five languages, five distinct subjects: a missing translation would
    // silently reuse another locale's copy.
    assert.equal(subjects.size, USER_LOCALES.length, `${kind} subjects are not all translated`);
  }
});

test("the HTML is what a mail client can render: tables, inline styles, no external anything", () => {
  for (const kind of EMAIL_MESSAGE_KINDS) {
    const { html } = render(kind, "en");
    assert.ok(html.includes("<table role=\"presentation\""));
    assert.ok(html.includes("style=\""));
    for (const forbidden of ["<script", "<style", "<link", "@import", "javascript:", " src=", "<img"]) {
      assert.equal(html.includes(forbidden), false, `${kind} html contains ${forbidden}`);
    }
    // Every link is absolute; a relative href is dead in an inbox.
    for (const href of html.matchAll(/href="([^"]*)"/g)) {
      assert.ok(href[1]!.startsWith("https://"), `${kind} href ${href[1]}`);
    }
  }
});

test("every interpolated value is escaped, in the body and in the link", () => {
  const message = renderEmail({
    kind: "account.invite",
    data: {
      inviterName: "<script>alert(\"x\")</script> & \"Ana\"",
      inviteToken: "a\"b<c&d",
      expiresAt: AT,
    },
    locale: "pt-BR",
    origin: ORIGIN,
  });
  assert.equal(message.html.includes("<script>"), false);
  assert.equal(message.html.includes("alert(\"x\")"), false);
  assert.ok(message.html.includes("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &quot;Ana&quot;"));
  // The href is a quoted attribute: a quote inside it must arrive as an entity,
  // or it would close the attribute and everything after it becomes markup.
  assert.ok(message.html.includes(`href="${ORIGIN}/invite/a&quot;b&lt;c&amp;d"`));
  // The text twin is never escaped, because nothing parses it as markup.
  assert.ok(message.text.includes("<script>alert(\"x\")</script> & \"Ana\""));
  assert.equal(escapeHtml("<a>&'\""), "&lt;a&gt;&amp;&#39;&quot;");
});

test("account messages footer points at Minha conta and explains why they arrived", () => {
  for (const kind of EMAIL_MESSAGE_KINDS) {
    assert.equal(emailMessageGroup(kind), "account");
    const message = render(kind, "pt-BR");
    assert.ok(message.html.includes(`href="${ORIGIN}/settings/account"`), kind);
    assert.ok(message.text.includes(`Minha conta: ${ORIGIN}/settings/account`), kind);
    assert.ok(message.html.includes("Por que você recebeu isto"), kind);
    assert.ok(/Você recebeu esta mensagem porque/.test(message.text), kind);
    // Account messages are never subscription-driven, so the footer must not
    // send the reader to a matrix that cannot switch them off.
    assert.equal(message.html.includes("#notifications"), false, kind);
  }
});

test("without a public origin nothing links, the footer says so, and no token leaks", () => {
  for (const kind of EMAIL_MESSAGE_KINDS) {
    const message = render(kind, "pt-BR", null);
    assert.equal(message.html.includes("href="), false, kind);
    assert.equal(message.text.includes("http"), false, kind);
    assert.ok(message.html.includes("não tem endereço público configurado"), kind);
    assert.ok(message.text.includes("não tem endereço público configurado"), kind);
  }
  const invite = render("account.invite", "pt-BR", null);
  assert.equal(invite.html.includes(SAMPLES["account.invite"].inviteToken), false);
  assert.equal(invite.text.includes(SAMPLES["account.invite"].inviteToken), false);
  const reset = render("account.reset", "en", null);
  assert.equal(reset.text.includes(SAMPLES["account.reset"].resetToken), false);
});

test("the invite and the reset carry their single-use link and their expiry", () => {
  const invite = render("account.invite", "pt-BR");
  assert.ok(invite.html.includes(`href="${ORIGIN}/invite/${SAMPLES["account.invite"].inviteToken}"`));
  assert.ok(invite.text.includes(`${ORIGIN}/invite/${SAMPLES["account.invite"].inviteToken}`));
  assert.ok(invite.text.includes("O convite expira em: 2026-10-03 14:05:09 UTC"));
  assert.ok(invite.text.includes("Marcos criou uma conta para você"));

  const anonymous = renderEmail({
    kind: "account.invite",
    data: { ...SAMPLES["account.invite"], inviterName: null },
    locale: "pt-BR", origin: ORIGIN,
  });
  assert.ok(anonymous.text.includes("Um administrador criou uma conta para você"));

  const reset = render("account.reset", "de");
  assert.ok(reset.text.includes(`${ORIGIN}/invite/${SAMPLES["account.reset"].resetToken}`));
  assert.ok(reset.subject.includes("Passwort"));
});

test("the security alerts name the time, the address and the browser, and say when either is missing", () => {
  const known = render("account.new_login", "en");
  assert.ok(known.text.includes("Time: 2026-09-30 14:05:09 UTC"));
  assert.ok(known.text.includes("IP address: 203.0.113.7"));
  assert.ok(known.text.includes("Browser: Firefox · macOS"));

  const unknown = renderEmail({
    kind: "account.new_login", data: { at: AT, ip: null, browser: null },
    locale: "en", origin: ORIGIN,
  });
  assert.ok(unknown.text.includes("IP address: not recorded"));
  assert.ok(unknown.text.includes("Browser: not recorded"));

  assert.ok(render("account.locked", "pt-BR").text.includes("Nova tentativa em: 15 minutos"));
  assert.ok(renderEmail({
    kind: "account.locked", data: { at: AT, retryAfterSeconds: 30 }, locale: "en", origin: null,
  }).text.includes("Try again in: 1 minute"));

  assert.ok(render("account.password_changed", "fr").text.includes("Heure: 2026-09-30 14:05:09 UTC"));
});

test("a timestamp reads the same in every language", () => {
  assert.equal(formatMoment(AT), "2026-09-30 14:05:09 UTC");
  const stamps = USER_LOCALES.map((locale) =>
    render("account.password_changed", locale).text.split("\n").find((line) => line.includes("2026-09-30")));
  assert.equal(new Set(stamps.map((line) => line?.split(": ")[1])).size, 1);
});
