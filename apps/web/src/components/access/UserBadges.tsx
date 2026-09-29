import type { UserSummary } from "@csb/shared";
import { Badge } from "@/components/ui/badge";
import { cx } from "../ui";
import { accessMessages, type AccessMessageKey } from "../../i18n/access";
import { useScopedI18n } from "../../i18n/scoped";

export type UserState = "active" | "disabled" | "pending";

/**
 * A pending invite is not a third `status` on the server — it is an active
 * account that has never set a password. The table and the drawer both read
 * it as its own state, so the distinction is derived in one place.
 */
export function userState(user: UserSummary): UserState {
  if (user.status === "disabled") return "disabled";
  return user.pendingInvite && !user.hasPassword ? "pending" : "active";
}

const stateLabel: Record<UserState, AccessMessageKey> = {
  active: "users.state.active", disabled: "users.state.disabled", pending: "users.state.pending",
};

const stateTone: Record<UserState, string> = {
  active: "border-chart-2/45 text-chart-2",
  disabled: "border-border text-muted-foreground",
  pending: "border-chart-3/45 text-chart-3",
};

const chip = "rounded-none border px-1.5 font-mono text-[9px] uppercase tracking-[0.12em]";

export function UserStateBadge({ user }: { user: UserSummary }) {
  const { t } = useScopedI18n(accessMessages);
  const state = userState(user);
  return <Badge variant="outline" className={cx(chip, stateTone[state])}>{t(stateLabel[state])}</Badge>;
}

export function UserRoleBadge({ user }: { user: UserSummary }) {
  const { t } = useScopedI18n(accessMessages);
  return <Badge variant="outline" className={cx(chip, user.isAdmin ? "border-primary/45 text-primary" : "border-border text-muted-foreground")}>
    {t(user.isAdmin ? "users.column.admin" : "users.member")}
  </Badge>;
}
