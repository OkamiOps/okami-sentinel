import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { accessMessages } from "../../i18n/access";
import { useScopedI18n } from "../../i18n/scoped";

/**
 * Every destructive administration action goes through the same confirmation,
 * so the reader always sees the consequence stated in words before it happens,
 * and the failure is reported by the panel that owns the action.
 */
export function ConfirmDialog({ open, onOpenChange, title, description, destructive = false, pending = false, onConfirm }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  destructive?: boolean;
  pending?: boolean;
  onConfirm: () => void;
}) {
  const { t } = useScopedI18n(accessMessages);
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-w-lg">
      <DialogHeader>
        <DialogTitle className="text-lg sm:text-xl">{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <div className="flex flex-wrap justify-end gap-2 p-4">
        <Button type="button" variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
        <Button type="button" variant={destructive ? "destructive" : "default"} disabled={pending} onClick={onConfirm}>{t("users.confirm")}</Button>
      </div>
    </DialogContent>
  </Dialog>;
}
