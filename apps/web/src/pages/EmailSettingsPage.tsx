import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import type {
  EmailDelivery,
  EmailPresetId,
  EmailOutboxStatus,
  EmailProviderKind,
  EmailSettingsResponse,
  EmailSmtpSecurity,
  EmailTestResult,
} from "@csb/shared";
import { emailProviderPreset } from "@csb/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SettingsSectionNav } from "../components/settings/SettingsSectionNav";
import { AlertBanner, EmptyState, Loading, PageHeader, Panel, cx } from "../components/ui";
import { authErrorCode } from "../lib/auth-api";
import { emailApi } from "../lib/email-api";
import { emailEventLabel } from "../lib/email-events";
import {
  applyPreset,
  canSendTest,
  draftFromSettings,
  emailSettingsField,
  isEmailErrorCode,
  settingsPayload,
  smtpPresets,
  type EmailSettingsDraft,
  type EmailSettingsField,
} from "../lib/email-settings-form";
import { formatDate } from "../format";
import { emailMessages, type EmailMessageKey } from "../i18n/email";
import { useScopedI18n } from "../i18n/scoped";

const PROVIDERS: readonly EmailProviderKind[] = ["smtp", "resend"];
const SECURITIES: readonly EmailSmtpSecurity[] = ["tls", "starttls", "none"];

const statusTone: Record<EmailOutboxStatus, string> = {
  queued: "border-border text-muted-foreground",
  sending: "border-primary/45 text-primary",
  sent: "border-chart-2/45 text-chart-2",
  failed: "border-destructive/50 text-destructive",
  cancelled: "border-chart-3/45 text-chart-3",
};

