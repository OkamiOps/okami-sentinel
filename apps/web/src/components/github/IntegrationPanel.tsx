import { useState } from "react";
import { AlertTriangle, ArrowUpRight, Check, Copy, RefreshCw, X } from "lucide-react";

import { AlertBanner, EmptyState, FormFeedback, Panel, Readout, cx } from "../ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatDate } from "../../format";
import type {
  GitHubIntegrationConnection,
  GitHubIntegrationStatus,
} from "../../lib/github-actions-api";
import { DeliveryList } from "./DeliveryList";
import { deliveryOutcomeTone, safeExternalUrl, type GitHubT } from "./labels";

/**
 * `01 INTEGRAÇÃO`, administrator only. Every block answers one question of the
 * checklist below it, in the order the operator has to solve them: who the App is,
 * what it was granted, what it subscribes to, how far it reaches, where the events
 * arrive, and what is still missing.
 */
export function IntegrationPanel({
  status,
  unavailable,
  t,
  canEdit,
  secretState,
  reconciling,
  reconcileNotice,
  reconcileError,
  deliveries,
  onSaveSecret,
  onReconcile,
  onRetry,
}: {
  status: GitHubIntegrationStatus | null;
  /** The read failed, as opposed to succeeding with nothing to show. */
  unavailable: boolean;
  t: GitHubT;
  canEdit: boolean;
  /** Which connection's form is busy and what it has to say; `null` for none. */
  secretState: { connectionId: string; busy: boolean; notice: string | null; error: string | null } | null;
  reconciling: boolean;
  reconcileNotice: string | null;
  reconcileError: string | null;
  deliveries: GitHubIntegrationStatus["deliveries"]["last"][] | null;
  onSaveSecret: (connectionId: string, secret: string) => void;
  onReconcile: () => void;
  onRetry: () => void;
}) {
  if (status === null) {
    // One statement of the outage, inside the panel that failed, with the way out.
    // The page used to print the same sentence in a banner above an empty panel
    // that repeated it and offered nothing.
    return <Panel label={t("github.integration")} title={t("github.integrationTitle")}>
      <EmptyState
        title={unavailable ? t("github.integration.unavailable") : t("github.integration.none")}
        description={unavailable ? t("github.integration.unavailableDetail") : t("github.integration.noneDescription")}
      >
        {unavailable && <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          {t("common.retry")}
        </Button>}
      </EmptyState>
    </Panel>;
  }
  if (status.connections.length === 0) {
    return <Panel label={t("github.integration")} title={t("github.integrationTitle")}>
      <EmptyState
        title={t("github.integration.none")}
        description={t("github.integration.noneDescription")}
      />
    </Panel>;
  }

  return <div className="grid min-w-0 gap-4">
    {status.connections.map((connection) => <ConnectionBlock
      key={connection.connectionId}
      connection={connection}
      t={t}
      canEdit={canEdit}
      secret={secretState?.connectionId === connection.connectionId ? secretState : null}
      onSaveSecret={onSaveSecret}
    />)}

    {/* The checklist is eight rows; the 24 h panel is four. Side by side the right
        column ended in a third of a screen of white, so the deliveries list — which
        is long — stacks under the reconcile panel and fills it. */}
    <div className="grid min-w-0 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(22rem,.62fr)]">
      <ChecklistPanel status={status} t={t} />
      <div className="grid min-w-0 content-start gap-4">
        <ReconcilePanel
          status={status}
          t={t}
          canEdit={canEdit}
          reconciling={reconciling}
          notice={reconcileNotice}
          error={reconcileError}
          onReconcile={onReconcile}
        />
        <DeliveryList deliveries={deliveries} t={t} />
      </div>
    </div>
  </div>;
}

