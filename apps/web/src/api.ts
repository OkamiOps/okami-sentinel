import type {
  CompareRequest,
  CompareResult,
  CapabilityReport,
  CreateProviderConnectionRequest,
  FindingDetail,
  FindingSummary,
  FindingTriage,
  FsListResponse,
  GateArtifact,
  GateDecision,
  GatePublishStatus,
  GateRun,
  GuardrailGitHubStatus,
  GuardrailPolicy,
  GuardrailRepository,
  HealthResponse,
  MetricsSummary,
  ProviderConnection,
  ProviderAuthFlow,
  ProviderAuthFlowResponse,
  ProviderConnectionResponse,
  ProviderConnectionsResponse,
  ProviderDisconnectResponse,
  ProviderModel,
  ProviderModelsResponse,
  ConnectionCompatibility,
  ResolveScanCompatibilityRequest,
  RegressionSummary,
  ScanRun,
  ScannerCatalogResponse,
  ScanConnectionSelection,
  StartScanRequest,
  UpdateFindingTriageRequest,
  UpdateProviderConnectionRequest,
} from "@csb/shared";
import { parseApiResponse } from "./lib/http.js";

const BASE = "/api";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  return parseApiResponse<T>(res);
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function createScanRoutingClient(fetcher: Fetcher = fetch): {
  resolveCompatibility(body: ResolveScanCompatibilityRequest): Promise<ConnectionCompatibility>;
} {
  return {
    async resolveCompatibility(body) {
      return parseApiResponse<ConnectionCompatibility>(await fetcher(`${BASE}/connections/compatibility`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }));
    },
  };
}

