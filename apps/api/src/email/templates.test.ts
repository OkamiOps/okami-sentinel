import assert from "node:assert/strict";
import test from "node:test";
import { USER_LOCALES, type UserLocale } from "@csb/shared";
import {
  EMAIL_MESSAGE_KINDS,
  emailMessageGroup,
  emailMessageStatus,
  emailStatusTone,
  escapeHtml,
  formatMoment,
  renderEmail,
  toAsciiEntities,
  type EmailMessageDataMap,
  type EmailMessageKind,
} from "./templates.js";

/** The inverse of `toAsciiEntities`, for tests that check the round trip. */
function decodeAsciiEntities(value: string): string {
  return value.replace(/&#(\d+);/g, (_match, codePoint: string) => String.fromCodePoint(Number(codePoint)));
}

const AT = new Date("2026-09-30T14:05:09.000Z");
const LATER = new Date("2026-09-30T18:45:09.000Z");
const SEVERITY = { critical: 1, high: 2, medium: 3, low: 4, info: 5, unknown: 0, total: 15 };
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
  "gate.blocked": {
    gateId: "gate-1", repository: "okami/sentinel", branch: "feature/login", pullRequest: 42,
    outcome: "blocked", severity: SEVERITY, costUsd: 0.42, durationMs: 247_000,
  },
  "gate.error": {
    gateId: "gate-2", repository: "okami/sentinel", branch: "main", pullRequest: null,
    outcome: "error", severity: null, costUsd: null, durationMs: 12_000,
  },
  "gate.passed": {
    gateId: "gate-3", repository: "okami/sentinel", branch: "feature/login", pullRequest: 43,
    outcome: "warning", severity: SEVERITY, costUsd: 0.004, durationMs: 3_900_000,
  },
  "scan.failed": {
    scanId: "s-1", repository: "okami/sentinel", branch: "main", status: "failed",
    severity: null, costUsd: null, durationMs: null,
  },
  "scan.completed": {
    scanId: "s-2", repository: "okami/sentinel", branch: "main", status: "completed",
    severity: SEVERITY, costUsd: 1.5, durationMs: 61_000,
  },
  "ops.engine_unavailable": { since: AT, at: LATER, engines: ["codex-security", "mantis"] },
  "ops.engine_unavailable.resolved": { since: AT, at: LATER },
  "ops.connection_attention": {
    connectionName: "OpenRouter principal", status: "degraded", since: AT, at: LATER,
  },
  "ops.connection_attention.resolved": { connectionName: "OpenRouter principal", since: AT, at: LATER },
  "ops.daily_cost": {
    repository: "okami/sentinel", day: "2026-09-30", percent: 80,
    reservedUsd: 8, ceilingUsd: 10,
  },
  "ops.github_publish_failed": {
    gateId: "gate-4", repository: "okami/sentinel", branch: "main",
    reason: "github_check_publish_failed", at: AT,
  },
  "ops.github_publish_failed.resolved": {
    gateId: "gate-4", repository: "okami/sentinel", since: AT, at: LATER,
  },
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
    for (const forbidden of ["<script", "<link", "@import", "javascript:", "url("]) {
      assert.equal(html.includes(forbidden), false, `${kind} html contains ${forbidden}`);
    }
    // One stylesheet, in the head, carrying only what no inline style can
    // express: the phone widths. The design is dark-native — there is no light
    // scheme to switch to — so nothing in the head switches schemes, and a
    // client that drops the stylesheet still gets the whole dark message,
    // because every element is styled inline and every surface has a bgcolor.
    assert.equal(html.split("<style>").length - 1, 1, `${kind} stylesheet count`);
    assert.equal(html.includes("prefers-color-scheme"), false, kind);
    assert.ok(html.includes("@media only screen and (max-width:480px)"), kind);
    assert.ok(html.includes("name=\"color-scheme\" content=\"dark\""), kind);
    assert.ok(html.includes("name=\"supported-color-schemes\" content=\"dark\""), kind);
    assert.ok(/<body[^>]*bgcolor="#060609"/.test(html), kind);
    // The brand mark and the pre-dimmed watermark are the only network fetches.
    const sources = [...html.matchAll(/ src="([^"]*)"/g)].map((match) => match[1]);
    assert.deepEqual(sources, [
      `${ORIGIN}/brand/email-mark.png`,
      `${ORIGIN}/brand/email-wolf-watermark.png`,
    ], kind);
    // Every link is absolute; a relative href is dead in an inbox.
    for (const href of html.matchAll(/href="([^"]*)"/g)) {
      assert.ok(href[1]!.startsWith("https://"), `${kind} href ${href[1]}`);
    }
  }
});

