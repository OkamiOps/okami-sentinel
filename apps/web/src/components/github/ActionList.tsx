import { AlertTriangle, HardDrive, Plus } from "lucide-react";
import type { GitHubAction, GuardrailRepository } from "@csb/shared";

import { AlertBanner, EmptyState, Panel, cx } from "../ui";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatUsd } from "../../format";
import type { GitHubActionsMessageKey } from "../../i18n/github-actions";
import type { GitHubT } from "./labels";

/**
 * What each role may do, in one place, so the buttons and the sheet cannot disagree
 * about it. The API re-decides every one of these — this only keeps the screen from
 * offering a 403 as the answer to pressing a button.
 */
export interface GitHubActionPermissions {
  /** Create, enable, and anything that decides what a run costs or whose budget pays. */
  canSpend: boolean;
  /** Disable, delete, and reshape a **disabled** action. */
  canMaintain: boolean;
}

export function permissionsFor(
  isAdmin: boolean,
  can: (role: "maintainer", repositoryKey: string | null) => boolean,
  repositoryKey: string | null,
): GitHubActionPermissions {
  return { canSpend: isAdmin, canMaintain: can("maintainer", repositoryKey) };
}

/** A maintainer may reshape an action only while it is switched off. */
export function canReshape(action: GitHubAction, permissions: GitHubActionPermissions): boolean {
  return permissions.canSpend || (permissions.canMaintain && !action.enabled);
}

/**
 * `02 AÇÕES`. The selector spans **every** enrolled repository plus "all", because
 * an action list restricted to one repository is what made the old tab look stuck.
 */