export function EmailSettingsPage() {
  const { t } = useScopedI18n(emailMessages);
  const [response, setResponse] = useState<EmailSettingsResponse | null>(null);
  const [draft, setDraft] = useState<EmailSettingsDraft | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorField, setErrorField] = useState<EmailSettingsField | null>(null);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<EmailTestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<EmailDelivery[] | null>(null);
  const [historyFailed, setHistoryFailed] = useState(false);

  const loadHistory = useCallback(async () => {
    setHistoryFailed(false);
    try {
      setDeliveries(await emailApi.deliveries());
    } catch {
      setDeliveries(null);
      setHistoryFailed(true);
    }
  }, []);

  const load = useCallback(async () => {
    setLoadFailed(false);
    try {
      const next = await emailApi.settings();
      setResponse(next);
      setDraft(draftFromSettings(next.settings, next.presets));
    } catch {
      setResponse(null);
      setDraft(null);
      setLoadFailed(true);
    }
    await loadHistory();
  }, [loadHistory]);

  useEffect(() => { void load(); }, [load]);

  function update<Key extends keyof EmailSettingsDraft>(key: Key, value: EmailSettingsDraft[Key]) {
    setDraft((current) => current === null ? current : { ...current, [key]: value });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending || draft === null) return;
    setPending(true);
    setNotice(null);
    setError(null);
    setErrorField(null);
    // A save invalidates whatever the previous test proved: the configuration
    // it exercised is no longer the configuration on file.
    setTest(null);
    setTestError(null);
    try {
      const saved = await emailApi.saveSettings(settingsPayload(draft));
      setResponse(saved);
      setDraft(draftFromSettings(saved.settings, saved.presets));
      setNotice(t("email.saved"));
    } catch (failure) {
      const code = authErrorCode(failure);
      const field = emailSettingsField(code);
      setErrorField(field);
      setError(messageFor(code, t));
    } finally {
      setPending(false);
    }
  }

  async function sendTest() {
    if (testing) return;
    setTesting(true);
    setTest(null);
    setTestError(null);
    try {
      setTest(await emailApi.sendTest());
      // The test writes its own outbox row, so the history below is stale the
      // moment the result arrives.
      await loadHistory();
    } catch (failure) {
      const code = authErrorCode(failure);
      setTestError(messageFor(code, t, "email.testRequestError"));
    } finally {
      setTesting(false);
    }
  }

  const settings = response?.settings ?? null;
  const testable = settings !== null && canSendTest(settings);

  return <>
    <SettingsSectionNav />
    <PageHeader
      code={t("email.code")} title={t("email.title")} description={t("email.description")}
      actions={<Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => void load()}>{t("email.refresh")}</Button>}
    />
    {loadFailed && <AlertBanner>
      <span className="mr-3">{t("email.loadError")}</span>
      <Button type="button" variant="outline" size="sm" onClick={() => void load()}>{t("common.retry")}</Button>
    </AlertBanner>}
    {response !== null && response.publicOrigin === null && <AlertBanner tone="warning">{t("email.noOriginWarning")}</AlertBanner>}

    {draft === null || response === null
      ? loadFailed ? null : <Loading />
      : <>
        <form onSubmit={(event) => void submit(event)} noValidate>
          {/* items-start: the two cards carry different numbers of fields (and
              the left one grows a warning), and a stretched row would leave one
              of them with a block of empty card instead of ending at its last
              control. */}
          <div className="grid min-w-0 items-start gap-4 xl:grid-cols-2">
            <Panel label={t("email.providerPanel")} title={t("email.providerTitle")}>
              <div className="grid gap-4 px-4 py-4">
                <Field id="email-provider" label={t("email.provider")} description={t("email.providerHelp")}>
                  {(a11y) => <Select value={draft.provider} onValueChange={(value) => update("provider", value as EmailProviderKind)}>
                    <SelectTrigger {...a11y} className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent position="popper">
                      {PROVIDERS.map((provider) => <SelectItem key={provider} value={provider}>{t(`email.provider.${provider}` as EmailMessageKey)}</SelectItem>)}
                    </SelectContent>
                  </Select>}
                </Field>
                {draft.provider === "smtp"
                  ? <SmtpFields
                    draft={draft} response={response} errorField={errorField} pending={pending} onUpdate={update}
                    onPreset={(id) => setDraft((current) => current === null ? current : applyPreset(current, id))}
                  />
                  : <SecretField
                    draft={draft} pending={pending} invalid={errorField === "secret"}
                    label={t("email.resendKey")} configured={response.settings.secretConfigured}
                    onUpdate={(value) => update("secret", value)}
                  />}
              </div>
            </Panel>

            <Panel label={t("email.senderPanel")} title={t("email.senderTitle")}>
              <div className="grid gap-4 px-4 py-4">
                <div className="grid items-start gap-4 sm:grid-cols-2">
                  <Field id="email-from-name" label={t("email.fromName")} invalid={errorField === "fromName"}>
                    {(a11y) => <Input {...a11y} value={draft.fromName} autoComplete="off" disabled={pending} onChange={(event) => update("fromName", event.target.value)} />}
                  </Field>
                  <Field id="email-from-address" label={t("email.fromAddress")} invalid={errorField === "fromAddress"}>
                    {(a11y) => <Input {...a11y} type="email" value={draft.fromAddress} autoComplete="off" spellCheck={false} disabled={pending} onChange={(event) => update("fromAddress", event.target.value)} />}
                  </Field>
                </div>
                <Field id="email-reply-to" label={t("email.replyTo")} description={t("email.replyToHelp")} invalid={errorField === "replyTo"}>
                  {(a11y) => <Input {...a11y} type="email" value={draft.replyTo} autoComplete="off" spellCheck={false} disabled={pending} onChange={(event) => update("replyTo", event.target.value)} />}
                </Field>
                <label className="flex items-start gap-3 border border-border px-3 py-2.5 text-xs">
                  <Checkbox className="mt-0.5" checked={draft.enabled} disabled={pending} aria-label={t("email.enabled")} onCheckedChange={(checked) => update("enabled", checked === true)} />
                  <span className="min-w-0">
                    <span className="block font-medium">{t("email.enabled")}</span>
                    <span className="mt-1 block leading-relaxed text-muted-foreground">{t("email.enabledHelp")}</span>
                  </span>
                </label>
                <dl className="grid gap-1.5 border border-border bg-muted/20 px-3 py-2.5">
                  <dt className="bench-label">{t("email.publicOrigin")}</dt>
                  <dd className="break-all font-mono text-[11px] text-muted-foreground">{response.publicOrigin ?? t("email.publicOriginNone")}</dd>
                </dl>
              </div>
            </Panel>
          </div>

          <div className="bench-panel mt-4 grid gap-3 px-4 py-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
            <div className="grid min-w-0 gap-1">
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                {response.settings.updatedAt === null
                  ? t("email.updatedNever")
                  : response.settings.updatedBy
                    ? t("email.updated", { date: formatDate(response.settings.updatedAt), actor: response.settings.updatedBy })
                    : t("email.updatedUnknownActor", { date: formatDate(response.settings.updatedAt) })}
              </p>
              {/* The reason the test button is disabled belongs beside the
                  button, not floating under the card. */}
              {!testable && <p className="text-[11px] leading-relaxed text-muted-foreground">{t("email.testBlocked")}</p>}
            </div>
            <div className="flex flex-wrap items-center gap-2 lg:justify-end">
              <Button type="button" variant="outline" disabled={testing || pending || !testable} onClick={() => void sendTest()}>
                {testing ? t("email.testing") : t("email.test")}
              </Button>
              <Button type="submit" disabled={pending}>{pending ? t("email.saving") : t("email.save")}</Button>
            </div>
          </div>
        </form>

        <div className="mt-4 grid gap-3">
          {error && <AlertBanner>{error}</AlertBanner>}
          {notice && <AlertBanner tone="success">{notice}</AlertBanner>}
          {testError && <AlertBanner>{testError}</AlertBanner>}
          {test && <AlertBanner tone={test.ok ? "success" : "error"}>
            {test.ok
              ? t("email.testSent", { address: test.to ?? "—" })
              : <span>
                {test.to ? t("email.testFailedTo", { address: test.to }) : t("email.testFailed")}
                {test.code && <span className="ml-1">{t(`email.code.${test.code}` as EmailMessageKey)}</span>}
                {test.message && <span className="mt-1 block break-words font-mono text-[10px] leading-relaxed">{test.message}</span>}
              </span>}
          </AlertBanner>}
        </div>

        <div className="mt-4">
          <DeliveryHistory deliveries={deliveries} failed={historyFailed} onRetry={() => void loadHistory()} />
        </div>
      </>}
  </>;
}

