import type { Page } from "@playwright/test";
import { EMAIL_PROVIDER_PRESETS } from "@csb/shared";
import type {
  AccountNotificationsResponse,
  GitHubAction,
  GitHubActionEvent,
  GuardrailRepository,
  WebhookDeliveryRecord,
  AccountNotificationsUpdateEntry,
  EmailDelivery,
  EmailQueueSkip,
  EmailSettings,
  EmailTestResult,
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
  session?: { isAdmin: boolean; grants: RepositoryGrant[]; username?: string };
  loginResponse?: { status: number; body: unknown };
  invitePreviewResponse?: { status: number; body: unknown };
  acceptInviteResponse?: { status: number; body: unknown };
  patchUserResponse?: { status: number; body: unknown };
  createUserResponse?: { status: number; body: unknown };
  setRepositoryRoleResponse?: { status: number; body: unknown };
  changePasswordResponse?: { status: number; body: unknown };
  accountSessionsFail?: boolean;
  sessionUnreachable?: boolean;
  /** No member account exists at all: every repository has zero grants
   *  and zero candidates, which is a different sentence from "all granted". */
  noMembers?: boolean;
  /** Whatever `GET /email/settings` should already have on file. */
  emailSettings?: Partial<EmailSettings>;
  /** `null` reproduces local mode, where e-mails carry no links. */
  publicOrigin?: string | null;
  /** A refusal from `PUT /email/settings`, field code included. */
  saveEmailSettingsResponse?: { status: number; body: unknown };
  /** `GET /email/settings` itself refuses — a 403 the route guard let through. */
  emailSettingsFail?: { status: number; body: unknown };
  /** `POST /email/test` answers 200 on a provider rejection too. */
  emailTestResult?: EmailTestResult;
  emailTestResponse?: { status: number; body: unknown };
  emailDeliveries?: EmailDelivery[];
  emailDeliveriesFail?: boolean;
  /** The resolved destination for this account, or `null` for the warning. */
  notificationsAddress?: string | null;
  notificationsFail?: boolean;
  /** A refusal from `PUT /account/notifications`, which must roll the cell back. */
  notificationsUpdateResponse?: { status: number; body: unknown };
  /**
   * Refuse only the cells named here, so a spec can have one toggle fail while
   * another succeeds — the case where a whole-matrix rollback undoes the
   * wrong cell.
   */
  notificationsUpdateRefusals?: Array<{ scope: string; event: string }>;
  /** Hold every notification write, so the optimistic flip can be observed. */
  notificationsUpdateDelayMs?: number;
  /** Nobody has shared a repository with this account yet. */
  noNotificationRepositories?: boolean;
  /** What the invite and reset routes report about the e-mail they queued. */
  inviteEmail?: { emailQueued: boolean; emailSkipped: EmailQueueSkip | null; emailTo: string | null };
}

const emailSettings: EmailSettings = {
  provider: "smtp", enabled: false, fromName: "Okami Sentinel", fromAddress: null, replyTo: null,
  smtpHost: null, smtpPort: null, smtpSecurity: "tls", smtpUsername: null,
  secretConfigured: false, updatedAt: null, updatedBy: null,
};

const emailDeliveries: EmailDelivery[] = [
  {
    id: "delivery-one", event: "account.invite", toAddress: "bea@example.test", locale: "en",
    subject: "You were invited to Sentinel", status: "sent", attempts: 1, nextAttemptAt: null,
    lastError: null, providerMessageId: "msg-1", createdAt: "2026-09-29T10:00:00.000Z", sentAt: "2026-09-29T10:00:04.000Z",
  },
  {
    id: "delivery-two", event: "gate.blocked", toAddress: "ana@example.test", locale: "pt-BR",
    subject: "Gate bloqueado em luna-core", status: "failed", attempts: 5, nextAttemptAt: null,
    lastError: "550 5.7.1 Sender address not verified", providerMessageId: null,
    createdAt: "2026-09-29T11:00:00.000Z", sentAt: null,
  },
  {
    id: "delivery-three", event: "ops.engine_unavailable.resolved", toAddress: "root@example.test", locale: "en",
    subject: "Engine available again", status: "queued", attempts: 1, nextAttemptAt: "2026-09-29T12:05:00.000Z",
    lastError: "Connection timed out", providerMessageId: null,
    createdAt: "2026-09-29T12:00:00.000Z", sentAt: null,
  },
];

