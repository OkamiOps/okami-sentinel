import type { RepositoryGrant, RepositoryRole } from "@csb/shared";
import { RoleSelect } from "./RoleSelect";
import { EmptyState } from "../ui";
import { accessMessages } from "../../i18n/access";
import { useScopedI18n } from "../../i18n/scoped";

export interface RepositoryOption { repositoryKey: string; displayName: string }

export type RoleDraft = Record<string, RepositoryRole | null>;

/** A draft keyed by repository is what both screens edit; the API takes a list. */
export function draftToGrants(draft: RoleDraft): RepositoryGrant[] {
  return Object.entries(draft)
    .filter((entry): entry is [string, RepositoryRole] => entry[1] !== null)
    .map(([repositoryKey, role]) => ({ repositoryKey, role }));
}

export function grantsToDraft(grants: RepositoryGrant[]): RoleDraft {
  return Object.fromEntries(grants.map((grant) => [grant.repositoryKey, grant.role]));
}

/**
 * One role per repository, shared by the invite dialog and the user drawer so
 * both read the same way and stay in step when the role list changes.
 */
export function RepositoryRoleList({ repositories, draft, onChange, disabled = false }: {
  repositories: RepositoryOption[];
  draft: RoleDraft;
  onChange: (repositoryKey: string, role: RepositoryRole | null) => void;
  disabled?: boolean;
}) {
  const { t } = useScopedI18n(accessMessages);
  if (repositories.length === 0) return <EmptyState title={t("invite.noRepositories")} description={t("access.emptyDescription")} />;
  return <ul className="grid gap-px border border-border bg-border">
    {repositories.map((repository) => <li
      key={repository.repositoryKey}
      className="grid gap-2 bg-background px-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_14rem] sm:items-center"
    >
      <div className="min-w-0">
        <div className="truncate text-xs font-medium">{repository.displayName}</div>
        <div className="truncate font-mono text-[10px] text-muted-foreground">{repository.repositoryKey}</div>
      </div>
      <RoleSelect
        allowNone
        label={repository.displayName}
        value={draft[repository.repositoryKey] ?? null}
        disabled={disabled}
        onChange={(role) => onChange(repository.repositoryKey, role)}
      />
    </li>)}
  </ul>;
}
