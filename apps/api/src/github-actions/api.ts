import { Hono, type Context } from "hono";

import type {
  GitHubAction,
  GitHubActionCreate,
  GitHubActionEvent,
  GitHubActionEventStatus,
  GitHubActionPatch,
  GitHubActionScannerSelection,
  GitHubActionTriggerKind,
  GuardrailRepository,
  WebhookDeliveryRecord,
} from "@csb/shared";

import { isStorableWebhookSecret } from "../credentials/system-github-app-credential-store.js";
import {
  canSeeRepository,
  hasRepositoryRole,
  principalOf,
  scopeOf,
  type Principal,
} from "../auth/principal.js";
import {
  MAX_BRANCH_PATTERN_WILDCARDS,
  branchPatternWildcards,
} from "./branch-patterns.js";
import type { GitHubIntegrationStatus } from "./integration-status.js";
import type { GitHubReconcileOutcome } from "./reconciler.js";
import { MAX_BRANCH_PATTERNS } from "./schema.js";
import { gitHubActionNeedsBranchPatternReview } from "./store.js";

const EVENT_STATUSES: readonly GitHubActionEventStatus[] = [
  "observed", "queued", "dispatching", "launched", "skipped", "failed", "superseded",
];

const MAX_KEY = 512;
const MAX_NAME = 80;
const MAX_PATTERN = 255;
const MAX_USD = 100_000;
const DEFAULT_EVENT_LIMIT = 100;
const MAX_EVENT_LIMIT = 200;
const DEFAULT_DELIVERY_LIMIT = 200;
const MAX_DELIVERY_LIMIT = 200;
/**
 * The actions listing is the register itself, not a feed, so the default page is
 * generous: the screen shows every action of every repository the caller can see and
 * would paginate only an unusually large install.
 */
const DEFAULT_ACTION_LIMIT = 200;
const MAX_ACTION_LIMIT = 500;
/**
 * The shape the vault requires of a connection id. Validating it here is what keeps
 * a malformed id a 404 like an unknown one, instead of the 502 the vault's
 * `secure_storage_unavailable` used to become — which was both a lie about whose
 * fault it was and a format oracle.
 */
const CONNECTION_ID = /^[A-Za-z0-9-]{1,100}$/;

/**
 * Everything the routes touch, injected, so the whole authorization surface is
 * testable without a database and the store's migration stays off the import path
 * of anything that only wants the shapes.
 */
export interface GitHubActionsApiDependencies {
  /** Wire to `getGitHubAction`. */
  getAction(actionId: string): GitHubAction | null;
  /**
   * Wire to `listGitHubActions`. `repositoryKeys` is the caller's scope and must be
   * applied in SQL: an in-memory filter over a page would hide the rows the caller
   * may read and make a short page look like the end of the list.
   */
  listActions(filter: {
    repositoryKey?: string | null;
    repositoryKeys?: readonly string[] | null;
    limit?: number;
    offset?: number;
  }): GitHubAction[];
  /** Wire to `createGitHubAction`; may throw `github_action_name_taken`. */
  createAction(input: GitHubActionCreate): GitHubAction;
  /** Wire to `patchGitHubAction`; may throw `github_action_branch_patterns_unreviewed`. */
  patchAction(actionId: string, patch: GitHubActionPatch): GitHubAction | null;
  /** Wire to `deleteGitHubAction`. */
  deleteAction(actionId: string): boolean;
  getRepository(repositoryKey: string): GuardrailRepository | null;
  /** Wire to `listGitHubActionEvents`. The filter is already scoped by the handler. */
  listEvents(filter: {
    actionId?: string;
    repositoryKeys?: string[];
    statuses?: GitHubActionEventStatus[];
    limit: number;
    offset: number;
  }): GitHubActionEvent[];
  /** Wire to `listWebhookDeliveries`. */
  listDeliveries(options: { limit: number; offset: number }): WebhookDeliveryRecord[];
  /** Wire to `buildGitHubIntegrationStatus` with the app's own reads. */
  readIntegrationStatus(): Promise<GitHubIntegrationStatus>;
  /**
   * Wire to `SystemGitHubAppCredentialStore.putWebhookSecret`. It must throw when
   * the connection has no stored bundle, so a typo in a connection id cannot
   * create a secret for nothing.
   */
  storeWebhookSecret(connectionId: string, secret: string): Promise<void>;
  /**
   * Wire to `recordWebhookSecretStored`. Rotating the secret retires every delivery
   * that verified against the old one, so the instant has to be recorded or the
   * `delivery_verified` step keeps vouching for a value GitHub no longer signs with.
   */
  recordWebhookSecretStored(connectionId: string, storedAt?: string | null): void;
  /** Wire to `webhookSecretStoredAt`; the route needs it to roll the instant back. */
  readWebhookSecretStoredAt(connectionId: string): string | null;
  /**
   * Wire to `githubWebhookSecretCache.invalidate`. Without it a freshly pasted
   * secret is ignored for a whole cache window and the operator reads a signature
   * failure as their own mistake.
   */
  invalidateWebhookSecrets(): void;
  /**
   * Wire to `reconcileGitHubActionsNow`. Its `joined` flag reaches the response
   * verbatim: the operator has to know the counts belong to a cycle that was
   * already running when the button was pressed.
   */
  reconcile(): Promise<GitHubReconcileOutcome>;
}

