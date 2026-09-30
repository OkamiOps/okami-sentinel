import assert from "node:assert/strict";
import test from "node:test";
import { EMAIL_PROVIDER_PRESETS, type EmailSettings } from "@csb/shared";
import {
  applyPreset,
  canSendTest,
  detectPresetId,
  draftFromSettings,
  emailSettingsField,
  isEmailErrorCode,
  parsePort,
  secretBelongsToOtherProvider,
  secretConfiguredFor,
  settingsPayload,
  smtpPresets,
} from "./email-settings-form";

const keptSecret = { provider: "smtp", secretConfigured: true } as const;
const noSecret = { provider: "smtp", secretConfigured: false } as const;

const stored: EmailSettings = {
  provider: "smtp", enabled: true, fromName: "Okami Sentinel", fromAddress: "alerts@okami.test",
  replyTo: null, smtpHost: "smtp.resend.com", smtpPort: 465, smtpSecurity: "tls",
  smtpUsername: "resend", secretConfigured: true, updatedAt: "2026-09-30T10:00:00.000Z", updatedBy: "root",
};

test("the preset select is recovered from the stored transport, not guessed", () => {
  assert.equal(detectPresetId(stored), "resend");
  assert.equal(detectPresetId({ ...stored, smtpHost: "smtp.office365.com", smtpPort: 587, smtpSecurity: "starttls" }), "microsoft365");
  // A host that matches a preset on a different port is that administrator's
  // own configuration; calling it a preset would rewrite the port on save.
  assert.equal(detectPresetId({ ...stored, smtpPort: 2465 }), "custom");
  assert.equal(detectPresetId({ ...stored, smtpHost: "mail.internal" }), "custom");
  assert.equal(detectPresetId({ ...stored, smtpHost: null, smtpPort: null }), "custom");
});

test("only the SMTP presets reach the preset select", () => {
  const ids = smtpPresets().map((preset) => preset.id);
  assert.deepEqual(ids, ["resend", "hostinger", "zoho", "zoho-eu", "gmail", "microsoft365", "custom"]);
  assert.equal(smtpPresets(EMAIL_PROVIDER_PRESETS).every((preset) => preset.provider === "smtp"), true);
});

test("a stored secret starts the form empty, which is what keeps it", () => {
  const draft = draftFromSettings(stored);
  assert.equal(draft.secret, "");
  assert.equal(draft.presetId, "resend");
  assert.equal(draft.smtpPort, "465");
  assert.equal(draft.replyTo, "");
  assert.equal(settingsPayload(draft, keptSecret).secret, undefined);
  assert.equal("secret" in settingsPayload(draft, keptSecret), false);
  assert.equal(settingsPayload({ ...draft, secret: "re_new_key" }, keptSecret).secret, "re_new_key");
});

test("a preset fills the transport, and a fixed username, without erasing a mailbox one", () => {
  const custom = { ...draftFromSettings(stored), presetId: "custom" as const, smtpHost: "", smtpPort: "", smtpUsername: "ana@okami.test" };
  const resend = applyPreset(custom, "resend");
  assert.deepEqual(
    { host: resend.smtpHost, port: resend.smtpPort, security: resend.smtpSecurity, username: resend.smtpUsername },
    { host: "smtp.resend.com", port: "465", security: "tls", username: "resend" },
  );
  const hostinger = applyPreset({ ...custom, smtpUsername: "ana@okami.test" }, "hostinger");
  assert.equal(hostinger.smtpHost, "smtp.hostinger.com");
  assert.equal(hostinger.smtpSecurity, "tls");
  // Hostinger's username is the sending mailbox, which only the administrator
  // knows: the preset must not blank what they typed.
  assert.equal(hostinger.smtpUsername, "ana@okami.test");
  const microsoft = applyPreset(custom, "microsoft365");
  assert.equal(microsoft.smtpPort, "587");
  assert.equal(microsoft.smtpSecurity, "starttls");
  // `custom` knows nothing, so it changes nothing but the selection itself.
  const back = applyPreset(microsoft, "custom");
  assert.deepEqual({ ...back, presetId: "microsoft365" }, microsoft);
  assert.equal(back.presetId, "custom");
});

test("the Resend provider sends no SMTP transport at all", () => {
  const payload = settingsPayload({ ...draftFromSettings(stored), provider: "resend", secret: "re_key" }, keptSecret);
  assert.equal(payload.provider, "resend");
  assert.equal("smtpHost" in payload, false);
  assert.equal("smtpPort" in payload, false);
  assert.equal("smtpSecurity" in payload, false);
  assert.equal("smtpUsername" in payload, false);
  assert.equal(payload.secret, "re_key");
});

