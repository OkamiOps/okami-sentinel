import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AuthCard, AuthFrame } from "../components/auth/AuthFrame";
import { Loading, cx } from "../components/ui";
import { useAuth } from "../auth/AuthProvider";
import { AuthRequestError, authApi, type InvitePreview } from "../lib/auth-api";
import { authMessages, type AuthMessageKey } from "../i18n/auth";
import { useScopedI18n } from "../i18n/scoped";
import { PASSWORD_MIN_LENGTH, passwordIssue, type PasswordIssue } from "../lib/password-policy";

type StrengthKey = "strength.weak" | "strength.fair" | "strength.good" | "strength.strong";

/** Length is the only signal the server policy actually rewards, so it is the
 * only one this meter claims to measure. */
function strengthOf(password: string): { filled: number; key: StrengthKey } {
  if (password.length >= 24) return { filled: 4, key: "strength.strong" };
  if (password.length >= 16) return { filled: 3, key: "strength.good" };
  if (password.length >= PASSWORD_MIN_LENGTH) return { filled: 2, key: "strength.fair" };
  return { filled: 1, key: "strength.weak" };
}

const issueKey: Record<PasswordIssue, AuthMessageKey> = {
  tooShort: "invite.tooShort", tooLong: "invite.tooLong",
  matchesUsername: "invite.matchesUsername", mismatch: "invite.mismatch",
};

/**
 * "Ask your administrator for a new link" is destructive advice: it sends the
 * colleague away and burns the token they are holding. Say it only when the
 * server actually rejected the token, repeat a named policy rule when the
 * server named one, and treat everything else (429, 5xx, a dropped network) as
 * a retry on a form that is still usable.
 */
function acceptFailureKey(failure: unknown): AuthMessageKey {
  if (!(failure instanceof AuthRequestError)) return "invite.retry";
  if (failure.code === "password_too_short") return "invite.tooShort";
  if (failure.code === "password_too_long") return "invite.tooLong";
  if (failure.code === "password_matches_username") return "invite.matchesUsername";
  if (failure.code === "invite_invalid" || failure.status === 404) return "invite.invalid";
  return "invite.retry";
}

export function InvitePage() {
  const { t } = useScopedI18n(authMessages);
  const { token = "" } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const { refresh } = useAuth();

  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "invalid">("loading");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    authApi.invite(token).then(
      (result) => { if (active) { setPreview(result); setState("ready"); } },
      () => { if (active) setState("invalid"); },
    );
    return () => { active = false; };
  }, [token]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending || preview === null) return;
    const issue = passwordIssue(password, confirmation, preview.username);
    if (issue) return setError(t(issueKey[issue]));
    setPending(true);
    setError(null);
    try {
      await authApi.acceptInvite(token, password);
      await refresh();
      navigate("/", { replace: true });
    } catch (failure) {
      setError(t(acceptFailureKey(failure)));
    } finally {
      setPending(false);
    }
  }

  if (state === "loading") return <AuthFrame><div className="bench-panel"><Loading /></div></AuthFrame>;

  if (state === "invalid" || preview === null) {
    return (
      <AuthFrame>
        <AuthCard code={t("invite.code")} title={t("invite.title")}>
          <div className="grid gap-4 px-5 py-5">
            <p role="alert" className="border border-destructive/45 bg-destructive/8 px-3 py-2.5 text-xs leading-relaxed text-destructive">
              {t("invite.invalid")}
            </p>
            <Button asChild variant="outline" size="lg" className="w-full"><Link to="/login">{t("invite.backToLogin")}</Link></Button>
          </div>
        </AuthCard>
      </AuthFrame>
    );
  }

  const reset = preview.purpose === "reset";
  const strength = strengthOf(password);

  return (
    <AuthFrame footer={<Link to="/login" className="truncate transition-colors hover:text-foreground">{t("invite.backToLogin")}</Link>}>
      <AuthCard
        code={t("invite.code")}
        title={reset ? t("invite.resetTitle") : t("invite.title")}
        description={reset ? undefined : preview.invitedBy ? t("invite.invitedBy", { name: preview.invitedBy }) : t("invite.invitedAnonymous")}
      >
        <form className="grid gap-4 px-5 py-5" onSubmit={(event) => void submit(event)} noValidate>
          <div className="grid gap-1.5">
            <label htmlFor="invite-username" className="bench-label">{t("invite.username")}</label>
            <Input id="invite-username" name="username" value={preview.username} autoComplete="username" readOnly tabIndex={-1} aria-describedby="invite-display-name" className="bg-muted/40 text-muted-foreground" />
            <p id="invite-display-name" className="font-mono text-[10px] text-muted-foreground">{preview.displayName}</p>
          </div>

          <div className="grid gap-1.5">
            <label htmlFor="invite-password" className="bench-label">{t("invite.password")}</label>
            <div className="relative">
              <Input
                id="invite-password" name="new-password" type={revealed ? "text" : "password"} value={password}
                autoComplete="new-password" disabled={pending} className="pr-11" aria-describedby="invite-policy invite-strength"
                onChange={(event) => setPassword(event.target.value)}
              />
              <button
                type="button" aria-pressed={revealed} aria-label={revealed ? t("login.hide") : t("login.show")}
                disabled={pending} onClick={() => setRevealed((value) => !value)}
                className="absolute inset-y-0 right-0 flex w-10 items-center justify-center border-l border-border text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-40"
              >
                {revealed ? <EyeOff aria-hidden size={14} /> : <Eye aria-hidden size={14} />}
              </button>
            </div>
            <div className="flex items-center gap-2">
              <span aria-hidden="true" className="flex flex-1 gap-1">
                {[0, 1, 2, 3].map((index) => (
                  <span key={index} className={cx("h-1 flex-1", index < strength.filled && password.length > 0
                    ? strength.filled === 1 ? "bg-destructive" : strength.filled === 2 ? "bg-chart-3" : strength.filled === 3 ? "bg-chart-5" : "bg-chart-2"
                    : "bg-border")} />
                ))}
              </span>
              <span id="invite-strength" className="w-16 shrink-0 text-right font-mono text-[9px] uppercase tracking-[0.12em] text-muted-foreground">
                {password.length > 0 ? t(strength.key) : ""}
              </span>
            </div>
            <p id="invite-policy" className="text-[11px] leading-relaxed text-muted-foreground">{t("invite.policy")}</p>
          </div>

          <div className="grid gap-1.5">
            <label htmlFor="invite-confirm" className="bench-label">{t("invite.confirm")}</label>
            <Input
              id="invite-confirm" name="confirm-password" type={revealed ? "text" : "password"} value={confirmation}
              autoComplete="new-password" disabled={pending}
              onChange={(event) => setConfirmation(event.target.value)}
            />
          </div>

          <div aria-live="polite" className="empty:hidden">
            {error && <p className="border border-destructive/45 bg-destructive/8 px-3 py-2.5 text-xs text-destructive">{error}</p>}
          </div>

          <Button type="submit" size="lg" className="w-full" disabled={pending}>
            {pending && <span aria-hidden="true" className="loading loading-spinner loading-xs" />}
            {pending ? t("login.submitting") : t("invite.submit")}
          </Button>
        </form>
      </AuthCard>
    </AuthFrame>
  );
}
