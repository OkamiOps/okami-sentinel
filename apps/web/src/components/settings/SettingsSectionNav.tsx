import { Link, useLocation } from "react-router-dom";

import { cx } from "../ui";
import { type TranslationKey, useI18n } from "../../i18n";

const sections: ReadonlyArray<{ to: string; code: string; label: TranslationKey }> = [
  { to: "/settings", code: "01", label: "settings.systemSection" },
  { to: "/settings/connections", code: "02", label: "settings.connectionsSection" },
];

export function SettingsSectionNav() {
  const { pathname } = useLocation();
  const { t } = useI18n();
  return <nav aria-label={t("settings.title")} className="mb-4 flex w-full overflow-x-auto border border-border bg-background/70">
    {sections.map((section) => {
      const active = pathname === section.to;
      return <Link key={section.to} to={section.to} aria-current={active ? "page" : undefined} className={cx("group relative flex h-10 shrink-0 items-center gap-2 border-r border-border px-4 font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:z-10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring", active && "bg-accent text-chart-1")}><span className="text-[8px] opacity-55">{section.code}</span><span>{t(section.label)}</span><span className={cx("absolute inset-x-0 bottom-0 h-px bg-chart-1 transition-transform", active ? "scale-x-100" : "scale-x-0 group-hover:scale-x-100")} /></Link>;
    })}
  </nav>;
}