test("every kind, in every locale, carries a status word, a header indicator and a preheader", () => {
  const tones = new Set(["danger", "success", "warning", "info", "neutral"]);
  for (const kind of EMAIL_MESSAGE_KINDS) {
    assert.ok(tones.has(emailStatusTone(emailMessageStatus(kind))), kind);
    for (const locale of USER_LOCALES) {
      const { html, text } = render(kind, locale);
      // The hero: the status word, mono, in the status colour, sized by its
      // own length so the longest localized word still fits a phone.
      const word = /<div class="sw (sw-[lmsx])" style="[^"]*color:(#[0-9a-f]{6})">([^<]+)<\/div>/.exec(html);
      assert.ok(word, `${kind}/${locale} status word`);
      const label = decodeAsciiEntities(word![3]!);
      assert.equal(label, label.toLocaleUpperCase(locale), `${kind}/${locale} status word is not upper-case`);
      // The header indicator claims exactly what the message itself is —
      // its status — never the readiness of an engine it did not measure.
      const indicator = /<td class="hs ind"[^>]*color:(#[0-9a-f]{6})">&#9679;&nbsp; ([^<]+)<\/td>/.exec(html);
      assert.ok(indicator, `${kind}/${locale} header indicator`);
      assert.equal(decodeAsciiEntities(indicator![2]!), label, `${kind}/${locale} indicator disagrees with the status word`);
      assert.equal(indicator![1], word![2], `${kind}/${locale} indicator colour disagrees with the status word`);
      // The status word and the plain-text twin never disagree.
      assert.equal(text.split("\n")[1], `[${label}]`, `${kind}/${locale} text status line`);
      // The hidden preview line a client shows next to the subject.
      const preheader = /<div style="display:none;max-height:0;overflow:hidden;mso-hide:all">([^<]+)<\/div>/.exec(html);
      assert.ok(preheader, `${kind}/${locale} preheader`);
      assert.ok(text.includes(decodeAsciiEntities(preheader[1]!)), `${kind}/${locale} preheader copy`);
    }
  }
});

test("the status word's colour comes from one table, and long localized words get a smaller size", () => {
  const accents: Array<[EmailMessageKind, string]> = [
    ["gate.blocked", "#ff39d1"],
    ["gate.error", "#f94144"],
    ["scan.completed", "#5fd37f"],
    ["ops.engine_unavailable", "#ff7527"],
    ["ops.engine_unavailable.resolved", "#5fd37f"],
    ["account.invite", "#00dfe8"],
    ["account.new_login", "#f3ba25"],
  ];
  for (const [kind, accent] of accents) {
    assert.ok(render(kind, "pt-BR").html.includes(`color:${accent}">`), `${kind} accent ${accent}`);
  }
  // German has the longest words; each lands in a smaller bucket instead of
  // overflowing a 375-pixel screen.
  assert.match(render("scan.failed", "de").html, /class="sw sw-m"/);          // FEHLGESCHLAGEN
  assert.match(render("account.reset", "de").html, /class="sw sw-x"/);        // PASSWORT ZURUECKSETZEN
  assert.match(render("gate.blocked", "pt-BR").html, /class="sw sw-l"/);      // BLOQUEADO
});

test("the header never claims an engine state the message did not measure", () => {
  for (const kind of EMAIL_MESSAGE_KINDS) {
    for (const locale of USER_LOCALES) {
      const { html } = render(kind, locale);
      for (const claim of ["MOTOR PRONTO", "ENGINE READY", "MOTOR LISTO", "ENGINE BEREIT", "MOTEUR PR"]) {
        assert.equal(html.includes(claim), false, `${kind}/${locale} claims ${claim}`);
      }
    }
  }
});

test("the eyebrow names a real module of the app, with the app's own number", () => {
  const decoded = (kind: EmailMessageKind, locale: "pt-BR" | "en" = "pt-BR") =>
    decodeAsciiEntities(render(kind, locale).html);
  assert.ok(decoded("gate.blocked").includes("03 / GUARDRAILS"));
  assert.ok(decoded("ops.github_publish_failed").includes("03 / GUARDRAILS"));
  assert.ok(decoded("scan.completed").includes("02 / RUNS"));
  assert.ok(decoded("ops.daily_cost").includes("04 / GITHUB"));
  assert.ok(decoded("ops.engine_unavailable").includes("08.02 / CONEXÕES"));
  assert.ok(decoded("ops.connection_attention", "en").includes("08.02 / CONNECTIONS"));
  assert.ok(decoded("account.invite").includes("08.05 / CONTA"));
  assert.ok(decoded("account.new_login", "en").includes("08.05 / ACCOUNT"));
  assert.ok(decoded("account.test").includes("08.06 / E-MAIL"));
});

test("the signature strip prints the render moment it was actually given", () => {
  const message = renderEmail({
    kind: "gate.blocked", data: SAMPLES["gate.blocked"],
    locale: "pt-BR", origin: ORIGIN, now: LATER,
  });
  assert.ok(decodeAsciiEntities(message.html).includes("SENTINEL · LEITURA 2026-09-30 18:45:09 UTC"));
  // Each locale keeps its own word in front of the same UTC stamp.
  const en = renderEmail({
    kind: "gate.blocked", data: SAMPLES["gate.blocked"], locale: "en", origin: ORIGIN, now: LATER,
  });
  assert.ok(en.html.includes("READ 2026-09-30 18:45:09 UTC"));
});

test("the repository and the ref lead the message: a large name, a branch tag, a PR tag", () => {
  const { html, text } = render("gate.blocked", "pt-BR");
  // The name is the target block, not a fact row.
  assert.match(html, /class="t-name"[^>]*>okami\/sentinel<\/div>/);
  // The branch rides in the accent chip, the pull request in the neutral one.
  assert.ok(html.includes(`color:#4fe3ea;word-break:break-all">feature/login</span>`));
  assert.ok(html.includes(`color:#9293a4;word-break:break-all">#42</span>`));
  // And neither is repeated below in the fact panel.
  assert.equal(/class="fact-v"[^>]*>okami\/sentinel</.test(html), false);
  assert.equal(/class="fact-v"[^>]*>feature\/login</.test(html), false);
  // The plain-text twin keeps them as rows, because it has no typography.
  assert.ok(text.includes("Repositório: okami/sentinel"));
  assert.ok(text.includes("Branch: feature/login"));
  assert.ok(text.includes("Pull request: #42"));

  // A repository-less scan leads with its scan id under the honest label.
  const loose = renderEmail({
    kind: "scan.failed",
    data: { ...SAMPLES["scan.failed"], repository: null, branch: null },
    locale: "pt-BR", origin: ORIGIN,
  });
  assert.match(loose.html, /class="t-name"[^>]*>s-1<\/div>/);
  assert.ok(loose.text.includes("Scan: s-1"));
  assert.equal(loose.html.includes("class=\"chip\""), false);

  // A very long ref is never truncated; it wraps inside its chip.
  const longBranch = "feature/billing-webhooks-retry-backoff-and-idempotency-keys";
  const wrapped = renderEmail({
    kind: "gate.blocked",
    data: { ...SAMPLES["gate.blocked"], branch: longBranch },
    locale: "pt-BR", origin: ORIGIN,
  });
  assert.ok(wrapped.html.includes(`>${longBranch}</span>`));
});

test("the tone of a message is decided by its kind, or by its data when the data knows better", () => {
  assert.equal(emailStatusTone(emailMessageStatus("gate.blocked")), "danger");
  assert.equal(emailStatusTone(emailMessageStatus("scan.completed")), "success");
  assert.equal(emailStatusTone(emailMessageStatus("account.invite")), "info");
  assert.equal(emailStatusTone(emailMessageStatus("account.password_changed")), "neutral");
  assert.equal(emailStatusTone(emailMessageStatus("ops.engine_unavailable.resolved")), "success");
  // Two kinds arrive in two tones, because the data, not the kind, decides:
  // a gate that passed with warnings, and a ceiling crossed rather than neared.
  assert.ok(render("gate.passed", "en").text.includes("[WARNINGS]"));
  assert.ok(render("ops.daily_cost", "en").text.includes("[80% OF CEILING]"));
  assert.ok(renderEmail({
    kind: "ops.daily_cost",
    data: { ...SAMPLES["ops.daily_cost"], percent: 100 },
    locale: "en", origin: ORIGIN,
  }).text.includes("[CEILING REACHED]"));
});

test("severity becomes four chips in the HTML and stays four rows in the plain text", () => {
  const { html, text } = render("gate.blocked", "pt-BR");
  for (const [label, count] of [["Críticos", "1"], ["Altos", "2"], ["Médios", "3"], ["Baixos", "4"]]) {
    // The HTML is pure ASCII, so an accented label arrives as a numeric
    // character reference rather than as the character itself.
    const htmlLabel = toAsciiEntities(label);
    assert.ok(html.includes(`>${htmlLabel}</div>`), `${label} chip`);
    assert.ok(text.includes(`${label}: ${count}`), `${label} text row`);
    // The chips already say them; repeating them in the panel would be noise.
    assert.equal(html.includes(`>${htmlLabel}</td>`), false, `${label} repeated in the panel`);
  }
  assert.ok(html.includes(">Findings</td>"));
  assert.ok(html.includes("class=\"bar-critical\""));
  // A zero is dimmed rather than dropped: "nothing at this level" is the news.
  const clean = renderEmail({
    kind: "scan.completed",
    data: { ...SAMPLES["scan.completed"], severity: { ...SEVERITY, critical: 0 } },
    locale: "en", origin: ORIGIN,
  });
  assert.equal(clean.html.includes("class=\"bar-critical\""), false);
  assert.ok(clean.html.includes("class=\"bar-off\""));
  // A message with no scan behind it has no chip row at all.
  assert.equal(render("gate.error", "pt-BR").html.includes("class=\"chip-l\""), false);
});

test("the call to action is a button whose href is escaped, with the URL spelled out under it", () => {
  const message = renderEmail({
    kind: "account.invite",
    data: { inviterName: null, inviteToken: "a\"b<c&d", expiresAt: AT },
    locale: "en", origin: ORIGIN,
  });
  const escaped = `${ORIGIN}/invite/a&quot;b&lt;c&amp;d`;
  // Twice: the VML rectangle Outlook's Word engine draws, and the anchor every
  // other client draws. Both carry the same escaped URL.
  assert.equal(message.html.split(`href="${escaped}"`).length - 1, 2);
  assert.ok(message.html.includes("<!--[if mso]>"));
  assert.ok(message.html.includes("v:roundrect"));
  assert.ok(message.html.includes("class=\"btn\""));
  // Stripped of the button, the reader can still read the address.
  assert.ok(message.html.includes(`word-break:break-all">${escaped}</p>`));
  assert.equal(message.html.includes("a\"b<c&d"), false);
});

test("the mark and the watermark are fetched only when there is an origin to fetch them from", () => {
  const remote = render("gate.blocked", "en");
  assert.ok(remote.html.includes(`src="${ORIGIN}/brand/email-mark.png" width="30" height="37"`));
  assert.ok(remote.html.includes("alt=\"Okami Sentinel\""));
  // The wolf needs no CSS opacity: the asset itself is pre-dimmed on the card
  // colour, so Outlook renders it exactly as designed.
  assert.ok(remote.html.includes(`src="${ORIGIN}/brand/email-wolf-watermark.png" width="80" height="99"`));
  assert.equal(remote.html.includes("opacity"), false);

  const local = render("gate.blocked", "en", null);
  assert.equal(local.html.includes("<img"), false);
  assert.equal(local.html.includes("email-mark"), false);
  assert.equal(local.html.includes("email-wolf-watermark"), false);
  // The wordmark carries the brand on its own when the image cannot.
  assert.ok(local.html.includes(">OKAMI"));
  assert.ok(local.html.includes("Okami Sentinel"));
});

test("no message comes near the size at which Gmail clips a body", () => {
  for (const kind of EMAIL_MESSAGE_KINDS) {
    for (const locale of USER_LOCALES) {
      const bytes = Buffer.byteLength(render(kind, locale).html, "utf8");
      assert.ok(bytes < 60 * 1024, `${kind}/${locale} html is ${bytes} bytes`);
    }
  }
});

test("the HTML is pure ASCII, so no mail client can mis-decode it under a single-byte charset", () => {
  for (const kind of EMAIL_MESSAGE_KINDS) {
    for (const locale of USER_LOCALES) {
      const { html } = render(kind, locale);
      assert.equal(/[^\x00-\x7F]/.test(html), false, `${kind}/${locale} html has a non-ASCII byte`);
    }
  }
});

test("decoding the HTML's numeric character references restores the original accented copy", () => {
  // pt-BR: á.
  const accountTestPtBr = decodeAsciiEntities(render("account.test", "pt-BR").html);
  assert.ok(accountTestPtBr.includes("O e-mail está funcionando"));

  // German: ß survives the round trip.
  const gateErrorDe = decodeAsciiEntities(render("gate.error", "de").html);
  assert.ok(gateErrorDe.includes("abschließen"));

  // French: ç and é survive the round trip.
  const accountTestFr = decodeAsciiEntities(render("account.test", "fr").html);
  assert.ok(accountTestFr.includes("Si vous avez reçu ce message, le fournisseur est correctement configuré."));
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

test("the footer says why once, then offers one thing to do about it", () => {
  const accountKinds = EMAIL_MESSAGE_KINDS.filter((kind) => emailMessageGroup(kind) === "account");
  assert.equal(accountKinds.length, 6);
  // The invitee has no password yet and the reset reader is locked out, so
  // their footer keeps the reason and drops the "my account" link entirely.
  const linkless = new Set<EmailMessageKind>(["account.invite", "account.reset"]);
  for (const kind of accountKinds) {
    const message = render(kind, "pt-BR");
    if (linkless.has(kind)) {
      assert.equal(message.html.includes(`href="${ORIGIN}/settings/account"`), false, kind);
      assert.equal(message.text.includes("Abrir minha conta"), false, kind);
    } else {
      assert.ok(message.html.includes(`href="${ORIGIN}/settings/account"`), kind);
      assert.ok(message.text.includes(`Abrir minha conta: ${ORIGIN}/settings/account`), kind);
    }
    assert.ok(/Você recebe este e-mail porque/.test(message.text), kind);
    // Account messages are never subscription-driven, so the footer must not
    // send the reader to a matrix that cannot switch them off.
    assert.equal(message.html.includes("#notifications"), false, kind);
  }
  // The suppression never suppresses the CTA itself, and local mode still
  // explains the missing links once.
  assert.ok(render("account.invite", "en").html.includes(`href="${ORIGIN}/invite/`));
  assert.ok(render("account.reset", "en", null).text.includes("no public address configured"));

  const switchable = EMAIL_MESSAGE_KINDS.filter((kind) => emailMessageGroup(kind) !== "account");
  // Five repository events, four operational ones and the three resolutions.
  assert.equal(switchable.length, 12);
  for (const kind of switchable) {
    const message = render(kind, "pt-BR");
    assert.ok(message.html.includes(`href="${ORIGIN}/settings/account#notifications"`), kind);
    assert.ok(message.text.includes(`Gerenciar notificações: ${ORIGIN}/settings/account#notifications`), kind);
  }

  // The reason is one sentence: no bold prefix, no name of a page repeated as
  // prose, and no second copy of the link's own words.
  for (const kind of EMAIL_MESSAGE_KINDS) {
    for (const locale of USER_LOCALES) {
      const message = render(kind, locale);
      assert.equal(message.html.includes("<strong"), false, `${kind}/${locale}`);
      assert.equal(/Ajuste em|Change that in|Cámbialo en|Änderbar unter|Modifiable dans/.test(message.text), false, `${kind}/${locale}`);
      assert.equal(message.text.split("\n").filter((line) => line.startsWith("--")).length, 1, kind);
    }
  }
});

test("a repository message carries counts, cost, duration and a link — and no finding detail", () => {
  // The fixture stands in for a real finding: if any part of it can reach a
  // rendered body, the template is reading something it must never read.
  const secrets = [
    "Hardcoded AWS key in the billing worker",
    "apps/api/src/billing/worker.ts",
    "const AWS_SECRET_ACCESS_KEY = \"AKIA...\"",
    "CWE-798",
  ];
  for (const kind of EMAIL_MESSAGE_KINDS) {
    for (const locale of USER_LOCALES) {
      const { html, text, subject } = render(kind, locale);
      for (const secret of secrets) {
        assert.equal(html.includes(secret), false, `${kind}/${locale} html leaked ${secret}`);
        assert.equal(text.includes(secret), false, `${kind}/${locale} text leaked ${secret}`);
        assert.equal(subject.includes(secret), false, `${kind}/${locale} subject leaked ${secret}`);
      }
    }
  }

  const blocked = render("gate.blocked", "pt-BR");
  assert.ok(blocked.text.includes("Repositório: okami/sentinel"));
  assert.ok(blocked.text.includes("Branch: feature/login"));
  assert.ok(blocked.text.includes("Pull request: #42"));
  // The pill already says "BLOQUEADO"; the panel does not repeat it.
  assert.equal(blocked.text.includes("Resultado:"), false);
  assert.ok(blocked.text.includes("[BLOQUEADO]"));
  assert.ok(blocked.text.includes("Findings: 15"));
  assert.ok(blocked.text.includes("Críticos: 1"));
  assert.ok(blocked.text.includes("Altos: 2"));
  assert.ok(blocked.text.includes("Custo: USD 0.42"));
  assert.ok(blocked.text.includes("Duração: 4m 07s"));
  assert.ok(blocked.html.includes(`href="${ORIGIN}/guardrails/gate-1"`));

  // A gate that decided without a scan has no counts at all: four zeros would
  // read like a clean result instead of like an absent one.
  const errored = render("gate.error", "pt-BR");
  assert.equal(errored.text.includes("Findings:"), false);
  assert.equal(errored.text.includes("Custo:"), false);
  assert.equal(errored.text.includes("Resultado:"), false);
  assert.ok(errored.text.includes("[ERRO]"));

  // A sub-cent cost keeps four decimals rather than rounding to nothing.
  assert.ok(render("gate.passed", "pt-BR").text.includes("Custo: USD 0.0040"));
  // `gate.passed` covers the warning too, and says which one it is.
  assert.ok(render("gate.passed", "pt-BR").text.includes("aprovado com aviso"));
  assert.ok(render("gate.passed", "pt-BR").text.includes("Duração: 1h 05m"));

  const scan = render("scan.completed", "en");
  assert.equal(scan.text.includes("Result:"), false);
  assert.ok(scan.text.includes("[COMPLETED]"));
  // A result that is not the pill's own word still earns its row.
  assert.ok(renderEmail({
    kind: "scan.failed",
    data: { ...SAMPLES["scan.failed"], status: "incomplete" },
    locale: "en", origin: ORIGIN,
  }).text.includes("Result: incomplete"));
  assert.ok(scan.html.includes(`href="${ORIGIN}/scans/s-2"`));
});

test("the operational alerts name the target, the window and the settings page", () => {
  const engine = render("ops.engine_unavailable", "pt-BR");
  assert.ok(engine.text.includes("Desde: 2026-09-30 14:05:09 UTC"));
  assert.ok(engine.text.includes("Motores: codex-security, mantis"));
  // The interface calls it a motor in pt-BR; so does the inbox.
  assert.ok(engine.text.includes("O motor está indisponível"));
  assert.equal(/\bengine/i.test(engine.text), false);
  assert.ok(engine.html.includes(`href="${ORIGIN}/settings/connections"`));

  const recovered = render("ops.engine_unavailable.resolved", "pt-BR");
  assert.ok(recovered.text.includes("Normalizado em: 2026-09-30 18:45:09 UTC"));
  assert.ok(recovered.text.includes("Duração: 4h 40m"));

  const connection = render("ops.connection_attention", "en");
  assert.ok(connection.text.includes("Connection: OpenRouter principal"));
  assert.ok(connection.text.includes("Status: degraded"));

  const cost = render("ops.daily_cost", "en");
  assert.ok(cost.text.includes("Day (UTC): 2026-09-30"));
  assert.ok(cost.text.includes("Reserved: USD 8.00"));
  assert.ok(cost.text.includes("Daily ceiling: USD 10.00"));
  assert.ok(cost.text.includes("Share: 80%"));
  assert.ok(cost.html.includes(`href="${ORIGIN}/github"`));

  const publish = render("ops.github_publish_failed", "en");
  assert.ok(publish.text.includes("Reason: github_check_publish_failed"));
  assert.ok(publish.html.includes(`href="${ORIGIN}/guardrails/gate-4"`));
});

test("without a public origin nothing links, the footer says so, and no token leaks", () => {
  for (const kind of EMAIL_MESSAGE_KINDS) {
    const message = render(kind, "pt-BR", null);
    assert.equal(message.html.includes("href="), false, kind);
    assert.equal(message.text.includes("http"), false, kind);
    assert.ok(message.html.includes(toAsciiEntities("não tem endereço público configurado")), kind);
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
  assert.ok(invite.text.includes("Expira em: 2026-10-03 14:05:09 UTC"));
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

  assert.ok(render("account.locked", "pt-BR").text.includes("Nova tentativa: 15 minutos"));
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