function ConnectionBlock({
  connection,
  t,
  canEdit,
  secret,
  onSaveSecret,
}: {
  connection: GitHubIntegrationConnection;
  t: GitHubT;
  canEdit: boolean;
  /** `null` unless this is the connection whose form was last submitted. */
  secret: { busy: boolean; notice: string | null; error: string | null } | null;
  onSaveSecret: (connectionId: string, secret: string) => void;
}) {
  const appUrl = safeExternalUrl(`https://github.com/settings/apps/${connection.appSlug}`);
  const mismatch = connection.appId !== null && connection.recordedAppId !== null
    && connection.appId !== connection.recordedAppId;
  const stateTone = connection.installationsState === "active"
    ? "text-chart-2"
    : connection.installationsState === "suspended" ? "text-destructive" : "text-chart-3";

  return <Panel
    label={t("github.integration")}
    title={connection.appName}
    wrapTitle
    aside={<StateChip
      label={t(`github.installationsState.${connection.installationsState}`)}
      tone={connection.installationsState === "active" ? "good" : connection.installationsState === "suspended" ? "risk" : "signal"}
    />}
  >
    <p className="border-b px-4 py-3 text-xs leading-relaxed text-muted-foreground">{t("github.integrationDescription")}</p>

    <section aria-label={t("github.identity")} className="border-b">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 pt-4">
        <div className="bench-label text-primary">{t("github.identity")}</div>
        {appUrl && <Button asChild variant="outline" size="sm">
          <a href={appUrl} target="_blank" rel="noreferrer">{t("github.identity.openApp")}<ArrowUpRight aria-hidden className="size-3" /></a>
        </Button>}
      </div>
      <dl className="grid sm:grid-cols-2 lg:grid-cols-4">
        <Cell label={t("github.identity.name")} value={connection.appName} />
        <Cell label={t("github.identity.slug")} value={connection.appSlug} mono />
        <Cell label={t("github.identity.appId")} value={connection.appId ?? "—"} mono />
        <Cell
          label={t("github.identity.recordedAppId")}
          value={connection.recordedAppId ?? "—"}
          mono
          tone={mismatch ? "risk" : undefined}
        />
      </dl>
      {mismatch && <div className="px-4 pb-4"><AlertBanner tone="warning">{t("github.identity.appIdMismatch")}</AlertBanner></div>}
      {connection.installationsState !== "active" && <p className={cx("border-t px-4 py-3 text-xs leading-relaxed", stateTone)}>
        {t(`github.installationsState.${connection.installationsState}Detail`)}
      </p>}
    </section>

    <section aria-label={t("github.permissions")} className="border-b">
      <div className="px-4 pt-4">
        <div className="bench-label text-primary">{t("github.permissions")}</div>
        <h3 className="mt-1 text-sm font-semibold">{t("github.permissionsTitle")}</h3>
      </div>
      {/* A header row, so "write / write" under nothing is not two anonymous
          columns. The same labels repeat inline below `sm`, where the row stacks. */}
      <div className="mt-3 hidden grid-cols-[minmax(0,1fr)_7rem_7rem_14rem] items-center gap-2 border-t bg-secondary/[.16] px-4 py-2 sm:grid">
        <span className="bench-label">{t("github.permissions.name")}</span>
        <span className="bench-label">{t("github.permissions.required")}</span>
        <span className="bench-label">{t("github.permissions.granted")}</span>
        <span />
      </div>
      <div className="divide-y border-t">
        {connection.permissions.map((permission) => {
          // The review link belongs to every unmet permission, not only the ones
          // GitHub reports as pending: a level that was never asked for is fixed on
          // the same page, and a row that names what is missing without offering the
          // way to fix it is the tab the operator called stuck.
          const review = permission.ok
            ? undefined
            : permission.pendingInstallationIds
              .map((id) => connection.installations.find((item) => item.installationId === id))
              .find((item) => item !== undefined) ?? connection.installations[0];
          return <div
            key={permission.name}
            className={cx(
              "grid min-w-0 items-center gap-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_7rem_7rem_14rem]",
              !permission.ok && "bg-chart-3/[.06]",
            )}
          >
            <span className="min-w-0 break-all font-mono text-[11px]">{permission.name}</span>
            <span className="font-mono text-[10px] text-muted-foreground">
              <span className="bench-label mr-1 inline sm:hidden">{t("github.permissions.required")}</span>
              {permission.required}
            </span>
            <span className={cx("font-mono text-[10px]", permission.ok ? "text-chart-2" : "text-chart-3")}>
              <span className="bench-label mr-1 inline sm:hidden">{t("github.permissions.granted")}</span>
              {permission.granted ?? t("github.permissions.none")}
            </span>
            <span className="flex flex-wrap items-center gap-2 sm:justify-end">
              <OkBadge ok={permission.ok} okLabel={t("github.permissions.ok")} failLabel={t("github.permissions.missing")} />
              {permission.pendingInstallationIds.length > 0 && <span className="font-mono text-[9px] text-chart-3">
                {t("github.permissions.pending", { count: permission.pendingInstallationIds.length })}
              </span>}
              {review && safeExternalUrl(review.manageUrl) && <Button asChild variant="outline" size="sm">
                <a href={safeExternalUrl(review.manageUrl)!} target="_blank" rel="noreferrer">{t("github.permissions.review")}<ArrowUpRight aria-hidden className="size-3" /></a>
              </Button>}
            </span>
          </div>;
        })}
      </div>
      <p className="border-t px-4 py-3 text-[11px] leading-relaxed text-muted-foreground">{t("github.permissions.hint")}</p>
    </section>

    <section aria-label={t("github.events")} className="border-b">
      <div className="px-4 pt-4">
        <div className="bench-label text-primary">{t("github.events")}</div>
        <h3 className="mt-1 text-sm font-semibold">{t("github.eventsTitle")}</h3>
      </div>
      <div className="mt-3 grid border-t sm:grid-cols-2 lg:grid-cols-3">
        {connection.events.map((event) => <div
          key={event.name}
          className={cx(
            "flex min-w-0 items-center justify-between gap-3 border-b border-r px-4 py-3",
            !event.subscribed && "bg-chart-3/[.06]",
          )}
        >
          <span className="min-w-0 break-all font-mono text-[11px]">{event.name}</span>
          <OkBadge
            ok={event.subscribed}
            okLabel={t("github.events.subscribed")}
            failLabel={t("github.events.missing")}
          />
        </div>)}
      </div>
    </section>

    <section aria-label={t("github.scope")} className="border-b">
      <div className="px-4 pt-4">
        <div className="bench-label text-primary">{t("github.scope")}</div>
        <h3 className="mt-1 text-sm font-semibold">{t("github.scopeTitle")}</h3>
      </div>
      {connection.installations.length === 0
        ? <div className="mt-3 border-t"><EmptyState compact title={t(`github.installationsState.${connection.installationsState}`)} description={t(`github.installationsState.${connection.installationsState}Detail`)} /></div>
        : <div className="mt-3 divide-y border-t">
          {connection.installations.map((installation) => {
            const manageUrl = safeExternalUrl(installation.manageUrl);
            return <div key={installation.installationId} className="grid min-w-0 gap-3 px-4 py-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
              <div className="grid min-w-0 gap-3 sm:grid-cols-4">
                <Readout label={t("github.identity.installations")} value={installation.account} wrap />
                <Readout label={t("github.scope.authorized")} value={installation.authorizedRepositoryCount} />
                <Readout label={t("github.scope.enrolled")} value={installation.enrolledRepositoryCount} tone={installation.enrolledRepositoryCount ? "good" : undefined} />
                <Readout
                  label={t("github.scope.selection")}
                  value={t(`github.scope.selection.${installation.repositorySelection}`)}
                  detail={installation.suspended ? t("github.scope.suspended") : undefined}
                  tone={installation.suspended ? "risk" : undefined}
                  wrap
                />
              </div>
              {manageUrl && <Button asChild variant="configuration" size="sm" className="justify-between lg:w-64">
                <a href={manageUrl} target="_blank" rel="noreferrer">
                  {installation.suspended ? t("github.scope.resume") : t("github.scope.expand")}
                  <ArrowUpRight aria-hidden className="size-3" />
                </a>
              </Button>}
            </div>;
          })}
        </div>}
      <p className="border-t px-4 py-3 text-[11px] leading-relaxed text-muted-foreground">{t("github.scope.hint")}</p>
    </section>

    <WebhookSection
      connection={connection}
      t={t}
      canEdit={canEdit}
      busy={secret?.busy === true}
      notice={secret?.notice ?? null}
      error={secret?.error ?? null}
      onSaveSecret={onSaveSecret}
    />
  </Panel>;
}

