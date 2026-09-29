import type { MiddlewareHandler } from "hono";
import type { RepositoryRole } from "@csb/shared";
import { getGateRun } from "../gate-store.js";
import { getGitHubMonitorRule } from "../github-monitor/store.js";
import { canSeeRepository, hasRepositoryRole, principalOf, type Principal } from "./principal.js";
import { getRunRepositoryKey } from "./repository-key.js";

/**
 * What a request has to prove before its handler runs.
 *
 * - `public`: reachable without a session (the login form, an invite link).
 * - `authenticated`: any live session, no repository scoping involved.
 * - `scoped`: any live session; the handler itself filters its result set down
 *   to the caller's grants, so the middleware must not guess a single key.
 * - `admin`: administrators only.
 * - `repository`: the named role on the repository the request addresses,
 *   resolved from the path parameter (`param`), from the scan's run row
 *   (`scan`), from the gate run (`gate`) or from the monitor rule's row
 *   (`monitorRule`).
 */
export type Requirement =
  | { kind: "public" }
  | { kind: "authenticated" }
  | { kind: "admin" }
  | { kind: "scoped" }
  | { kind: "repository"; role: RepositoryRole; from: RepositorySource };

type RepositorySource = "param" | "scan" | "gate" | "monitorRule";

const PUBLIC = { kind: "public" } as const;
const AUTH = { kind: "authenticated" } as const;
const ADMIN = { kind: "admin" } as const;
const SCOPED = { kind: "scoped" } as const;
const R = (role: RepositoryRole, from: RepositorySource) => ({ kind: "repository", role, from }) as const;
const viewerScan = R("viewer", "scan");

/**
 * Every route the API registers, with the `/api` prefix removed because the
 * server runtime mounts this application under it while the local runtime also
 * answers the legacy unprefixed paths. A request that matches nothing here is
 * refused: adding a route without a requirement fails the coverage test.
 *
 * `POST /github-monitor/rules` and `POST /github-monitor/poll` are `SCOPED`
 * because the repository travels in the body, where the handler checks the role
 * itself; a rule patch addresses the rule, whose own row names the repository.
 */
