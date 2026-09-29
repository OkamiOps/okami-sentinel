import type { Page } from "@playwright/test";
import type {
  FindingDetail,
  FindingTriage,
  LifecycleFinding,
  MetricsSummary,
  ProviderConnection,
  RepositoryAccessEntry,
  RepositoryGrant,
  ScanAnalysisMetrics,
  ScanRun,
  UserSessionSummary,
  UserSummary,
} from "@csb/shared";
import type { ScanFilesGraph } from "../src/api";

export interface MockApiOptions {
  signedOut?: boolean;
  session?: { isAdmin: boolean; grants: RepositoryGrant[] };
  loginResponse?: { status: number; body: unknown };
  acceptInviteResponse?: { status: number; body: unknown };
  patchUserResponse?: { status: number; body: unknown };
  createUserResponse?: { status: number; body: unknown };
  setRepositoryRoleResponse?: { status: number; body: unknown };
  changePasswordResponse?: { status: number; body: unknown };
  accountSessionsFail?: boolean;
  sessionUnreachable?: boolean;
}

const rootUser: UserSummary = {
  id: "u-root", username: "root", displayName: "Root", email: null,
  isAdmin: true, status: "active", hasPassword: true, pendingInvite: false,
  repositoryCount: 0, lastLoginAt: "2026-09-07T09:00:00.000Z", createdAt: "2026-09-01T10:00:00.000Z",
};

const anaUser: UserSummary = {
  id: "u-ana", username: "ana", displayName: "Ana", email: null,
  isAdmin: false, status: "active", hasPassword: true, pendingInvite: false,
  repositoryCount: 1, lastLoginAt: null, createdAt: "2026-09-01T10:00:00.000Z",
};

// Invited but never signed in: the only row the "pending invite" filter keeps,
// and the only account the access screen can still grant a repository to.
const beaUser: UserSummary = {
  id: "u-bea", username: "bea", displayName: "Bea", email: "bea@example.test",
  isAdmin: false, status: "active", hasPassword: false, pendingInvite: true,
  repositoryCount: 0, lastLoginAt: null, createdAt: "2026-09-06T10:00:00.000Z",
};

const anaGrants: RepositoryGrant[] = [{ repositoryKey: "github:1", role: "viewer" }];

const repositoryAccess: RepositoryAccessEntry[] = [{
  repositoryKey: "github:1", displayName: "luna-core", source: "github",
  grants: [{ userId: "u-ana", username: "ana", displayName: "Ana", role: "viewer" }],
}];

function currentSessionSummary(current: boolean): UserSessionSummary {
  return {
    id: "session-one", createdAt: "2026-09-07T09:00:00.000Z", lastSeenAt: "2026-09-07T10:00:00.000Z",
    ip: "127.0.0.1", userAgent: "fixture-agent", current,
  };
}

// The account panel renders a device label out of the user agent, so these
// carry real-looking strings instead of the opaque `fixture-agent`.
const accountSessions: UserSessionSummary[] = [
  {
    id: "session-one", createdAt: "2026-09-07T09:00:00.000Z", lastSeenAt: "2026-09-07T10:00:00.000Z",
    ip: "127.0.0.1", current: true,
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  },
  {
    id: "session-two", createdAt: "2026-09-05T08:00:00.000Z", lastSeenAt: "2026-09-06T08:30:00.000Z",
    ip: "10.0.0.8", current: false,
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0",
  },
];

export const baseRun: ScanRun = {
  id: "scan-one", displayName: "Repository alpha", repositoryPath: "/fixture/alpha", scanDir: "/fixture/scans/one",
  repositoryKey: "github:1",
  revision: "main", status: "completed", engine: "codex-security", model: "fixture-model", effort: "high",
  mode: "standard", provider: "fixture", authMode: "api-key", scannerVersion: null, recipeHash: null,
  startedAt: "2026-09-07T10:00:00Z", completedAt: "2026-09-07T10:01:00Z", durationMs: 60000,
  cost: null, severity: { critical: 0, high: 0, medium: 0, low: 0, info: 0, unknown: 0, total: 0 },
  source: "benchmark", pid: null, execution: null,
};

export const connection: ProviderConnection = {
  id: "fixture-connection", scopeId: "local", name: "Fixture provider", providerKind: "codex", routeKind: "codex-local-cli",
  transport: "local-cli", authKind: "existing-session", protocol: "codex-app-server", status: "ready",
  modelSelectionMode: "runtime-default", defaultModelId: null, lastTestedAt: null, lastModelSyncAt: null,
  modelCatalogStale: false, display: { providerLabel: "Fixture", routeLabel: "Local fixture", secretConfigured: false, endpointConfigured: false, endpointKind: null },
};

