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
  return <nav aria-label={t("settings.title")} className="mb-4 grid w-full grid-cols-2 overflow-hidden border border-border bg-background/70 sm:flex">
    {sections.map((section) => {
      const active = pathname === section.to;
      return <Link key={section.to} to={section.to} aria-current={active ? "page" : undefined} className={cx("group relative flex h-10 min-w-0 items-center justify-center gap-2 border-r border-border px-3 font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground transition-colors last:border-r-0 hover:bg-accent hover:text-foreground focus-visible:z-10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring sm:shrink-0 sm:justify-start sm:px-4 sm:last:border-r", active && "bg-accent text-chart-1")}><span className="text-[8px] opacity-55">{section.code}</span><span className="truncate">{t(section.label)}</span><span className={cx("absolute inset-x-0 bottom-0 h-px bg-chart-1 transition-transform", active ? "scale-x-100" : "scale-x-0 group-hover:scale-x-100")} /></Link>;
    })}
  </nav>;
}
