import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { UserSessionSummary } from "@csb/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SettingsSectionNav } from "../components/settings/SettingsSectionNav";
import { AlertBanner, EmptyState, Loading, PageHeader, Panel, cx } from "../components/ui";
import { useAuth } from "../auth/AuthProvider";
import { authApi, authErrorCode } from "../lib/auth-api";
import { passwordIssue, type PasswordIssue } from "../lib/password-policy";
import { describeUserAgent } from "../lib/user-agent";
import { formatRelativeTime } from "../format";
import { accessMessages, type AccessMessageKey } from "../i18n/access";
import { useScopedI18n } from "../i18n/scoped";

const issueKey: Record<PasswordIssue, AccessMessageKey> = {
  tooShort: "account.tooShort", tooLong: "account.tooLong",
  matchesUsername: "account.matchesUsername", mismatch: "account.mismatch",
};

/** The server may reject a password the client accepted; repeat its named rule
 * instead of collapsing everything into "try again". */
function changeFailureKey(failure: unknown): AccessMessageKey {
  const code = authErrorCode(failure);
  if (code === "invalid_credentials") return "account.wrongCurrent";
  if (code === "password_too_short") return "account.tooShort";
  if (code === "password_too_long") return "account.tooLong";
  if (code === "password_matches_username") return "account.matchesUsername";
  return "account.changeError";
}

export function AccountPage() {
  const { t } = useScopedI18n(accessMessages);
  const { session, status, isAdmin, refresh } = useAuth();
  // Changing the password ends every other session server-side, so the table
  // below it has to be re-read or it keeps listing sessions that are gone.
  const [sessionsReload, setSessionsReload] = useState(0);

  // The shell only gates `loading` and `signed-out`; an unreachable session
  // endpoint still reaches this page with nothing to render. Say so and offer
  // the read again, instead of spinning forever on a request already decided.
  if (!session) return status === "loading" ? <Loading /> : <AccountUnverified onRetry={refresh} />;

  // A local deployment has no account store behind it: every `/account`
  // endpoint answers 404 there. Showing a password form and a session list
  // that can only fail would be a lie, so local mode keeps the identity
  // readout and says plainly where accounts do apply.
  const local = session.runtimeMode === "local";

  return <>
    <PageHeader code={t("account.code")} title={t("account.title")} description={t("account.description")} />
    <SettingsSectionNav />
    {local && <AlertBanner tone="info">{t("account.localNote")}</AlertBanner>}
    <div className="grid gap-4 xl:grid-cols-2">
      <ProfilePanel displayName={session.user.displayName} username={session.user.username} isAdmin={isAdmin} editable={!local} onSaved={refresh} />
      {!local && <PasswordPanel username={session.user.username} onChanged={() => setSessionsReload((value) => value + 1)} />}
      {!local && <div className="min-w-0 xl:col-span-2"><SessionsPanel reloadKey={sessionsReload} /></div>}
    </div>
  </>;
}

function AccountUnverified({ onRetry }: { onRetry: () => Promise<void> }) {
  const { t } = useScopedI18n(accessMessages);
  const [retrying, setRetrying] = useState(false);
  return <>
    <PageHeader code={t("account.code")} title={t("account.title")} description={t("account.description")} />
    <SettingsSectionNav />
    <Panel label={t("account.profile")}>
      <div className="grid gap-4 px-4 py-5">
        <AlertBanner tone="warning">{t("account.unverified")}</AlertBanner>
        <div>
          <Button type="button" variant="outline" size="sm" disabled={retrying} onClick={() => {
            setRetrying(true);
            void onRetry().finally(() => setRetrying(false));
          }}>{t("common.retry")}</Button>
        </div>
      </div>
    </Panel>
  </>;
}

function ProfilePanel({ displayName, username, isAdmin, editable, onSaved }: { displayName: string; username: string; isAdmin: boolean; editable: boolean; onSaved: () => Promise<void> }) {
  const { t } = useScopedI18n(accessMessages);
  const [name, setName] = useState(displayName);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A rename that lands elsewhere (another tab, an admin) must not be silently
  // overwritten by a stale draft this panel is still holding.
  useEffect(() => { setName(displayName); }, [displayName]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending || !editable) return;
    const trimmed = name.trim();
    if (!trimmed) { setNotice(null); return setError(t("account.nameRequired")); }
    setPending(true);
    setNotice(null);
    setError(null);
    try {
      await authApi.updateProfile(trimmed);
      await onSaved();
      setNotice(t("account.saved"));
    } catch {
      setError(t("account.saveError"));
    } finally {
      setPending(false);
    }
  }

  return <Panel label={t("account.profile")} title={displayName}>
    <form className="grid gap-4 px-4 py-4" onSubmit={(event) => void submit(event)} noValidate>
      <div className="grid gap-1.5">
        <label htmlFor="account-display-name" className="bench-label">{t("account.displayName")}</label>
        <Input id="account-display-name" name="display-name" value={name} disabled={pending} readOnly={!editable} autoComplete="name" className={cx(!editable && "bg-muted/40 text-muted-foreground")} onChange={(event) => setName(event.target.value)} />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <label htmlFor="account-username" className="bench-label">{t("account.username")}</label>
          <Input id="account-username" value={username} autoComplete="username" readOnly tabIndex={-1} className="bg-muted/40 text-muted-foreground" />
        </div>
        <div className="grid gap-1.5">
          <span className="bench-label">{t("account.role")}</span>
          <span className="flex h-9 items-center border border-border bg-muted/40 px-3 font-mono text-[11px] text-muted-foreground">
            {isAdmin ? t("userMenu.admin") : t("userMenu.member")}
          </span>
        </div>
      </div>
      <PanelFeedback notice={notice} error={error} />
      {editable && <div className="flex justify-end">
        <Button type="submit" disabled={pending}>{pending ? t("account.saving") : t("account.save")}</Button>
      </div>}
    </form>
  </Panel>;
}

