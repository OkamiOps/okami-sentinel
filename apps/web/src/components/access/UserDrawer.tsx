import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { InviteLinkResponse, UserSessionSummary, UserSummary } from "@csb/shared";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ConfirmDialog } from "./ConfirmDialog";
import { InviteLinkPanel } from "./InviteLinkPanel";
import { draftToGrants, grantsToDraft, RepositoryRoleList, type RepositoryOption, type RoleDraft } from "./RepositoryRoleList";
import { UserRoleBadge, UserStateBadge } from "./UserBadges";
import { AlertBanner, cx, EmptyState, FormFeedback, Loading } from "../ui";
import { authErrorCode, usersApi } from "../../lib/auth-api";
import { describeUserAgent } from "../../lib/user-agent";
import { formatRelativeTime } from "../../format";
import { accessMessages, type AccessMessageKey } from "../../i18n/access";
import { useScopedI18n } from "../../i18n/scoped";

const destructiveText = "text-destructive hover:text-destructive";

/** Refusing the last administrator is a rule, not an outage: say which rule. */
function actionFailureKey(failure: unknown): AccessMessageKey {
  return authErrorCode(failure) === "last_admin" ? "actions.lastAdmin" : "actions.error";
}

export function UserDrawer({ user, repositories, onOpenChange, onChanged }: {
  user: UserSummary | null;
  repositories: RepositoryOption[];
  onOpenChange: (open: boolean) => void;
  onChanged: (user: UserSummary) => void;
}) {
  const { t } = useScopedI18n(accessMessages);
  return <Sheet open={user !== null} onOpenChange={onOpenChange}>
    <SheetContent side="right" className="gap-0 data-[side=right]:sm:max-w-xl">
      {/* Keyed by the user so every tab, draft and notice belongs to the
          person on screen and never leaks into the next one opened. */}
      {user === null
        ? <SheetTitle className="sr-only">{t("users.title")}</SheetTitle>
        : <DrawerBody key={user.id} user={user} repositories={repositories} onChanged={onChanged} />}
    </SheetContent>
  </Sheet>;
}

function DrawerBody({ user, repositories, onChanged }: {
  user: UserSummary;
  repositories: RepositoryOption[];
  onChanged: (user: UserSummary) => void;
}) {
  const { t } = useScopedI18n(accessMessages);
  return <>
    <SheetHeader className="border-b pr-12">
      <SheetTitle className="truncate">{user.displayName}</SheetTitle>
      <SheetDescription className="font-mono text-[11px]">@{user.username}</SheetDescription>
      <div className="mt-2 flex flex-wrap gap-2"><UserStateBadge user={user} /><UserRoleBadge user={user} /></div>
    </SheetHeader>
    <Tabs defaultValue="access" className="min-h-0 flex-1 gap-0">
      <TabsList variant="line" className="h-10 w-full justify-start gap-2 border-b px-4">
        <TabsTrigger value="access">{t("drawer.tab.access")}</TabsTrigger>
        <TabsTrigger value="sessions">{t("drawer.tab.sessions")}</TabsTrigger>
        <TabsTrigger value="actions">{t("drawer.tab.actions")}</TabsTrigger>
      </TabsList>
      <TabsContent value="access" className="min-h-0 overflow-y-auto p-4">
        {user.isAdmin
          ? <p className="border border-border bg-muted/30 px-3 py-2.5 text-xs text-muted-foreground">{t("role.adminSeesAll")}</p>
          : <AccessTab user={user} repositories={repositories} onChanged={onChanged} />}
      </TabsContent>
      <TabsContent value="sessions" className="min-h-0 overflow-y-auto p-4"><SessionsTab user={user} /></TabsContent>
      {/* forceMount: the server stores only the reset link's hash, so once a
          link is generated it is unrecoverable. Leaving the tab must not
          unmount this panel and discard it. */}
      <TabsContent value="actions" className="min-h-0 overflow-y-auto p-4" forceMount>
        <ActionsTab user={user} onChanged={onChanged} />
      </TabsContent>
    </Tabs>
  </>;
}

