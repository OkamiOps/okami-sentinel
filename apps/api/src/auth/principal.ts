import { randomBytes } from "node:crypto";
import type { Context } from "hono";
import type { RepositoryRole } from "@csb/shared";
import { runtimeMode } from "../deployment-settings.js";
import { securitySessionToken } from "../security-session.js";

export const ROLE_RANK: Record<RepositoryRole, number> = { viewer: 1, analyst: 2, operator: 3, maintainer: 4 };

export interface Principal {
  kind: "user" | "local";
  userId: string | null;
  sessionId: string | null;
  username: string;
  displayName: string;
  isAdmin: boolean;
  grants: ReadonlyMap<string, RepositoryRole>;
}

export type AccessScope = { kind: "all" } | { kind: "repositories"; keys: ReadonlySet<string> };

export const LOCAL_PRINCIPAL: Principal = {
  kind: "local", userId: null, sessionId: null, username: "local", displayName: "Local", isAdmin: true, grants: new Map(),
};

export function hasRepositoryRole(principal: Principal, repositoryKey: string | null | undefined, role: RepositoryRole): boolean {
  if (principal.isAdmin) return true;
  if (!repositoryKey) return false;
  const granted = principal.grants.get(repositoryKey);
  return granted !== undefined && ROLE_RANK[granted] >= ROLE_RANK[role];
}

export function canSeeRepository(principal: Principal, repositoryKey: string | null | undefined): boolean {
  return hasRepositoryRole(principal, repositoryKey, "viewer");
}

export function scopeOf(principal: Principal): AccessScope {
  return principal.isAdmin ? { kind: "all" } : { kind: "repositories", keys: new Set(principal.grants.keys()) };
}

export function inScope(scope: AccessScope, repositoryKey: string | null | undefined): boolean {
  return scope.kind === "all" || (!!repositoryKey && scope.keys.has(repositoryKey));
}

function isServerMode(): boolean {
  try { return runtimeMode(process.env) === "server"; } catch { return true; }
}

export function principalOf(c: Context): Principal {
  const principal = c.get("principal" as never) as Principal | undefined;
  if (principal) return principal;
  if (isServerMode()) throw new Error("principal_missing");
  return LOCAL_PRINCIPAL;
}

/**
 * Fails closed. In server mode the expected CSRF token is the one minted with
 * the request's session; falling back to the process-wide token would hand every
 * caller that can read `/api/security-session` in a local runtime — or simply
 * reach a guard before a session exists — a token that validates. A fresh random
 * value can never match a header, so the guard denies instead of waving through.
 * `principalOf` throws in the same situation; a throw here would turn a denial
 * into a 500, which is why this returns an unusable token instead.
 */
export function csrfTokenOf(c: Context): string {
  const token = c.get("csrfToken" as never) as string | undefined;
  if (token) return token;
  return isServerMode() ? randomBytes(32).toString("base64url") : securitySessionToken;
}