class ApiError extends Error {
  constructor(readonly code: string, readonly status: 400 | 403 | 404 | 409 | 500 | 502) {
    super(code);
    this.name = "GitHubActionsApiError";
  }
}

function invalid(code = "invalid_request"): never { throw new ApiError(code, 400); }
function forbidden(): never { throw new ApiError("forbidden", 403); }
/**
 * One code for a repository that does not exist and for one that was never shared
 * with the caller: the difference would let a member enumerate the register.
 */
function repositoryNotFound(): never { throw new ApiError("repository_not_found", 404); }
function notFound(): never { throw new ApiError("not_found", 404); }

/**
 * Which patch an administrator has to sign. Both executors spend — `sentinel-managed`
 * bills a Sentinel provider connection, `github-actions` bills the customer's
 * minutes and API key — so the rule is about the money and not about the executor.
 *
 * - Turning an action **on** always needs an administrator.
 * - Anything that decides *what* a run costs, or *whose* budget pays, needs one:
 *   the executor, the App authority, the scanner, either ceiling, and
 *   `includeForks`, which admits code nobody in the organisation wrote.
 * - Shape (`name`, `branchPatterns`, `triggerKind`) is a maintainer's to change
 *   while the action is **disabled**; on a live one it changes what the next run
 *   scans, so it needs an administrator too.
 *
 * Switching an action **off** is never blocked, whatever it is: an operator must be
 * able to stop spending without waiting for an administrator.
 */
export function patchRequiresAdmin(action: GitHubAction, patch: GitHubActionPatch): boolean {
  const spending: Array<keyof GitHubActionPatch> = [
    "executor", "connectionId", "installationId", "repositoryId",
    "scanner", "costCeilingUsd", "dailyCostCeilingUsd",
  ];
  if (patch.enabled === true) return true;
  // Turning forks **on** admits code nobody in the organisation wrote; turning them
  // off narrows what an action scans, and is a maintainer's to do for the same
  // reason `enabled: false` is. Making them wait for an administrator to stop it —
  // or disable the action and lose every other pull request with it — is the wrong
  // way round.
  if (patch.includeForks === true) return true;
  if (spending.some((key) => patch[key] !== undefined)) return true;
  const shape: Array<keyof GitHubActionPatch> = ["name", "branchPatterns", "triggerKind"];
  return action.enabled && shape.some((key) => patch[key] !== undefined);
}

