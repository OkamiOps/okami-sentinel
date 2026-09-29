import { useId, useState, type FormEvent } from "react";
import type { InviteLinkResponse, UserSummary } from "@csb/shared";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { InviteLinkPanel } from "./InviteLinkPanel";
import { draftToGrants, RepositoryRoleList, type RepositoryOption, type RoleDraft } from "./RepositoryRoleList";
import { AlertBanner } from "../ui";
import { authErrorCode, usersApi } from "../../lib/auth-api";
import { formatHandle, normalizeUsername } from "../../lib/username";
import { accessMessages, type AccessMessageKey } from "../../i18n/access";
import { useScopedI18n } from "../../i18n/scoped";

/** The server names why it refused; repeat that instead of "try again". */
function createFailureKey(failure: unknown): AccessMessageKey {
  const code = authErrorCode(failure);
  if (code === "username_taken") return "invite.usernameTaken";
  if (code === "username_invalid") return "invite.usernameRule";
  if (code === "repository_unknown" || code === "repository_duplicate") return "invite.repositoryUnknown";
  if (code === "role_invalid") return "invite.repositoryUnknown";
  return "invite.error";
}

export function InviteUserDialog({ open, onOpenChange, repositories, onCreated }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repositories: RepositoryOption[];
  onCreated: (user: UserSummary) => void;
}) {
  const { t } = useScopedI18n(accessMessages);
  const fieldId = useId();
  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  const [draft, setDraft] = useState<RoleDraft>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invite, setInvite] = useState<InviteLinkResponse | null>(null);

  const preview = normalizeUsername(username);

  function close() {
    onOpenChange(false);
    // The invite link must not reappear on the next open: it exists only in
    // this dialog's state and the server can no longer produce it.
    setDisplayName("");
    setUsername("");
    setEmail("");
    setIsAdmin(false);
    setDraft({});
    setError(null);
    setInvite(null);
    setPending(false);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    const name = displayName.trim();
    if (!name) return setError(t("invite.nameRequired"));
    if (preview === null) return setError(t("invite.usernameRule"));
    setPending(true);
    setError(null);
    try {
      const created = await usersApi.create({
        username: preview,
        displayName: name,
        email: email.trim() || null,
        // An administrator reaches every repository, so per-repository grants
        // would be dead rows in the database from the first day.
        isAdmin,
        grants: isAdmin ? [] : draftToGrants(draft),
      });
      onCreated(created.user);
      setInvite(created.invite);
    } catch (failure) {
      setError(t(createFailureKey(failure)));
    } finally {
      setPending(false);
    }
  }

  return <Dialog open={open} onOpenChange={(next) => next ? onOpenChange(true) : close()}>
    <DialogContent className="max-w-2xl">
      <DialogHeader>
        <DialogTitle>{invite ? t("invite.created") : t("invite.title")}</DialogTitle>
        {/* The warning belongs next to the link itself, once. */}
        <DialogDescription>{t("invite.description")}</DialogDescription>
      </DialogHeader>
      {invite
        ? <div className="grid gap-4 overflow-y-auto p-4 sm:p-5">
          <InviteLinkPanel invite={invite} />
          <div className="flex justify-end"><Button type="button" onClick={close}>{t("invite.done")}</Button></div>
        </div>
        : <form className="grid gap-4 overflow-y-auto p-4 sm:p-5" onSubmit={(event) => void submit(event)} noValidate>
          {/* items-start: the username cell carries a help line the name cell
              does not, and a stretched row would push the shorter field down
              instead of leaving both inputs on one top edge. */}
          <div className="grid items-start gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <label htmlFor={`${fieldId}-name`} className="bench-label">{t("invite.name")}</label>
              <Input id={`${fieldId}-name`} value={displayName} autoComplete="off" disabled={pending} onChange={(event) => setDisplayName(event.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <label htmlFor={`${fieldId}-username`} className="bench-label">{t("invite.username")}</label>
              <Input
                id={`${fieldId}-username`} value={username} autoComplete="off" spellCheck={false} disabled={pending}
                aria-describedby={`${fieldId}-username-hint`} onChange={(event) => setUsername(event.target.value)}
              />
              <p id={`${fieldId}-username-hint`} className="text-[11px] leading-relaxed text-muted-foreground">
                {preview === null
                  ? t("invite.usernameRule")
                  : t("invite.usernamePreview", { username: formatHandle(preview) })}
              </p>
            </div>
          </div>
          <div className="grid gap-1.5">
            <label htmlFor={`${fieldId}-email`} className="bench-label">{t("invite.email")}</label>
            <Input id={`${fieldId}-email`} type="email" value={email} autoComplete="off" disabled={pending} onChange={(event) => setEmail(event.target.value)} />
          </div>
          <label className="flex items-center gap-3 border border-border px-3 py-2.5 text-xs">
            <Checkbox checked={isAdmin} disabled={pending} onCheckedChange={(checked) => setIsAdmin(checked === true)} />
            <span>{t("invite.admin")}</span>
          </label>
          <div className="grid gap-2">
            <span className="bench-label">{t("invite.repositories")}</span>
            {isAdmin
              ? <p className="border border-border bg-muted/30 px-3 py-2.5 text-xs text-muted-foreground">{t("role.adminSeesAll")}</p>
              : <>
                <RepositoryRoleList
                  repositories={repositories} draft={draft} disabled={pending}
                  onChange={(repositoryKey, role) => setDraft((current) => ({ ...current, [repositoryKey]: role }))}
                />
                <p className="text-[11px] leading-relaxed text-muted-foreground">{t("role.phaseOneNote")}</p>
              </>}
          </div>
          {error && <AlertBanner>{error}</AlertBanner>}
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" disabled={pending} onClick={close}>{t("common.cancel")}</Button>
            <Button type="submit" disabled={pending}>{pending ? t("invite.submitting") : t("invite.submit")}</Button>
          </div>
        </form>}
    </DialogContent>
  </Dialog>;
}
