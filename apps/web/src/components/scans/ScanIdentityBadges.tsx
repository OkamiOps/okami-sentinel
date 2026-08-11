import type { ScanRun } from "@csb/shared";

import { cx } from "../ui";
import { useI18n } from "../../i18n";
import { scanLedgerIdentity } from "../../lib/scan-ledger";

const engineTone: Record<ScanRun["engine"], string> = {
  "codex-security": "border-primary/45 bg-primary/[.07] text-primary",
  mantis: "border-chart-2/45 bg-chart-2/[.07] text-chart-2",
  vulnhunter: "border-chart-5/45 bg-chart-5/[.07] text-chart-5",
};

export function ScanIdentityBadges({ scan, compact = false }: { scan: ScanRun; compact?: boolean }) {
  const { t } = useI18n();
  const identity = scanLedgerIdentity(scan);
  const model = scan.model ? identity.model : t("scans.providerDefault");

  return (
    <div
      role="group"
      aria-label={`${t("scans.engine")}: ${identity.engine}; ${t("scans.model")}: ${model}`}
      className="flex min-w-0 flex-wrap items-center gap-1.5"
    >
      <span className={cx("inline-flex h-5 items-center border px-1.5 font-mono text-[8px] font-semibold uppercase tracking-wide", engineTone[scan.engine])}>
        {identity.engine}
      </span>
      <span
        title={model}
        className={cx("inline-flex h-5 min-w-0 items-center border border-border bg-muted/35 px-1.5 font-mono text-[8px] text-foreground", compact ? "max-w-44" : "max-w-64")}
      >
        <span className="truncate">{model}</span>
      </span>
    </div>
  );
}