// Keep the mock DTOs checked against the same public contracts consumed by the
// panels. New detail endpoints must remain explicit here: unknown requests
// still fail below instead of becoming accidental generic successes.
const analysisMetrics = {
  measuredAt: "2026-09-07T10:02:00Z",
  files: 1,
  bytes: 34,
  lines: 1,
  batchesCompleted: 1,
  batchesTotal: 1,
  candidates: 0,
  rejections: 0,
  reasoningTokens: 0,
  outputTokensPerSecond: 1,
} satisfies ScanAnalysisMetrics;

const filesGraph = {
  status: "unavailable",
  reason: "unsupported_scan",
  snapshot: null,
  files: [],
  edges: [],
} satisfies ScanFilesGraph;

export async function mockApi(page: Page, locale = "en", options: MockApiOptions = {}) {
  const state = {
    offline: false, connectionsFail: false, modelsFail: false, launchCount: 0, cancelCount: 0, resetCount: 0,
    runs: [structuredClone(baseRun), { ...structuredClone(baseRun), id: "scan-two", displayName: "Repository beta" }],
    requests: [] as string[],
    requestUrls: [] as string[],
    findings: [] as LifecycleFinding[],
    reportFindings: [] as FindingDetail[],
    lastLaunch: null as Record<string, unknown> | null,
    connection: structuredClone(connection),
    auth: {
      signedIn: !options.signedOut,
      isAdmin: options.session?.isAdmin ?? true,
      grants: options.session?.grants ?? ([] as RepositoryGrant[]),
      runtimeMode: (options.session ? "server" : "local") as "local" | "server",
      // A 5xx from /auth/session is not a sign-out: it leaves the shell with an
      // unverified session, which is a different state from signed out.
      sessionUnreachable: options.sessionUnreachable === true,
    },
    users: [structuredClone(rootUser), structuredClone(anaUser), structuredClone(beaUser)] as UserSummary[],
    repositoryAccess: structuredClone(repositoryAccess) as RepositoryAccessEntry[],
    accountSessions: structuredClone(accountSessions),
    accountSessionsFail: options.accountSessionsFail === true,
  };
  await page.addInitScript(({ locale }) => {
    localStorage.setItem("okami-sentinel.locale", locale);
    localStorage.setItem("csb-bench-launch-v2", JSON.stringify({ repositoryPath: "/fixture/alpha", connectionId: "fixture-connection", paths: "src", maxCostUsd: "2" }));
  }, { locale });
  // Every API request is intercepted. No running API, credentials, or external provider is used.
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace(/^\/api/, "");
    state.requests.push(`${req.method()} ${path}`);
    state.requestUrls.push(`${req.method()} ${path}${url.search}`);
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (state.offline) return route.fulfill({ status: 503, contentType: "text/plain", body: "Service unavailable" });
    // A signed-out browser gets a 401 from everything except the public auth
    // endpoints, exactly as the real API does. Flipping `auth.signedIn` after
    // load therefore reproduces a session expiring mid-visit.
    if (!state.auth.signedIn && !path.startsWith("/auth/")) return json({ error: "authentication_required" }, 401);
    if (path === "/scans/active") return json({ scans: state.runs.filter((run) => ["running", "queued"].includes(run.status)) });
    if (path === "/scans/catalog") return json({ total: state.runs.length, repositories: [...new Set(state.runs.map((run) => run.displayName))].sort() });
    if (path === "/metrics/summary") {
      const query = (url.searchParams.get("query") ?? "").toLowerCase();
      const repository = url.searchParams.get("repository");
      const engine = url.searchParams.get("engine");
      const status = url.searchParams.get("status");
      const runs = state.runs.filter((run) => run.displayName.toLowerCase().includes(query)
        && (!repository || run.displayName === repository) && (!engine || run.engine === engine)
        && (!status || (status === "active" ? ["running", "queued"].includes(run.status) : status === "attention" ? ["failed", "incomplete"].includes(run.status) : run.status === status)));
      return json(fixtureMetrics(runs));
    }
    if (path === "/ingest") return json({ imported: 0 });
    if (path === "/scans" && req.method() === "GET") {
      let scans = state.runs;
      const status = url.searchParams.get("status") ?? "all";
      if (status === "active") scans = scans.filter((run) => !["cancelled", "failed"].includes(run.status));
      else if (status !== "all") scans = scans.filter((run) => run.status === status);
      const query = (url.searchParams.get("query") ?? "").toLowerCase();
      scans = scans.filter((run) => run.displayName.toLowerCase().includes(query));
      const limit = Number(url.searchParams.get("limit") ?? scans.length);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      return json({ scans: scans.slice(offset, offset + limit), total: scans.length, limit, offset, summary: { evidence: 0, costUsd: null, costIsUpperBound: false, archivedCount: 0 } });
    }
    if (path === "/scans" && req.method() === "POST") {
      state.launchCount++;
      state.lastLaunch = req.postDataJSON();
      const run = { ...baseRun, id: "launched-scan", status: "running" as const, completedAt: null, startedAt: new Date().toISOString() };
      state.runs.push(run);
      return json({ scan: run }, 201);
    }
    const match = path.match(/^\/scans\/([^/]+)(?:\/(.*))?$/);
    if (match) {
      const run = state.runs.find((item) => item.id === match[1]) ?? baseRun;
      const regression = { scanId: run.id, baseline: null, baselineSource: "none", isRepositoryBaseline: false, counts: Object.fromEntries(["new", "persisting", "fixed", "regressed"].map((status) => [status, state.findings.filter((finding) => finding.lifecycle === status).length])), findings: state.findings };
      if (!match[2]) return json({ scan: run, findings: [] });
      if (match[2] === "cancel") { state.cancelCount++; run.status = "cancelled"; return json({ ok: true }); }
      if (match[2] === "regression") return json(regression);
      if (match[2] === "telemetry") return json({ lines: [], cursor: 0 });
      if (match[2] === "analysis-metrics") return json(analysisMetrics);
      if (match[2] === "files-graph") return json(filesGraph);
      if (match[2] === "report") return json({ scan: run, findings: state.reportFindings, regression, generatedAt: "2026-09-07T10:02:00Z" });
      if (match[2] === "events") return route.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" });
      const findingDetailMatch = match[2].match(/^findings\/([^/]+)$/);
      if (findingDetailMatch && req.method() === "GET") {
        return json({ finding: { ...reportFinding, findingId: findingDetailMatch[1] } });
      }
      const triageMatch = match[2].match(/^findings\/([^/]+)\/triage$/);
      if (triageMatch && req.method() === "POST") {
        const body = req.postDataJSON() as { status: FindingTriage["status"]; note?: string | null };
        const triage: FindingTriage = { status: body.status, note: body.note ?? null, updatedAt: "2026-09-07T10:05:00Z" };
        const finding = state.findings.find((item) => item.findingId === triageMatch[1] && item.sourceScanId === run.id);
        if (finding) finding.triage = triage;
        return json({ triage });
      }
    }
    if (path === "/security-session" || path === "/connections/security-session" || path === "/engine-updates/security-session") {
      return json({ csrfToken: "fixture-token", runtimeMode: "local", repositoryRoots: [] });
    }
    if (path === "/auth/session") {
      if (state.auth.sessionUnreachable) return json({ error: "internal_error" }, 500);
      if (!state.auth.signedIn) return json({ error: "authentication_required" }, 401);
      return json({
        user: { id: "u-root", username: "root", displayName: "Root", isAdmin: state.auth.isAdmin },
        grants: state.auth.grants,
        csrfToken: "fixture-token",
        runtimeMode: state.auth.runtimeMode,
        repositoryRoots: [],
      });
    }
    if (path === "/auth/login" && req.method() === "POST") {
      if (options.loginResponse) return json(options.loginResponse.body, options.loginResponse.status);
      const body = req.postDataJSON() as { username?: string; password?: string };
      if (body.password === "ana password 123") {
        state.auth.signedIn = true;
        return json({ ok: true });
      }
      return json({ error: "invalid_credentials" }, 401);
    }
    if (path === "/auth/logout" && req.method() === "POST") {
      state.auth.signedIn = false;
      return route.fulfill({ status: 204 });
    }
    const inviteMatch = path.match(/^\/auth\/invites\/([^/]+)$/);
    if (inviteMatch) {
      if (req.method() === "GET") {
        return json({ username: "ana", displayName: "Ana", purpose: "invite", invitedBy: "Root", expiresAt: "2026-10-02T10:00:00.000Z" });
      }
      if (req.method() === "POST") {
        if (options.acceptInviteResponse) return json(options.acceptInviteResponse.body, options.acceptInviteResponse.status);
        state.auth.signedIn = true;
        return json({ ok: true });
      }
    }
    if (path === "/account/sessions" && req.method() === "GET") {
      if (state.accountSessionsFail) return json({ error: "fixture unavailable" }, 503);
      return json({ sessions: state.accountSessions });
    }
    if (path === "/account/sessions/others" && req.method() === "DELETE") {
      state.accountSessions = state.accountSessions.filter((session) => session.current);
      return route.fulfill({ status: 204 });
    }
    const accountSessionMatch = path.match(/^\/account\/sessions\/([^/]+)$/);
    if (accountSessionMatch && req.method() === "DELETE") {
      state.accountSessions = state.accountSessions.filter((session) => session.id !== accountSessionMatch[1]);
      return route.fulfill({ status: 204 });
    }
    if (path === "/account/password" && req.method() === "POST") {
      if (options.changePasswordResponse) return json(options.changePasswordResponse.body, options.changePasswordResponse.status);
      // The API ends every other session on a successful change, exactly as
      // the success message promises.
      state.accountSessions = state.accountSessions.filter((session) => session.current);
      return route.fulfill({ status: 204 });
    }
    if (path === "/account/profile" && req.method() === "PATCH") {
      const body = req.postDataJSON() as { displayName?: string };
      return json({ id: "u-root", username: "root", displayName: body.displayName ?? "Root", isAdmin: state.auth.isAdmin });
    }
    if (path === "/users" && req.method() === "GET") return json({ users: state.users });
    if (path === "/users" && req.method() === "POST") {
      if (options.createUserResponse) return json(options.createUserResponse.body, options.createUserResponse.status);
      const body = req.postDataJSON() as { username?: string; displayName?: string; email?: string | null; isAdmin?: boolean; grants?: RepositoryGrant[] };
      const created: UserSummary = {
        id: `u-${body.username ?? "new"}`, username: String(body.username ?? ""), displayName: String(body.displayName ?? ""),
        email: body.email ?? null, isAdmin: body.isAdmin === true, status: "active", hasPassword: false, pendingInvite: true,
        repositoryCount: body.grants?.length ?? 0, lastLoginAt: null, createdAt: "2026-09-07T10:00:00.000Z",
      };
      state.users.push(created);
      return json({ user: created, invite: { inviteUrl: `http://127.0.0.1:4175/invite/${"b".repeat(43)}`, expiresAt: "2026-10-06T10:00:00.000Z" } }, 201);
    }
    const userMatch = path.match(/^\/users\/([^/]+)(?:\/(.*))?$/);
    if (userMatch) {
      const [, id, sub] = userMatch;
      if (!sub && req.method() === "PATCH") {
        if (options.patchUserResponse) return json(options.patchUserResponse.body, options.patchUserResponse.status);
        const body = req.postDataJSON() as Partial<UserSummary>;
        const existing = state.users.find((user) => user.id === id);
        const patched: UserSummary = { ...(existing ?? rootUser), ...body };
        state.users = state.users.map((user) => user.id === id ? patched : user);
        return json(patched);
      }
      if (sub === "grants" && req.method() === "GET") return json({ grants: id === "u-ana" ? anaGrants : [] });
      if (sub === "grants" && req.method() === "PUT") {
        const body = req.postDataJSON() as { grants?: RepositoryGrant[] };
        return json({ grants: body.grants ?? [] });
      }
      if (sub === "sessions" && req.method() === "GET") return json({ sessions: [currentSessionSummary(false)] });
      if (sub === "sessions" && req.method() === "DELETE") return route.fulfill({ status: 204 });
      if (sub === "reset" && req.method() === "POST") {
        // A second reset must invalidate the first token, so this must not
        // repeat it: tests rely on the link (and its copy-button state)
        // actually changing between two resets of the same user.
        state.resetCount += 1;
        const char = state.resetCount === 1 ? "c" : "d";
        return json({ inviteUrl: `http://127.0.0.1:4175/invite/${char.repeat(43)}`, expiresAt: "2026-10-06T10:00:00.000Z" });
      }
    }
    if (path === "/repository-access" && req.method() === "GET") return json({ repositories: state.repositoryAccess });
    const repositoryAccessMatch = path.match(/^\/repository-access\/([^/]+)\/users\/([^/]+)$/);
    if (repositoryAccessMatch && req.method() === "PUT") {
      if (options.setRepositoryRoleResponse) return json(options.setRepositoryRoleResponse.body, options.setRepositoryRoleResponse.status);
      const [, repositoryKey, userId] = repositoryAccessMatch;
      const { role } = req.postDataJSON() as { role: RepositoryGrant["role"] | null };
      const entry = state.repositoryAccess.find((item) => item.repositoryKey === decodeURIComponent(repositoryKey));
      const user = state.users.find((item) => item.id === userId);
      if (entry && user) {
        entry.grants = entry.grants.filter((grant) => grant.userId !== userId);
        if (role) entry.grants.push({ userId, username: user.username, displayName: user.displayName, role });
      }
      return route.fulfill({ status: 204 });
    }
    if (path === "/connections") return state.connectionsFail ? json({ error: "fixture unavailable" }, 503) : json({ connections: [state.connection] });
    if (path === "/connections/fixture-connection/models" || path === "/connections/fixture-connection/models/refresh") {
      if (state.modelsFail) return json({ error: "fixture unavailable" }, 503);
      const models = [{ connectionId: "fixture-connection", id: "fixture-model", displayName: "Fixture model", contextWindow: 8192, capabilities: {}, pricing: null, discoveredAt: "2026-09-07T10:00:00Z", source: "runtime" }];
      return path.endsWith("/refresh") ? json({ connection: state.connection, discovery: { models, supportsRuntimeDefault: false } }) : json({ models });
    }
    if (path === "/connections/compatibility") return json({ ...req.postDataJSON().selection, eligible: true, reasons: [], selectedProfile: "native", availableProfiles: ["native"] });
    if (path === "/health") return json({ ok: true, api: "fixture", codexStateDir: "/fixture", codexInfo: null, activeScanId: null, activeScanIds: [], maxConcurrentScans: 1 });
    if (path === "/scanners") return json({ scanners: [{ engine: "codex-security", name: "Codex Security", enabled: true, available: true, maturity: "stable", reason: null, sourceUrl: "", authModes: [], models: [], efforts: [], modes: ["standard"], stageCount: 6, writesTarget: false, executesGeneratedCode: false }], refreshedAt: "2026-09-07T10:00:00Z" });
    if (path === "/fs/list") return json({ path: "/fixture/alpha", parent: "/fixture", entries: [] });
    if (path === "/compare") {
      const ids: string[] = req.postDataJSON().scanIds;
      return json({ scans: state.runs.filter((run) => ids.includes(run.id)), baselineScanId: ids[0], candidateScanIds: ids.slice(1), comparisons: ids.slice(1).map((id) => ({ candidateScanId: id, counts: { candidate_only: 0, baseline_only: 0, both: 0, severity_changed: 0 }, findings: [] })), ranking: [] });
    }
    throw new Error(`Unmocked API request: ${req.method()} ${path}`);
  });
  return state;
}