export function createGitHubActionsApi(deps: GitHubActionsApiDependencies): Hono {
  const api = new Hono();

  api.get("/github/integration", async (c) => guard(c, async () => {
    requireAdmin(principalOf(c));
    try {
      return c.json(await deps.readIntegrationStatus());
    } catch {
      // Whatever GitHub or the vault said stays out of the response: an upstream
      // message can carry an installation id or a token fragment.
      throw new ApiError("github_integration_unavailable", 502);
    }
  }));

  /**
   * The secret goes in and never comes back out. GitHub generates it, the operator
   * pastes it here, and the only way to learn that it is the right one is a
   * delivery whose signature verified — which is why the checklist has its own
   * step for that and this route answers 204 and nothing else.
   */
  api.put("/github/integration/webhook-secret", async (c) => guard(c, async () => {
    requireAdmin(principalOf(c));
    const body = object(await json(c));
    exactKeys(body, new Set(["connectionId", "secret"]));
    // Deliberately generous here: the regex below is what decides, so a too-long
    // id answers 404 like any other unusable one rather than 400.
    const connectionId = text(body.connectionId, MAX_KEY);
    const secret = webhookSecret(body.secret);
    // A shape the vault would refuse answers exactly like an id it does not hold, so
    // the pair cannot be used to learn which ids are well formed.
    if (!CONNECTION_ID.test(connectionId)) throw new ApiError("connection_not_found", 404);
    // The instant is recorded *before* the vault write, and rolled back if the write
    // fails. The other order has one unrecoverable outcome: the secret stored and the
    // rotation lost, which leaves the old proof vouching for a value that no longer
    // exists — a green "entrega verificada" over a paste nobody has tested. Recording
    // first can only ever fail the other way, and the rollback closes even that.
    const previous = deps.readWebhookSecretStoredAt(connectionId);
    deps.recordWebhookSecretStored(connectionId);
    try {
      await deps.storeWebhookSecret(connectionId, secret);
    } catch (error) {
      deps.recordWebhookSecretStored(connectionId, previous);
      if (error instanceof Error && error.message === "credential_not_found") {
        throw new ApiError("connection_not_found", 404);
      }
      // Every refusal of the *input* is settled above, so anything left is ours.
      throw new ApiError("webhook_secret_not_stored", 502);
    }
    deps.invalidateWebhookSecrets();
    return c.body(null, 204);
  }));

  api.get("/github/deliveries", (c) => guard(c, () => {
    requireAdmin(principalOf(c));
    const { limit, offset } = page(c, DEFAULT_DELIVERY_LIMIT, MAX_DELIVERY_LIMIT);
    // One row beyond the page decides `hasMore` without a second count query.
    const rows = deps.listDeliveries({ limit: limit + 1, offset });
    return c.json({
      deliveries: rows.slice(0, limit), limit, offset, hasMore: rows.length > limit,
    });
  }));

  api.post("/github/reconcile", (c) => guard(c, async () => {
    requireAdmin(principalOf(c));
    try {
      return c.json(await deps.reconcile());
    } catch {
      throw new ApiError("github_reconcile_failed", 502);
    }
  }));

  api.get("/github/actions", (c) => guard(c, () => {
    const principal = principalOf(c);
    const requested = optionalQuery(c.req.query("repositoryKey"));
    // A repository the caller cannot see answers like one that does not exist,
    // before the listing reveals whether any action belongs to it.
    if (requested !== null && !canSeeRepository(principal, requested)) repositoryNotFound();
    const { limit, offset } = page(c, DEFAULT_ACTION_LIMIT, MAX_ACTION_LIMIT);
    const keys = repositoryKeysFor(principal, requested);
    // One row beyond the page decides `hasMore` without a second count query.
    const rows = deps.listActions({
      ...(keys === null ? {} : { repositoryKeys: keys }),
      limit: limit + 1,
      offset,
    });
    return c.json({
      actions: rows.slice(0, limit), limit, offset, hasMore: rows.length > limit,
    });
  }));

  api.post("/github/actions", (c) => guard(c, async () => {
    const principal = principalOf(c);
    const body = object(await json(c));
    // The repository travels in the body, out of the route policy's reach, so
    // visibility is settled here — and before anything else in the body is
    // validated, so a refusal reveals nothing but the 404.
    const repositoryKey = text(body.repositoryKey, MAX_KEY);
    if (!canSeeRepository(principal, repositoryKey)) repositoryNotFound();
    // Creating an action spends, whichever executor it names.
    requireAdmin(principal);
    const repository = deps.getRepository(repositoryKey);
    if (repository === null) repositoryNotFound();
    const authority = remoteAuthority(repository);
    const input = parseCreate(body, repositoryKey, authority, principal);
    return c.json({ action: deps.createAction(input) }, 201);
  }));

  api.patch("/github/actions/:actionId", (c) => guard(c, async () => {
    const principal = principalOf(c);
    const current = visibleAction(deps, principal, c.req.param("actionId"), "maintainer");
    const patch = parsePatch(object(await json(c)));
    if (patchRequiresAdmin(current, patch) && !principal.isAdmin) forbidden();
    // The store throws the same code; refusing here keeps the 409 a route fact
    // and not an exception shape.
    if (patch.enabled === true && patch.branchPatterns === undefined
      && gitHubActionNeedsBranchPatternReview(current)) {
      throw new ApiError("github_action_branch_patterns_unreviewed", 409);
    }
    const updated = deps.patchAction(current.id, patch);
    if (updated === null) notFound();
    return c.json({ action: updated });
  }));

  api.delete("/github/actions/:actionId", (c) => guard(c, () => {
    const principal = principalOf(c);
    const current = visibleAction(deps, principal, c.req.param("actionId"), "maintainer");
    if (!deps.deleteAction(current.id)) notFound();
    return c.body(null, 204);
  }));

  api.get("/github/actions/:actionId/events", (c) => guard(c, () => {
    const principal = principalOf(c);
    const current = visibleAction(deps, principal, c.req.param("actionId"), "viewer");
    const { limit, offset } = page(c, DEFAULT_EVENT_LIMIT, MAX_EVENT_LIMIT);
    const rows = deps.listEvents({ actionId: current.id, limit: limit + 1, offset });
    return c.json({ events: rows.slice(0, limit), limit, offset, hasMore: rows.length > limit });
  }));

  api.get("/github/events", (c) => guard(c, () => {
    const principal = principalOf(c);
    const requested = optionalQuery(c.req.query("repositoryKey"));
    if (requested !== null && !canSeeRepository(principal, requested)) repositoryNotFound();
    const outcome = optionalQuery(c.req.query("outcome"));
    if (outcome !== null && !EVENT_STATUSES.includes(outcome as GitHubActionEventStatus)) invalid();
    const { limit, offset } = page(c, DEFAULT_EVENT_LIMIT, MAX_EVENT_LIMIT);
    // The scope is pushed into the query rather than applied to the page: a
    // filter after the limit would hide exactly the rows the caller may read.
    const keys = repositoryKeysFor(principal, requested);
    const rows = deps.listEvents({
      ...(keys === null ? {} : { repositoryKeys: keys }),
      ...(outcome === null ? {} : { statuses: [outcome as GitHubActionEventStatus] }),
      limit: limit + 1,
      offset,
    });
    return c.json({ events: rows.slice(0, limit), limit, offset, hasMore: rows.length > limit });
  }));

  return api;
}

