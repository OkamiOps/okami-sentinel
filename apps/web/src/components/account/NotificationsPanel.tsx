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
import { cellKey, cellState, withCell, withCellState, type NotificationCell } from "../../lib/notification-matrix";
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
   * flight reads as a refusal.
   *
   * Everything here is per cell, because two toggles can be in flight at once.
   * The reply carries the whole matrix, but only the cell this request was
   * about is taken from it — adopting the rest would undo a second toggle the
   * server had not seen yet when it composed this answer. A refusal restores
   * the one cell's previous state, captured before the optimistic write, and
   * leaves every other cell (including one confirmed meanwhile) alone.
   */
  async function toggle(cell: NotificationCell, enabled: boolean) {
    const key = cellKey(cell);
    setError(null);
    // Safe to read from this render: the cell is disabled while its own
    // request is in flight, so nothing else can have moved it meanwhile.
    const previous = matrix === null ? null : cellState(matrix, cell);
    setMatrix((current) => current === null ? current : withCell(current, cell, enabled));
    setPendingCells((current) => [...current, key]);
    try {
      const reply = await notificationsApi.update([{ scope: cell.scope, event: cell.event, enabled }]);
      setMatrix((current) => current === null ? reply : withCellState(current, cell, cellState(reply, cell)));
    } catch {
      setMatrix((current) => current === null ? current : withCellState(current, cell, previous));
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
      ? <div className="px-4 pt-4"><AlertBanner tone="info">{t("notifications.localNote")}</AlertBanner></div>
      : loadFailed
      ? <div className="grid gap-4 px-4 py-5">
        <AlertBanner>{t("notifications.loadError")}</AlertBanner>
        <div><Button type="button" variant="outline" size="sm" onClick={() => void load()}>{t("common.retry")}</Button></div>
      </div>
      : matrix === null
        ? <Loading />
        : <div className="grid gap-px bg-border">
          {/* `AlertBanner` carries its own `mb-4`; the wrapper supplies the
              top padding only, or the gap below it doubles. */}
          {matrix.address === null && <div className="bg-card px-4 pt-4">
            {/* This build's profile panel has no e-mail field — only an
                administrator can fill one in — so the warning points at the
                person who can act instead of at a control that is not there. */}
            <AlertBanner tone="warning">
              <span className="mr-1">{t("notifications.noAddress")}</span>
              {t("notifications.noAddressFix")}
            </AlertBanner>
          </div>}
          {error && <div className="bg-card px-4 pt-4"><AlertBanner>{error}</AlertBanner></div>}

          <ScopeGroup title={t("notifications.repositories")}>
            {matrix.repositories.length === 0
              ? <EmptyState compact title={t("notifications.repositoriesEmpty")} description={t("notifications.repositoriesEmptyDescription")} />
              : <MatrixRows
                rows={matrix.repositories.map((repository) => ({
                  scope: repository.repositoryKey,
                  label: repository.displayName,
                  scopeName: repository.displayName,
                  detail: repository.repositoryKey,
                  events: repository.events,
                }))}
                pendingCells={pendingCells} onToggle={toggle}
              />}
          </ScopeGroup>

          {matrix.ops && <ScopeGroup title={t("notifications.ops")} description={t("notifications.opsDescription")}>
            <MatrixRows
              rows={[{ scope: OPS_NOTIFICATION_SCOPE, label: t("notifications.opsRow"), scopeName: t("notifications.ops"), detail: null, events: matrix.ops.events }]}
              pendingCells={pendingCells} onToggle={toggle}
            />
          </ScopeGroup>}

          {matrix.unassigned && <ScopeGroup title={t("notifications.unassigned")} description={t("notifications.unassignedDescription")}>
            <MatrixRows
              rows={[{ scope: UNASSIGNED_NOTIFICATION_SCOPE, label: t("notifications.unassignedRow"), scopeName: t("notifications.unassigned"), detail: null, events: matrix.unassigned.events }]}
              pendingCells={pendingCells} onToggle={toggle}
            />
          </ScopeGroup>}

          <ScopeGroup
            title={t("notifications.accountEvents")} description={t("notifications.accountDescription")}
            badge={t("notifications.accountAlwaysOn")}
          >
            <ul className="flex flex-wrap gap-2 px-4 py-3">
              {(matrix.accountEvents.length === 0 ? ACCOUNT_NOTIFICATION_EVENTS : matrix.accountEvents).map((event) => <li key={event}>
                <Badge variant="outline" className="rounded-none border-chart-2/40 px-2 py-1 text-[10px] font-normal text-foreground">
                  <span className="text-chart-2">✓</span>
                  <span className="ml-1">{t(`notifications.event.${event}` as EmailMessageKey)}</span>
                </Badge>
              </li>)}
            </ul>
          </ScopeGroup>

          <div className="bg-card px-4 py-3">
            <p className="text-[11px] leading-relaxed text-muted-foreground">{t("notifications.defaultNote")}</p>
          </div>
        </div>}
  </Panel>;
}

