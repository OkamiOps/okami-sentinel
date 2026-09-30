import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  ACCOUNT_NOTIFICATION_EVENTS,
  OPS_NOTIFICATION_SCOPE,
  UNASSIGNED_NOTIFICATION_SCOPE,
  type AccountNotificationsResponse,
  type NotificationEventState,
} from "@csb/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { AlertBanner, EmptyState, Loading, Panel, cx } from "../ui";
import { notificationsApi } from "../../lib/email-api";
import { cellKey, cellState, withCell, type NotificationCell } from "../../lib/notification-matrix";
import { emailMessages, type EmailMessageKey } from "../../i18n/email";
import { useScopedI18n } from "../../i18n/scoped";

/**
 * Minha conta → Notificações. The anchor id is what the footer of every
 * repository and operational e-mail links to, so it has to exist on this
 * element and not on a wrapper the page might stop rendering.
 */
export function NotificationsPanel({ local = false }: { local?: boolean }) {
  const { t } = useScopedI18n(emailMessages);
  const [matrix, setMatrix] = useState<AccountNotificationsResponse | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingCells, setPendingCells] = useState<readonly string[]>([]);

  const load = useCallback(async () => {
    if (local) return;
    setLoadFailed(false);
    try {
      setMatrix(await notificationsApi.get());
    } catch {
      setMatrix(null);
      setLoadFailed(true);
    }
  }, [local]);

  useEffect(() => { void load(); }, [load]);

  /**
   * The cell flips first: a checkbox that snaps back while the request is in
   * flight reads as a refusal. A real refusal restores the stored value — the
   * API validates the whole batch before writing anything, so the matrix on
   * file is exactly what it was.
   */
  async function toggle(cell: NotificationCell, enabled: boolean) {
    const restore = matrix;
    const key = cellKey(cell);
    setError(null);
    setMatrix((current) => current === null ? current : withCell(current, cell, enabled));
    setPendingCells((current) => [...current, key]);
    try {
      setMatrix(await notificationsApi.update([{ scope: cell.scope, event: cell.event, enabled }]));
    } catch {
      setMatrix(restore);
      setError(t("notifications.saveError"));
    } finally {
      setPendingCells((current) => current.filter((item) => item !== key));
    }
  }

  return <Panel
    id="notifications" label={t("notifications.title")} title={t("notifications.subtitle")}
    aside={matrix?.address ? <span className="hidden max-w-[16rem] truncate font-mono text-[10px] text-muted-foreground sm:block" title={matrix.address}>{matrix.address}</span> : null}
  >
    <p className="border-b px-4 py-3 text-xs leading-relaxed text-muted-foreground">{t("notifications.description")}</p>
    {local
      ? <div className="px-4 py-4"><AlertBanner tone="info">{t("notifications.localNote")}</AlertBanner></div>
      : loadFailed
      ? <div className="grid gap-4 px-4 py-5">
        <AlertBanner>{t("notifications.loadError")}</AlertBanner>
        <div><Button type="button" variant="outline" size="sm" onClick={() => void load()}>{t("common.retry")}</Button></div>
      </div>
      : matrix === null
        ? <Loading />
        : <div className="grid gap-px bg-border">
          {matrix.address === null && <div className="bg-card px-4 py-4">
            {/* This build's profile panel has no e-mail field — only an
                administrator can fill one in — so the warning points at the
                person who can act instead of at a control that is not there. */}
            <AlertBanner tone="warning">
              <span className="mr-1">{t("notifications.noAddress")}</span>
              {t("notifications.noAddressFix")}
            </AlertBanner>
          </div>}
          {error && <div className="bg-card px-4 py-4"><AlertBanner>{error}</AlertBanner></div>}

          <ScopeGroup title={t("notifications.repositories")}>
            {matrix.repositories.length === 0
              ? <EmptyState compact title={t("notifications.repositoriesEmpty")} description={t("notifications.repositoriesEmptyDescription")} />
              : <MatrixRows
                rows={matrix.repositories.map((repository) => ({
                  scope: repository.repositoryKey,
                  label: repository.displayName,
                  detail: repository.repositoryKey,
                  events: repository.events,
                }))}
                pendingCells={pendingCells} onToggle={toggle}
              />}
          </ScopeGroup>

          {matrix.ops && <ScopeGroup title={t("notifications.ops")} description={t("notifications.opsDescription")}>
            <MatrixRows
              rows={[{ scope: OPS_NOTIFICATION_SCOPE, label: t("notifications.ops"), detail: null, events: matrix.ops.events }]}
              pendingCells={pendingCells} onToggle={toggle}
            />
          </ScopeGroup>}

          {matrix.unassigned && <ScopeGroup title={t("notifications.unassigned")} description={t("notifications.unassignedDescription")}>
            <MatrixRows
              rows={[{ scope: UNASSIGNED_NOTIFICATION_SCOPE, label: t("notifications.unassigned"), detail: null, events: matrix.unassigned.events }]}
              pendingCells={pendingCells} onToggle={toggle}
            />
          </ScopeGroup>}

          <ScopeGroup title={t("notifications.accountEvents")} description={t("notifications.accountDescription")}>
            <ul className="flex flex-wrap gap-2 px-4 py-3">
              {(matrix.accountEvents.length === 0 ? ACCOUNT_NOTIFICATION_EVENTS : matrix.accountEvents).map((event) => <li key={event}>
                <Badge variant="outline" className="rounded-none border-chart-2/40 px-2 py-1 text-[10px] font-normal text-foreground">
                  <span className="text-chart-2">✓</span>
                  <span className="ml-1">{t(`notifications.event.${event}` as EmailMessageKey)}</span>
                </Badge>
              </li>)}
            </ul>
            <p className="px-4 pb-3 font-mono text-[9px] uppercase tracking-[0.12em] text-muted-foreground">{t("notifications.accountAlwaysOn")}</p>
          </ScopeGroup>

          <div className="bg-card px-4 py-3">
            <p className="text-[11px] leading-relaxed text-muted-foreground">{t("notifications.defaultNote")}</p>
          </div>
        </div>}
  </Panel>;
}