function WebhookSection({
  connection,
  t,
  canEdit,
  busy,
  notice,
  error,
  onSaveSecret,
}: {
  connection: GitHubIntegrationConnection;
  t: GitHubT;
  canEdit: boolean;
  busy: boolean;
  notice: string | null;
  error: string | null;
  onSaveSecret: (connectionId: string, secret: string) => void;
}) {
  const [secret, setSecret] = useState("");
  const [copied, setCopied] = useState(false);
  const inputId = `github-webhook-secret-${connection.connectionId}`;
  /**
   * The step is unmet *and* a delivery did verify once: the secret was rotated and
   * the old proof retired. Without this branch the panel printed the amber "the
   * integration is still ready" next to the field the operator had just pasted into,
   * while the checklist two panels below showed the same step red — and the
   * reassuring sentence is the one they read.
   */
  const proofRetired = connection.missing.includes("delivery_verified")
    && connection.lastVerifiedDeliveryAt !== null;
  const verified = !connection.missing.includes("delivery_verified");

  async function copy() {
    if (!connection.webhookUrl) return;
    try {
      await navigator.clipboard.writeText(connection.webhookUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // A browser that refuses the clipboard leaves the URL selectable on screen.
    }
  }

  return <section aria-label={t("github.webhook")}>
    <div className="px-4 pt-4">
      <div className="bench-label text-primary">{t("github.webhook")}</div>
      <h3 className="mt-1 text-sm font-semibold">{t("github.webhookTitle")}</h3>
    </div>

    <div className="mt-3 border-t p-4">
      <div className="bench-label">{t("github.webhook.url")}</div>
      {connection.webhookUrl
        ? <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2">
          <code className="min-w-0 flex-1 break-all border border-primary/35 bg-primary/[.04] px-3 py-2 font-mono text-[11px] leading-relaxed">{connection.webhookUrl}</code>
          <Button type="button" variant="outline" size="sm" onClick={() => void copy()}>
            <Copy aria-hidden className="size-3" />{copied ? t("github.webhook.copied") : t("github.webhook.copy")}
          </Button>
        </div>
        : <p className="mt-2 text-xs leading-relaxed text-chart-3">{t("github.webhook.noUrl")}</p>}
    </div>

    <dl className="grid border-t sm:grid-cols-2">
      <Cell
        label={t("github.webhook.secret")}
        value={connection.webhookSecretConfigured ? t("github.webhook.secretConfigured") : t("github.webhook.secretMissing")}
        tone={connection.webhookSecretConfigured ? "good" : "risk"}
      />
      <Cell
        label={t("github.checklist.delivery_verified")}
        value={connection.lastVerifiedDeliveryAt === null
          ? t("github.webhook.never")
          : formatDate(connection.lastVerifiedDeliveryAt)}
        tone={!verified ? "risk" : connection.deliveryVerifiedStale ? "signal" : "good"}
      />
    </dl>

    {/* One sentence, and only when there is something to say. The happy path says
        nothing here: the cell above already prints the timestamp, and printing it
        twice two lines apart was the duplication the operator spotted. */}
    {!verified && <div className="border-t px-4 py-3">
      <div className="grid gap-2">
        <p className="text-xs leading-relaxed text-destructive">
          {proofRetired ? t("github.delivery.proofRetired") : t("github.delivery.neverVerified")}
        </p>
        <p className="text-xs leading-relaxed text-muted-foreground">{t("github.delivery.pingHint")}</p>
      </div>
    </div>}
    {verified && connection.deliveryVerifiedStale && <div className="border-t px-4 py-3">
      <div className="flex min-w-0 items-start gap-2">
        <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0 text-chart-3" />
        <p className="min-w-0 text-xs leading-relaxed text-chart-3">
          {t("github.delivery.stale", { count: connection.deliveryVerifiedAgeDays ?? 0 })}
          {" "}
          <span className="text-muted-foreground">{t("github.delivery.staleDetail")}</span>
        </p>
      </div>
    </div>}

    {canEdit && <form
      className="grid gap-3 border-t p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end"
      onSubmit={(event) => {
        event.preventDefault();
        onSaveSecret(connection.connectionId, secret);
        setSecret("");
      }}
    >
      <div className="min-w-0">
        <label className="bench-label" htmlFor={inputId}>{t("github.webhook.secretNew")}</label>
        <div className="mt-2">
          {/* A password input, never a readback: the stored value is not fetchable. */}
          <Input
            id={inputId}
            type="password"
            autoComplete="new-password"
            value={secret}
            placeholder={t("github.webhook.secretPlaceholder")}
            onChange={(event) => setSecret(event.target.value)}
          />
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">{t("github.webhook.secretHint")}</p>
      </div>
      <Button type="submit" className="min-h-11" disabled={busy || secret.trim().length === 0}>
        {busy
          ? t("github.webhook.saving")
          : connection.webhookSecretConfigured ? t("github.webhook.rotate") : t("github.webhook.save")}
      </Button>
      <div className="sm:col-span-2"><FormFeedback notice={notice} error={error} /></div>
    </form>}
  </section>;
}

function ChecklistPanel({ status, t }: { status: GitHubIntegrationStatus; t: GitHubT }) {
  return <Panel label={t("github.checklist")} title={t("github.checklistTitle")} wrapTitle>
    <ol className="divide-y">
      {status.checklist.map((item, index) => <li key={item.id} className="grid min-w-0 grid-cols-[2.5rem_1.25rem_minmax(0,1fr)_auto] items-center gap-2 px-4 py-3">
        <span className="font-mono text-[9px] text-muted-foreground">{String(index + 1).padStart(2, "0")}</span>
        <span className={cx(
          "grid size-5 place-items-center border",
          item.ok ? "border-chart-2/60 text-chart-2" : "border-destructive/50 text-destructive",
        )}>
          {item.ok ? <Check aria-hidden className="size-3" /> : <X aria-hidden className="size-3" />}
        </span>
        <span className="min-w-0 text-xs">{t(`github.checklist.${item.id}`)}</span>
        <span className={cx(
          "shrink-0 border px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-wider",
          item.ok ? "border-chart-2/45 text-chart-2" : "border-destructive/45 text-destructive",
        )}>
          {item.ok ? t("github.checklist.ok") : t("github.checklist.pending")}
        </span>
      </li>)}
    </ol>
    <p className="border-t px-4 py-3 text-[11px] leading-relaxed text-muted-foreground">{t("github.checklist.hint")}</p>
  </Panel>;
}

function ReconcilePanel({
  status,
  t,
  canEdit,
  reconciling,
  notice,
  error,
  onReconcile,
}: {
  status: GitHubIntegrationStatus;
  t: GitHubT;
  canEdit: boolean;
  reconciling: boolean;
  notice: string | null;
  error: string | null;
  onReconcile: () => void;
}) {
  const last = status.deliveries.last;
  return <Panel
    label={t("github.deliveries24h")}
    title={t("github.webhook.last24h")}
    aside={canEdit && <Button type="button" variant="outline" size="sm" disabled={reconciling} onClick={onReconcile}>
      <RefreshCw aria-hidden className={cx("size-3", reconciling && "animate-spin motion-reduce:animate-none")} />
      {reconciling ? t("github.reconciling") : t("github.reconcile")}
    </Button>}
  >
    <div className="grid grid-cols-3 gap-px bg-border">
      <Cell label={t("github.outcome.processed")} value={status.deliveries.last24h.processed} tone={status.deliveries.last24h.processed ? "good" : undefined} bare />
      <Cell label={t("github.outcome.ignored")} value={status.deliveries.last24h.ignored} bare />
      <Cell label={t("github.outcome.failed")} value={status.deliveries.last24h.failed} tone={status.deliveries.last24h.failed ? "risk" : undefined} bare />
    </div>
    <dl className="grid border-t sm:grid-cols-2">
      <Cell label={t("github.webhook.lastDelivery")} value={last === null ? t("github.webhook.never") : formatDate(last.receivedAt)} />
      <Cell label={t("github.reconcile.lastAt")} value={status.reconciliation.lastAt === null ? t("github.webhook.never") : formatDate(status.reconciliation.lastAt)} />
    </dl>
    {last !== null && <div className="flex flex-wrap items-center gap-2 border-t px-4 py-3">
      <span className={cx("border px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-wider", deliveryOutcomeTone[last.outcome])}>
        {t(`github.outcome.${last.outcome}`)}
      </span>
      <span className="min-w-0 break-all font-mono text-[10px] text-muted-foreground">{last.event}{last.action ? ` · ${last.action}` : ""}</span>
    </div>}
    <div className="border-t px-4 py-3">
      <Readout label={t("github.reconcile.recovered")} value={status.reconciliation.recoveredLast24h} />
    </div>
    {(notice || error) && <div className="border-t p-4"><FormFeedback notice={notice} error={error} /></div>}
  </Panel>;
}

function Cell({
  label,
  value,
  mono = false,
  tone,
  bare = false,
}: {
  label: string;
  value: string | number;
  mono?: boolean;
  tone?: "good" | "risk" | "signal";
  bare?: boolean;
}) {
  return <div className={cx("min-w-0 border-b border-r p-4", bare && "border-0 bg-card")}>
    <dt className="bench-label">{label}</dt>
    <dd className={cx(
      "mt-2 break-all text-xs leading-relaxed",
      mono && "font-mono text-[11px]",
      tone === "good" && "text-chart-2",
      tone === "risk" && "text-destructive",
      tone === "signal" && "text-chart-3",
    )}>{value}</dd>
  </div>;
}

function OkBadge({ ok, okLabel, failLabel }: { ok: boolean; okLabel: string; failLabel: string }) {
  return <span className={cx(
    "inline-flex h-5 shrink-0 items-center gap-1 border px-1.5 font-mono text-[8px] uppercase tracking-wider",
    ok ? "border-chart-2/45 text-chart-2" : "border-chart-3/45 text-chart-3",
  )}>
    {ok ? <Check aria-hidden className="size-2.5" /> : <X aria-hidden className="size-2.5" />}
    {ok ? okLabel : failLabel}
  </span>;
}

function StateChip({ label, tone }: { label: string; tone: "good" | "risk" | "signal" }) {
  return <span className={cx(
    "inline-flex h-6 items-center gap-1.5 border px-2 font-mono text-[9px] uppercase tracking-wider",
    tone === "good" && "border-chart-2/45 text-chart-2",
    tone === "risk" && "border-destructive/45 text-destructive",
    tone === "signal" && "border-chart-3/45 text-chart-3",
  )}>
    <span className="size-1.5 rounded-full bg-current" />{label}
  </span>;
}