/**
 * `null` means "no restriction" (an administrator), an array means exactly the
 * repositories the caller may read. An empty array is a real answer: a member with
 * no grant sees nothing, and the store returns nothing for it.
 */
function repositoryKeysFor(principal: Principal, requested: string | null): string[] | null {
  if (requested !== null) return [requested];
  const scope = scopeOf(principal);
  return scope.kind === "all" ? null : [...scope.keys];
}

/**
 * The action, or the 404 an invisible one deserves. The route policy resolves the
 * same repository from the same row, so this repeats the decision rather than
 * replacing it: the module is mounted standalone in tests and must not depend on
 * the middleware to be safe.
 */
function visibleAction(
  deps: GitHubActionsApiDependencies,
  principal: Principal,
  actionId: string | undefined,
  role: "viewer" | "maintainer",
): GitHubAction {
  const id = typeof actionId === "string" ? actionId.trim() : "";
  if (id === "" || id.length > 128) notFound();
  const action = deps.getAction(id);
  if (action === null || !canSeeRepository(principal, action.repositoryKey)) notFound();
  if (!hasRepositoryRole(principal, action.repositoryKey, role)) forbidden();
  return action;
}

function requireAdmin(principal: Principal): void {
  if (!principal.isAdmin) forbidden();
}

/**
 * Automation needs the App's authority, and it is copied from the enrolled
 * repository rather than accepted from the body: a caller who could name a
 * connection could point an action at an installation it has no grant on. A local
 * checkout has no such authority and says so instead of failing later as if GitHub
 * had refused.
 */