function ScopeGroup({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return <section className="bg-card">
    <header className="px-4 pb-2 pt-3">
      <h3 className="bench-label">{title}</h3>
      {description && <p className="mt-1 max-w-2xl text-[11px] leading-relaxed text-muted-foreground">{description}</p>}
    </header>
    {children}
  </section>;
}

/**
 * Tailwind generates classes it can find in the source, so the three column
 * counts the matrix actually has (two for the unassigned scope, four for ops,
 * five for a repository) are written out instead of interpolated.
 */
const COLUMN_TEMPLATES: Readonly<Record<number, string>> = Object.freeze({
  2: "sm:grid-cols-[minmax(7rem,1fr)_repeat(2,minmax(0,6.5rem))]",
  4: "sm:grid-cols-[minmax(7rem,1fr)_repeat(4,minmax(0,6.5rem))]",
  5: "sm:grid-cols-[minmax(7rem,1fr)_repeat(5,minmax(0,6.5rem))]",
});

interface MatrixRow {
  scope: string;
  label: string;
  detail: string | null;
  events: NotificationEventState[];
}

/**
 * One row per scope, one cell per event. Above `sm` the cells line up under a
 * header of event names — the matrix the design asks for. Below it the header
 * would not fit, so every cell carries its own name and the row becomes a
 * stack: one DOM, one checkbox per cell, and the same accessible name at both
 * widths.
 */
function MatrixRows({ rows, pendingCells, onToggle }: {
  rows: MatrixRow[];
  pendingCells: readonly string[];
  onToggle: (cell: NotificationCell, enabled: boolean) => void;
}) {
  const { t } = useScopedI18n(emailMessages);
  // Every row of one group carries the same events in the same order, so the
  // header can be read off the first one.
  const columns = rows[0]?.events.map((state) => state.event) ?? [];
  const template = COLUMN_TEMPLATES[columns.length] ?? COLUMN_TEMPLATES[5];

  return <div>
    <div className={cx("hidden border-b border-border/70 px-4 pb-2 sm:grid sm:items-end sm:gap-2", template)} aria-hidden="true">
      <span />
      {columns.map((event) => <span key={event} className="bench-label text-center leading-tight">
        {t(`notifications.event.${event}` as EmailMessageKey)}
      </span>)}
    </div>
    <ul className="divide-y divide-border">
      {rows.map((row) => <li key={row.scope} className={cx("grid gap-2 px-4 py-3 sm:items-center", template)}>
        <div className="min-w-0">
          <span className="block truncate text-xs font-medium" title={row.label}>{row.label}</span>
          {row.detail && <span className="block truncate font-mono text-[10px] text-muted-foreground" title={row.detail}>{row.detail}</span>}
        </div>
        {row.events.map((state) => {
          const label = t("notifications.cellLabel", { event: t(`notifications.event.${state.event}` as EmailMessageKey), scope: row.label });
          const key = cellKey({ scope: row.scope, event: state.event });
          return <label key={state.event} className="flex min-w-0 items-center justify-between gap-3 border-t border-border/50 pt-2 first-of-type:border-t-0 sm:justify-center sm:border-t-0 sm:pt-0">
            <span className="min-w-0 truncate text-xs text-muted-foreground sm:hidden">{t(`notifications.event.${state.event}` as EmailMessageKey)}</span>
            <Checkbox
              checked={state.enabled} aria-label={label} disabled={pendingCells.includes(key)}
              onCheckedChange={(checked) => onToggle({ scope: row.scope, event: state.event }, checked === true)}
            />
          </label>;
        })}
      </li>)}
    </ul>
  </div>;
}
