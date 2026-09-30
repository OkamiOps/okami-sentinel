import { useEffect, useId, useRef, useState } from "react";
import type { EmailQueueSkip, InviteLinkResponse } from "@csb/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AlertBanner } from "../ui";
import { formatDate } from "../../format";
import { accessMessages, type AccessMessageKey } from "../../i18n/access";
import { useScopedI18n } from "../../i18n/scoped";

/** Why no message was queued, in a sentence the administrator can act on. */
function skipKey(reason: EmailQueueSkip): AccessMessageKey {
  if (reason === "disabled") return "invite.emailDisabled";
  if (reason === "no_address") return "invite.emailNoAddress";
  if (reason === "duplicate") return "invite.emailDuplicate";
  return "invite.emailError";
}

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

  // A second link invalidates the first token; the button must not keep
  // reading "Copied" (or the failure banner from the previous attempt) once
  // the clipboard no longer holds what it claims to.
  useEffect(() => {
    setCopied(false);
    setCopyFailed(false);
  }, [invite.inviteUrl]);

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
    {/* Whether the message actually left is the server's answer, not a guess
        from the form: `emailQueued` and `emailSkipped` come back with the link
        precisely so the link can stop being the only story. */}
    {invite.emailQueued
      ? <AlertBanner tone="success">{t("invite.emailSent", { address: invite.emailTo ?? "—" })}</AlertBanner>
      : invite.emailSkipped !== null && <AlertBanner tone="info">{t(skipKey(invite.emailSkipped))}</AlertBanner>}
    {copyFailed && <AlertBanner tone="warning">{t("invite.copyFailed")}</AlertBanner>}
    <AlertBanner tone="warning">{t("invite.warning")}</AlertBanner>
  </div>;
}