export function ActionList({
  actions,
  repositories,
  repositoryKey,
  t,
  isAdmin,
  can,
  busyActionId,
  error,
  onRepositoryChange,
  onCreate,
  onEdit,
  onToggle,
  onDelete,
}: {
  actions: GitHubAction[];
  repositories: GuardrailRepository[];
  repositoryKey: string;
  t: GitHubT;
  isAdmin: boolean;
  can: (role: "maintainer", repositoryKey: string | null) => boolean;
  busyActionId: string | null;
  error: string | null;
  onRepositoryChange: (repositoryKey: string) => void;
  onCreate: () => void;
  onEdit: (action: GitHubAction) => void;
  onToggle: (action: GitHubAction, enabled: boolean) => void;
  onDelete: (action: GitHubAction) => void;
}) {
  const selected = repositories.find((repository) => repository.repositoryKey === repositoryKey) ?? null;
  const isLocal = selected !== null && selected.source === "local";
  const scopePermissions = permissionsFor(isAdmin, can, repositoryKey || null);
  // Creating needs a repository named: the body carries one, and "all repositories"
  // names none.
  const canCreate = scopePermissions.canSpend && selected !== null && !isLocal;
  const anyMaintainer = actions.some((action) => can("maintainer", action.repositoryKey));

  return <Panel
    label={t("github.actions")}
    title={t("github.actionsTitle")}
    wrapTitle
    aside={canCreate && <Button type="button" size="sm" onClick={onCreate}>
      <Plus aria-hidden className="size-3" />{t("github.actions.create")}
    </Button>}
  >
    <p className="border-b px-4 py-3 text-xs leading-relaxed text-muted-foreground">{t("github.actionsDescription")}</p>

    {repositories.length === 0
      ? <EmptyState title={t("github.actions.noRepositories")} description={t("github.actions.noRepositoriesDescription")} />
      : <>
        <div className="grid gap-3 border-b p-4 lg:grid-cols-[minmax(16rem,.5fr)_minmax(0,1fr)] lg:items-end">
          <div className="min-w-0">
            <label className="text-xs font-semibold" htmlFor="github-actions-repository">{t("github.actions.repository")}</label>
            <div className="mt-2">
              <Select value={repositoryKey || "__all__"} onValueChange={(value) => onRepositoryChange(value === "__all__" ? "" : value)}>
                <SelectTrigger id="github-actions-repository" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent position="popper" className="rounded-none border-border bg-popover">
                  <SelectItem value="__all__">{t("github.actions.allRepositories")}</SelectItem>
                  {repositories.map((repository) => <SelectItem key={repository.repositoryKey} value={repository.repositoryKey}>{repository.displayName}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <p className="min-w-0 border-l border-primary/35 pl-3 text-[11px] leading-relaxed text-muted-foreground">
            {t("github.actions.dayBudgetHint")}
          </p>
        </div>

        {error && <div className="p-4 pb-0"><AlertBanner>{error}</AlertBanner></div>}

        {/* A local checkout has no App authority, so the honest answer is the path
            to getting one — not a create form that would be refused. */}
        {isLocal
          ? <div className="p-4">
            <div className="flex min-w-0 items-start gap-3 border border-chart-3/40 bg-chart-3/[.06] p-4">
              <HardDrive aria-hidden className="mt-0.5 size-4 shrink-0 text-chart-3" />
              <div className="min-w-0">
                <strong className="block text-sm text-chart-3">{t("github.actions.localRepository")}</strong>
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{t("github.actions.localRepositoryDescription")}</p>
              </div>
            </div>
          </div>
          : actions.length === 0
            ? <EmptyState title={t("github.actions.empty")} description={t("github.actions.emptyDescription")} />
            : <ul className="divide-y">
              {actions.map((action) => <li key={action.id}>
                <ActionRow
                  action={action}
                  repositories={repositories}
                  t={t}
                  permissions={permissionsFor(isAdmin, can, action.repositoryKey)}
                  busy={busyActionId === action.id}
                  onEdit={() => onEdit(action)}
                  onToggle={(enabled) => onToggle(action, enabled)}
                  onDelete={() => onDelete(action)}
                />
              </li>)}
            </ul>}

        {!isLocal && actions.length > 0 && <p className="border-t px-4 py-3 text-[11px] leading-relaxed text-muted-foreground">
          {isAdmin ? t("github.actions.includeForksHint")
            : anyMaintainer ? t("github.actions.maintainerHint")
              : t("github.actions.viewerReadOnly")}
        </p>}
      </>}
  </Panel>;
}

function ActionRow({
  action,
  repositories,
  t,
  permissions,
  busy,
  onEdit,
  onToggle,
  onDelete,
}: {
  action: GitHubAction;
  repositories: GuardrailRepository[];
  t: GitHubT;
  permissions: GitHubActionPermissions;
  busy: boolean;
  onEdit: () => void;
  onToggle: (enabled: boolean) => void;
  onDelete: () => void;
}) {
  const repository = repositories.find((item) => item.repositoryKey === action.repositoryKey);
  const needsReview = action.migrationNote === "migrated_pattern_missing";
  const noteKey = action.migrationNote === null
    ? null
    : ["migrated_pattern_missing", "migrated_pattern_overflow", "migrated_without_ceiling"].includes(action.migrationNote)
      ? `github.migration.${action.migrationNote}` as GitHubActionsMessageKey
      : null;
  const note = action.migrationNote === null
    ? null
    : noteKey === null
      ? t("github.migration.unknown", { note: action.migrationNote })
      : t(noteKey);
  const profile = action.scanner === null
    ? t("github.sheet.modelRuntime")
    : [
      action.scanner.connection.modelId ?? t("github.sheet.modelRuntime"),
      t(`github.mode.${action.scanner.mode}`),
      action.scanner.effort ?? null,
    ].filter((part): part is string => part !== null).join(" · ");

  return <article className="grid min-w-0 gap-3 px-4 py-4 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_auto] xl:items-start">
    <div className="min-w-0">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <strong className="min-w-0 break-words text-sm">{action.name}</strong>
        <StateChip
          label={action.enabled ? t("github.actions.enabled") : t("github.actions.disabled")}
          tone={action.enabled ? "good" : "muted"}
        />
        {needsReview && <span className="inline-flex h-5 items-center gap-1 border border-chart-3/45 px-1.5 font-mono text-[8px] uppercase tracking-wider text-chart-3">
          <AlertTriangle aria-hidden className="size-2.5" />{t("github.actions.needsReview")}
        </span>}
        {action.includeForks && <span className="inline-flex h-5 items-center border border-destructive/45 px-1.5 font-mono text-[8px] uppercase tracking-wider text-destructive">
          fork
        </span>}
      </div>
      <div className="mt-1 min-w-0 break-all font-mono text-[10px] text-muted-foreground">
        {repository?.displayName ?? action.repositoryKey}
      </div>
      <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <Datum label={t("github.actions.column.trigger")} value={t(`github.trigger.${action.triggerKind}`)} />
        <Datum label={t("github.actions.column.executor")} value={t(`github.executor.${action.executor}`)} />
      </div>
      <div className="mt-2 flex min-w-0 flex-wrap gap-1">
        {action.branchPatterns.map((pattern) => <code
          key={pattern}
          className="min-w-0 break-all border bg-secondary/[.16] px-1.5 py-0.5 font-mono text-[10px]"
        >{pattern}</code>)}
      </div>
      {note && <p className={cx("mt-2 min-w-0 break-words text-xs leading-relaxed", needsReview ? "text-chart-3" : "text-muted-foreground")}>{note}</p>}
    </div>

    <dl className="grid min-w-0 grid-cols-2 gap-x-4 gap-y-3">
      <Cell label={t("github.actions.column.profile")} value={profile} />
      <Cell
        label={t("github.actions.column.ceiling")}
        value={`${formatUsd(action.costCeilingUsd, true)} / ${t("github.actions.perScan")}`}
        detail={action.dailyCostCeilingUsd === null
          ? t("github.actions.perDayNone")
          : `${formatUsd(action.dailyCostCeilingUsd, true)} / ${t("github.actions.perDay")}`}
      />
    </dl>

    <div className="flex shrink-0 flex-wrap items-center gap-2 xl:justify-end">
      {/* Enabling spends, so it is an administrator's; switching off never is. */}
      {action.enabled
        ? permissions.canMaintain && <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => onToggle(false)}>
          {t("github.actions.disableAction")}
        </Button>
        : permissions.canSpend && <Button type="button" size="sm" disabled={busy || needsReview} onClick={() => onToggle(true)}>
          {t("github.actions.enable")}
        </Button>}
      {canReshape(action, permissions) && <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onEdit}>
        {t("github.actions.edit")}
      </Button>}
      {permissions.canMaintain && <Button type="button" variant="destructive" size="sm" disabled={busy} onClick={onDelete}>
        {busy ? t("github.actions.deleting") : t("github.actions.delete")}
      </Button>}
    </div>
  </article>;
}

function Datum({ label, value }: { label: string; value: string }) {
  return <span className="inline-flex min-w-0 items-baseline gap-1.5">
    <span className="bench-label">{label}</span>
    <span className="min-w-0 break-words font-mono text-[10px]">{value}</span>
  </span>;
}

function Cell({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return <div className="min-w-0 border-l border-border pl-3">
    <dt className="bench-label">{label}</dt>
    <dd className="mt-1 min-w-0 break-words font-mono text-[10px] leading-relaxed">{value}</dd>
    {detail && <dd className="mt-0.5 min-w-0 break-words text-[10px] leading-relaxed text-muted-foreground">{detail}</dd>}
  </div>;
}

function StateChip({ label, tone }: { label: string; tone: "good" | "muted" }) {
  return <span className={cx(
    "inline-flex h-5 shrink-0 items-center gap-1.5 border px-1.5 font-mono text-[8px] uppercase tracking-wider",
    tone === "good" ? "border-chart-2/45 text-chart-2" : "border-border text-muted-foreground",
  )}>
    <span className="size-1 rounded-full bg-current" />{label}
  </span>;
}
