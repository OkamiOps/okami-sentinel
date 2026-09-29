import type { ReactNode } from "react";
import { LanguageSwitcher } from "../LanguageSwitcher";
import { ThemeSwitcher } from "../ThemeSwitcher";
import { cx } from "../ui";
import { authMessages } from "../../i18n/auth";
import { useScopedI18n } from "../../i18n/scoped";

/**
 * The first screen an invited colleague ever sees. The left half carries the
 * bench identity (mark, wordmark, pulsing grid, engine status) and is purely
 * decorative, so it is hidden from assistive technology and from narrow
 * viewports; the right half holds the only interactive content.
 */
export function AuthFrame({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  const { t } = useScopedI18n(authMessages);
  return (
    <div className="grid min-h-screen lg:grid-cols-[1.1fr_1fr]">
      {/* `bench-corners` forces `position: relative`, so it has to sit on the
          panel itself rather than on a nested absolutely-placed box. */}
      <aside aria-hidden="true" className="bench-panel bench-corners scanline hidden border-0 border-r border-border lg:flex lg:flex-col lg:justify-between lg:p-12">
        <img src="/brand/okami-sentinel-mark.png" alt="" className="pointer-events-none absolute left-[6%] top-1/2 w-[26rem] max-w-[58%] -translate-y-1/2 object-contain opacity-[.06] dark:opacity-[.10]" />
        <span className="auth-grid pointer-events-none absolute inset-0" />
        <span className="auth-glow pointer-events-none absolute inset-0" />
        <div className="relative flex items-center gap-4">
          <img src="/brand/okami-sentinel-mark.png" alt="" className="size-14 shrink-0 object-contain" />
          <div className="min-w-0">
            <div className="font-heading text-lg font-bold tracking-[0.14em]">OKAMI</div>
            <div className="bench-label mt-1">SENTINEL / {t("frame.tagline")}</div>
          </div>
        </div>
        <div className="relative flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
          <span className="live-dot text-chart-2" />
          <span className="text-chart-2">{t("frame.engine")}</span>
          <span className="h-px flex-1 bg-border" />
          <span>OKAMI / SENTINEL</span>
        </div>
      </aside>

      <main className="flex min-h-screen flex-col items-center justify-center px-4 py-10 sm:px-6">
        <div className="w-full max-w-sm">
          <div className="mb-5 flex items-center gap-3 lg:hidden">
            <img src="/brand/okami-sentinel-mark.png" alt="" className="size-9 shrink-0 object-contain" />
            <div className="min-w-0 flex-1">
              <div className="font-heading text-sm font-bold tracking-[0.14em]">OKAMI</div>
              <div className="bench-label mt-0.5 truncate">SENTINEL</div>
            </div>
            <div aria-hidden="true" className="flex shrink-0 items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.14em] text-chart-2">
              <span className="live-dot" />{t("frame.engine")}
            </div>
          </div>
          {children}
          <div className="mt-4 flex h-9 items-stretch justify-between border border-border bg-background/60">
            <div className="flex min-w-0 items-center px-3 font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground">
              {footer ?? <span className="truncate">{t("frame.tagline")}</span>}
            </div>
            <div className="flex shrink-0 items-stretch">
              <ThemeSwitcher />
              <LanguageSwitcher />
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

export function AuthCard({ code, title, description, children, className }: { code: string; title: string; description?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx("bench-panel bench-corners", className)}>
      <header className="border-b border-border px-5 py-4">
        <div className="bench-label text-primary">{code}</div>
        <h1 className="mt-1.5 font-heading text-xl font-semibold tracking-[-0.035em]">{title}</h1>
        {description && <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{description}</p>}
      </header>
      {children}
    </section>
  );
}