/** Keeps the CSRF token in the browser process only; public DTOs omit vault data. */
export function createConnectionsClient(fetcher: Fetcher = fetch): {
  list(): Promise<ProviderConnection[]>;
  create(body: CreateProviderConnectionRequest): Promise<ProviderConnection>;
  update(id: string, body: UpdateProviderConnectionRequest): Promise<ProviderConnection>;
  remove(id: string): Promise<void>;
  listModels(id: string): Promise<ProviderModel[]>;
  inspect(id: string): Promise<{ connection: ProviderConnection; inspection: { available: boolean; reason: string | null; supportsRuntimeDefault: boolean } }>;
  refreshModels(id: string): Promise<{ connection: ProviderConnection; discovery: { models: ProviderModel[]; supportsRuntimeDefault: boolean; safeError?: { code: string } } }>;
  probe(id: string, selection: ScanConnectionSelection): Promise<{ connection: ProviderConnection; report: CapabilityReport }>;
  startAuth(id: string, mode: "browser-oauth" | "device-code"): Promise<ProviderAuthFlow>;
  getAuth(id: string, flowId: string): Promise<ProviderAuthFlow>;
  cancelAuth(id: string, flowId: string): Promise<void>;
  disconnectAuth(id: string): Promise<ProviderDisconnectResponse["result"]>;
} {
  let csrfToken: Promise<string> | null = null;
  const getCsrfToken = () => {
    csrfToken ??= fetcher(`${BASE}/connections/security-session`, { headers: { Accept: "application/json" } })
      .then((response) => parseApiResponse<{ csrfToken: string }>(response))
      .then(({ csrfToken: token }) => token);
    return csrfToken;
  };
  const read = async <T>(path: string): Promise<T> =>
    parseApiResponse<T>(await fetcher(`${BASE}${path}`, { headers: { Accept: "application/json" } }));
  const write = async <T>(path: string, method: "POST" | "PATCH" | "DELETE", body?: unknown): Promise<T> => {
    const token = await getCsrfToken();
    return parseApiResponse<T>(await fetcher(`${BASE}${path}`, {
      method,
      headers: { Accept: "application/json", "Content-Type": "application/json", "X-CSRF-Token": token },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
  };
  return {
    async list() { return (await read<ProviderConnectionsResponse>("/connections")).connections; },
    async create(body) { return (await write<ProviderConnectionResponse>("/connections", "POST", body)).connection; },
    async update(id, body) { return (await write<ProviderConnectionResponse>(`/connections/${encodeURIComponent(id)}`, "PATCH", body)).connection; },
    async remove(id) {
      const token = await getCsrfToken();
      const response = await fetcher(`${BASE}/connections/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { Accept: "application/json", "X-CSRF-Token": token },
      });
      if (response.status === 204) return;
      await parseApiResponse<unknown>(response);
    },
    async listModels(id) {
      return (await read<ProviderModelsResponse>(`/connections/${encodeURIComponent(id)}/models`)).models;
    },
    async inspect(id) {
      return write(`/connections/${encodeURIComponent(id)}/inspect`, "POST");
    },
    async refreshModels(id) {
      return write(`/connections/${encodeURIComponent(id)}/models/refresh`, "POST");
    },
    async probe(id, selection) {
      return write(`/connections/${encodeURIComponent(id)}/probe`, "POST", selection);
    },
    async startAuth(id, mode) {
      return (await write<ProviderAuthFlowResponse>(
        `/connections/${encodeURIComponent(id)}/auth/start`,
        "POST",
        { mode },
      )).flow;
    },
    async getAuth(id, flowId) {
      return (await read<ProviderAuthFlowResponse>(
        `/connections/${encodeURIComponent(id)}/auth/${encodeURIComponent(flowId)}`,
      )).flow;
    },
    async cancelAuth(id, flowId) {
      await write<{ ok: boolean }>(
        `/connections/${encodeURIComponent(id)}/auth/${encodeURIComponent(flowId)}/cancel`,
        "POST",
      );
    },
    async disconnectAuth(id) {
      return (await write<ProviderDisconnectResponse>(
        `/connections/${encodeURIComponent(id)}/auth/disconnect`,
        "POST",
      )).result;
    },
  };
}

const connections = createConnectionsClient();
const scanRouting = createScanRoutingClient();

export interface EnrollGuardrailRepositoryRequest {
  repositoryPath: string;
  displayName?: string;
}

export interface StartLocalGateRequest {
  repositoryKey: string;
  baseRef: string;
  headRef: string;
}

export interface PolicySimulationRequest {
  gateId: string;
  policy: GuardrailPolicy;
  now?: string;
}

export interface PolicySimulationResponse {
  decision: GateDecision;
  configurationErrors: Array<{ field: string; message: string }>;
}

export interface GatePublicationAttempt {
  id: string;
  gateId: string;
  status: Extract<GatePublishStatus, "publishing" | "published" | "failed">;
  error: string | null;
  createdAt: string;
}

export interface ScanReportData {
  scan: ScanRun;
  findings: FindingDetail[];
  regression: RegressionSummary;
  generatedAt: string;
}

export interface ScanTelemetrySnapshot {
  lines: string[];
  cursor: number;
}

export const api = {
  health: () => request<HealthResponse>("/health"),
  listConnections: () => connections.list(),
  createConnection: (body: CreateProviderConnectionRequest) => connections.create(body),
  updateConnection: (id: string, body: UpdateProviderConnectionRequest) => connections.update(id, body),
  deleteConnection: (id: string) => connections.remove(id),
  listConnectionModels: (id: string) => connections.listModels(id),
  inspectConnection: (id: string) => connections.inspect(id),
  refreshConnectionModels: (id: string) => connections.refreshModels(id),
  probeConnection: (id: string, selection: ScanConnectionSelection) => connections.probe(id, selection),
  startConnectionAuth: (id: string, mode: "browser-oauth" | "device-code") => connections.startAuth(id, mode),
  getConnectionAuth: (id: string, flowId: string) => connections.getAuth(id, flowId),
  cancelConnectionAuth: (id: string, flowId: string) => connections.cancelAuth(id, flowId),
  disconnectConnectionAuth: (id: string) => connections.disconnectAuth(id),
  resolveScanCompatibility: (body: ResolveScanCompatibilityRequest) => scanRouting.resolveCompatibility(body),
  scanners: () => request<ScannerCatalogResponse>("/scanners"),
  ingest: () => request<{ imported: number }>("/ingest", { method: "POST" }),
  metrics: () => request<MetricsSummary>("/metrics/summary"),
  listScans: () => request<{ scans: ScanRun[] }>("/scans"),
  getScan: (id: string) =>
    request<{ scan: ScanRun; findings: FindingSummary[] }>(`/scans/${id}`),
  getTelemetry: (id: string) =>
    request<ScanTelemetrySnapshot>(`/scans/${id}/telemetry?limit=500`),
  report: (id: string) => request<ScanReportData>(`/scans/${id}/report`),
  getFinding: (scanId: string, findingId: string) =>
    request<{ finding: FindingDetail }>(`/scans/${scanId}/findings/${encodeURIComponent(findingId)}`),
  regression: (scanId: string) =>
    request<RegressionSummary>(`/scans/${scanId}/regression`),
  setBaseline: (scanId: string) =>
    request<RegressionSummary>(`/scans/${scanId}/baseline`, { method: "POST" }),
  updateTriage: (scanId: string, findingId: string, body: UpdateFindingTriageRequest) =>
    request<{ triage: FindingTriage }>(`/scans/${scanId}/findings/${encodeURIComponent(findingId)}/triage`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  startScan: (body: StartScanRequest) =>
    request<{ scan: ScanRun }>("/scans", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  cancelScan: (id: string) =>
    request<{ ok: boolean }>(`/scans/${id}/cancel`, { method: "POST" }),
  deleteScan: (id: string) =>
    request<{ ok: boolean; artifactsDeleted: boolean }>(`/scans/${id}`, {
      method: "DELETE",
    }),
  compare: (body: CompareRequest) =>
    request<CompareResult>("/compare", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  listFs: (path?: string) =>
    request<FsListResponse>(
      `/fs/list${path ? `?path=${encodeURIComponent(path)}` : ""}`,
    ),
  listGuardrailRepositories: () =>
    request<{ repositories: GuardrailRepository[] }>("/guardrails/repositories"),
  enrollGuardrailRepository: (body: EnrollGuardrailRepositoryRequest) =>
    request<{ repository: GuardrailRepository }>("/guardrails/repositories", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  getGuardrailPolicy: (repositoryKey: string) =>
    request<{ policy: GuardrailPolicy }>(
      `/guardrails/repositories/${encodeURIComponent(repositoryKey)}/policy`,
    ),
  updateGuardrailPolicy: (repositoryKey: string, policy: GuardrailPolicy) =>
    request<{ policy: GuardrailPolicy }>(
      `/guardrails/repositories/${encodeURIComponent(repositoryKey)}/policy`,
      { method: "PUT", body: JSON.stringify(policy) },
    ),
  simulateGuardrailPolicy: (
    repositoryKey: string,
    body: PolicySimulationRequest,
  ) => request<PolicySimulationResponse>(
    `/guardrails/repositories/${encodeURIComponent(repositoryKey)}/policy/simulate`,
    { method: "POST", body: JSON.stringify(body) },
  ),
  getGuardrailGitHubStatus: (repositoryKey: string) =>
    request<{ status: GuardrailGitHubStatus }>(
      `/guardrails/repositories/${encodeURIComponent(repositoryKey)}/github-status`,
    ),
  installGuardrailWorkflow: (repositoryKey: string) =>
    request<{ workflow: { path: string; committed: false } }>(
      `/guardrails/repositories/${encodeURIComponent(repositoryKey)}/install-workflow`,
      { method: "POST" },
    ),
  syncGuardrailBaseline: (repositoryKey: string) =>
    request<{ baseline: GateArtifact | null }>(
      `/guardrails/repositories/${encodeURIComponent(repositoryKey)}/baseline/sync`,
      { method: "POST" },
    ),
  listGates: (repositoryKey?: string) =>
    request<{ gates: GateRun[] }>(
      `/guardrails/gates${repositoryKey ? `?repositoryKey=${encodeURIComponent(repositoryKey)}` : ""}`,
    ),
  startGate: (body: StartLocalGateRequest) =>
    request<{ gate: GateRun }>("/guardrails/gates", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  getGate: (gateId: string) =>
    request<{ gate: GateRun; artifact: GateArtifact | null }>(
      `/guardrails/gates/${encodeURIComponent(gateId)}`,
    ),
  cancelGate: (gateId: string) =>
    request<{ ok: boolean }>(
      `/guardrails/gates/${encodeURIComponent(gateId)}/cancel`,
      { method: "POST" },
    ),
  publishGate: (gateId: string) =>
    request<{ gate: GateRun; attempt: GatePublicationAttempt }>(
      `/guardrails/gates/${encodeURIComponent(gateId)}/publish`,
      { method: "POST" },
    ),
  gateEventsUrl: (gateId: string) =>
    `${BASE}/guardrails/gates/${encodeURIComponent(gateId)}/events`,
};
