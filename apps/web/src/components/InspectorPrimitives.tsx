import type { ReactNode } from "react";
import { SeverityBadge, cx } from "./ui";

export function InspectorSection({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cx("min-w-0 border-b p-4", className)}>
      <div className="bench-label mb-3 text-primary">{label}</div>
      {children}
    </section>
  );
}

export function SignalCell({
  label,
  level,
  detail,
}: {
  label: string;
  level: string | null;
  detail: string | null;
}) {
  return (
    <div className="min-w-0 border-r p-4 last:border-r-0">
      <div className="flex items-center justify-between gap-3">
        <span className="bench-label">{label}</span>
        {level && <SeverityBadge severity={level} />}
      </div>
      {detail && (
        <p className="mt-3 break-words text-xs leading-6 text-muted-foreground">
          {detail}
        </p>
      )}
    </div>
  );
}

export function BulletList({ items }: { items: string[] }) {
  return (
    <ul className="space-y-2">
      {items.map((item, index) => (
        <li
          key={`${item}-${index}`}
          className="grid min-w-0 grid-cols-[.75rem_minmax(0,1fr)] gap-2 text-xs leading-6 text-muted-foreground"
        >
          <span className="mt-[.65rem] size-1 bg-border" />
          <span className="break-words">{item}</span>
        </li>
      ))}
    </ul>
  );
}
