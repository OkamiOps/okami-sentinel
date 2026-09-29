import { Link, useLocation } from "react-router-dom";

import { cx } from "../ui";
import { useAuth } from "../../auth/AuthProvider";
import { type TranslationKey, useI18n } from "../../i18n";

const sections: ReadonlyArray<{ to: string; code: string; label: TranslationKey; adminOnly: boolean }> = [
  { to: "/settings", code: "01", label: "settings.systemSection", adminOnly: true },
  { to: "/settings/connections", code: "02", label: "settings.connectionsSection", adminOnly: true },
  { to: "/settings/users", code: "03", label: "settings.usersSection", adminOnly: true },
  { to: "/settings/access", code: "04", label: "settings.accessSection", adminOnly: true },
  { to: "/settings/account", code: "05", label: "settings.accountSection", adminOnly: false },
];

/**
 * The tabs sit on a border-coloured track and are separated by a one-pixel
 * gap, which is what draws the hairline rules. A half-filled last grid row
 * would therefore expose the track as a solid block, so the empty cells are
 * filled explicitly — one count for the two-column layout, another for three.
 */
function fillerCount(items: number, columns: number): number {
  return (columns - (items % columns)) % columns;
}

export function SettingsSectionNav() {
  const { pathname } = useLocation();
  const { t } = useI18n();
  const { isAdmin, status } = useAuth();
  // A member has no reachable administration section, so the tabs that would
  // only bounce them back to their own account are not rendered at all. An
  // unverified session proves nothing about the role, and the route gate does
  // not redirect then either: the tabs must not disappear under an admin
  // standing on one of them during an outage.
  const member = status === "signed-in" && !isAdmin;
  const visible = sections.filter((section) => !member || !section.adminOnly);
  const narrowFillers = fillerCount(visible.length, 2);
  const wideFillers = fillerCount(visible.length, 3);

  return <nav aria-label={t("settings.title")} className="mb-4 grid w-full grid-cols-2 gap-px overflow-hidden border border-border bg-border sm:grid-cols-3 lg:flex">
    {visible.map((section) => {
      const active = pathname === section.to;
      return <Link key={section.to} to={section.to} aria-current={active ? "page" : undefined} className={cx("group relative flex h-10 min-w-0 items-center justify-center gap-2 bg-background px-3 font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:z-10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring lg:shrink-0 lg:justify-start lg:px-4", active && "bg-accent text-chart-1")}><span className="text-[8px] opacity-55">{section.code}</span><span className="truncate">{t(section.label)}</span><span className={cx("absolute inset-x-0 bottom-0 h-px bg-chart-1 transition-transform", active ? "scale-x-100" : "scale-x-0 group-hover:scale-x-100")} /></Link>;
    })}
    {Array.from({ length: Math.max(narrowFillers, wideFillers) }, (_, index) => (
      <span key={`filler-${index}`} aria-hidden="true" className={cx("h-10 bg-background lg:hidden", index < narrowFillers ? "block" : "hidden", index < wideFillers ? "sm:block" : "sm:hidden")} />
    ))}
    <span aria-hidden="true" className="hidden bg-background lg:block lg:flex-1" />
  </nav>;
}