/** `email.error.<code>`, when the API named a code this screen knows. */
function messageFor(code: string | null, t: (key: EmailMessageKey) => string, fallback: EmailMessageKey = "email.saveError"): string {
  return isEmailErrorCode(code) ? t(`email.error.${code}` as EmailMessageKey) : t(fallback);
}

function SmtpFields({ draft, response, errorField, pending, onUpdate, onPreset }: {
  draft: EmailSettingsDraft;
  response: EmailSettingsResponse;
  errorField: EmailSettingsField | null;
  pending: boolean;
  onUpdate: <Key extends keyof EmailSettingsDraft>(key: Key, value: EmailSettingsDraft[Key]) => void;
  onPreset: (id: EmailPresetId) => void;
}) {
  const { t } = useScopedI18n(emailMessages);
  const preset = emailProviderPreset(draft.presetId);
  const secretLabel = t(`email.secret.${preset?.secretHint ?? "password"}` as EmailMessageKey);

  return <>
    <Field id="email-preset" label={t("email.preset")} description={t("email.presetHelp")}>
      {(a11y) => <Select value={draft.presetId} onValueChange={(value) => onPreset(value as EmailPresetId)}>
        <SelectTrigger {...a11y} className="w-full"><SelectValue /></SelectTrigger>
        <SelectContent position="popper">
          {smtpPresets(response.presets).map((item) => <SelectItem key={item.id} value={item.id}>{t(`email.preset.${item.id}` as EmailMessageKey)}</SelectItem>)}
        </SelectContent>
      </Select>}
    </Field>
    {/* The host owns the slack and the port stays narrow, so the two inputs
        share one top edge instead of a wide numeric box drifting off it. */}
    <div className="grid items-start gap-4 sm:grid-cols-[minmax(0,1fr)_7.5rem]">
      <Field id="email-host" label={t("email.host")} invalid={errorField === "smtpHost"}>
        {(a11y) => <Input {...a11y} value={draft.smtpHost} autoComplete="off" spellCheck={false} disabled={pending} onChange={(event) => onUpdate("smtpHost", event.target.value)} />}
      </Field>
      <Field id="email-port" label={t("email.port")} invalid={errorField === "smtpPort"}>
        {(a11y) => <Input {...a11y} inputMode="numeric" value={draft.smtpPort} autoComplete="off" disabled={pending} className="tabular-nums" onChange={(event) => onUpdate("smtpPort", event.target.value)} />}
      </Field>
    </div>
    <div className="grid items-start gap-4 sm:grid-cols-2">
      <Field id="email-security" label={t("email.security")} invalid={errorField === "smtpSecurity"}>
        {(a11y) => <Select value={draft.smtpSecurity} onValueChange={(value) => onUpdate("smtpSecurity", value as EmailSmtpSecurity)}>
          <SelectTrigger {...a11y} className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent position="popper">
            {SECURITIES.map((security) => <SelectItem key={security} value={security}>{t(`email.security.${security}` as EmailMessageKey)}</SelectItem>)}
          </SelectContent>
        </Select>}
      </Field>
      <Field
        id="email-username" label={t("email.username")} invalid={errorField === "smtpUsername"}
        description={draft.smtpUsername.trim() ? t(`email.usernameHint.${preset?.usernameHint ?? "unknown"}` as EmailMessageKey) : t("email.usernameEmptyHint")}
      >
        {(a11y) => <Input {...a11y} value={draft.smtpUsername} autoComplete="off" spellCheck={false} disabled={pending} onChange={(event) => onUpdate("smtpUsername", event.target.value)} />}
      </Field>
    </div>
    {draft.smtpSecurity === "none" && <AlertBanner tone="warning">{t("email.securityNoneWarning")}</AlertBanner>}
    <SecretField
      draft={draft} pending={pending} invalid={errorField === "secret"} label={secretLabel}
      configured={response.settings.secretConfigured} onUpdate={(value) => onUpdate("secret", value)}
    />
  </>;
}

