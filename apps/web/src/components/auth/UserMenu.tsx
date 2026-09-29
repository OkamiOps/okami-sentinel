import { useNavigate } from "react-router-dom";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useAuth } from "../../auth/AuthProvider";
import { useI18n } from "../../i18n";

/** First letters of up to two words, so "Ana Paula Souza" reads as "AP". */
export function initialsOf(displayName: string): string {
  const letters = displayName.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((word) => [...word][0] ?? "");
  return letters.join("").toUpperCase() || "?";
}

export function UserMenu() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { session, isAdmin, logout } = useAuth();
  if (!session) return null;
  const { displayName, username } = session.user;
  // A local deployment has a single implicit operator and no credentials to
  // drop: offering "sign out" there would only produce a dead end.
  const canSignOut = session.runtimeMode === "server";

  return <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <button
        type="button" aria-label={t("userMenu.open")}
        className="flex h-full max-w-44 items-center gap-2 border-l border-border px-3 text-muted-foreground transition hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span aria-hidden="true" className="flex size-7 shrink-0 items-center justify-center border border-primary/45 bg-primary/10 font-mono text-[9px] font-semibold uppercase tracking-wide text-primary">{initialsOf(displayName)}</span>
        <span className="hidden min-w-0 truncate text-[11px] font-medium text-foreground xl:inline">{displayName}</span>
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="report-no-print w-60 rounded-none border-border bg-popover p-1.5">
      <div className="px-2 py-2">
        <div className="truncate text-[12px] font-semibold text-foreground">{displayName}</div>
        <div className="truncate font-mono text-[10px] text-muted-foreground">@{username}</div>
        <span className="mt-1.5 inline-flex h-5 items-center border border-border px-1.5 font-mono text-[9px] uppercase tracking-[0.12em] text-muted-foreground">
          {isAdmin ? t("userMenu.admin") : t("userMenu.member")}
        </span>
      </div>
      <DropdownMenuSeparator />
      <DropdownMenuItem className="rounded-none px-2 py-2.5 text-[11px]" onSelect={() => navigate("/settings/account")}>
        {t("userMenu.account")}
      </DropdownMenuItem>
      {canSignOut && <DropdownMenuItem className="rounded-none px-2 py-2.5 text-[11px]" onSelect={() => void logout()}>
        {t("userMenu.logout")}
      </DropdownMenuItem>}
    </DropdownMenuContent>
  </DropdownMenu>;
}
