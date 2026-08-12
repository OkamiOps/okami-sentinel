import type { ReactNode } from "react";

import { Check } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cx } from "../ui";

export function ChoiceCard({
  checked,
  disabled = false,
  icon,
  title,
  meta,
  description,
  onSelect,
}: {
  checked: boolean;
  disabled?: boolean;
  icon: ReactNode;
  title: string;
  meta: string;
  description: string;
  onSelect: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      role="radio"
      aria-checked={checked}
      disabled={disabled}
      className={cx(
        "group relative h-auto min-h-28 w-full items-start justify-start gap-3 whitespace-normal rounded-none border p-4 text-left transition-colors",
        checked
          ? "border-primary bg-primary/[.08] text-foreground hover:bg-primary/[.11]"
          : "border-border bg-card/30 text-muted-foreground hover:border-muted-foreground/50 hover:bg-secondary/40",
      )}
      onClick={onSelect}
    >
      <span className={cx(
        "mt-0.5 grid size-9 shrink-0 place-items-center border transition-colors",
        checked ? "border-primary text-primary" : "border-border text-muted-foreground",
      )}>
        {icon}
      </span>
      <span className="min-w-0 pr-6">
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-heading text-sm font-semibold text-foreground">{title}</span>
          <span className={cx(
            "font-mono text-[8px] uppercase tracking-[.12em]",
            checked ? "text-primary" : "text-muted-foreground",
          )}>{meta}</span>
        </span>
        <span className="mt-2 block text-xs font-normal leading-5">{description}</span>
      </span>
      {checked && <Check aria-hidden className="absolute right-3 top-3 text-primary" size={14} />}
    </Button>
  );
}
