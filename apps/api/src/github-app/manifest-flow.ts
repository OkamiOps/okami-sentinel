import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

const MANIFEST_FLOW_TTL_MS = 10 * 60_000;
const FLOW_ID = /^[A-Za-z0-9-]{1,100}$/;

export const GITHUB_APP_MANIFEST_PERMISSIONS = Object.freeze({
  actions: "write",
  checks: "write",
  contents: "read",
  metadata: "read",
  pull_requests: "read",
} as const);

export const GITHUB_APP_MANIFEST_EVENTS = Object.freeze([] as string[]);

export interface GitHubAppManifest {
  name: string;
  url: string;
  description: string;
  redirect_url: string;
  public: true;
  default_permissions: typeof GITHUB_APP_MANIFEST_PERMISSIONS;
  default_events: readonly string[];
  request_oauth_on_install: false;
}

export type ManifestFlowStatus =
  | "pending"
  | "exchanging"
  | "completed"
  | "expired"
  | "denied"
  | "failed";

export type PublicManifestFlowState =
  | { status: "pending" | "expired" | "denied" | "failed" }
  | { status: "completed"; connectionId: string };

export type ManifestFlowErrorCode =
  | "manifest_flow_expired"
  | "manifest_flow_not_found"
  | "manifest_state_invalid";

export class ManifestFlowError extends Error {
  constructor(readonly code: ManifestFlowErrorCode) {
    super(code);
    this.name = "ManifestFlowError";
  }
}

export interface GitHubAppManifestFlowDependencies {
  callbackUrl: string;
  localOrigin: string;
  now?: () => Date;
  createFlowId?: () => string;
  createState?: () => string;
}

interface ManifestFlowRecord {
  flowId: string;
  state: string;
  status: ManifestFlowStatus;
  createdAtMs: number;
  expiresAtMs: number;
  connectionId: string | null;
}

export class GitHubAppManifestFlow {
  readonly #callbackUrl: string;
  readonly #localOrigin: string;
  readonly #now: () => Date;
  readonly #createFlowId: () => string;
  readonly #createState: () => string;
  readonly #flows = new Map<string, ManifestFlowRecord>();

  constructor(dependencies: GitHubAppManifestFlowDependencies) {
    this.#callbackUrl = loopbackUrl(dependencies.callbackUrl).toString();
    this.#localOrigin = loopbackOrigin(dependencies.localOrigin);
    this.#now = dependencies.now ?? (() => new Date());
    this.#createFlowId = dependencies.createFlowId ?? randomUUID;
    this.#createState = dependencies.createState ?? (() => randomBytes(32).toString("base64url"));
  }

