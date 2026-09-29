import assert from "node:assert/strict";
import test from "node:test";
import {
  EMAIL_PROVIDER_PRESETS,
  emailProviderPreset,
  isUserLocale,
  USER_LOCALES,
  type EmailPresetId,
} from "@csb/shared";

test("the preset table carries every provider the design names, exactly once", () => {
  const ids = EMAIL_PROVIDER_PRESETS.map((preset) => preset.id);
  assert.deepEqual(ids, [
    "resend", "hostinger", "zoho", "zoho-eu", "gmail", "microsoft365", "custom",
  ] satisfies EmailPresetId[]);
  assert.equal(new Set(ids).size, ids.length);
});

test("each preset fills host, port and security the way the provider documents them", () => {
  assert.deepEqual(emailProviderPreset("resend"), {
    id: "resend", provider: "smtp", host: "smtp.resend.com", port: 465, security: "tls",
    username: "resend", usernameHint: "fixed", secretHint: "api-key",
  });
  assert.deepEqual(emailProviderPreset("hostinger"), {
    id: "hostinger", provider: "smtp", host: "smtp.hostinger.com", port: 465, security: "tls",
    username: null, usernameHint: "mailbox", secretHint: "password",
  });
  assert.equal(emailProviderPreset("zoho")?.host, "smtp.zoho.com");
  assert.equal(emailProviderPreset("zoho-eu")?.host, "smtp.zoho.eu");
  assert.equal(emailProviderPreset("gmail")?.host, "smtp.gmail.com");
  assert.equal(emailProviderPreset("gmail")?.secretHint, "app-password");
  assert.deepEqual(
    { ...emailProviderPreset("microsoft365") },
    {
      id: "microsoft365", provider: "smtp", host: "smtp.office365.com", port: 587,
      security: "starttls", username: null, usernameHint: "mailbox", secretHint: "password",
    },
  );
});

test("only the custom preset leaves the connection fields to the administrator", () => {
  for (const preset of EMAIL_PROVIDER_PRESETS) {
    const open = preset.host === null && preset.port === null && preset.security === null;
    assert.equal(open, preset.id === "custom", preset.id);
    if (!open) {
      assert.ok(preset.port! >= 1 && preset.port! <= 65_535, preset.id);
    }
  }
  assert.equal(emailProviderPreset("nope"), null);
});

test("the preset table cannot be mutated by a caller", () => {
  assert.throws(() => {
    (EMAIL_PROVIDER_PRESETS as unknown as Array<unknown>).push({});
  });
  assert.throws(() => {
    (emailProviderPreset("resend") as unknown as { host: string }).host = "evil.example";
  });
});

test("the five interface locales are the accepted set", () => {
  assert.deepEqual([...USER_LOCALES], ["pt-BR", "en", "es", "de", "fr"]);
  assert.ok(isUserLocale("pt-BR"));
  assert.ok(isUserLocale("fr"));
  assert.equal(isUserLocale("pt"), false);
  assert.equal(isUserLocale("PT-BR"), false);
  assert.equal(isUserLocale(null), false);
});
