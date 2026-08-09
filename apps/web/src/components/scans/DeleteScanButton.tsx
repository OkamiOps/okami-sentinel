import { useState } from "react";
import type { ScanRun } from "@csb/shared";
import { Trash2 } from "lucide-react";

import { api } from "../../api";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useI18n } from "../../i18n";

export function DeleteScanButton({
  scan,
  compact = false,
  onDeleted,
}: {
  scan: ScanRun;
  compact?: boolean;
  onDeleted: () => void | Promise<void>;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const removable = scan.status === "failed" || scan.status === "cancelled";

  if (!removable) return null;

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await api.deleteScan(scan.id);
      setOpen(false);
      await onDeleted();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Falha ao excluir scan");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        type="button"
        variant={compact ? "ghost" : "outline"}
        size={compact ? "icon-sm" : "sm"}
        className="text-destructive hover:text-destructive"
        aria-label={t("delete.label", { name: scan.displayName })}
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        <Trash2 aria-hidden size={13} />
        {!compact && t("common.delete")}
      </Button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="bottom"
          className="mx-auto max-h-[85dvh] overflow-y-auto border-border bg-background sm:left-1/2 sm:max-w-xl sm:-translate-x-1/2"
        >
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2 font-heading">
              <Trash2 aria-hidden size={17} className="text-destructive" />
              {t("delete.title")}
            </SheetTitle>
            <SheetDescription>
              {t("delete.description")}
            </SheetDescription>
          </SheetHeader>

          <div className="mx-4 grid gap-3 border p-4 sm:grid-cols-[minmax(0,1fr)_auto]">
            <div className="min-w-0">
              <div className="bench-label">EXECUÇÃO</div>
              <div className="mt-2 truncate text-sm font-semibold">{scan.displayName}</div>
              <div className="mt-1 break-all font-mono text-[9px] text-muted-foreground">{scan.id}</div>
            </div>
            <div className="sm:text-right">
              <div className="bench-label">STATUS</div>
              <div className="mt-2 font-mono text-xs uppercase text-destructive">{scan.status}</div>
            </div>
          </div>

          <div className="mx-4 border border-destructive/40 bg-destructive/[.06] p-4">
            <div className="bench-label text-destructive">{t("delete.folder")}</div>
            <div className="mt-2 break-all font-mono text-[10px] leading-relaxed text-foreground">{scan.scanDir}</div>
          </div>

          {error && <div role="alert" className="mx-4 border border-destructive/50 bg-destructive/[.08] p-3 text-xs text-destructive">{error}</div>}

          <SheetFooter className="sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" className="min-h-11" disabled={busy} onClick={() => setOpen(false)}>{t("common.cancel")}</Button>
            <Button type="button" variant="destructive" className="min-h-11" disabled={busy} onClick={() => void remove()}>
              <Trash2 aria-hidden size={14} />{busy ? t("delete.deleting") : t("delete.forever")}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </>
  );
}