/**
 * The stored value never comes back from the API, so this field is always empty
 * on arrival: a "configured" badge states that one exists, and leaving the box
 * untouched is what keeps it.
 */
function SecretField({ draft, pending, invalid, label, configured, onUpdate }: {
  draft: EmailSettingsDraft;
  pending: boolean;
  invalid: boolean;
  label: string;
  configured: boolean;
  onUpdate: (value: string) => void;
}) {
  const { t } = useScopedI18n(emailMessages);
  return <div className="grid gap-1.5">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <label htmlFor="email-secret" className="bench-label">{label}</label>
      <Badge variant="outline" className={cx("rounded-none border px-1.5 font-mono text-[9px] uppercase tracking-[0.12em]",
        configured ? "border-chart-2/45 text-chart-2" : "border-border text-muted-foreground")}>
        {configured ? t("email.secretConfigured") : t("email.secretMissing")}
      </Badge>
    </div>
    <Input
      id="email-secret" type="password" value={draft.secret} autoComplete="new-password" disabled={pending}
      aria-label={label} aria-describedby="email-secret-help" {...(invalid ? { "aria-invalid": true } : {})}
      onChange={(event) => onUpdate(event.target.value)}
    />
    <span id="email-secret-help" className="block text-[10px] leading-relaxed text-muted-foreground">
      {configured ? t("email.secretKeepHelp") : t("email.secretNewHelp")}
    </span>
  </div>;
}