function AccessTab({ user, repositories, onChanged }: {
  user: UserSummary;
  repositories: RepositoryOption[];
  onChanged: (user: UserSummary) => void;
}) {
  const { t } = useScopedI18n(accessMessages);
  const [draft, setDraft] = useState<RoleDraft | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadFailed(false);
    try {
      setDraft(grantsToDraft(await usersApi.grants(user.id)));
    } catch {
      setDraft(null);
      setLoadFailed(true);
    }
  }, [user.id]);

  useEffect(() => { void load(); }, [load]);

  async function save() {
    if (draft === null || pending) return;
    const grants = draftToGrants(draft);
    setPending(true);
    setNotice(null);
    setError(null);
    try {
      setDraft(grantsToDraft(await usersApi.replaceGrants(user.id, grants)));
      // The table column counts repositories; it would go stale otherwise.
      onChanged({ ...user, repositoryCount: grants.length });
      setNotice(t("drawer.saved"));
    } catch {
      setError(t("drawer.saveError"));
    } finally {
      setPending(false);
    }
  }

  if (loadFailed) return <div className="grid gap-3">
    <AlertBanner>{t("drawer.grantsError")}</AlertBanner>
    <div><Button type="button" variant="outline" size="sm" onClick={() => void load()}>{t("common.retry")}</Button></div>
  </div>;
  if (draft === null) return <Loading />;

  return <div className="grid gap-3">
    <RepositoryRoleList
      repositories={repositories} draft={draft} disabled={pending}
      onChange={(repositoryKey, role) => setDraft((current) => ({ ...current, [repositoryKey]: role }))}
    />
    <p className="text-[11px] leading-relaxed text-muted-foreground">{t("role.phaseOneNote")}</p>
    <FormFeedback notice={notice} error={error} />
    <div className="flex justify-end">
      <Button type="button" disabled={pending || repositories.length === 0} onClick={() => void save()}>
        {pending ? t("drawer.saving") : t("drawer.save")}
      </Button>
    </div>
  </div>;
}

function SessionsTab({ user }: { user: UserSummary }) {
  const { t } = useScopedI18n(accessMessages);
  const [sessions, setSessions] = useState<UserSessionSummary[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadFailed(false);
    try {
      setSessions(await usersApi.sessions(user.id));
    } catch {
      setSessions(null);
      setLoadFailed(true);
    }
  }, [user.id]);

  useEffect(() => { void load(); }, [load]);

  async function revokeAll() {
    setPending(true);
    setNotice(null);
    setError(null);
    try {
      await usersApi.revokeSessions(user.id);
      setConfirming(false);
      await load();
      setNotice(t("drawer.revokeAllDone"));
    } catch {
      setConfirming(false);
      setError(t("account.revokeError"));
    } finally {
      setPending(false);
    }
  }

  return <div className="grid gap-3">
    <FormFeedback notice={notice} error={error} />
    {loadFailed
      ? <>
        <AlertBanner>{t("account.sessionsError")}</AlertBanner>
        <div><Button type="button" variant="outline" size="sm" onClick={() => void load()}>{t("common.retry")}</Button></div>
      </>
      : sessions === null
        ? <Loading />
        : sessions.length === 0
          ? <EmptyState title={t("account.noSessions")} />
          : <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="bench-label">{t("account.device")}</TableHead>
                  <TableHead className="bench-label">{t("account.ip")}</TableHead>
                  <TableHead className="bench-label">{t("account.lastActive")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sessions.map((session) => <TableRow key={session.id}>
                  <TableCell className="max-w-[12rem] truncate text-xs">{describeUserAgent(session.userAgent) ?? t("account.unknownDevice")}</TableCell>
                  <TableCell className="font-mono text-[11px] text-muted-foreground">{session.ip ?? "—"}</TableCell>
                  <TableCell className="text-xs text-muted-foreground" title={session.lastSeenAt}>{formatRelativeTime(session.lastSeenAt)}</TableCell>
                </TableRow>)}
              </TableBody>
            </Table>
            <div className="flex justify-end">
              <Button type="button" variant="outline" className={destructiveText} disabled={pending} onClick={() => setConfirming(true)}>{t("drawer.revokeAll")}</Button>
            </div>
          </>}
    <ConfirmDialog
      open={confirming} onOpenChange={setConfirming} destructive pending={pending}
      title={t("drawer.revokeAllTitle", { name: user.displayName })}
      description={t("drawer.revokeAllBody")}
      onConfirm={() => void revokeAll()}
    />
  </div>;
}