test("empty optional fields are cleared, not sent as empty strings", () => {
  const payload = settingsPayload({ ...draftFromSettings(stored), replyTo: "  ", smtpUsername: "", fromAddress: " alerts@okami.test " }, keptSecret);
  assert.equal(payload.replyTo, null);
  assert.equal(payload.smtpUsername, null);
  assert.equal(payload.fromAddress, "alerts@okami.test");
});

test("a port that is not a port still reaches the API, so the API names the field", () => {
  assert.equal(parsePort("465"), 465);
  assert.equal(parsePort(" 587 "), 587);
  assert.equal(parsePort("0"), null);
  assert.equal(parsePort("70000"), null);
  assert.equal(parsePort("46a"), null);
  assert.equal(parsePort(""), null);
  assert.equal(settingsPayload({ ...draftFromSettings(stored), smtpPort: "not a port" }, keptSecret).smtpPort, "not a port");
  assert.equal(settingsPayload({ ...draftFromSettings(stored), smtpPort: "" }, keptSecret).smtpPort, null);
});

test("each validation code lands on the field it is about", () => {
  assert.equal(emailSettingsField("smtp_port_required"), "smtpPort");
  assert.equal(emailSettingsField("from_address_invalid"), "fromAddress");
  assert.equal(emailSettingsField("secret_required"), "secret");
  // A vault outage is not a field the administrator can fix by typing.
  assert.equal(emailSettingsField("secret_storage_unavailable"), null);
  assert.equal(emailSettingsField("something_new"), null);
  assert.equal(emailSettingsField(null), null);
  assert.equal(isEmailErrorCode("secret_storage_unavailable"), true);
  assert.equal(isEmailErrorCode("no_recipient_address"), true);
  assert.equal(isEmailErrorCode("something_new"), false);
  assert.equal(isEmailErrorCode(null), false);
});

test("the test button waits for a configuration a test could actually use", () => {
  assert.equal(canSendTest(stored), true);
  assert.equal(canSendTest({ ...stored, fromAddress: null }), false);
  assert.equal(canSendTest({ ...stored, secretConfigured: false }), false);
  assert.equal(canSendTest({ ...stored, smtpHost: null }), false);
  assert.equal(canSendTest({ ...stored, smtpPort: null }), false);
  // An internal relay with no username needs no secret at all.
  assert.equal(canSendTest({ ...stored, smtpUsername: null, secretConfigured: false }), true);
  assert.equal(canSendTest({ ...stored, provider: "resend", secretConfigured: true }), true);
  assert.equal(canSendTest({ ...stored, provider: "resend", secretConfigured: false }), false);
});

test("the stored secret belongs to the provider it was saved for", () => {
  const draft = draftFromSettings(stored);
  assert.equal(secretConfiguredFor(draft, keptSecret), true);
  assert.equal(secretBelongsToOtherProvider(draft, keptSecret), false);

  // The vault has one slot. A stored SMTP password is not a Resend API key.
  const switched = { ...draft, provider: "resend" as const };
  assert.equal(secretConfiguredFor(switched, keptSecret), false);
  assert.equal(secretBelongsToOtherProvider(switched, keptSecret), true);
  assert.equal(secretBelongsToOtherProvider(switched, noSecret), false);

  // Asking for removal already means "not configured any more".
  assert.equal(secretConfiguredFor({ ...draft, clearSecret: true }, keptSecret), false);
});

test("changing provider without a new secret clears the old one instead of reusing it", () => {
  const switched = { ...draftFromSettings(stored), provider: "resend" as const };
  // Saving this used to keep the SMTP password in the Resend slot, leaving the
  // installation enabled with a credential that can never authenticate.
  assert.equal(settingsPayload(switched, keptSecret).secret, null);
  assert.equal(settingsPayload({ ...switched, secret: "re_key" }, keptSecret).secret, "re_key");
  // With nothing stored there is nothing to clear, so the field stays absent.
  assert.equal("secret" in settingsPayload(switched, noSecret), false);
});

test("a requested removal is sent as an explicit null", () => {
  const draft = draftFromSettings(stored);
  assert.equal(settingsPayload({ ...draft, clearSecret: true }, keptSecret).secret, null);
  // A typed replacement outranks a stale removal flag.
  assert.equal(settingsPayload({ ...draft, clearSecret: true, secret: "typed" }, keptSecret).secret, "typed");
});
