import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AuthCard, AuthFrame } from "../components/auth/AuthFrame";
import { useAuth } from "../auth/AuthProvider";
import { AuthRequestError, authApi } from "../lib/auth-api";
import { safeNext } from "../lib/safe-next";
import { authMessages } from "../i18n/auth";
import { useScopedI18n } from "../i18n/scoped";

type Failure = { kind: "invalid" | "network" | "locked" | "rateLimited" };

/**
 * A 423/429 without `retryAfterSeconds` still has to disable the button for
 * something; a conservative minute keeps the copy coherent and bounded instead
 * of inviting an immediate retry the server will refuse anyway.
 */
const DEFAULT_LOCKOUT_SECONDS = 60;

/** The lockout copy is only useful with a clock the operator can watch run out. */
function formatCountdown(seconds: number): string {
  const safe = Math.max(0, seconds);
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

function failureFor(error: unknown): { failure: Failure; countdown: number } {
  if (error instanceof AuthRequestError) {
    const countdown = error.retryAfterSeconds ?? DEFAULT_LOCKOUT_SECONDS;
    if (error.code === "account_locked" || error.status === 423) return { failure: { kind: "locked" }, countdown };
    if (error.code === "rate_limited" || error.status === 429) return { failure: { kind: "rateLimited" }, countdown };
    if (error.code === "invalid_credentials" || error.status === 401) return { failure: { kind: "invalid" }, countdown: 0 };
  }
  return { failure: { kind: "network" }, countdown: 0 };
}

export function LoginPage() {
  const { t } = useScopedI18n(authMessages);
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { status, refresh } = useAuth();
  const next = safeNext(params.get("next"));
  const expired = params.get("expired") === "1";

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [remaining, setRemaining] = useState(0);
  const usernameRef = useRef<HTMLInputElement>(null);

  // A session that is already valid must never be able to sit on this page and
  // bounce back here: `safeNext` has already stripped `/login` and `/invite/*`
  // out of the destination, so this redirect terminates.
  useEffect(() => {
    if (status === "signed-in") navigate(next, { replace: true });
  }, [status, next, navigate]);

  useEffect(() => { usernameRef.current?.focus(); }, []);

  useEffect(() => {
    if (remaining <= 0) return;
    const id = window.setInterval(() => setRemaining((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearInterval(id);
  }, [remaining]);

  // Once the wait is over the stale "try again in 00:00" must not linger.
  const timed = failure?.kind === "locked" || failure?.kind === "rateLimited";
  useEffect(() => {
    if (timed && remaining === 0) setFailure(null);
  }, [timed, remaining]);

  const locked = remaining > 0;
  const message = failure === null ? null
    : failure.kind === "invalid" ? t("login.invalid")
      : failure.kind === "network" ? t("login.network")
        : t(failure.kind === "locked" ? "login.locked" : "login.rateLimited", { time: formatCountdown(remaining) });

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending || locked) return;
    setPending(true);
    setFailure(null);
    try {
      await authApi.login(username, password);
      await refresh();
      navigate(next, { replace: true });
    } catch (error) {
      const { failure: result, countdown } = failureFor(error);
      setFailure(result);
      setRemaining(countdown);
    } finally {
      setPending(false);
    }
  }

  function trackCapsLock(event: KeyboardEvent<HTMLInputElement>) {
    setCapsLock(event.getModifierState("CapsLock"));
  }

  return (
    <AuthFrame footer={<Link to="/" className="truncate transition-colors hover:text-foreground">OKAMI / SENTINEL</Link>}>
      <AuthCard code={t("login.code")} title={t("login.title")} description={t("login.description")}>
        <form className="grid gap-4 px-5 py-5" onSubmit={(event) => void submit(event)} noValidate>
          {expired && (
            <p className="border border-chart-5/40 bg-chart-5/8 px-3 py-2.5 text-xs text-chart-5" role="status">
              {t("login.expired")}
            </p>
          )}

          <div className="grid gap-1.5">
            <label htmlFor="login-username" className="bench-label">{t("login.username")}</label>
            <Input
              id="login-username" ref={usernameRef} name="username" value={username} autoComplete="username"
              autoCapitalize="none" autoCorrect="off" spellCheck={false} disabled={pending}
              onChange={(event) => setUsername(event.target.value)}
            />
          </div>

          <div className="grid gap-1.5">
            <label htmlFor="login-password" className="bench-label">{t("login.password")}</label>
            <div className="relative">
              <Input
                id="login-password" name="password" type={revealed ? "text" : "password"} value={password}
                autoComplete="current-password" disabled={pending} className="pr-11"
                aria-describedby={capsLock ? "login-caps" : undefined}
                onChange={(event) => setPassword(event.target.value)}
                onKeyUp={trackCapsLock} onKeyDown={trackCapsLock} onBlur={() => setCapsLock(false)}
              />
              <button
                type="button" aria-pressed={revealed} aria-label={revealed ? t("login.hide") : t("login.show")}
                disabled={pending} onClick={() => setRevealed((value) => !value)}
                className="absolute inset-y-0 right-0 flex w-10 items-center justify-center border-l border-border text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-40"
              >
                {revealed ? <EyeOff aria-hidden size={14} /> : <Eye aria-hidden size={14} />}
              </button>
            </div>
            {capsLock && <p id="login-caps" className="font-mono text-[10px] uppercase tracking-[0.12em] text-chart-3">{t("login.capsLock")}</p>}
          </div>

          <div aria-live="polite" className="empty:hidden">
            {message && <p className="border border-destructive/45 bg-destructive/8 px-3 py-2.5 text-xs text-destructive">{message}</p>}
          </div>

          <Button type="submit" size="lg" className="w-full" disabled={pending || locked}>
            {pending && <span aria-hidden="true" className="loading loading-spinner loading-xs" />}
            {pending ? t("login.submitting") : t("login.submit")}
          </Button>
        </form>
      </AuthCard>
    </AuthFrame>
  );
}
