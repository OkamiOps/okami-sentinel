import { Check, Languages } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { localeMeta, supportedLocales, useI18n } from "../i18n";

export function LanguageSwitcher() {
  const { locale, setLocale, t } = useI18n();
  return <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <button type="button" className="flex h-full min-w-14 items-center justify-center gap-2 border-l border-border px-3 font-mono text-[9px] text-muted-foreground transition hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring" aria-label={t("language.label")}>
        <Languages aria-hidden size={13} className="text-primary" /><span>{localeMeta[locale].short}</span>
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="w-52 rounded-none border-border bg-popover p-1.5">
      <DropdownMenuLabel className="font-mono text-[8px] uppercase tracking-[.14em] text-primary">{t("language.label")}</DropdownMenuLabel>
      {supportedLocales.map((item) => <DropdownMenuItem key={item} onSelect={() => setLocale(item)} className="rounded-none px-2 py-2.5">
        <span className="w-6 font-mono text-[8px] text-primary">{localeMeta[item].short}</span><span className="flex-1 text-[11px]">{localeMeta[item].label}</span>{locale === item && <Check aria-hidden size={12} className="text-chart-2" />}
      </DropdownMenuItem>)}
    </DropdownMenuContent>
  </DropdownMenu>;
}
