import { useCallback, useEffect, useState } from "react";
import type { RepositoryAccessEntry, RepositoryRole, UserSummary } from "@csb/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RoleSelect } from "../components/access/RoleSelect";
import { SettingsSectionNav } from "../components/settings/SettingsSectionNav";
import { AlertBanner, EmptyState, Loading, PageHeader, Panel, cx } from "../components/ui";
import { userState } from "../components/access/UserBadges";
import { usersApi } from "../lib/auth-api";
import { formatHandle } from "../lib/username";
import { accessMessages } from "../i18n/access";
import { useScopedI18n } from "../i18n/scoped";

type Grant = RepositoryAccessEntry["grants"][number];

function byName(left: Grant, right: Grant): number {
  return left.displayName.localeCompare(right.displayName);
}

/** The optimistic edit and the rollback both go through this one rewrite. */
function withRole(entries: RepositoryAccessEntry[], repositoryKey: string, user: UserSummary, role: RepositoryRole | null): RepositoryAccessEntry[] {
  return entries.map((entry) => {
    if (entry.repositoryKey !== repositoryKey) return entry;
    const others = entry.grants.filter((grant) => grant.userId !== user.id);
    const grants = role === null
      ? others
      : [...others, { userId: user.id, username: user.username, displayName: user.displayName, role }].sort(byName);
    return { ...entry, grants };
  });
}

export function RepositoryAccessPage() {
  const { t } = useScopedI18n(accessMessages);
  const [entries, setEntries] = useState<RepositoryAccessEntry[] | null>(null);
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadFailed(false);
    try {
      const [access, list] = await Promise.all([usersApi.repositoryAccess(), usersApi.list()]);
      setEntries(access.map((entry) => ({ ...entry, grants: [...entry.grants].sort(byName) })));
      setUsers(list);
    } catch {
      setEntries(null);
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  /**
   * The role lands in the list first: a select that snaps back to the old
   * value while the request is in flight reads as a refusal. A real refusal
   * restores the stored roles and says so.
   */
  async function setRole(repositoryKey: string, user: UserSummary, role: RepositoryRole | null) {
    const restore = entries;
    setError(null);
    setEntries((current) => current === null ? current : withRole(current, repositoryKey, user, role));
    try {
      await usersApi.setRepositoryRole(repositoryKey, user.id, role);
    } catch {
      setEntries(restore);
      setError(t("access.saveError"));
    }
  }

  return <>
    <PageHeader code={t("access.code")} title={t("access.title")} description={t("access.description")} />
    <SettingsSectionNav />
    {loadFailed && <AlertBanner>
      <span className="mr-3">{t("access.loadError")}</span>
      <Button type="button" variant="outline" size="sm" onClick={() => void load()}>{t("common.retry")}</Button>
    </AlertBanner>}
    {error && <AlertBanner>{error}</AlertBanner>}
    {entries === null
      ? loadFailed ? null : <Loading />
      : entries.length === 0
        ? <Panel label={t("access.title")}><EmptyState title={t("access.empty")} description={t("access.emptyDescription")} /></Panel>
        : <div className="grid gap-4">
          {entries.map((entry) => <RepositoryPanel
            key={entry.repositoryKey} entry={entry} users={users}
            onSetRole={(user, role) => void setRole(entry.repositoryKey, user, role)}
          />)}
        </div>}
  </>;
}

function RepositoryPanel({ entry, users, onSetRole }: {
  entry: RepositoryAccessEntry;
  users: UserSummary[];
  onSetRole: (user: UserSummary, role: RepositoryRole | null) => void;
}) {
  const { t } = useScopedI18n(accessMessages);
  const [candidateId, setCandidateId] = useState<string | null>(null);
  const [candidateRole, setCandidateRole] = useState<RepositoryRole | null>(null);

  // Administrators already reach every repository, and a disabled account
  // reaches none: granting either a role here would say nothing true.
  const candidates = users.filter((user) => !user.isAdmin && userState(user) !== "disabled"
    && !entry.grants.some((grant) => grant.userId === user.id));
  const candidate = candidates.find((user) => user.id === candidateId) ?? null;

  function grant() {
    if (!candidate || candidateRole === null) return;
    onSetRole(candidate, candidateRole);
    setCandidateId(null);
    setCandidateRole(null);
  }

  return <Panel
    label={<span className="flex flex-wrap items-center gap-2">
      <Badge variant="outline" className={cx("rounded-none border px-1.5 font-mono text-[9px] uppercase tracking-[0.12em]",
        entry.source === "github" ? "border-primary/45 text-primary" : "border-border text-muted-foreground")}>
        {t(entry.source === "github" ? "access.source.github" : "access.source.local")}
      </Badge>
      <span className="truncate font-mono text-[10px] normal-case tracking-normal text-muted-foreground">{entry.repositoryKey}</span>
    </span>}
    title={entry.displayName}
    wrapTitle
  >
    {entry.grants.length === 0
      ? <EmptyState title={t("access.noGrants")} />
      : <ul className="divide-y divide-border">
        {entry.grants.map((grant) => {
          const user = users.find((item) => item.id === grant.userId);
          return <li key={grant.userId} className="grid gap-2 px-4 py-2.5 sm:grid-cols-[minmax(0,1fr)_14rem] sm:items-center">
            <div className="min-w-0">
              <div className="truncate text-xs font-medium">{grant.displayName}</div>
              <div className="truncate font-mono text-[10px] text-muted-foreground">{formatHandle(grant.username)}</div>
            </div>
            <RoleSelect
              allowNone value={grant.role}
              label={t("access.roleFor", { name: grant.displayName, repository: entry.displayName })}
              // A user missing from the list cannot be identified for the API.
              disabled={user === undefined}
              onChange={(role) => user && onSetRole(user, role)}
            />
          </li>;
        })}
      </ul>}
    <div className="grid gap-2 border-t bg-muted/20 px-4 py-3">
      <span className="bench-label">{t("access.grantTitle")}</span>
      {candidates.length === 0
        ? <p className="text-xs text-muted-foreground">{t("access.allGranted")}</p>
        : <div className="grid gap-2 sm:grid-cols-[minmax(0,20rem)_14rem_auto] sm:items-center sm:justify-start">
          <Select value={candidateId ?? ""} onValueChange={setCandidateId}>
            <SelectTrigger aria-label={t("access.userFor", { repository: entry.displayName })} size="sm" className="w-full min-w-0">
              <SelectValue placeholder={t("access.selectUser")} />
            </SelectTrigger>
            <SelectContent position="popper">
              {candidates.map((user) => <SelectItem key={user.id} value={user.id}>
                <span className="truncate text-xs">{user.displayName}</span>
                <span className="font-mono text-[10px] text-muted-foreground">{formatHandle(user.username)}</span>
              </SelectItem>)}
            </SelectContent>
          </Select>
          <RoleSelect
            value={candidateRole} onChange={setCandidateRole}
            label={t("access.roleForNew", { repository: entry.displayName })}
          />
          <Button type="button" size="sm" disabled={!candidate || candidateRole === null} onClick={grant}>{t("access.grant")}</Button>
        </div>}
    </div>
  </Panel>;
}
