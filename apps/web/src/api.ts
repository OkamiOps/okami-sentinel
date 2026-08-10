import type {
  CompareRequest,
  CompareResult,
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
  ProviderConnectionResponse,
  ProviderConnectionsResponse,
  RegressionSummary,
  ScanRun,
  ScannerCatalogResponse,
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

/** Keeps the CSRF token in the browser process only; public DTOs omit vault data. */
export function createConnectionsClient(fetcher: Fetcher = fetch): {
  list(): Promise<ProviderConnection[]>;
  create(body: CreateProviderConnectionRequest): Promise<ProviderConnection>;
  update(id: string, body: UpdateProviderConnectionRequest): Promise<ProviderConnection>;
  remove(id: string): Promise<void>;
} {
  let csrfToken: Promise<string> | null = null;
  const getCsrfToken = () => {
    csrfToken ??= fetcher(`${BASE}/connections/csrf`, { headers: { Accept: "application/json" } })
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
    async remove(id) { await write<{ ok: true }>(`/connections/${encodeURIComponent(id)}`, "DELETE"); },
  };
}

const connections = createConnectionsClient();

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
