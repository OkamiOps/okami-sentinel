import type { RepositoryRole } from "@csb/shared";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { accessMessages, type AccessMessageKey } from "../../i18n/access";
import { useScopedI18n } from "../../i18n/scoped";
import { cx } from "../ui";

/** Weakest first, as the spec's table reads. */
export const REPOSITORY_ROLES: readonly RepositoryRole[] = ["viewer", "analyst", "operator", "maintainer"];

const roleLabel: Record<RepositoryRole, AccessMessageKey> = {
  viewer: "role.viewer", analyst: "role.analyst", operator: "role.operator", maintainer: "role.maintainer",
};

const roleDetail: Record<RepositoryRole, AccessMessageKey> = {
  viewer: "role.viewerDetail", analyst: "role.analystDetail",
  operator: "role.operatorDetail", maintainer: "role.maintainerDetail",
};

/** Radix has no empty item value, so "no access" carries a sentinel. */
const NONE = "__none__";

/**
 * The trigger states the role alone; the one-line description belongs in the
 * open list, where it helps the decision, not in the closed control, where it
 * would only crowd the row out of its column.
 */
export function RoleSelect({ value, onChange, allowNone = false, label, disabled = false, className }: {
  value: RepositoryRole | null;
  onChange: (role: RepositoryRole | null) => void;
  allowNone?: boolean;
  /** Accessible name: the repository or the person this role applies to. */
  label: string;
  disabled?: boolean;
  className?: string;
}) {
  const { t } = useScopedI18n(accessMessages);
  return <Select
    value={value ?? NONE}
    disabled={disabled}
    onValueChange={(next) => onChange(next === NONE ? null : next as RepositoryRole)}
  >
    <SelectTrigger aria-label={label} size="sm" className={cx("w-full min-w-0", className)}>
      <SelectValue>
        <span className={cx("truncate", value === null && !allowNone && "text-muted-foreground")}>
          {value === null ? t(allowNone ? "role.none" : "role.select") : t(roleLabel[value])}
        </span>
      </SelectValue>
    </SelectTrigger>
    <SelectContent position="popper" className="max-w-[min(24rem,calc(100vw-2rem))]">
      {allowNone && <SelectItem value={NONE}>
        <span className="text-xs font-medium">{t("role.none")}</span>
      </SelectItem>}
      {REPOSITORY_ROLES.map((role) => <SelectItem key={role} value={role}>
        <span className="flex min-w-0 flex-col gap-0.5 py-0.5">
          <span className="text-xs font-medium">{t(roleLabel[role])}</span>
          <span className="whitespace-normal text-[10px] leading-snug text-muted-foreground">{t(roleDetail[role])}</span>
        </span>
      </SelectItem>)}
    </SelectContent>
  </Select>;
}