type ActionKind = "admin" | "status" | "reset";

function ActionsTab({ user, onChanged }: { user: UserSummary; onChanged: (user: UserSummary) => void }) {
  const { t } = useScopedI18n(accessMessages);
  const [confirming, setConfirming] = useState<ActionKind | null>(null);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reset, setReset] = useState<InviteLinkResponse | null>(null);

  const disabled = user.status === "disabled";
  const confirmCopy: Record<ActionKind, { title: string; description: string; destructive: boolean }> = {
    admin: user.isAdmin
      ? { title: t("actions.removeAdminTitle", { name: user.displayName }), description: t("actions.removeAdminBody"), destructive: true }
      : { title: t("actions.makeAdminTitle", { name: user.displayName }), description: t("actions.makeAdminBody"), destructive: false },
    status: disabled
      ? { title: t("actions.enableTitle", { name: user.displayName }), description: t("actions.enableBody"), destructive: false }
      : { title: t("actions.disableTitle", { name: user.displayName }), description: t("actions.disableBody"), destructive: true },
    reset: { title: t("actions.resetTitle", { name: user.displayName }), description: t("actions.resetBody"), destructive: true },
  };

  async function run(kind: ActionKind) {
    if (pending) return;
    setPending(true);
    setNotice(null);
    setError(null);
    try {
      if (kind === "reset") {
        setReset(await usersApi.reset(user.id));
        // Reset does not report the account back, and it just changed
        // pendingInvite server-side; re-read the row instead of leaving the
        // table and this header on the snapshot the drawer opened with.
        try {
          const fresh = (await usersApi.list()).find((candidate) => candidate.id === user.id);
          if (fresh) onChanged(fresh);
        } catch {
          // Best-effort: the link just generated stays visible either way.
        }
      } else {
        onChanged(await usersApi.update(user.id, kind === "admin"
          ? { isAdmin: !user.isAdmin }
          : { status: disabled ? "active" : "disabled" }));
        setNotice(t("actions.updated"));
      }
    } catch (failure) {
      setError(t(actionFailureKey(failure)));
    } finally {
      setConfirming(null);
      setPending(false);
    }
  }

  return <div className="grid gap-4">
    <FormFeedback notice={notice} error={error} />
    <ActionRow label={t("actions.adminSection")}>
      {/* The filled destructive button belongs to the confirmation; the
          trigger only carries the colour, as the delete controls do. */}
      <Button type="button" variant="outline" className={cx(user.isAdmin && destructiveText)} disabled={pending} onClick={() => setConfirming("admin")}>
        {t(user.isAdmin ? "actions.removeAdmin" : "actions.makeAdmin")}
      </Button>
    </ActionRow>
    <ActionRow label={t("actions.statusSection")}>
      <Button type="button" variant="outline" className={cx(!disabled && destructiveText)} disabled={pending} onClick={() => setConfirming("status")}>
        {t(disabled ? "actions.enable" : "actions.disable")}
      </Button>
    </ActionRow>
    <ActionRow label={t("actions.passwordSection")}>
      <Button type="button" variant="outline" disabled={pending} onClick={() => setConfirming("reset")}>{t("actions.reset")}</Button>
    </ActionRow>
    {reset && <div className="border border-border p-3"><InviteLinkPanel invite={reset} labelKey="invite.resetLink" /></div>}
    {confirming !== null && <ConfirmDialog
      open onOpenChange={(open) => { if (!open) setConfirming(null); }}
      pending={pending}
      title={confirmCopy[confirming].title}
      description={confirmCopy[confirming].description}
      destructive={confirmCopy[confirming].destructive}
      onConfirm={() => void run(confirming)}
    />}
  </div>;
}

function ActionRow({ label, children }: { label: string; children: ReactNode }) {
  return <div className="flex flex-wrap items-center justify-between gap-3 border border-border px-3 py-2.5">
    <span className="bench-label">{label}</span>
    {children}
  </div>;
}