export const ROUTE_POLICY: ReadonlyArray<readonly [method: string, pattern: string, requirement: Requirement]> = [
  ["GET", "/healthz", PUBLIC], ["GET", "/readyz", PUBLIC],
  ["POST", "/auth/login", PUBLIC], ["GET", "/auth/invites/:token", PUBLIC], ["POST", "/auth/invites/:token", PUBLIC],
  ["POST", "/auth/logout", AUTH], ["GET", "/auth/session", AUTH],
  ["PATCH", "/account/profile", AUTH], ["POST", "/account/password", AUTH], ["GET", "/account/sessions", AUTH],
  ["DELETE", "/account/sessions/others", AUTH], ["DELETE", "/account/sessions/:id", AUTH],
  ["GET", "/security-session", AUTH], ["GET", "/scanners", AUTH], ["GET", "/health", SCOPED],
  ["GET", "/users", ADMIN], ["POST", "/users", ADMIN], ["PATCH", "/users/:id", ADMIN], ["POST", "/users/:id/reset", ADMIN],
  ["DELETE", "/users/:id/sessions", ADMIN], ["GET", "/users/:id/sessions", ADMIN], ["GET", "/users/:id/grants", ADMIN],
  ["PUT", "/users/:id/grants", ADMIN], ["GET", "/repository-access", ADMIN], ["PUT", "/repository-access/:repositoryKey/users/:userId", ADMIN],
  ["POST", "/ingest", ADMIN], ["GET", "/fs/list", ADMIN], ["GET", "/metrics/summary", SCOPED], ["POST", "/compare", SCOPED],
  ["GET", "/scans", SCOPED], ["POST", "/scans", ADMIN], ["GET", "/scans/active", SCOPED], ["GET", "/scans/catalog", SCOPED],
  ["GET", "/scans/:id", viewerScan], ["DELETE", "/scans/:id", R("maintainer", "scan")],
  ["GET", "/scans/:id/analysis-metrics", viewerScan], ["GET", "/scans/:id/files-graph", viewerScan],
  ["GET", "/scans/:id/candidate-preview", viewerScan], ["GET", "/scans/:id/telemetry", viewerScan],
  ["GET", "/scans/:id/report", viewerScan], ["GET", "/scans/:id/regression", viewerScan],
  ["POST", "/scans/:id/baseline", R("operator", "scan")], ["GET", "/scans/:id/findings", viewerScan],
  ["GET", "/scans/:id/findings/:findingId", viewerScan], ["POST", "/scans/:id/findings/:findingId/triage", R("analyst", "scan")],
  ["POST", "/scans/:id/cancel", R("operator", "scan")], ["GET", "/scans/:id/events", viewerScan],
  ["GET", "/guardrails/repositories", SCOPED], ["POST", "/guardrails/repositories", ADMIN],
  ["POST", "/guardrails/repositories/:repositoryKey/actions-dispatch", R("operator", "param")],
  ["GET", "/guardrails/repositories/:repositoryKey/actions-status", R("viewer", "param")],
  ["POST", "/guardrails/repositories/:repositoryKey/baseline/sync", R("operator", "param")],
  ["GET", "/guardrails/repositories/:repositoryKey/caller-workflow", R("viewer", "param")],
  ["PUT", "/guardrails/repositories/:repositoryKey/caller-workflow", R("maintainer", "param")],
  ["GET", "/guardrails/repositories/:repositoryKey/github-status", R("viewer", "param")],
  ["GET", "/guardrails/repositories/:repositoryKey/policy", R("viewer", "param")],
  ["PUT", "/guardrails/repositories/:repositoryKey/policy", R("maintainer", "param")],
  ["POST", "/guardrails/repositories/:repositoryKey/policy/simulate", R("analyst", "param")],
  ["GET", "/guardrails/repositories/:repositoryKey/pull-requests", R("viewer", "param")],
  ["POST", "/guardrails/repositories/:repositoryKey/target-preview", R("operator", "param")],
  ["GET", "/guardrails/gates", SCOPED], ["POST", "/guardrails/gates", ADMIN],
  ["GET", "/guardrails/gates/:gateId", R("viewer", "gate")], ["DELETE", "/guardrails/gates/:gateId", R("maintainer", "gate")],
  ["POST", "/guardrails/gates/:gateId/cancel", R("operator", "gate")], ["GET", "/guardrails/gates/:gateId/events", R("viewer", "gate")],
  ["POST", "/guardrails/gates/:gateId/publish", R("operator", "gate")],
  ["GET", "/guardrails/github-app/connections", ADMIN], ["DELETE", "/guardrails/github-app/connections/:connectionId", ADMIN],
  ["GET", "/guardrails/github-app/connections/:connectionId/installations", ADMIN],
  ["GET", "/guardrails/github-app/installations/:installationId/repositories", ADMIN],
  ["GET", "/guardrails/github-app/manifest/authorize/:flowId", ADMIN], ["GET", "/guardrails/github-app/manifest/callback", ADMIN],
  ["GET", "/guardrails/github-app/manifest/flows/:flowId", ADMIN], ["POST", "/guardrails/github-app/manifest/start", ADMIN],
  ["GET", "/github-monitor/overview", SCOPED], ["GET", "/github-monitor/rules", SCOPED], ["GET", "/github-monitor/events", SCOPED],
  ["GET", "/github-monitor/actions-runs", SCOPED], ["GET", "/github-monitor/branches", SCOPED],
  ["POST", "/github-monitor/rules", SCOPED], ["PATCH", "/github-monitor/rules/:id", R("maintainer", "monitorRule")],
  ["POST", "/github-monitor/poll", SCOPED],
  ["GET", "/github-checkouts", SCOPED], ["GET", "/github-checkouts/:repositoryKey", R("viewer", "param")],
  ["POST", "/github-checkouts/:repositoryKey/fetch", R("operator", "param")], ["POST", "/github-checkouts/:repositoryKey/pull", R("operator", "param")],
  ["GET", "/connections", ADMIN], ["POST", "/connections", ADMIN], ["POST", "/connections/compatibility", ADMIN],
  ["GET", "/connections/security-session", AUTH], ["GET", "/connections/:id", ADMIN], ["PATCH", "/connections/:id", ADMIN],
  ["DELETE", "/connections/:id", ADMIN], ["GET", "/connections/:id/auth/:flowId", ADMIN],
  ["POST", "/connections/:id/auth/:flowId/cancel", ADMIN], ["POST", "/connections/:id/auth/disconnect", ADMIN],
  ["POST", "/connections/:id/auth/start", ADMIN], ["POST", "/connections/:id/inspect", ADMIN],
  ["GET", "/connections/:id/models", ADMIN], ["POST", "/connections/:id/models/refresh", ADMIN], ["POST", "/connections/:id/probe", ADMIN],
  ["GET", "/engine-updates", ADMIN], ["POST", "/engine-updates/check", ADMIN], ["GET", "/engine-updates/security-session", AUTH],
  ["POST", "/engine-updates/:id/update", ADMIN], ["POST", "/engine-updates/:id/rollback", ADMIN],
];

