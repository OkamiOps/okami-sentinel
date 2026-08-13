import { useState } from "react";
import type { GateRun } from "@csb/shared";
import { Trash2 } from "lucide-react";

import { api } from "../../api";
import { useI18n } from "../../i18n";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

export function DeleteGateButton({ gate, onDeleted }: { gate: GateRun; onDeleted: () => void | Promise<void> }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const terminal = gate.status === "completed" || gate.status === "cancelled" || gate.status === "error";

  if (!terminal) return null;

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await api.deleteGate(gate.id);
      setOpen(false);
      await onDeleted();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("guardrails.deleteError"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button type="button" variant="outline" className="min-h-11 text-destructive hover:text-destructive" onClick={() => { setError(null); setOpen(true); }}>
        <Trash2 aria-hidden size={14} />{t("guardrails.deleteGate")}
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="bottom" className="mx-auto max-h-[85dvh] overflow-y-auto border-border bg-background sm:left-1/2 sm:max-w-xl sm:-translate-x-1/2">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2 font-heading"><Trash2 aria-hidden size={17} className="text-destructive" />{t("guardrails.deleteTitle")}</SheetTitle>
            <SheetDescription>{t("guardrails.deleteDescription")}</SheetDescription>
          </SheetHeader>
          <div className="mx-4 grid gap-3 border p-4 sm:grid-cols-[minmax(0,1fr)_auto]">
            <div className="min-w-0"><div className="bench-label">GATE</div><div className="mt-2 break-all font-mono text-xs font-semibold">{gate.id}</div></div>
            <div className="sm:text-right"><div className="bench-label">STATUS</div><div className="mt-2 font-mono text-xs uppercase text-destructive">{gate.status}</div></div>
          </div>
          <div className="mx-4 border border-destructive/40 bg-destructive/[.06] p-4 text-xs leading-relaxed text-foreground">{gate.scanId === null ? t("guardrails.deleteNoScan") : t("guardrails.deleteLinkedScan")}</div>
          {error && <div role="alert" className="mx-4 border border-destructive/50 bg-destructive/[.08] p-3 text-xs text-destructive">{error}</div>}
          <SheetFooter className="sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" className="min-h-11" disabled={busy} onClick={() => setOpen(false)}>{t("common.cancel")}</Button>
            <Button type="button" variant="destructive" className="min-h-11" disabled={busy} onClick={() => void remove()}><Trash2 aria-hidden size={14} />{busy ? t("guardrails.deleting") : t("guardrails.deleteForever")}</Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </>
  );
}
