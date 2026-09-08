import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const MANIFEST_FLOW_TTL_MS = 10 * 60_000;
const FLOW_ID = /^[A-Za-z0-9-]{1,100}$/;

export const GITHUB_APP_MANIFEST_PERMISSIONS = Object.freeze({
  actions: "write",
  checks: "write",
  contents: "write",
  metadata: "read",
  pull_requests: "read",
  workflows: "write",
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
  /** Explicit deployment origin; absent means the original loopback-only flow. */
  serverOrigin?: string;
  stateFile?: string;
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
  readonly #stateFile: string | undefined;
  readonly #apiBasePath: string;

  constructor(dependencies: GitHubAppManifestFlowDependencies) {
    if (dependencies.serverOrigin) {
      const origin = new URL(dependencies.serverOrigin);
      const callback = new URL(dependencies.callbackUrl);
      const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
      if ((origin.protocol !== "https:" && !(loopback && origin.protocol === "http:")) ||
          origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash ||
          callback.origin !== origin.origin || callback.username || callback.password ||
          callback.pathname !== "/api/guardrails/github-app/manifest/callback" || callback.search || callback.hash) {
        throw new ManifestFlowError("manifest_state_invalid");
      }
      this.#callbackUrl = callback.toString();
      this.#localOrigin = origin.origin;
      this.#apiBasePath = "/api";
    } else {
      this.#callbackUrl = loopbackUrl(dependencies.callbackUrl).toString();
      this.#localOrigin = loopbackOrigin(dependencies.localOrigin);
      this.#apiBasePath = "";
    }
    this.#now = dependencies.now ?? (() => new Date());
    this.#createFlowId = dependencies.createFlowId ?? randomUUID;
    this.#createState = dependencies.createState ?? (() => randomBytes(32).toString("base64url"));
    this.#stateFile = dependencies.stateFile;
    this.#restore();
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
    this.#persist();
    return {
      flowId,
      authorizeUrl: `${this.#localOrigin}${this.#apiBasePath}/guardrails/github-app/manifest/authorize/${encodeURIComponent(flowId)}`,
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
      this.#persist();
      return { flowId: flow.flowId, status: "denied" };
    }
    flow.status = "exchanging";
    this.#persist();
    return { flowId: flow.flowId, status: "exchanging" };
  }

  complete(flowId: string, connectionId: string): void {
    const flow = this.#flow(flowId);
    this.#expire(flow);
    if (flow.status === "expired") throw new ManifestFlowError("manifest_flow_expired");
    if (flow.status !== "exchanging") throw new ManifestFlowError("manifest_state_invalid");
    flow.connectionId = flowIdentifier(connectionId);
    flow.status = "completed";
    this.#persist();
  }

  fail(flowId: string): void {
    const flow = this.#flow(flowId);
    if (flow.status === "completed" || flow.status === "denied" || flow.status === "expired") return;
    flow.state = "";
    flow.status = "failed";
    this.#persist();
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

  #restore(): void {
    if (!this.#stateFile || !fs.existsSync(this.#stateFile)) return;
    try {
      const stat = fs.lstatSync(this.#stateFile);
      if (!stat.isFile() || stat.size > 512_000) throw new Error();
      const flows: unknown = JSON.parse(fs.readFileSync(this.#stateFile, "utf8"));
      if (!Array.isArray(flows) || flows.length > 512) throw new Error();
      for (const flow of flows) {
        if (!flow || !FLOW_ID.test(flow.flowId) ||
            !["pending", "exchanging", "completed", "expired", "denied", "failed"].includes(flow.status) ||
            typeof flow.state !== "string" || (flow.status === "pending" && !/^[A-Za-z0-9_-]{43,128}$/.test(flow.state)) ||
            !Number.isFinite(flow.createdAtMs) || !Number.isFinite(flow.expiresAtMs) ||
            (flow.connectionId !== null && (typeof flow.connectionId !== "string" || !FLOW_ID.test(flow.connectionId)))) throw new Error();
        this.#flows.set(flow.flowId, flow);
      }
      this.#sweep();
    } catch { throw new ManifestFlowError("manifest_state_invalid"); }
  }

  #persist(): void {
    if (!this.#stateFile) return;
    if (this.#flows.size > 512) throw new ManifestFlowError("manifest_state_invalid");
    fs.mkdirSync(path.dirname(this.#stateFile), { recursive: true, mode: 0o700 });
    const temporary = `${this.#stateFile}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify([...this.#flows.values()]), { mode: 0o600, flag: "wx" });
      fs.renameSync(temporary, this.#stateFile);
    } finally { fs.rmSync(temporary, { force: true }); }
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
