import { useCallback, useEffect, useMemo, useState } from "react";
import type { UserSummary } from "@csb/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { InviteUserDialog } from "../components/access/InviteUserDialog";
import type { RepositoryOption } from "../components/access/RepositoryRoleList";
import { UserDrawer } from "../components/access/UserDrawer";
import { UserRoleBadge, UserStateBadge, userState, type UserState } from "../components/access/UserBadges";
import { SettingsSectionNav } from "../components/settings/SettingsSectionNav";
import { AlertBanner, EmptyState, Loading, PageHeader, Panel } from "../components/ui";
import { usersApi } from "../lib/auth-api";
import { formatHandle } from "../lib/username";
import { formatRelativeTime } from "../format";
import { accessMessages, type AccessMessageKey } from "../i18n/access";
import { useScopedI18n } from "../i18n/scoped";

type StatusFilter = "all" | UserState;

const filters: ReadonlyArray<readonly [StatusFilter, AccessMessageKey]> = [
  ["all", "users.filter.all"], ["active", "users.filter.active"],
  ["disabled", "users.filter.disabled"], ["pending", "users.filter.pending"],
];

export function UsersPage() {
  const { t } = useScopedI18n(accessMessages);
  const [users, setUsers] = useState<UserSummary[] | null>(null);
  const [repositories, setRepositories] = useState<RepositoryOption[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [inviting, setInviting] = useState(false);
  const [openUserId, setOpenUserId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadFailed(false);
    try {
      // The access view already lists every registered repository, roles
      // included, so the invite dialog and the drawer need no second source.
      const [list, access] = await Promise.all([usersApi.list(), usersApi.repositoryAccess()]);
      setUsers(list);
      setRepositories(access.map(({ repositoryKey, displayName }) => ({ repositoryKey, displayName })));
    } catch {
      setUsers(null);
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  function apply(updated: UserSummary) {
    setUsers((current) => (current ?? []).map((user) => user.id === updated.id ? updated : user));
  }

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (users ?? []).filter((user) => (status === "all" || userState(user) === status)
      && (!needle || user.displayName.toLowerCase().includes(needle) || user.username.includes(needle)));
  }, [users, query, status]);

  // The drawer reads from the list, so a rename or a role change lands in it
  // without a second copy of the user going stale behind the sheet.
  const openUser = users?.find((user) => user.id === openUserId) ?? null;

  return <>
    <PageHeader
      code={t("users.code")} title={t("users.title")} description={t("users.description")}
      actions={<Button type="button" onClick={() => setInviting(true)}>{t("users.invite")}</Button>}
    />
    <SettingsSectionNav />
    {loadFailed && <AlertBanner>
      <span className="mr-3">{t("users.loadError")}</span>
      <Button type="button" variant="outline" size="sm" onClick={() => void load()}>{t("common.retry")}</Button>
    </AlertBanner>}
    <Panel label={t("users.title")} aside={<span className="font-mono text-[10px] text-muted-foreground tabular-nums">{visible.length}</span>}>
      <div className="grid gap-3 border-b px-4 py-3 sm:grid-cols-[minmax(0,24rem)_12rem] sm:justify-start">
        <div className="grid gap-1.5">
          <label htmlFor="users-search" className="bench-label">{t("users.search")}</label>
          <Input
            id="users-search" value={query} type="search" autoComplete="off"
            placeholder={t("users.searchPlaceholder")} onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <span className="bench-label">{t("users.status")}</span>
          <Select value={status} onValueChange={(value) => setStatus(value as StatusFilter)}>
            <SelectTrigger aria-label={t("users.status")} className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent position="popper">
              {filters.map(([value, label]) => <SelectItem key={value} value={value}>{t(label)}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>
      {users === null
        ? loadFailed ? null : <Loading />
        : visible.length === 0
          ? <EmptyState title={t(users.length === 0 ? "users.empty" : "users.emptyFiltered")} />
          : <Table>
            <TableHeader>
              <TableRow>
                {/* The name column absorbs the slack so the compact columns stay
                    next to each other instead of drifting apart. */}
                <TableHead className="bench-label w-full">{t("users.column.name")}</TableHead>
                <TableHead className="bench-label">{t("users.column.status")}</TableHead>
                <TableHead className="bench-label">{t("users.column.admin")}</TableHead>
                <TableHead className="bench-label text-right">{t("users.column.repositories")}</TableHead>
                <TableHead className="bench-label">{t("users.column.lastLogin")}</TableHead>
                {/* Phase 1 has nothing to say in these two columns, so a
                    narrow screen spends its width on the ones that do. */}
                <TableHead className="bench-label hidden md:table-cell">{t("users.column.twoFactor")}</TableHead>
                <TableHead className="bench-label hidden md:table-cell">{t("users.column.github")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((user) => <TableRow key={user.id} className="cursor-pointer" onClick={() => setOpenUserId(user.id)}>
                <TableCell className="max-w-[22rem]">
                  {/* The whole row is the target for a pointer; the button is
                      what a keyboard reaches. Its own text is the name, so the
                      row still reads as the person it is about. */}
                  <button
                    type="button" aria-haspopup="dialog"
                    className="block max-w-full text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    onClick={(event) => { event.stopPropagation(); setOpenUserId(user.id); }}
                  >
                    <span className="block truncate text-xs font-medium">{user.displayName}</span>
                    <span className="block truncate font-mono text-[10px] text-muted-foreground">{formatHandle(user.username)}</span>
                  </button>
                </TableCell>
                <TableCell><UserStateBadge user={user} /></TableCell>
                <TableCell><UserRoleBadge user={user} /></TableCell>
                <TableCell className="text-right font-mono text-[11px] tabular-nums">{user.repositoryCount}</TableCell>
                <TableCell className="whitespace-nowrap text-xs text-muted-foreground" title={user.lastLoginAt ?? undefined}>
                  {user.lastLoginAt ? formatRelativeTime(user.lastLoginAt) : t("users.never")}
                </TableCell>
                {/* 2FA and a linked GitHub account arrive in phase 3. */}
                <TableCell className="hidden font-mono text-[11px] text-muted-foreground md:table-cell">—</TableCell>
                <TableCell className="hidden font-mono text-[11px] text-muted-foreground md:table-cell">—</TableCell>
              </TableRow>)}
            </TableBody>
          </Table>}
    </Panel>
    <InviteUserDialog
      open={inviting} onOpenChange={setInviting} repositories={repositories}
      onCreated={(user) => setUsers((current) => [...(current ?? []), user])}
    />
    <UserDrawer
      user={openUser} repositories={repositories}
      onOpenChange={(open) => { if (!open) setOpenUserId(null); }}
      onChanged={apply}
    />
  </>;
}