function remoteAuthority(repository: GuardrailRepository): {
  connectionId: string;
  installationId: string;
  repositoryId: string;
} {
  if (repository.source !== "github" || repository.repositoryPath !== null
    || repository.githubConnectionId === null
    || repository.githubInstallationId === null
    || repository.githubRepositoryId === null) {
    // The request is well formed; the repository's own state is what refuses it,
    // and `GET /github/branches` already answers 409 for exactly this.
    throw new ApiError("repository_source_unsupported", 409);
  }
  return {
    connectionId: repository.githubConnectionId,
    installationId: repository.githubInstallationId,
    repositoryId: repository.githubRepositoryId,
  };
}

function parseCreate(
  body: Record<string, unknown>,
  repositoryKey: string,
  authority: { connectionId: string; installationId: string; repositoryId: string },
  principal: Principal,
): GitHubActionCreate {
  exactKeys(body, new Set([
    "repositoryKey", "name", "triggerKind", "branchPatterns", "executor", "scanner",
    "costCeilingUsd", "dailyCostCeilingUsd", "enabled", "includeForks",
  ]));
  return {
    repositoryKey,
    name: text(body.name, MAX_NAME),
    triggerKind: triggerKind(body.triggerKind),
    branchPatterns: branchPatterns(body.branchPatterns),
    executor: executor(body.executor),
    ...authority,
    scanner: scanner(body.scanner),
    costCeilingUsd: requiredUsd(body.costCeilingUsd),
    dailyCostCeilingUsd: body.dailyCostCeilingUsd === undefined
      ? null
      : nullableUsd(body.dailyCostCeilingUsd),
    enabled: body.enabled === undefined ? false : boolean(body.enabled),
    includeForks: body.includeForks === undefined ? false : boolean(body.includeForks),
    // Never the caller's to choose: it comes from the session, and is `null` for
    // the local runtime's single principal, which has no user row.
    createdBy: principal.userId,
  };
}

function parsePatch(body: Record<string, unknown>): GitHubActionPatch {
  exactKeys(body, new Set([
    "name", "triggerKind", "branchPatterns", "executor", "scanner",
    "costCeilingUsd", "dailyCostCeilingUsd", "enabled", "includeForks",
  ]));
  if (Object.keys(body).length === 0) invalid();
  return {
    ...(body.name === undefined ? {} : { name: text(body.name, MAX_NAME) }),
    ...(body.triggerKind === undefined ? {} : { triggerKind: triggerKind(body.triggerKind) }),
    ...(body.branchPatterns === undefined ? {} : { branchPatterns: branchPatterns(body.branchPatterns) }),
    ...(body.executor === undefined ? {} : { executor: executor(body.executor) }),
    ...(body.scanner === undefined ? {} : { scanner: scanner(body.scanner) }),
    ...(body.costCeilingUsd === undefined ? {} : { costCeilingUsd: requiredUsd(body.costCeilingUsd) }),
    ...(body.dailyCostCeilingUsd === undefined
      ? {}
      : { dailyCostCeilingUsd: nullableUsd(body.dailyCostCeilingUsd) }),
    ...(body.enabled === undefined ? {} : { enabled: boolean(body.enabled) }),
    ...(body.includeForks === undefined ? {} : { includeForks: boolean(body.includeForks) }),
  };
}

/**
 * The bound the store enforces, plus the one it cannot: a pattern with more
 * wildcards than the matcher compiles matches **nothing**, so storing it would
 * present as a live action that never fires.
 */
function branchPatterns(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_BRANCH_PATTERNS) {
    invalid("invalid_branch_patterns");
  }
  const patterns = (value as unknown[]).map((entry) => {
    if (typeof entry !== "string") invalid("invalid_branch_patterns");
    const pattern = (entry as string).trim();
    if (pattern === "" || pattern.length > MAX_PATTERN || pattern.includes("\0")) {
      invalid("invalid_branch_patterns");
    }
    if (branchPatternWildcards(pattern) > MAX_BRANCH_PATTERN_WILDCARDS) {
      invalid("invalid_branch_patterns");
    }
    return pattern;
  });
  if (new Set(patterns).size !== patterns.length) invalid("invalid_branch_patterns");
  return patterns;
}

