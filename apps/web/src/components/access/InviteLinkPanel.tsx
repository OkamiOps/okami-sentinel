import { useId, useRef, useState } from "react";
import type { InviteLinkResponse } from "@csb/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AlertBanner } from "../ui";
import { formatDate } from "../../format";
import { accessMessages, type AccessMessageKey } from "../../i18n/access";
import { useScopedI18n } from "../../i18n/scoped";

/**
 * The API returns the invite token once and stores only its hash, so this is
 * the single moment the link exists in readable form. Both the invite dialog
 * and the reset action render it here: one copy button, one warning, one
 * expiry, and a text box the reader can still select by hand when the
 * clipboard is unavailable.
 */
export function InviteLinkPanel({ invite, labelKey = "invite.link" }: { invite: InviteLinkResponse; labelKey?: AccessMessageKey }) {
  const { t } = useScopedI18n(accessMessages);
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  async function copy() {
    setCopyFailed(false);
    try {
      await navigator.clipboard.writeText(invite.inviteUrl);
      setCopied(true);
    } catch {
      // Clipboard access can be refused (insecure context, denied permission).
      // Selecting the link keeps the manual copy one keystroke away.
      inputRef.current?.select();
      setCopyFailed(true);
    }
  }

  return <div className="grid gap-3">
    <div className="grid gap-1.5">
      <label htmlFor={inputId} className="bench-label">{t(labelKey)}</label>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id={inputId} ref={inputRef} value={invite.inviteUrl} readOnly
          className="min-w-0 flex-1 font-mono text-[11px]"
          onFocus={(event) => event.currentTarget.select()}
        />
        <Button type="button" variant={copied ? "outline" : "default"} onClick={() => void copy()}>
          {copied ? t("invite.copied") : t("invite.copy")}
        </Button>
      </div>
      <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
        {t("invite.expires", { date: formatDate(invite.expiresAt) })}
      </p>
    </div>
    {copyFailed && <AlertBanner tone="warning">{t("invite.copyFailed")}</AlertBanner>}
    <AlertBanner tone="warning">{t("invite.warning")}</AlertBanner>
  </div>;
}
