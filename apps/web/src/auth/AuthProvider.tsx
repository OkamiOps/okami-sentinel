import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { AuthSessionResponse, RepositoryRole } from "@csb/shared";
import { authApi } from "../lib/auth-api";
import { ApiError } from "../lib/http";

const RANK: Record<RepositoryRole, number> = { viewer: 1, analyst: 2, operator: 3, maintainer: 4 };
const PUBLIC_PATHS = [/^\/login$/, /^\/invite\/[^/]+$/];
type Status = "loading" | "signed-in" | "signed-out" | "unreachable";
type AuthValue = ReturnType<typeof buildValue>;
const AuthContext = createContext<AuthValue | null>(null);

function buildValue(session: AuthSessionResponse | null, status: Status, refresh: () => Promise<void>, logout: () => Promise<void>) {
  const isAdmin = session?.user.isAdmin ?? false;
  const grants = new Map((session?.grants ?? []).map((g) => [g.repositoryKey, g.role] as const));
  const roleFor = (key: string | null | undefined) => (key ? grants.get(key) ?? null : null);
  const can = (role: RepositoryRole, key: string | null | undefined) => {
    if (isAdmin) return true;
    const granted = roleFor(key);
    return granted !== null && RANK[granted] >= RANK[role];
  };
  const canAny = (role: RepositoryRole) => isAdmin || [...grants.values()].some((g) => RANK[g] >= RANK[role]);
  return { session, status, refresh, logout, isAdmin, roleFor, can, canAny };
}

export function revalidateSession(): void {
  window.dispatchEvent(new Event("sentinel:revalidate"));
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<AuthSessionResponse | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const navigate = useNavigate();
  const location = useLocation();

  // "Your session expired" is only true if one was ever held. A first visit
  // with no cookie is a plain sign-in, not an expiry, so the banner is opt-in
  // on an observed signed-in -> signed-out transition rather than on any 401.
  const heldSession = useRef(false);

  const refresh = useCallback(async () => {
    try {
      setSession(await authApi.session());
      heldSession.current = true;
      setStatus("signed-in");
    } catch (error) {
      // Only a genuine 401 means the session is gone. A network hiccup or a
      // 5xx from an overloaded/offline API is not proof of a signed-out
      // user, and must not force a redirect away from whatever the page's
      // own error handling is already showing.
      if (error instanceof ApiError && error.status === 401) {
        setSession(null);
        setStatus("signed-out");
        return;
      }
      // An unreachable session endpoint must not leave the shell spinning
      // forever: surface a retryable state instead. A session already in hand
      // survives the hiccup — only the very first read degrades the shell.
      setStatus((current) => (current === "signed-in" ? current : "unreachable"));
    }
  }, []);

  const logout = useCallback(async () => {
    await authApi.logout().catch(() => undefined);
    setSession(null);
    // Signing out deliberately is not an expiry either: a later visit to a
    // protected path must not be greeted with the expired banner.
    heldSession.current = false;
    setStatus("signed-out");
    navigate("/login", { replace: true });
  }, [navigate]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    const signedOut = () => { setSession(null); setStatus("signed-out"); };
    const revalidate = () => { void refresh(); };
    window.addEventListener("sentinel:unauthorized", signedOut);
    window.addEventListener("sentinel:revalidate", revalidate);
    return () => {
      window.removeEventListener("sentinel:unauthorized", signedOut);
      window.removeEventListener("sentinel:revalidate", revalidate);
    };
  }, [refresh]);

  useEffect(() => {
    if (status !== "signed-out") return;
    if (PUBLIC_PATHS.some((pattern) => pattern.test(location.pathname))) return;
    const next = `${location.pathname}${location.search}${location.hash}`;
    const expired = heldSession.current ? "&expired=1" : "";
    navigate(`/login?next=${encodeURIComponent(next)}${expired}`, { replace: true });
  }, [status, location.pathname, location.search, location.hash, navigate]);

  const value = useMemo(() => buildValue(session, status, refresh, logout), [session, status, refresh, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth outside AuthProvider");
  return value;
}
