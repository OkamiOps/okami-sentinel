import type { WebhookDeliveryRecord } from "@csb/shared";

import { EmptyState, Panel, cx } from "../ui";
import { formatDate, shortId } from "../../format";
import { deliveryOutcomeTone, isNeutralReason, reasonText, type GitHubT } from "./labels";

/**
 * The webhook deliveries, administrator only: they are integration diagnostics and
 * name installations. A delivery row exists only after a signature verified, so an
 * empty list is itself the answer to "is the secret right".
 */
export function DeliveryList({
  deliveries,
  t,
}: {
  deliveries: Array<WebhookDeliveryRecord | null> | null;
  t: GitHubT;
}) {
  const rows = (deliveries ?? []).filter((row): row is WebhookDeliveryRecord => row !== null);
  return <Panel
    label={t("github.deliveries")}
    title={t("github.deliveriesTitle")}
    wrapTitle
    aside={<span className="font-mono text-[8px] uppercase tracking-[.1em] text-muted-foreground">{rows.length}</span>}
  >
    <p className="border-b px-4 py-3 text-xs leading-relaxed text-muted-foreground">{t("github.deliveries.adminOnly")}</p>
    {rows.length === 0
      ? <EmptyState title={t("github.deliveries.empty")} description={t("github.deliveries.emptyDescription")} />
      : <ul className="divide-y">
        {rows.map((delivery) => {
          const reason = reasonText(t, delivery.reason);
          return <li key={delivery.deliveryId} className="grid min-w-0 gap-3 px-4 py-4 lg:grid-cols-[8rem_minmax(0,1fr)_auto] lg:items-start">
            <div className="min-w-0">
              <span className={cx("inline-flex border px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-wider", deliveryOutcomeTone[delivery.outcome])}>
                {t(`github.outcome.${delivery.outcome}`)}
              </span>
              <div className="mt-2 font-mono text-[9px] text-muted-foreground">{formatDate(delivery.receivedAt)}</div>
            </div>
            <div className="min-w-0">
              <strong className="block min-w-0 break-all text-sm">{delivery.event}{delivery.action ? ` · ${delivery.action}` : ""}</strong>
              <div className="mt-1 min-w-0 break-all font-mono text-[10px] text-muted-foreground">
                {delivery.repositoryKey ?? "—"}
                {delivery.headSha ? ` · ${shortId(delivery.headSha)}` : ""}
                {` · ${shortId(delivery.deliveryId)}`}
              </div>
              {/* The reason is always a sentence. A raw `snake_case` code in a table
                  is how a screen admits it does not know what it is showing. */}
              {reason && <p className={cx(
                "mt-2 text-xs leading-relaxed",
                delivery.outcome === "failed" ? "text-destructive"
                  : isNeutralReason(delivery.reason) ? "text-muted-foreground" : "text-chart-3",
              )}>{reason}</p>}
            </div>
            <div className="shrink-0 text-right font-mono text-[9px] text-muted-foreground">
              {delivery.matchedActionIds.length > 0 && <div>{delivery.matchedActionIds.length} × {t("github.actions.column.name")}</div>}
              {delivery.durationMs !== null && <div>{delivery.durationMs} ms</div>}
            </div>
          </li>;
        })}
      </ul>}
  </Panel>;
}
