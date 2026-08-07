import type { FindingLifecycle } from "@csb/shared";
import { cx } from "./ui";

export const lifecycleLabel: Record<FindingLifecycle, string> = {
  new: "new",
  regressed: "regressed",
  persisting: "persisting",
  fixed: "fixed",
};

export const lifecycleTone: Record<FindingLifecycle, string> = {
  new: "text-primary",
  regressed: "text-destructive",
  persisting: "text-chart-3",
  fixed: "text-chart-2",
};

const lifecycleBorder: Record<FindingLifecycle, string> = {
  new: "border-primary/45 text-primary",
  regressed: "border-destructive/45 text-destructive",
  persisting: "border-chart-3/45 text-chart-3",
  fixed: "border-chart-2/45 text-chart-2",
};

export function LifecycleBadge({ state }: { state: FindingLifecycle }) {
  return (
    <span
      className={cx(
        "inline-flex h-5 shrink-0 items-center border px-1.5 font-mono text-[7px] uppercase tracking-wider",
        lifecycleBorder[state],
      )}
    >
      {lifecycleLabel[state]}
    </span>
  );
}