  start(): { flowId: string; authorizeUrl: string } {
    this.#sweep();
    const nowMs = this.#now().getTime();
    const flowId = flowIdentifier(this.#createFlowId());
    const state = highEntropyState(this.#createState());
    if (this.#flows.has(flowId)) throw new ManifestFlowError("manifest_state_invalid");
    this.#flows.set(flowId, {
      flowId,
      state,
      status: "pending",
      createdAtMs: nowMs,
      expiresAtMs: nowMs + MANIFEST_FLOW_TTL_MS,
      connectionId: null,
    });
    return {
      flowId,
      authorizeUrl: `${this.#localOrigin}/guardrails/github-app/manifest/authorize/${encodeURIComponent(flowId)}`,
    };
  }

  authorization(flowId: string): {
    actionUrl: string;
    manifest: GitHubAppManifest;
    state: string;
  } {
    const flow = this.#pendingFlow(flowId);
    const state = encodeURIComponent(flow.state);
    return {
      actionUrl: `https://github.com/settings/apps/new?state=${state}`,
      state: flow.state,
      manifest: Object.freeze({
        name: "OKAMI Sentinel Guardrails",
        url: "https://github.com/OkamiOps/okami-sentinel",
        description: "Evidence-backed repository security guardrails",
        redirect_url: withFlowId(this.#callbackUrl, flow.flowId),
        public: true,
        default_permissions: GITHUB_APP_MANIFEST_PERMISSIONS,
        default_events: GITHUB_APP_MANIFEST_EVENTS,
        request_oauth_on_install: false,
      }),
    };
  }

  beginCallback(
    flowId: string,
    state: string,
    error: string | null,
  ): { flowId: string; status: "exchanging" | "denied" } {
    const flow = this.#pendingFlow(flowId);
    if (!sameSecret(flow.state, state)) {
      throw new ManifestFlowError("manifest_state_invalid");
    }
    // Consume state before any result is returned or remote exchange starts.
    flow.state = "";
    if (error !== null) {
      flow.status = "denied";
      return { flowId: flow.flowId, status: "denied" };
    }
    flow.status = "exchanging";
    return { flowId: flow.flowId, status: "exchanging" };
  }

  complete(flowId: string, connectionId: string): void {
    const flow = this.#flow(flowId);
    this.#expire(flow);
    if (flow.status === "expired") throw new ManifestFlowError("manifest_flow_expired");
    if (flow.status !== "exchanging") throw new ManifestFlowError("manifest_state_invalid");
    flow.connectionId = flowIdentifier(connectionId);
    flow.status = "completed";
  }

  fail(flowId: string): void {
    const flow = this.#flow(flowId);
    if (flow.status === "completed" || flow.status === "denied" || flow.status === "expired") return;
    flow.state = "";
    flow.status = "failed";
  }

  publicState(flowId: string): PublicManifestFlowState {
    const flow = this.#flow(flowId);
    this.#expire(flow);
    if (flow.status === "completed") {
      if (flow.connectionId === null) throw new ManifestFlowError("manifest_state_invalid");
      return { status: "completed", connectionId: flow.connectionId };
    }
    if (flow.status === "exchanging") return { status: "pending" };
    return { status: flow.status };
  }

  #pendingFlow(flowId: string): ManifestFlowRecord {
    const flow = this.#flow(flowId);
    this.#expire(flow);
    if (flow.status === "expired") throw new ManifestFlowError("manifest_flow_expired");
    if (flow.status !== "pending" || flow.state.length === 0) {
      throw new ManifestFlowError("manifest_state_invalid");
    }
    return flow;
  }

  #flow(flowId: string): ManifestFlowRecord {
    const id = flowIdentifier(flowId);
    const flow = this.#flows.get(id);
    if (!flow) throw new ManifestFlowError("manifest_flow_not_found");
    return flow;
  }

  #expire(flow: ManifestFlowRecord): void {
    if ((flow.status === "pending" || flow.status === "exchanging") && this.#now().getTime() > flow.expiresAtMs) {
      flow.state = "";
      flow.status = "expired";
    }
  }

  #sweep(): void {
    const retentionMs = 60 * 60_000;
    const nowMs = this.#now().getTime();
    for (const [flowId, flow] of this.#flows) {
      this.#expire(flow);
      if (flow.expiresAtMs + retentionMs < nowMs) this.#flows.delete(flowId);
    }
  }
}

function withFlowId(callbackUrl: string, flowId: string): string {
  const url = new URL(callbackUrl);
  url.searchParams.set("flowId", flowId);
  return url.toString();
}

function loopbackUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ManifestFlowError("manifest_state_invalid");
  }
  if (
    url.protocol !== "http:" ||
    (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") ||
    url.username ||
    url.password
  ) {
    throw new ManifestFlowError("manifest_state_invalid");
  }
  return url;
}

function loopbackOrigin(value: string): string {
  const url = loopbackUrl(value);
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new ManifestFlowError("manifest_state_invalid");
  }
  return url.origin;
}

function flowIdentifier(value: string): string {
  if (!FLOW_ID.test(value)) throw new ManifestFlowError("manifest_flow_not_found");
  return value;
}

function highEntropyState(value: string): string {
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(value)) {
    throw new ManifestFlowError("manifest_state_invalid");
  }
  return value;
}

function sameSecret(expected: string, provided: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(provided);
  return left.length === right.length && timingSafeEqual(left, right);
}
