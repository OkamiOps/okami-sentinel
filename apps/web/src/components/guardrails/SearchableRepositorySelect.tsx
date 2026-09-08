import { useId, useState } from "react";
import { Popover } from "radix-ui";
import { Check, ChevronsUpDown } from "lucide-react";
import { Input } from "../ui/input";
import { Button } from "../ui/button";
import { useScopedI18n } from "../../i18n/scoped";
import { repositoryPickerMessages } from "../../i18n/repository-picker";

export function SearchableRepositorySelect({ id, value, options, disabled, onChange }: {
  id: string;
  value: string;
  options: { id: string; label: string; disabled?: boolean; disabledLabel?: string }[];
  disabled?: boolean;
  onChange: (id: string) => void;
}) {
  const { t } = useScopedI18n(repositoryPickerMessages);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const titleId = useId();
  const selected = options.find((option) => option.id === value);
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const filtered = options.filter((option) => terms.every((term) => option.label.toLocaleLowerCase().includes(term)));
  return <Popover.Root open={open} onOpenChange={(next) => { setOpen(next); if (next) setQuery(""); }} modal>
    <Popover.Trigger asChild><Button id={id} type="button" variant="outline" disabled={disabled} className="min-h-11 w-full min-w-0 justify-between text-left font-normal"><span className="truncate">{selected?.label ?? t("select")}</span><ChevronsUpDown aria-hidden className="size-4 shrink-0" /></Button></Popover.Trigger>
    <Popover.Portal><Popover.Content aria-labelledby={titleId} align="start" sideOffset={4} collisionPadding={12} className="z-[70] flex max-h-[min(440px,var(--radix-popover-content-available-height))] w-[var(--radix-popover-trigger-width)] min-w-0 flex-col border border-border bg-popover text-popover-foreground shadow-lg">
      <div className="shrink-0 space-y-2 border-b p-3"><label id={titleId} htmlFor={`${id}-search`} className="text-xs font-semibold">{t("search")}</label><Input id={`${id}-search`} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("search")} autoComplete="off" /><p className="text-xs text-muted-foreground" role="status">{t("count", { shown: filtered.length, total: options.length })}</p></div>
      <div className="min-h-0 overflow-y-auto p-1">{filtered.length ? filtered.map((option) => <button type="button" key={option.id} disabled={option.disabled} aria-pressed={option.id === value} onClick={() => { onChange(option.id); setOpen(false); }} className="flex min-h-11 w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-secondary focus-visible:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-45"><span className="min-w-0 break-all">{option.label}{option.disabled && <span className="ml-2 text-xs text-muted-foreground">{option.disabledLabel ?? t("archived")}</span>}</span>{option.id === value && <Check aria-hidden className="size-4 shrink-0" />}</button>) : <p className="p-4 text-sm text-muted-foreground">{t("empty")}</p>}</div>
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}
