import { Hono, type Context, type Next } from "hono";
import {
  DEFAULT_USER_LOCALE,
  EMAIL_PROVIDER_PRESETS,
  type EmailDeliveriesResponse,
  type EmailProviderKind,
  type EmailSettingsResponse,
  type EmailSmtpSecurity,
  type EmailTestResult,
} from "@csb/shared";
import { globalSecretRedactor } from "../redaction.js";
import { principalOf } from "../auth/principal.js";
import { getUser } from "../auth/user-store.js";
import {
  createSystemEmailCredentialStore,
  newEmailSecretRef,
  type EmailCredentialStore,
} from "../credentials/system-email-credential-store.js";
import { localeOf, isEmailAddress, resolveUserEmailAddress } from "./address.js";
import { insertOutboxRow, listEmailDeliveries, markEmailFailed, markEmailSent } from "./outbox-store.js";
import { renderEmail } from "./templates.js";
import {
  getEmailSettings,
  publicEmailSettings,
  saveEmailSettings,
  type EmailSettingsRecord,
} from "./settings-store.js";
import {
  createEmailTransport,
  EmailTransportError,
  type EmailTransport,
  type EmailTransportConfig,
} from "./transport.js";

export interface EmailApiDependencies {
  secrets: EmailCredentialStore;
  /** `null` in local mode: the e-mails then carry no absolute Sentinel links. */
  publicOrigin: string | null;
  transport: (config: EmailTransportConfig) => EmailTransport;
  now: () => Date;
}

/**
 * Validation error codes are returned verbatim so the screen can name the field
 * that is wrong instead of showing one generic message.
 */
type ValidationError =
  | "provider_invalid" | "enabled_invalid" | "from_name_invalid" | "from_address_invalid"
  | "reply_to_invalid" | "smtp_host_invalid" | "smtp_port_invalid" | "smtp_security_invalid"
  | "smtp_username_invalid" | "secret_invalid"
  | "from_address_required" | "smtp_host_required" | "smtp_port_required" | "secret_required";

/** What the caller asked to happen to the stored secret. */
type SecretIntent =
  | { kind: "keep" }
  | { kind: "clear" }
  | { kind: "replace"; value: string };

interface ParsedSettings {
  record: Omit<EmailSettingsRecord, "updatedAt" | "updatedBy" | "secretRef">;
  secret: SecretIntent;
}

const HOSTNAME = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*$/;
const SECURITIES: readonly EmailSmtpSecurity[] = ["tls", "starttls", "none"];

