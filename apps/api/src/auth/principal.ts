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

export function csrfTokenOf(c: Context): string {
  return (c.get("csrfToken" as never) as string | undefined) ?? securitySessionToken;
}
