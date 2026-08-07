import type {
  CompareRequest,
  CompareResult,
  FindingDetail,
  FindingSummary,
  FindingTriage,
  FsListResponse,
  GateArtifact,
  GateDecision,
  GateRun,
  GuardrailPolicy,
  GuardrailRepository,
  HealthResponse,
  MetricsSummary,
  RegressionSummary,
  ScanRun,
  StartScanRequest,
  UpdateFindingTriageRequest,
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

export const api = {
  health: () => request<HealthResponse>("/health"),
  ingest: () => request<{ imported: number }>("/ingest", { method: "POST" }),
  metrics: () => request<MetricsSummary>("/metrics/summary"),
  listScans: () => request<{ scans: ScanRun[] }>("/scans"),
  getScan: (id: string) =>
    request<{ scan: ScanRun; findings: FindingSummary[] }>(`/scans/${id}`),
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
  gateEventsUrl: (gateId: string) =>
    `${BASE}/guardrails/gates/${encodeURIComponent(gateId)}/events`,
};