function PasswordPanel({ username, onChanged }: { username: string; onChanged: () => void }) {
  const { t } = useScopedI18n(accessMessages);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    const issue = passwordIssue(next, confirmation, username);
    if (issue) { setNotice(null); return setError(t(issueKey[issue])); }
    setPending(true);
    setNotice(null);
    setError(null);
    try {
      await authApi.changePassword(current, next);
      setCurrent("");
      setNext("");
      setConfirmation("");
      setNotice(t("account.changed"));
      onChanged();
    } catch (failure) {
      setError(t(changeFailureKey(failure)));
    } finally {
      setPending(false);
    }
  }

  return <Panel label={t("account.password")} title={t("account.change")}>
    <form className="grid gap-4 px-4 py-4" onSubmit={(event) => void submit(event)} noValidate>
      <div className="grid gap-1.5">
        <label htmlFor="account-current-password" className="bench-label">{t("account.current")}</label>
        <Input id="account-current-password" name="current-password" type="password" value={current} autoComplete="current-password" disabled={pending} onChange={(event) => setCurrent(event.target.value)} />
      </div>
      <div className="grid gap-1.5">
        <label htmlFor="account-new-password" className="bench-label">{t("account.new")}</label>
        <Input id="account-new-password" name="new-password" type="password" value={next} autoComplete="new-password" disabled={pending} aria-describedby="account-password-policy" onChange={(event) => setNext(event.target.value)} />
        <p id="account-password-policy" className="text-[11px] leading-relaxed text-muted-foreground">{t("account.policy")}</p>
      </div>
      <div className="grid gap-1.5">
        <label htmlFor="account-confirm-password" className="bench-label">{t("account.confirm")}</label>
        <Input id="account-confirm-password" name="confirm-password" type="password" value={confirmation} autoComplete="new-password" disabled={pending} onChange={(event) => setConfirmation(event.target.value)} />
      </div>
      <PanelFeedback notice={notice} error={error} />
      <div className="flex justify-end">
        <Button type="submit" disabled={pending}>{pending ? t("account.changing") : t("account.change")}</Button>
      </div>
    </form>
  </Panel>;
}

function SessionsPanel({ reloadKey }: { reloadKey: number }) {
  const { t } = useScopedI18n(accessMessages);
  const [sessions, setSessions] = useState<UserSessionSummary[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A failed read clears the list and raises its own state: an error banner
  // stacked on a spinner that will never resolve tells the reader to wait for
  // a request that already failed, and gives them nothing to do about it.
  const load = useCallback(async () => {
    setLoadFailed(false);
    try {
      setSessions(await authApi.sessions());
    } catch {
      setSessions(null);
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => { void load(); }, [load, reloadKey]);

  async function revoke(action: () => Promise<void>) {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await action();
      await load();
    } catch {
      setError(t("account.revokeError"));
    } finally {
      setPending(false);
    }
  }

  const others = (sessions ?? []).filter((session) => !session.current);

  return <Panel
    label={t("account.sessions")}
    aside={<Button type="button" variant="outline" size="sm" disabled={pending || others.length === 0} onClick={() => void revoke(() => authApi.revokeOtherSessions())}>{t("account.revokeOthers")}</Button>}
  >
    {error && <div className="px-4 pt-4"><AlertBanner>{error}</AlertBanner></div>}
    {loadFailed
      ? <div className="grid gap-4 px-4 py-5">
        <AlertBanner>{t("account.sessionsError")}</AlertBanner>
        <div><Button type="button" variant="outline" size="sm" onClick={() => void load()}>{t("common.retry")}</Button></div>
      </div>
      : sessions === null
      ? <Loading />
      : sessions.length === 0
        ? <EmptyState title={t("account.noSessions")} />
        : <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="bench-label">{t("account.device")}</TableHead>
              <TableHead className="bench-label">{t("account.ip")}</TableHead>
              <TableHead className="bench-label">{t("account.lastActive")}</TableHead>
              <TableHead className="sr-only">{t("account.revoke")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sessions.map((session) => <TableRow key={session.id}>
              <TableCell className="max-w-[18rem] truncate text-xs">
                {describeUserAgent(session.userAgent) ?? t("account.unknownDevice")}
                {session.current && <span className="ml-2 inline-flex h-5 items-center border border-primary/45 px-1.5 font-mono text-[9px] uppercase tracking-[0.12em] text-primary">{t("account.thisSession")}</span>}
              </TableCell>
              <TableCell className="font-mono text-[11px] text-muted-foreground">{session.ip ?? "—"}</TableCell>
              <TableCell className="text-xs text-muted-foreground" title={session.lastSeenAt}>{formatRelativeTime(session.lastSeenAt)}</TableCell>
              <TableCell className="text-right">
                {/* Revoking the session you are reading this in would sign you
                    out mid-page; "sign out" in the user menu is that action. */}
                <Button type="button" variant="outline" size="sm" disabled={pending || session.current} onClick={() => void revoke(() => authApi.revokeSession(session.id))}>{t("account.revoke")}</Button>
              </TableCell>
            </TableRow>)}
          </TableBody>
        </Table>}
  </Panel>;
}

function PanelFeedback({ notice, error }: { notice: string | null; error: string | null }) {
  return <div aria-live="polite" className="empty:hidden">
    {error && <p role="alert" className="border border-destructive/45 bg-destructive/8 px-3 py-2.5 text-xs text-destructive">{error}</p>}
    {!error && notice && <p className="border border-chart-2/40 bg-chart-2/8 px-3 py-2.5 text-xs text-chart-2">{notice}</p>}
  </div>;
}
