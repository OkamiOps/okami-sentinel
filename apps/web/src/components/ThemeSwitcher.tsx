import { Check, Moon, Sun, Monitor } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useTheme, type Theme } from "../theme";
import { useI18n } from "../i18n";

const themes: ReadonlyArray<{ value: Theme; icon: typeof Sun }> = [
  { value: "light", icon: Sun },
  { value: "dark", icon: Moon },
  { value: "system", icon: Monitor },
];

export function ThemeSwitcher() {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const { t } = useI18n();
  const CurrentIcon = resolvedTheme === "dark" ? Moon : Sun;

  return <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <button type="button" className="flex h-full min-w-12 items-center justify-center gap-2 border-l border-border px-3 font-mono text-[9px] text-muted-foreground transition hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring" aria-label={t("theme.label")}>
        <CurrentIcon aria-hidden size={13} className="text-primary" />
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="w-44 rounded-none border-border bg-popover p-1.5">
      <DropdownMenuLabel className="font-mono text-[8px] uppercase tracking-[.14em] text-primary">{t("theme.label")}</DropdownMenuLabel>
      {themes.map(({ value, icon: Icon }) => <DropdownMenuItem key={value} onSelect={() => setTheme(value)} className="rounded-none px-2 py-2.5">
        <Icon aria-hidden size={13} className="text-muted-foreground" />
        <span className="ml-2 flex-1 text-[11px]">{t(`theme.${value}` as "theme.light")}</span>
        {theme === value && <Check aria-hidden size={12} className="text-chart-2" />}
      </DropdownMenuItem>)}
    </DropdownMenuContent>
  </DropdownMenu>;
}