export function fixtureMetrics(runs: ScanRun[]): MetricsSummary {
  const severity = { ...baseRun.severity };
  for (const run of runs) for (const key of Object.keys(severity) as Array<keyof typeof severity>) severity[key] += run.severity[key];
  return {
    totalScans: runs.length, completedScans: runs.filter((run) => run.status === "completed").length,
    runningScans: runs.filter((run) => ["running", "queued"].includes(run.status)).length,
    attentionScans: runs.filter((run) => ["failed", "incomplete"].includes(run.status)).length,
    pricedScans: 0, totalEstimatedUsd: 0, avgUsdPerScan: 0, hasUpperBoundCost: false,
    avgDurationMs: 60000, totalInputTokens: 0, totalOutputTokens: 0,
    highPerDollar: null, findingsPerDollar: null, severity,
    byModelEffort: [], costTrend: [], topCategories: [], recent: runs,
  };
}

export const reportFinding: FindingDetail = {
  findingId: "fixture-finding", occurrenceId: null, title: "Original scanner evidence",
  severity: "high", confidence: "high", ruleId: "fixture-rule", summary: "Original evidence stays in its source language.",
  primaryPath: "src/example.ts", fingerprints: [], category: "Input validation", cwe: ["CWE-20"],
  attackPath: null, attackPathModel: null, codeEvidence: [{ path: "src/example.ts", startLine: 12, endLine: 13, role: "source", explanation: "Original explanation", code: "const validated = schema.parse(input);\nreturn validated;" }],
  remediation: "Keep validation at the input boundary.", locations: [], taxonomy: null, rootCause: null,
  validation: null, preventiveControls: null, remediationTests: null, severityRationale: null, confidenceRationale: null,
};