interface CompiledRoute {
  method: string;
  segments: readonly string[];
  literals: number;
  requirement: Requirement;
}

const COMPILED: readonly CompiledRoute[] = ROUTE_POLICY.map(([method, pattern, requirement]) => {
  const segments = pattern.split("/");
  return { method, segments, literals: segments.filter((segment) => !segment.startsWith(":")).length, requirement };
});

/**
 * Hono splits the URL on `/` and decodes each segment once, so an encoded
 * separator stays inside a single segment instead of forging a new one. This
 * matcher has to decode the same way, or a crafted path could be authorized
 * against one repository key and then handled as another.
 */
function decodedSegments(requestPath: string): string[] | null {
  const decoded: string[] = [];
  for (const segment of requestPath.split("/")) {
    try {
      decoded.push(decodeURIComponent(segment));
    } catch {
      return null;
    }
  }
  return decoded;
}

export function matchPolicy(
  method: string,
  requestPath: string,
): { requirement: Requirement; params: Record<string, string> } | null {
  const segments = decodedSegments(requestPath);
  if (!segments) return null;
  let best: { literals: number; requirement: Requirement; params: Record<string, string> } | null = null;
  for (const route of COMPILED) {
    if (route.method !== method || route.segments.length !== segments.length) continue;
    if (best && best.literals >= route.literals) continue;
    const params: Record<string, string> = {};
    let matched = true;
    for (let index = 0; index < route.segments.length; index += 1) {
      const pattern = route.segments[index]!;
      const value = segments[index]!;
      if (pattern.startsWith(":")) {
        if (value === "") { matched = false; break; }
        // A decoded separator stays inside the captured value, exactly as the
        // handler will read it: repository keys such as `local/app` are encoded
        // as `local%2Fapp` and must resolve to the same key on both sides.
        params[pattern.slice(1)] = value;
      } else if (pattern !== value) {
        matched = false;
        break;
      }
    }
    if (matched) best = { literals: route.literals, requirement: route.requirement, params };
  }
  return best ? { requirement: best.requirement, params: best.params } : null;
}

/**
 * Deny by default: an unmatched path is refused before any handler observes the
 * request. An invisible repository answers `not_found` so a member cannot use
 * the difference between 403 and 404 to enumerate scans, gates or repositories
 * that were never shared with them; a visible one with too low a role answers
 * `forbidden`.
 */
export function authorize(): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method === "OPTIONS") return next();
    const requestPath = c.req.path.replace(/^\/api(?=\/)/, "");
    const matched = matchPolicy(c.req.method === "HEAD" ? "GET" : c.req.method, requestPath);
    if (!matched) return c.json({ error: "not_found" }, 404);
    const { requirement, params } = matched;
    if (requirement.kind === "public") return next();
    let principal: Principal;
    try {
      principal = principalOf(c);
    } catch (error) {
      // Only a missing session is an authentication problem. Anything else is a
      // genuine fault and must surface as a 500 instead of a misleading 401.
      if (!(error instanceof Error) || error.message !== "principal_missing") throw error;
      return c.json({ error: "authentication_required" }, 401);
    }
    if (requirement.kind === "authenticated" || requirement.kind === "scoped") return next();
    if (requirement.kind === "admin") return principal.isAdmin ? next() : c.json({ error: "forbidden" }, 403);
    if (principal.isAdmin) return next();
    const key = repositoryKeyFor(requirement.from, params);
    if (!canSeeRepository(principal, key)) return c.json({ error: "not_found" }, 404);
    if (!hasRepositoryRole(principal, key, requirement.role)) return c.json({ error: "forbidden" }, 403);
    return next();
  };
}

/**
 * An unresolvable owner is treated as an invisible one: `canSeeRepository`
 * refuses a missing key, so an unknown scan, gate or rule id answers 404.
 */
function repositoryKeyFor(
  from: RepositorySource,
  params: Record<string, string>,
): string | null | undefined {
  switch (from) {
    case "param": return params.repositoryKey;
    case "scan": return getRunRepositoryKey(params.id!);
    case "gate": return getGateRun(params.gateId!)?.repositoryKey;
    case "monitorRule": return getGitHubMonitorRule(params.id!)?.repositoryKey;
  }
}
