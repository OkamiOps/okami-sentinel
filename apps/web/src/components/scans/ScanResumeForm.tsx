import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { ScanRun } from "@csb/shared";
import { api } from "../../api";
import { scanBudgetMessages } from "../../i18n/scan-budget";
import { useScopedI18n } from "../../i18n/scoped";
import { Button } from "../ui/button";

export function ScanResumeForm({ scan }: { scan: ScanRun }) {
  const { t } = useScopedI18n(scanBudgetMessages);
  const navigate = useNavigate();
  const [cap, setCap] = useState(String(scan.resume?.suggestedMaxCostUsd ?? 200));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return <form className="mt-4 space-y-3" onSubmit={async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try { const result = await api.resumeScan(scan.id, Number(cap)); navigate(`/scans/${result.scanId}`); }
    catch (err) { setError(err instanceof Error ? err.message : t("resumeError")); setBusy(false); }
  }}>
    <p>{t("resumeReuse")}</p>
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
      <label className="flex min-w-0 flex-col gap-1 font-medium">{t("resumeCap")}
        <input className="w-full border bg-background px-3 py-2 text-foreground sm:w-48" type="number" min="0.01" step="0.01" required value={cap} onChange={event => setCap(event.target.value)} />
      </label>
      <Button type="submit" disabled={busy}>{busy ? t("resuming") : t("resumeScan")}</Button>
    </div>
    {error && <p role="alert" className="break-words text-destructive">{error}</p>}
  </form>;
}