function scanner(value: unknown): GitHubActionScannerSelection | null {
  if (value === null || value === undefined) return null;
  const input = object(value);
  exactKeys(input, new Set(["engine", "connection", "effort", "mode"]));
  if (input.engine !== "codex-security") invalid();
  if (input.mode !== "standard" && input.mode !== "deep") invalid();
  const connection = object(input.connection);
  exactKeys(connection, new Set(["connectionId", "modelSelectionMode", "modelId"]));
  const modelSelectionMode = connection.modelSelectionMode;
  if (modelSelectionMode !== "catalog" && modelSelectionMode !== "runtime-default") invalid();
  const modelId = connection.modelId;
  if ((modelSelectionMode === "catalog" && typeof modelId !== "string")
    || (modelSelectionMode === "runtime-default" && modelId !== null)) invalid();
  return {
    engine: "codex-security",
    connection: {
      connectionId: text(connection.connectionId, 100),
      modelSelectionMode,
      modelId: modelId === null ? null : text(modelId, 320),
    },
    ...(input.effort === undefined ? {} : { effort: text(input.effort, 64) }),
    mode: input.mode,
  } satisfies GitHubActionScannerSelection;
}

function requiredUsd(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > MAX_USD) {
    invalid("invalid_cost_ceiling");
  }
  return value as number;
}

function nullableUsd(value: unknown): number | null {
  return value === null ? null : requiredUsd(value);
}

function triggerKind(value: unknown): GitHubActionTriggerKind {
  if (value === "pull_request" || value === "push") return value;
  return invalid();
}

function executor(value: unknown): GitHubAction["executor"] {
  if (value === "sentinel-managed" || value === "github-actions") return value;
  return invalid();
}

function page(c: Context, fallback: number, maximum: number): { limit: number; offset: number } {
  return {
    limit: boundedInteger(c.req.query("limit"), fallback, 1, maximum),
    offset: boundedInteger(c.req.query("offset"), 0, 0, 100_000),
  };
}

function boundedInteger(raw: string | undefined, fallback: number, low: number, high: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < low || parsed > high) invalid();
  return parsed;
}

/**
 * The vault's own predicate, not a copy of its bounds: the route used to accept
 * sixteen times what the store would keep, so a long random secret passed here and
 * came back as a 502 that blamed the server for the operator's paste.
 */
function webhookSecret(value: unknown): string {
  if (!isStorableWebhookSecret(value)) invalid("webhook_secret_invalid");
  return value;
}

async function json(c: Context): Promise<unknown> {
  try {
    return await c.req.json<unknown>();
  } catch {
    return invalid();
  }
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function exactKeys(input: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  if (Object.keys(input).some((key) => !allowed.has(key))) invalid();
}

function text(value: unknown, maximum: number): string {
  if (typeof value !== "string") invalid();
  const result = (value as string).trim();
  if (result.length === 0 || result.length > maximum || result.includes("\0")) invalid();
  return result;
}

function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") invalid();
  return value as boolean;
}

/**
 * Absent and present-but-empty mean the same thing: no filter. A front end that
 * writes `?repositoryKey=${selected ?? ""}` is asking for every repository, not
 * sending a malformed request.
 */
function optionalQuery(value: string | undefined): string | null {
  if (value === undefined || value.trim() === "") return null;
  return text(value, MAX_KEY);
}

/**
 * Every refusal in one place, so a store error code cannot escape as a 500 with
 * whatever message SQLite chose.
 */
async function guard(c: Context, run: () => Response | Promise<Response>): Promise<Response> {
  c.header("Cache-Control", "no-store");
  try {
    return await run();
  } catch (error) {
    if (error instanceof ApiError) return c.json({ error: error.code }, error.status);
    const code = error instanceof Error ? error.message : "github_action_write_failed";
    switch (code) {
      case "github_action_name_taken":
        return c.json({ error: code }, 409);
      case "github_action_branch_patterns_unreviewed":
        return c.json({ error: code }, 409);
      case "github_action_branch_patterns_invalid":
        return c.json({ error: "invalid_branch_patterns" }, 400);
      case "github_action_state_invalid":
        return c.json({ error: code }, 500);
      default:
        throw error;
    }
  }
}