async function body(c: Context): Promise<Record<string, unknown>> {
  try {
    const parsed = await c.req.json();
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

/** The route policy already reserves these paths; this is the defense in depth. */
async function adminOnly(c: Context, next: Next): Promise<Response | void> {
  if (principalOf(c).isAdmin) return next();
  return c.json({ error: "forbidden" }, 403);
}

/**
 * Turns a request body into the row that will be written, or into the first
 * field that is wrong. The current record matters because omitting the secret
 * keeps it, and because `enabled` can only be turned on when the configuration
 * that will be stored is actually complete — not when the previous one was.
 */
export function parseEmailSettings(
  input: Record<string, unknown>,
  current: EmailSettingsRecord,
): { ok: true; parsed: ParsedSettings } | { ok: false; error: ValidationError } {
  const fail = (error: ValidationError) => ({ ok: false as const, error });

  const provider = input.provider ?? current.provider;
  if (provider !== "smtp" && provider !== "resend") return fail("provider_invalid");

  if (input.enabled !== undefined && typeof input.enabled !== "boolean") return fail("enabled_invalid");
  const enabled = (input.enabled as boolean | undefined) ?? current.enabled;

  const fromNameRaw = input.fromName === undefined ? current.fromName : input.fromName;
  // A control character in the display name is refused here rather than stripped
  // later: the administrator should learn the name was wrong, and `formatSender`
  // must never be the only thing standing between a CR and a forged header.
  if (typeof fromNameRaw !== "string" || /[\u0000-\u001F\u007F]/.test(fromNameRaw)) {
    return fail("from_name_invalid");
  }
  const fromName = fromNameRaw.trim().slice(0, 120);

  const fromAddress = optionalText(input.fromAddress, current.fromAddress);
  if (fromAddress === INVALID) return fail("from_address_invalid");
  if (fromAddress !== null && !isEmailAddress(fromAddress)) return fail("from_address_invalid");

  const replyTo = optionalText(input.replyTo, current.replyTo);
  if (replyTo === INVALID) return fail("reply_to_invalid");
  if (replyTo !== null && !isEmailAddress(replyTo)) return fail("reply_to_invalid");

  const smtpHost = optionalText(input.smtpHost, current.smtpHost);
  if (smtpHost === INVALID) return fail("smtp_host_invalid");
  if (smtpHost !== null && !HOSTNAME.test(smtpHost)) return fail("smtp_host_invalid");

  const smtpPortRaw = input.smtpPort === undefined ? current.smtpPort : input.smtpPort;
  let smtpPort: number | null;
  if (smtpPortRaw === null || smtpPortRaw === "") {
    smtpPort = null;
  } else if (typeof smtpPortRaw === "number" && Number.isSafeInteger(smtpPortRaw)) {
    smtpPort = smtpPortRaw;
  } else {
    return fail("smtp_port_invalid");
  }
  if (smtpPort !== null && (smtpPort < 1 || smtpPort > 65_535)) return fail("smtp_port_invalid");

  const security = input.smtpSecurity === undefined ? current.smtpSecurity : input.smtpSecurity;
  if (!SECURITIES.includes(security as EmailSmtpSecurity)) return fail("smtp_security_invalid");

  const smtpUsername = optionalText(input.smtpUsername, current.smtpUsername);
  if (smtpUsername === INVALID) return fail("smtp_username_invalid");
  if (smtpUsername !== null && (smtpUsername.length > 320 || /[\u0000-\u001F\u007F]/.test(smtpUsername))) {
    return fail("smtp_username_invalid");
  }

  let secret: SecretIntent;
  if (!("secret" in input)) {
    secret = { kind: "keep" };
  } else if (input.secret === null || input.secret === "") {
    secret = { kind: "clear" };
  } else if (
    typeof input.secret === "string" && input.secret.length <= 4_096 &&
    !/[\u0000-\u001F\u007F]/.test(input.secret)
  ) {
    secret = { kind: "replace", value: input.secret };
  } else {
    return fail("secret_invalid");
  }

  const willHaveSecret = secret.kind === "replace" || (secret.kind === "keep" && current.secretRef !== null);
  if (enabled) {
    if (fromAddress === null) return fail("from_address_required");
    if (provider === "smtp") {
      if (smtpHost === null) return fail("smtp_host_required");
      if (smtpPort === null) return fail("smtp_port_required");
    }
    // An internal relay that asks for no username asks for no password either,
    // which is exactly what the `none` security mode exists for. A secret is
    // required only where the provider actually authenticates.
    if ((provider === "resend" || smtpUsername !== null) && !willHaveSecret) {
      return fail("secret_required");
    }
  }

  return {
    ok: true,
    parsed: {
      record: {
        provider: provider as EmailProviderKind, enabled, fromName, fromAddress, replyTo,
        smtpHost, smtpPort, smtpSecurity: security as EmailSmtpSecurity, smtpUsername,
      },
      secret,
    },
  };
}

const INVALID = Symbol("invalid");

/** `undefined` keeps the stored value, `null` or `""` clears it. */
function optionalText(value: unknown, fallback: string | null): string | null | typeof INVALID {
  if (value === undefined) return fallback;
  if (value === null) return null;
  if (typeof value !== "string") return INVALID;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed.slice(0, 320);
}

/** The transport configuration a complete record implies, or `null` when it is not complete. */
export function transportConfigFor(
  record: EmailSettingsRecord,
  secret: string | null,
): EmailTransportConfig | null {
  if (record.fromAddress === null) return null;
  if (record.provider === "resend") {
    if (secret === null) return null;
    return {
      provider: "resend", fromName: record.fromName, fromAddress: record.fromAddress,
      replyTo: record.replyTo, smtp: null, secret,
    };
  }
  if (record.smtpHost === null || record.smtpPort === null) return null;
  // Authless relay: a username is what makes a password necessary.
  if (record.smtpUsername !== null && secret === null) return null;
  return {
    provider: "smtp", fromName: record.fromName, fromAddress: record.fromAddress,
    replyTo: record.replyTo, secret,
    smtp: {
      host: record.smtpHost, port: record.smtpPort,
      security: record.smtpSecurity, username: record.smtpUsername,
    },
  };
}

export function createEmailApi(supplied?: Partial<EmailApiDependencies>): Hono {
  const deps = {
    publicOrigin: supplied?.publicOrigin ?? null,
    transport: supplied?.transport ?? ((config: EmailTransportConfig) => createEmailTransport(config)),
    now: supplied?.now ?? (() => new Date()),
  };
  // Built on first use, never while this module is being imported: in server
  // mode the default store resolves the vault key file, and a process that only
  // ever reads the database must not fail to start over a missing one.
  let store = supplied?.secrets;
  const secrets = (): EmailCredentialStore =>
    (store ??= createSystemEmailCredentialStore({ redactor: globalSecretRedactor }));
  const api = new Hono();
  // Registered before the guard, so the header also reaches a 403: a refusal
  // must be no more cacheable than the answer would have been. A provider
  // configuration, a delivery history and a send result are never safe to keep
  // in a shared cache.
  api.use("/email/*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  });
  for (const path of ["/email/settings", "/email/test", "/email/deliveries"]) api.use(path, adminOnly);

  const settingsResponse = (record: EmailSettingsRecord): EmailSettingsResponse => ({
    settings: publicEmailSettings(record),
    presets: EMAIL_PROVIDER_PRESETS,
    publicOrigin: deps.publicOrigin,
  });

  api.get("/email/settings", (c) => c.json(settingsResponse(getEmailSettings())));

  api.put("/email/settings", async (c) => {
    const current = getEmailSettings();
    const parsed = parseEmailSettings(await body(c), current);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const { record, secret } = parsed.parsed;

    // The vault is written before the row that names the reference, so a failed
    // vault write leaves the previous, still-valid configuration untouched.
    let secretRef = current.secretRef;
    if (secret.kind === "replace") {
      secretRef = newEmailSecretRef();
      try {
        await secrets().put(secretRef, { secret: secret.value });
      } catch {
        return c.json({ error: "secret_storage_unavailable" }, 503);
      }
    } else if (secret.kind === "clear") {
      secretRef = null;
    }

    let saved: EmailSettingsRecord;
    try {
      saved = saveEmailSettings({ ...record, secretRef }, principalOf(c).userId, deps.now());
    } catch (error) {
      // The row still names the previous secret, so the slot written moments ago
      // is unreachable. Remove it rather than leave material in the vault that
      // nothing will ever read or rotate.
      if (secret.kind === "replace" && secretRef !== null) {
        await secrets().delete(secretRef).catch(() => undefined);
      }
      throw error;
    }

    // Only once the row no longer points at it may the old secret go.
    if (current.secretRef !== null && current.secretRef !== secretRef) {
      await secrets().delete(current.secretRef).catch(() => undefined);
    }
    return c.json(settingsResponse(saved));
  });

  api.post("/email/test", async (c) => {
    const principal = principalOf(c);
    const user = principal.userId ? getUser(principal.userId) : null;
    const to = user
      ? resolveUserEmailAddress(user)
      : isEmailAddress(principal.username) ? principal.username : null;
    if (to === null) return c.json({ error: "no_recipient_address" }, 400);

    const record = getEmailSettings();
    let secret: string | null = null;
    if (record.secretRef !== null) {
      try {
        secret = (await secrets().get(record.secretRef))?.secret ?? null;
      } catch {
        return c.json({ error: "secret_storage_unavailable" }, 503);
      }
    }
    const config = transportConfigFor(record, secret);
    if (config === null) return c.json({ error: "email_not_configured" }, 400);

    const locale = user ? localeOf(user) : DEFAULT_USER_LOCALE;
    const rendered = renderEmail({
      kind: "account.test", data: { to, at: deps.now() }, locale, origin: deps.publicOrigin,
    });
    // The test is a real delivery, so it belongs in the history like any other,
    // already claimed as `sending` because this request sends it itself.
    const id = insertOutboxRow({
      event: "account.test",
      dedupeKey: `account.${principal.userId ?? "local"}.test.${deps.now().toISOString()}`,
      userId: principal.userId, toAddress: to, locale,
      subject: rendered.subject, html: rendered.html, text: rendered.text,
      status: "sending", nextAttemptAt: null,
    }, deps.now());

    try {
      const result = await deps.transport(config).send({
        to, subject: rendered.subject, html: rendered.html, text: rendered.text,
        idempotencyKey: id ?? `test_${deps.now().getTime()}`,
      });
      if (id !== null) markEmailSent(id, result.providerMessageId, deps.now());
      const response: EmailTestResult = {
        ok: true, to, code: null, message: null, providerMessageId: result.providerMessageId,
      };
      return c.json(response);
    } catch (error) {
      const failure = error instanceof EmailTransportError
        ? error
        : { code: "provider_unavailable" as const, message: "The provider is unavailable." };
      if (id !== null) markEmailFailed(id, failure.message, null);
      const response: EmailTestResult = {
        ok: false, to, code: failure.code, message: failure.message, providerMessageId: null,
      };
      return c.json(response);
    }
  });

  api.get("/email/deliveries", (c) => {
    const response: EmailDeliveriesResponse = { deliveries: listEmailDeliveries() };
    return c.json(response);
  });

  return api;
}