function notificationMatrix(isAdmin: boolean, address: string | null, repositories: boolean): AccountNotificationsResponse {
  return {
    address,
    locale: "pt-BR",
    repositories: repositories
      ? [{
        repositoryKey: "github:1", displayName: "luna-core", source: "github", role: isAdmin ? null : "viewer",
        events: [
          { event: "gate.blocked", enabled: true, isDefault: true },
          { event: "gate.error", enabled: true, isDefault: true },
          { event: "gate.passed", enabled: false, isDefault: true },
          { event: "scan.failed", enabled: true, isDefault: true },
          { event: "scan.completed", enabled: false, isDefault: true },
        ],
      }]
      : [],
    ops: isAdmin
      ? {
        events: [
          { event: "ops.engine_unavailable", enabled: true, isDefault: true },
          { event: "ops.connection_attention", enabled: true, isDefault: true },
          { event: "ops.daily_cost", enabled: true, isDefault: true },
          { event: "ops.github_publish_failed", enabled: true, isDefault: true },
        ],
      }
      : null,
    unassigned: isAdmin
      ? {
        events: [
          { event: "scan.failed", enabled: true, isDefault: true },
          { event: "scan.completed", enabled: false, isDefault: true },
        ],
      }
      : null,
    accountEvents: ["account.invite", "account.reset", "account.new_login", "account.locked", "account.password_changed"],
  };
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

/**
 * The three fields the invite and reset routes gained: whether a message was
 * queued, where it went, and why not. The default reproduces a configured
 * provider that accepted the message.
 */
function inviteEmailFields(options: MockApiOptions, fallbackAddress: string | null) {
  if (options.inviteEmail) return options.inviteEmail;
  return { emailQueued: true, emailSkipped: null, emailTo: fallbackAddress };
}

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
      username: options.session?.username ?? "root",
      runtimeMode: (options.session ? "server" : "local") as "local" | "server",
      // A 5xx from /auth/session is not a sign-out: it leaves the shell with an
      // unverified session, which is a different state from signed out.
      sessionUnreachable: options.sessionUnreachable === true,
    },
    users: (options.noMembers
      ? [structuredClone(rootUser)]
      : [structuredClone(rootUser), structuredClone(anaUser), structuredClone(beaUser)]) as UserSummary[],
    repositoryAccess: structuredClone(repositoryAccess).map((entry) => options.noMembers ? { ...entry, grants: [] } : entry) as RepositoryAccessEntry[],
    accountSessions: structuredClone(accountSessions),
    accountSessionsFail: options.accountSessionsFail === true,
    invitePreviewFails: options.invitePreviewResponse !== undefined,
    emailSettings: { ...structuredClone(emailSettings), ...(options.emailSettings ?? {}) } as EmailSettings,
    publicOrigin: options.publicOrigin === undefined ? "http://127.0.0.1:4175" : options.publicOrigin,
    emailDeliveries: structuredClone(options.emailDeliveries ?? emailDeliveries),
    emailDeliveriesFail: options.emailDeliveriesFail === true,
    /** Every body `PUT /email/settings` received, in order. */
    emailSettingsWrites: [] as Array<Record<string, unknown>>,
    emailTestCount: 0,
    notifications: notificationMatrix(
      options.session?.isAdmin ?? true,
      options.notificationsAddress === undefined ? "root@example.test" : options.notificationsAddress,
      options.noNotificationRepositories !== true,
    ),
    notificationsFail: options.notificationsFail === true,
    /** Every sparse patch `PUT /account/notifications` received, in order. */
    notificationWrites: [] as AccountNotificationsUpdateEntry[][],
    /** Every locale `PATCH /account/profile` was asked to remember. */
    localeWrites: [] as string[],
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
        user: { id: "u-root", username: state.auth.username, displayName: "Root", isAdmin: state.auth.isAdmin, locale: state.localeWrites.at(-1) ?? null },
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
        // A preview that fails is not the same as a rejected token: flipping
        // this off mid-test reproduces a retry that then succeeds.
        if (state.invitePreviewFails && options.invitePreviewResponse) {
          return json(options.invitePreviewResponse.body, options.invitePreviewResponse.status);
        }
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
      const body = req.postDataJSON() as { displayName?: string; locale?: string };
      if (typeof body.locale === "string") state.localeWrites.push(body.locale);
      return json({
        id: "u-root", username: "root", displayName: body.displayName ?? "Root",
        isAdmin: state.auth.isAdmin, locale: state.localeWrites.at(-1) ?? null,
      });
    }
    if (path === "/account/notifications") {
      if (state.notificationsFail) return json({ error: "internal_error" }, 500);
      if (req.method() === "GET") return json(state.notifications);
      if (req.method() === "PUT") {
        const body = req.postDataJSON() as { subscriptions?: AccountNotificationsUpdateEntry[] };
        const subscriptions = body.subscriptions ?? [];
        state.notificationWrites.push(subscriptions);
        if (options.notificationsUpdateDelayMs) {
          await new Promise((resolve) => setTimeout(resolve, options.notificationsUpdateDelayMs));
        }
        const refused = (options.notificationsUpdateRefusals ?? []).some((cell) =>
          subscriptions.some((entry) => entry.scope === cell.scope && entry.event === cell.event));
        // All or nothing, exactly as the API does it: a refused batch writes
        // nothing at all.
        if (refused) return json({ error: "scope_unknown", scope: subscriptions[0]?.scope }, 400);
        if (options.notificationsUpdateResponse) {
          // A refused batch writes nothing, so the stored matrix is returned
          // untouched on the next read and the screen has to roll back.
          return json(options.notificationsUpdateResponse.body, options.notificationsUpdateResponse.status);
        }
        for (const entry of subscriptions) {
          const events = entry.scope === "ops"
            ? state.notifications.ops?.events
            : entry.scope === "unassigned"
              ? state.notifications.unassigned?.events
              : state.notifications.repositories.find((item) => item.repositoryKey === entry.scope)?.events;
          const cell = events?.find((item) => item.event === entry.event);
          if (cell) {
            cell.enabled = entry.enabled;
            cell.isDefault = false;
          }
        }
        return json(state.notifications);
      }
    }
    if (path === "/email/settings") {
      if (options.emailSettingsFail && req.method() === "GET") return json(options.emailSettingsFail.body, options.emailSettingsFail.status);
      if (req.method() === "GET") return json({ settings: state.emailSettings, presets: EMAIL_PROVIDER_PRESETS, publicOrigin: state.publicOrigin });
      if (req.method() === "PUT") {
        const body = req.postDataJSON() as Record<string, unknown>;
        state.emailSettingsWrites.push(body);
        if (options.saveEmailSettingsResponse) return json(options.saveEmailSettingsResponse.body, options.saveEmailSettingsResponse.status);
        const { secret, ...rest } = body;
        // The real route never returns the secret, only that one exists, and an
        // absent `secret` keeps whatever was already stored.
        state.emailSettings = {
          ...state.emailSettings,
          ...(rest as Partial<EmailSettings>),
          secretConfigured: typeof secret === "string" && secret.length > 0 ? true : secret === null || secret === "" ? false : state.emailSettings.secretConfigured,
          updatedAt: "2026-09-30T12:00:00.000Z",
          updatedBy: "root",
        };
        return json({ settings: state.emailSettings, presets: EMAIL_PROVIDER_PRESETS, publicOrigin: state.publicOrigin });
      }
    }
    if (path === "/email/test" && req.method() === "POST") {
      state.emailTestCount += 1;
      if (options.emailTestResponse) return json(options.emailTestResponse.body, options.emailTestResponse.status);
      return json(options.emailTestResult ?? { ok: true, to: "root@example.test", code: null, message: null, providerMessageId: "msg-test" });
    }
    if (path === "/email/deliveries" && req.method() === "GET") {
      if (state.emailDeliveriesFail) return json({ error: "fixture unavailable" }, 503);
      return json({ deliveries: state.emailDeliveries });
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
      return json({ user: created, invite: { inviteUrl: `http://127.0.0.1:4175/invite/${"b".repeat(43)}`, expiresAt: "2026-10-06T10:00:00.000Z", ...inviteEmailFields(options, created.email ?? created.username) } }, 201);
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
        const target = state.users.find((user) => user.id === id);
        return json({
          inviteUrl: `http://127.0.0.1:4175/invite/${char.repeat(43)}`, expiresAt: "2026-10-06T10:00:00.000Z",
          ...inviteEmailFields(options, target?.email ?? target?.username ?? null),
        });
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

// ---------------------------------------------------------------------------
// GitHub tab
// ---------------------------------------------------------------------------

/**
 * The five integration states the screen has to tell apart. They are named rather
 * than assembled per test because the difference between them is exactly what the
 * copy has to get right, and a test that hand-builds one usually gets one field
 * wrong and proves nothing.
 */
export type GitHubIntegrationScenario =
  | "all_green"
  | "missing_permissions"
  | "pending_approval"
  | "suspended"
  | "not_configured"
  | "not_ready"
  | "installed_nowhere"
  | "stale_delivery"
  | "unreachable"
  | "no_connection";

const REQUIRED_PERMISSIONS: ReadonlyArray<readonly [string, string]> = [
  ["actions", "write"], ["checks", "write"], ["contents", "write"],
  ["metadata", "read"], ["pull_requests", "write"], ["workflows", "write"],
];

const REQUIRED_EVENTS = [
  "pull_request", "push", "installation", "installation_repositories", "check_run", "workflow_run",
];

export const githubRepository: GuardrailRepository = {
  repositoryKey: "github:1", repositoryPath: null, source: "github", displayName: "luna-core",
  defaultBranch: "main", defaultExecutor: "sentinel-managed", remoteOwner: "okamiops", remoteName: "luna-core",
  githubConnectionId: "github-connection", githubInstallationId: "77", githubRepositoryId: "9001",
  enabled: true, policyPath: ".csb/guardrails.json", lastGateId: null, githubStatus: "ready",
};

export const githubSecondRepository: GuardrailRepository = {
  ...githubRepository, repositoryKey: "github:2", displayName: "solar-api",
  remoteName: "solar-api", githubRepositoryId: "9002",
};

export const localRepository: GuardrailRepository = {
  ...githubRepository, repositoryKey: "local:1", source: "local", displayName: "bench-local",
  repositoryPath: "/srv/bench", remoteOwner: null, remoteName: null,
  githubConnectionId: null, githubInstallationId: null, githubRepositoryId: null,
};

export function githubAction(overrides: Partial<GitHubAction> = {}): GitHubAction {
  return {
    id: "action-pr", repositoryKey: githubRepository.repositoryKey, name: "PR deep",
    triggerKind: "pull_request", branchPatterns: ["main", "release/**"], executor: "sentinel-managed",
    connectionId: "github-connection", installationId: "77", repositoryId: "9001",
    scanner: {
      engine: "codex-security",
      connection: { connectionId: "fixture-connection", modelSelectionMode: "catalog", modelId: "fixture-model" },
      mode: "deep",
    },
    costCeilingUsd: 2.5, dailyCostCeilingUsd: 6, enabled: true, includeForks: false, revision: 1,
    baselineInitializedAt: "2026-09-29T00:00:00.000Z", createdBy: "u-root",
    lastEventAt: "2026-09-30T11:00:00.000Z", lastReconciledAt: "2026-09-30T11:45:00.000Z",
    lastError: null, migrationNote: null,
    createdAt: "2026-09-29T00:00:00.000Z", updatedAt: "2026-09-30T10:00:00.000Z",
    ...overrides,
  };
}

export function githubEvent(overrides: Partial<GitHubActionEvent> = {}): GitHubActionEvent {
  return {
    id: "event-1", actionId: "action-pr", repositoryKey: githubRepository.repositoryKey,
    actionRevision: 1, origin: "webhook", deliveryId: "delivery-1", kind: "pull_request",
    status: "launched", headSha: "a".repeat(40), baseRef: "main", headRef: "feature/login",
    pullRequestNumber: 7, targetIdentity: "pr:7@" + "a".repeat(40) as GitHubActionEvent["targetIdentity"],
    title: "Add the login boundary", gateId: "gate-1", costCeilingUsd: 2.5,
    reason: null, error: null, detectedAt: "2026-09-30T11:50:00.000Z",
    observedAt: "2026-09-30T11:49:00.000Z", dispatchedAt: "2026-09-30T11:50:05.000Z", completedAt: null,
    ...overrides,
  };
}

export function githubDelivery(overrides: Partial<WebhookDeliveryRecord> = {}): WebhookDeliveryRecord {
  return {
    deliveryId: "delivery-1", connectionId: "github-connection", event: "pull_request",
    action: "synchronize", repositoryKey: githubRepository.repositoryKey, installationId: "77",
    headSha: "a".repeat(40), outcome: "processed", reason: null,
    matchedActionIds: ["action-pr"], eventIds: ["event-1"],
    receivedAt: "2026-09-30T11:50:00.000Z", durationMs: 42,
    ...overrides,
  };
}

function githubIntegration(scenario: GitHubIntegrationScenario) {
  const missing = scenario === "missing_permissions" ? new Set(["workflows"]) : new Set<string>();
  const pending = scenario === "pending_approval" ? new Set(["checks", "workflows"]) : new Set<string>();
  const notConfigured = scenario === "not_configured";
  const suspended = scenario === "suspended";
  const notReady = scenario === "not_ready";
  const nowhere = scenario === "installed_nowhere";
  const stale = scenario === "stale_delivery";
  const live = !suspended && !notReady && !nowhere;
  const permissions = REQUIRED_PERMISSIONS.map(([name, required]) => {
    const granted = !live || missing.has(name) || pending.has(name)
      ? (missing.has(name) && live ? "read" : null)
      : required;
    return {
      name,
      required,
      granted,
      ok: live && !missing.has(name) && !pending.has(name),
      pendingInstallationIds: live && pending.has(name) ? ["77"] : [],
    };
  });
  const installations = notReady || nowhere ? [] : [{
    installationId: "77", account: "OkamiOps", repositorySelection: suspended ? "all" as const : "selected" as const,
    suspended, authorizedRepositoryCount: suspended ? 0 : 4,
    enrolledRepositoryCount: suspended ? 0 : 2,
    manageUrl: "https://github.com/organizations/OkamiOps/settings/installations/77",
  }];
  const secretConfigured = !notConfigured;
  const lastVerified = notConfigured || !live
    ? null
    : stale ? "2026-09-20T09:00:00.000Z" : "2026-09-30T11:50:00.000Z";
  const steps = {
    app_installed: live,
    permissions: permissions.every((permission) => permission.ok),
    events: true,
    webhook_secret: secretConfigured,
    delivery_verified: lastVerified !== null,
    repository_enrolled: live && !suspended,
    action_enabled: scenario === "all_green" || stale,
    baseline: false,
  };
  let blocked = false;
  const checklist = (Object.keys(steps) as Array<keyof typeof steps>).map((id) => {
    blocked ||= !steps[id];
    return { id, ok: !blocked };
  });
  const ready = checklist.slice(0, 6).every((item) => item.ok);
  return {
    connections: [{
      connectionId: "github-connection", appSlug: "okami-sentinel", appName: "OKAMI Sentinel Guardrails",
      appId: "4242", recordedAppId: notConfigured ? "okami-sentinel" : "4242",
      webhookSecretConfigured: secretConfigured,
      lastVerifiedDeliveryAt: lastVerified,
      deliveryVerifiedStale: stale,
      deliveryVerifiedAgeDays: stale ? 10 : lastVerified === null ? null : 0,
      webhookUrl: "http://127.0.0.1:4175/api/github/webhook",
      ready,
      installationsState: notReady ? "not_ready" as const
        : nowhere ? "none" as const
          : suspended ? "suspended" as const : "active" as const,
      missing: checklist.slice(0, 6).filter((item) => !item.ok).map((item) => item.id),
      permissions,
      events: REQUIRED_EVENTS.map((name) => ({ name, subscribed: true })),
      installations,
    }],
    deliveries: {
      last: notConfigured ? null : githubDelivery(),
      last24h: notConfigured ? { processed: 0, ignored: 0, failed: 0 } : { processed: 12, ignored: 3, failed: 1 },
    },
    reconciliation: { lastAt: "2026-09-30T11:45:00.000Z", recoveredLast24h: 2 },
    checklist,
    readyConnectionId: ready ? "github-connection" : null,
  };
}

export interface GitHubTabOptions {
  locale?: string;
  session?: MockApiOptions["session"];
  repositories?: GuardrailRepository[];
  actions?: GitHubAction[];
  events?: GitHubActionEvent[];
  deliveries?: WebhookDeliveryRecord[];
  integration?: GitHubIntegrationScenario;
  /** `POST /github/reconcile` answers `joined: true`: the cycle was already running. */
  reconcileJoined?: boolean;
  /** `GET /github/integration` answers 502, as it does while GitHub is down. */
  integrationFails?: boolean;
}

/**
 * Every `/github/*` route the tab reads, on top of `mockApi`. Registered **after**
 * it so these patterns win, and deliberately exhaustive: an unmocked `/github/`
 * request throws, which is how a call to a deleted route shows up as a failure
 * instead of a blank panel.
 */
export async function mockGitHubTab(page: Page, options: GitHubTabOptions = {}) {
  const scenario = options.integration ?? "all_green";
  const state = {
    /** Every `/github/*` request, as `METHOD /path?query`: the query is the scope. */
    requests: [] as string[],
    repositories: structuredClone(options.repositories ?? [githubRepository, githubSecondRepository]),
    actions: structuredClone(options.actions ?? [githubAction()]),
    events: structuredClone(options.events ?? [githubEvent()]),
    deliveries: structuredClone(options.deliveries ?? [githubDelivery()]),
    integration: githubIntegration(scenario),
    /** Every body `PUT /github/integration/webhook-secret` received. */
    secretWrites: [] as Array<{ connectionId: string; secret: string }>,
    /** Every action write, in order, so a spec can assert the exact patch. */
    writes: [] as Array<{ method: string; id: string | null; body: unknown }>,
    reconciles: 0,
  };

  const base = await mockApi(page, options.locale ?? "pt-BR", { session: options.session });

  await page.route("**/api/guardrails/repositories", (route) =>
    route.fulfill({ json: { repositories: state.repositories } }));

  await page.route("**/api/github/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/api/, "");
    state.requests.push(`${request.method()} ${path}${url.search}`);
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    if (path === "/github/integration" && request.method() === "GET") {
      if (options.integrationFails) return json({ error: "github_integration_unavailable" }, 502);
      return json(state.integration);
    }
    if (path === "/github/integration/webhook-secret" && request.method() === "PUT") {
      const body = request.postDataJSON() as { connectionId: string; secret: string };
      state.secretWrites.push(body);
      if (body.secret.length < 16) return json({ error: "webhook_secret_invalid" }, 400);
      // The real route answers 204 and never echoes the value; the next read has to
      // report it as configured, with the previous proof retired.
      state.integration.connections[0]!.webhookSecretConfigured = true;
      state.integration.connections[0]!.lastVerifiedDeliveryAt = null;
      state.integration.connections[0]!.deliveryVerifiedStale = false;
      state.integration.connections[0]!.deliveryVerifiedAgeDays = null;
      return route.fulfill({ status: 204 });
    }
    if (path === "/github/deliveries" && request.method() === "GET") {
      return json({ deliveries: state.deliveries, limit: 50, offset: 0, hasMore: false });
    }
    if (path === "/github/reconcile" && request.method() === "POST") {
      state.reconciles += 1;
      return json({
        repositories: 2, created: 1, observed: 0, errors: 0, joined: options.reconcileJoined === true,
      });
    }
    if (path === "/github/branches" && request.method() === "GET") {
      return json({ branches: ["main", "release/1"] });
    }
    if (path === "/github/events" && request.method() === "GET") {
      const repositoryKey = url.searchParams.get("repositoryKey");
      const outcome = url.searchParams.get("outcome");
      const events = state.events
        .filter((event) => !repositoryKey || event.repositoryKey === repositoryKey)
        .filter((event) => !outcome || event.status === outcome);
      return json({ events, limit: 50, offset: 0, hasMore: false });
    }
    if (path === "/github/actions" && request.method() === "GET") {
      const repositoryKey = url.searchParams.get("repositoryKey");
      const actions = state.actions.filter((action) => !repositoryKey || action.repositoryKey === repositoryKey);
      return json({ actions, limit: 200, offset: 0, hasMore: false });
    }
    if (path === "/github/actions" && request.method() === "POST") {
      const body = request.postDataJSON() as Record<string, unknown>;
      state.writes.push({ method: "POST", id: null, body });
      const repository = state.repositories.find((item) => item.repositoryKey === body.repositoryKey);
      if (repository?.source === "local") return json({ error: "repository_source_unsupported" }, 409);
      if (state.actions.some((action) => action.name === body.name && action.triggerKind === body.triggerKind
        && action.repositoryKey === body.repositoryKey)) {
        return json({ error: "github_action_name_taken" }, 409);
      }
      const created = githubAction({
        ...(body as Partial<GitHubAction>),
        id: `action-${state.actions.length + 1}`,
      });
      state.actions.push(created);
      return json({ action: created }, 201);
    }
    const actionMatch = path.match(/^\/github\/actions\/([^/]+)(?:\/(events))?$/);
    if (actionMatch) {
      const [, id, sub] = actionMatch;
      const index = state.actions.findIndex((action) => action.id === id);
      if (index === -1) return json({ error: "not_found" }, 404);
      if (sub === "events") {
        return json({
          events: state.events.filter((event) => event.actionId === id), limit: 50, offset: 0, hasMore: false,
        });
      }
      if (request.method() === "PATCH") {
        const body = request.postDataJSON() as Record<string, unknown>;
        state.writes.push({ method: "PATCH", id: id!, body });
        const current = state.actions[index]!;
        // The server is the authority, and it refuses a maintainer who enables or
        // reshapes a live action. The mock refuses the same way so a screen that
        // offered the button would fail here instead of looking like it worked.
        const isAdmin = options.session?.isAdmin !== false;
        const spends = body.enabled === true || body.includeForks === true
          || ["executor", "scanner", "costCeilingUsd", "dailyCostCeilingUsd"].some((key) => key in body);
        const reshapes = current.enabled
          && ["name", "branchPatterns", "triggerKind"].some((key) => key in body);
        if (!isAdmin && (spends || reshapes)) return json({ error: "forbidden" }, 403);
        const next = { ...current, ...(body as Partial<GitHubAction>) };
        state.actions[index] = next;
        return json({ action: next });
      }
      if (request.method() === "DELETE") {
        state.writes.push({ method: "DELETE", id: id!, body: null });
        if (options.session?.isAdmin === false && !(options.session.grants ?? []).some((grant) =>
          grant.repositoryKey === state.actions[index]!.repositoryKey && grant.role === "maintainer")) {
          return json({ error: "forbidden" }, 403);
        }
        state.actions.splice(index, 1);
        return route.fulfill({ status: 204 });
      }
    }
    throw new Error(`Unmocked GitHub request: ${request.method()} ${path}`);
  });

  return { ...base, github: state };
}
