import type { ProviderConnection } from "@csb/shared";
import { Cable, CircleCheckBig, CircleDashed, TriangleAlert } from "lucide-react";

import { cx } from "../ui";
import { type TranslationKey, useI18n } from "../../i18n";

type Props = {
  connections: ProviderConnection[];
  selectedId: string | null;
  onSelect: (id: string) => void;
};

const statusTone: Record<ProviderConnection["status"], string> = {
  draft: "bg-muted-foreground",
  "authentication-required": "bg-chart-3",
  testing: "bg-chart-5",
  ready: "bg-chart-2",
  degraded: "bg-chart-3",
  expired: "bg-destructive",
  unavailable: "bg-destructive",
};
const statusLabels: Record<ProviderConnection["status"], TranslationKey> = {
  draft: "connections.status.draft",
  "authentication-required": "connections.status.authentication-required",
  testing: "connections.status.testing",
  ready: "connections.status.ready",
  degraded: "connections.status.degraded",
  expired: "connections.status.expired",
  unavailable: "connections.status.unavailable",
};

function StatusGlyph({ status }: { status: ProviderConnection["status"] }) {
  if (status === "ready") return <CircleCheckBig aria-hidden="true" className="size-3 text-chart-2" />;
  if (status === "expired" || status === "unavailable" || status === "degraded") return <TriangleAlert aria-hidden="true" className="size-3 text-destructive" />;
  return <CircleDashed aria-hidden="true" className="size-3 text-muted-foreground" />;
}

export function ConnectionList({ connections, selectedId, onSelect }: Props) {
  const { t } = useI18n();
  return <section aria-label={t("settings.connectionsSection")} className="min-w-0 border-b border-border lg:border-r lg:border-b-0">
    <div className="flex min-h-12 items-center justify-between border-b border-border px-3 py-2">
      <div><div className="bench-label">{t("connections.patchBay")}</div><div className="mt-0.5 text-sm font-semibold">{t("settings.connectionsSection")}</div></div>
      <span className="border border-border px-1.5 py-0.5 font-mono text-[9px] tabular-nums text-muted-foreground">{connections.length}</span>
    </div>
    <div role="listbox" aria-label={t("settings.connectionsSection")} className="max-h-[30rem] overflow-y-auto">
      {connections.map((connection) => {
        const selected = connection.id === selectedId;
        return <button key={connection.id} type="button" role="option" aria-selected={selected} onClick={() => onSelect(connection.id)} className={cx("group grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b border-border px-3 py-3 text-left transition-colors focus-visible:z-10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring", selected ? "bg-accent" : "hover:bg-accent/60")}>
          <span aria-hidden="true" className={cx("h-8 w-0.5 self-stretch", statusTone[connection.status])} />
          <span className="min-w-0"><span className="flex items-center gap-2"><Cable aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" /><span className="truncate text-xs font-semibold">{connection.name}</span></span><span className="mt-1 block truncate font-mono text-[9px] uppercase tracking-[0.08em] text-muted-foreground">{connection.display.providerLabel} / {connection.display.routeLabel}</span></span>
          <span className="flex shrink-0 items-center gap-1.5 font-mono text-[8px] uppercase text-muted-foreground"><StatusGlyph status={connection.status} /><span className="sr-only">{t(statusLabels[connection.status])}</span><span aria-hidden="true" className="hidden xl:inline">{t(statusLabels[connection.status])}</span></span>
        </button>;
      })}
    </div>
  </section>;
}