function ScopeGroup({ title, description, badge, children }: { title: string; description?: string; badge?: string; children: ReactNode }) {
  return <section className="bg-card">
    <header className="px-4 pb-2 pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="bench-label">{title}</h3>
        {/* The state belongs to the group, next to its name: on its own under
            the chips it read as a caption for nothing. */}
        {badge && <span className="border border-chart-2/40 px-1.5 font-mono text-[8px] uppercase tracking-[0.12em] text-chart-2">{badge}</span>}
      </div>
      {description && <p className="mt-1 max-w-2xl text-[11px] leading-relaxed text-muted-foreground">{description}</p>}
    </header>
    {children}
  </section>;
}

/**
 * Tailwind generates classes it can find in the source, so the three column
 * counts the matrix actually has (two for the unassigned scope, four for ops,
 * five for a repository) are written out instead of interpolated.
 *
 * The tracks have a real floor. `minmax(0, …)` let a column shrink to nothing,
 * and a German event name is one unbreakable word far wider than that, so the
 * headers used to run into each other and out of the panel between roughly 640
 * and 1200 pixels.
 */
const COLUMN_TEMPLATES: Readonly<Record<number, string>> = Object.freeze({
  2: "lg:grid-cols-[minmax(7rem,1fr)_repeat(2,minmax(6rem,7rem))]",
  4: "lg:grid-cols-[minmax(7rem,1fr)_repeat(4,minmax(6rem,7rem))]",
  5: "lg:grid-cols-[minmax(7rem,1fr)_repeat(5,minmax(6rem,7rem))]",
});

interface MatrixRow {
  scope: string;
  label: string;
  /** The group this row belongs to, as the cells' accessible name says it. */
  scopeName: string;
  detail: string | null;
  events: NotificationEventState[];
}

/**
 * One row per scope, one cell per event. From `lg` up the cells line up under a
 * header of event names — the matrix the design asks for. Below that the header
 * does not fit in any of the five languages, so every cell carries its own name
 * and the row becomes a stack: one DOM, one checkbox per cell, and the same
 * accessible name at every width.
 *
 * `lg` rather than `sm` because German needs the whole band up to ~1200 px:
 * `GITHUB-VERÖFFENTLICHUNG FEHLGESCHLAGEN` over a 7rem track is four wrapped
 * lines at best and a collision at worst.
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
    <div className={cx("hidden border-b border-border/70 px-4 pb-2 lg:grid lg:items-end lg:gap-2", template)} aria-hidden="true">
      <span />
      {columns.map((event) => <span key={event} className="bench-label hyphens-auto break-words text-center leading-tight">
        {t(`notifications.event.${event}` as EmailMessageKey)}
      </span>)}
    </div>
    <ul className="divide-y divide-border">
      {rows.map((row) => <li key={row.scope} className={cx("grid gap-2 px-4 py-3 lg:items-center lg:gap-2", template)}>
        <div className="min-w-0">
          <span className="block truncate text-xs font-medium" title={row.label}>{row.label}</span>
          {row.detail && <span className="block truncate font-mono text-[10px] text-muted-foreground" title={row.detail}>{row.detail}</span>}
        </div>
        {row.events.map((state) => {
          const label = t("notifications.cellLabel", { event: t(`notifications.event.${state.event}` as EmailMessageKey), scope: row.scopeName });
          const key = cellKey({ scope: row.scope, event: state.event });
          return <label key={state.event} className="flex min-w-0 items-center justify-between gap-3 border-t border-border/50 pt-2 first-of-type:border-t-0 lg:justify-center lg:border-t-0 lg:pt-0">
            <span className="min-w-0 truncate text-xs text-muted-foreground lg:hidden">{t(`notifications.event.${state.event}` as EmailMessageKey)}</span>
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
