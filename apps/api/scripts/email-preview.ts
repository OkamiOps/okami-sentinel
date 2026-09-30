/**
 * Renders every e-mail kind to a directory of HTML files so the shell can be
 * looked at rather than imagined. Nothing here sends anything: it writes files
 * and stops.
 *
 *   pnpm --filter @csb/api email:preview
 *   pnpm --filter @csb/api email:preview -- --locale=en --out=/tmp/x
 *
 * The output directory defaults to /tmp, outside the repository, because these
 * are throwaway artefacts and the repository is not a scratch pad.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { USER_LOCALES, type UserLocale } from "@csb/shared";
import {
  EMAIL_MESSAGE_KINDS,
  emailMessageGroup,
  emailMessageStatus,
  emailStatusTone,
  renderEmail,
  type EmailMessageDataMap,
  type EmailMessageKind,
} from "../src/email/templates.js";

const AT = new Date("2026-09-30T09:12:44.000Z");
const LATER = new Date("2026-09-30T14:41:02.000Z");
const SEVERITY = { critical: 2, high: 7, medium: 14, low: 31, info: 12, unknown: 0, total: 66 };
const CLEAN = { critical: 0, high: 0, medium: 3, low: 9, info: 4, unknown: 0, total: 16 };

const SAMPLES: { [K in EmailMessageKind]: EmailMessageDataMap[K] } = {
  "account.test": { to: "ana.ferreira@okamilab.dev", at: AT },
  "account.invite": {
    inviterName: "Marcos Santos",
    inviteToken: "Tk7Qw2fB9zR4nL6vH1sX8cM3pD5yA0eG2jK4tU7bN9w",
    expiresAt: new Date("2026-10-03T09:12:44.000Z"),
  },
  "account.reset": {
    resetToken: "Rs3Nc8vT1mQ6yZ0kJ5hR7fW2dL9pB4xE6sA1gU8oV3q",
    expiresAt: new Date("2026-10-01T09:12:44.000Z"),
  },
  "account.new_login": { at: AT, ip: "189.45.212.7", browser: "Safari 26 · macOS 27" },
  "account.locked": { at: AT, retryAfterSeconds: 900 },
  "account.password_changed": { at: AT },
  "gate.blocked": {
    gateId: "gt_8f31c0a4", repository: "okamilab/sentinel-core", branch: "feat/billing-webhooks",
    pullRequest: 412, outcome: "blocked", severity: SEVERITY, costUsd: 0.38, durationMs: 247_000,
  },
  "gate.error": {
    gateId: "gt_5b90d217", repository: "okamilab/sentinel-core", branch: "main",
    pullRequest: null, outcome: "error", severity: null, costUsd: null, durationMs: 12_400,
  },
  "gate.passed": {
    gateId: "gt_2c17ae55", repository: "okamilab/sentinel-web", branch: "feat/report-export",
    pullRequest: 413, outcome: "warning", severity: CLEAN, costUsd: 0.0042, durationMs: 188_000,
  },
  "scan.failed": {
    scanId: "sc_71d4e0", repository: "okamilab/sentinel-core", branch: "main",
    status: "failed", severity: null, costUsd: null, durationMs: 41_000,
  },
  "scan.completed": {
    scanId: "sc_0a93f2", repository: "okamilab/sentinel-core", branch: "main",
    status: "completed", severity: SEVERITY, costUsd: 1.52, durationMs: 3_900_000,
  },
  "ops.engine_unavailable": { since: AT, at: LATER, engines: ["codex-security", "mantis"] },
  "ops.engine_unavailable.resolved": { since: AT, at: LATER },
  "ops.connection_attention": {
    connectionName: "OpenRouter · produção", status: "degraded", since: AT, at: LATER,
  },
  "ops.connection_attention.resolved": {
    connectionName: "OpenRouter · produção", since: AT, at: LATER,
  },
  "ops.daily_cost": {
    repository: "okamilab/sentinel-core", day: "2026-09-30", percent: 100,
    reservedUsd: 24, ceilingUsd: 24,
  },
  "ops.github_publish_failed": {
    gateId: "gt_8f31c0a4", repository: "okamilab/sentinel-core", branch: "feat/billing-webhooks",
    reason: "github_check_publish_failed", at: AT,
  },
  "ops.github_publish_failed.resolved": {
    gateId: "gt_8f31c0a4", repository: "okamilab/sentinel-core", since: AT, at: LATER,
  },
};

function argument(name: string, fallback: string): string {
  const match = process.argv.slice(2).find((value) => value.startsWith(`--${name}=`));
  return match === undefined ? fallback : match.slice(name.length + 3);
}

const locale = argument("locale", "pt-BR") as UserLocale;
if (!USER_LOCALES.includes(locale)) {
  throw new Error(`unknown locale ${locale}; expected one of ${USER_LOCALES.join(", ")}`);
}
const origin = argument("origin", "http://127.0.0.1:4173");
const outDir = path.resolve(argument("out", "/tmp/email-previews"));

await mkdir(outDir, { recursive: true });

const rows: string[] = [];
for (const kind of EMAIL_MESSAGE_KINDS) {
  const message = renderEmail({ kind, data: SAMPLES[kind], locale, origin } as never);
  const file = `${kind.replace(/[^a-z0-9]+/gi, "-")}.html`;
  await writeFile(path.join(outDir, file), message.html, "utf8");
  await writeFile(path.join(outDir, `${file}.txt`), message.text, "utf8");
  const status = emailMessageStatus(kind);
  rows.push(
    `<tr><td><a href="./${file}">${kind}</a></td>`
    + `<td>${emailMessageGroup(kind)}</td>`
    + `<td>${status} / ${emailStatusTone(status)}</td>`
    + `<td>${(Buffer.byteLength(message.html, "utf8") / 1024).toFixed(1)} KiB</td>`
    + `<td><a href="./${file}.txt">text</a></td></tr>`,
  );
}

await writeFile(
  path.join(outDir, "index.html"),
  `<!doctype html><meta charset="utf-8"><title>Okami Sentinel e-mail previews</title>`
  + `<style>body{font:14px ui-sans-serif,system-ui;margin:40px;background:#f8f8fa;color:#0b0b12}`
  + `table{border-collapse:collapse}td,th{border-bottom:1px solid #d4d4dc;padding:6px 14px;text-align:left}`
  + `a{color:#c2410c}</style>`
  + `<h1>Okami Sentinel — ${locale}</h1><p>origin: <code>${origin}</code></p>`
  + `<table><tr><th>kind</th><th>group</th><th>status / tone</th><th>size</th><th>plain</th></tr>${rows.join("")}</table>`,
  "utf8",
);

console.log(`${EMAIL_MESSAGE_KINDS.length} previews in ${outDir} (locale ${locale})`);