function DeliveryHistory({ deliveries, failed, onRetry }: { deliveries: EmailDelivery[] | null; failed: boolean; onRetry: () => void }) {
  const { t } = useScopedI18n(emailMessages);
  return <Panel
    label={t("email.history")} title={t("email.historyDescription")} wrapTitle
    aside={<span className="font-mono text-[10px] text-muted-foreground tabular-nums">{deliveries?.length ?? 0}</span>}
  >
    {failed
      ? <div className="grid gap-4 px-4 py-5">
        <AlertBanner>{t("email.historyError")}</AlertBanner>
        <div><Button type="button" variant="outline" size="sm" onClick={onRetry}>{t("common.retry")}</Button></div>
      </div>
      : deliveries === null
        ? <Loading />
        : deliveries.length === 0
          ? <EmptyState title={t("email.historyEmpty")} description={t("email.historyEmptyDescription")} />
          : <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="bench-label w-full">{t("email.column.recipient")}</TableHead>
                <TableHead className="bench-label">{t("email.column.event")}</TableHead>
                <TableHead className="bench-label">{t("email.column.status")}</TableHead>
                <TableHead className="bench-label text-right">{t("email.column.attempts")}</TableHead>
                <TableHead className="bench-label hidden md:table-cell">{t("email.column.error")}</TableHead>
                <TableHead className="bench-label whitespace-nowrap">{t("email.column.time")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {deliveries.map((delivery) => <TableRow key={delivery.id}>
                <TableCell className="max-w-[16rem]">
                  <span className="block truncate text-xs font-medium" title={delivery.toAddress}>{delivery.toAddress}</span>
                  <span className="block truncate font-mono text-[10px] text-muted-foreground" title={delivery.subject}>{delivery.subject}</span>
                </TableCell>
                <TableCell className="whitespace-nowrap text-xs" title={delivery.event}>{emailEventLabel(delivery.event, t)}</TableCell>
                <TableCell>
                  <span className={cx("inline-flex h-5 items-center whitespace-nowrap border px-1.5 font-mono text-[9px] uppercase tracking-[0.12em]", statusTone[delivery.status])}>
                    {t(`email.status.${delivery.status}` as EmailMessageKey)}
                  </span>
                  {delivery.nextAttemptAt && delivery.status === "queued" && <span className="mt-1 block whitespace-nowrap font-mono text-[9px] text-muted-foreground">{t("email.nextAttempt", { date: formatDate(delivery.nextAttemptAt) })}</span>}
                </TableCell>
                <TableCell className="text-right font-mono text-[11px] tabular-nums">{delivery.attempts}</TableCell>
                <TableCell className="hidden max-w-[18rem] md:table-cell">
                  <span className="block truncate font-mono text-[10px] text-muted-foreground" title={delivery.lastError ?? undefined}>{delivery.lastError ?? "—"}</span>
                </TableCell>
                <TableCell className="whitespace-nowrap text-xs text-muted-foreground" title={delivery.sentAt ?? delivery.createdAt}>
                  {formatDate(delivery.sentAt ?? delivery.createdAt)}
                </TableCell>
              </TableRow>)}
            </TableBody>
          </Table>}
  </Panel>;
}

/**
 * One label, one control, one optional help line — the same three-row shape
 * every field on this page uses, so two fields side by side always share a top
 * edge no matter which of them carries a hint.
 */
function Field({ id, label, description, invalid, children }: {
  id: string;
  label: string;
  description?: string;
  invalid?: boolean;
  children: (a11y: { id: string; "aria-label": string; "aria-describedby"?: string; "aria-invalid"?: true }) => ReactNode;
}) {
  const describedBy = description ? `${id}-help` : undefined;
  return <div className="grid gap-1.5">
    <label htmlFor={id} className="bench-label">{label}</label>
    {children({ id, "aria-label": label, ...(describedBy ? { "aria-describedby": describedBy } : {}), ...(invalid ? { "aria-invalid": true } : {}) })}
    {description && <span id={describedBy} className="block text-[10px] leading-relaxed text-muted-foreground">{description}</span>}
  </div>;
}
