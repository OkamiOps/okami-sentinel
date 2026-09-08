import { scanAnalysisMetrics } from "./scan-analysis-metrics.js";
import { getGitHubMonitorRule } from "./github-monitor/store.js";
import { GitHubMonitorService } from "./github-monitor/service.js";
import { createGitHubMonitorApi } from "./github-monitor/api.js";
import { automaticGitHubScanDispatcher } from "./github-monitor-dispatch.js";
import { createGitHubCheckoutsApp } from "./github-checkouts.js";
import { githubIntegrationSecurity } from "./github-integration-security.js";
import { isDraining } from "./shutdown.js";
import { randomUUID } from "node:crypto";
import { runtimeMode, repositoryRoots } from "./deployment-settings.js";
import { securitySessionToken } from "./security-session.js";
import { assertRepositoryAccess } from "./repository-access.js";
import path from "node:path";

import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import {
  buildDecisionGraph,
  evaluateGate,
} from "@csb/gate-core";
import {
  defaultGitRunner,
  parseGuardrailPolicy,
  readGuardrailExceptions,
  readGuardrailPolicy,
  writeGuardrailPolicy,
} from "@csb/gate-runtime";
import type {
  CompareRequest,
  GateArtifact,
  GateDecision,
  GateExecutorKind,
  GateFindingDelta,
  GateRun,
  GuardrailPullRequestSummary,
  GuardrailException,
  GuardrailPolicy,
  GuardrailRepository,
  HealthResponse,
  UpdateFindingTriageRequest,
} from "@csb/shared";
import {
  purgeScanRunArtifacts,
  readCliLogSnapshot,
} from "./activity.js";
import { compareScans } from "./compare.js";
import { getCodexInfo } from "./codex-info.js";
import { CODEX_SECURITY_STATE_DIR } from "./config.js";
import { deleteRun, getRun, hideRun, listRuns } from "./db.js";
import { listDirectory } from "./fs.js";
import {
  cancelGate,
  deleteTerminalGate,
  getGateArtifact,
  reconcileGateWithLinkedScan,
  startLocalGate,
  startRemoteActionsGate,
  startRemoteManagedGate,
  subscribeGate,
} from "./gate-orchestrator.js";
import {
  type GatePublicationAttempt,
  type GateRunUpdate,
  getGateRun,
  listGatePublicationAttempts,
  listGateRuns,
  listGuardrailRepositories,
  recordGatePublicationAttempt,
  updateGateRun,
  upsertGuardrailRepository,
  type GateEvent,
} from "./gate-store.js";
import { GitHubBaselineProvider } from "./github-baseline.js";
import {
  publishGateCheck,
  type PublishGateCheckInput,
} from "./github-check.js";
import { getGitHubStatus, getRemoteGitHubStatus } from "./github-status.js";
import { createGitHubAppApi, getSystemGitHubAppService } from "./github-app-api.js";
import { GitHubRepositoryService } from "./guardrails/github-repository-service.js";
import {
  GitHubRepositorySourceAdapter,
  parseEnrollGuardrailRepositoryRequest,
  type EnrollGuardrailRepositoryRequest,
} from "./guardrails/repository-source-adapter.js";
import { GitHubRefResolver } from "./guardrails/github-ref-resolver.js";
import {
  ProtectedPolicyLoader,
  type ProtectedPolicyBundle,
} from "./guardrails/protected-policy-loader.js";
import {
  TargetPreviewError,
  TargetPreviewService,
  nativeScanCostCeilingSupported,
  parseStartGateRequest,
  resolvedScanSelection,
  parseTargetPreviewRequest,
  type AcceptedGateTargetPreview,
  type GateTargetPreview,
  type StartGateRequest,
  type TargetPreviewRequest,
} from "./guardrails/target-preview.js";
import {
  callerWorkflowDocument,
  DEFAULT_GUARDRAIL_AUTOMATION,
  type GuardrailAutomationTriggers,
  normalizeBranchFilters,
  type CallerWorkflowDocument,
} from "./github-workflow.js";
import {
  getGitHubActionsStatus,
  type GitHubActionsStatus,
} from "./guardrails/github-actions-status.js";
import {
  importExternalScans,
  readFindingsFile,
  refreshRunFromDisk,
  toFindingSummaries,
} from "./ingest.js";
import { buildMetricsSummary } from "./metrics.js";
import { refreshOpenRouterPricing } from "./openrouter-pricing.js";
import { withProgress, withProgressMany } from "./progress.js";
import { buildRegressionSummary, markScanAsRepositoryBaseline, updateFindingTriage } from "./regression.js";
import { isRemovableScanStatus } from "./lifecycle.js";
import { GITHUB_ACTIONS_WORKFLOW_SHA, MAX_CONCURRENT_SCANS } from "./config.js";
import { createConnectionsApp } from "./connections-api.js";
import { getProviderRuntime } from "./provider-runtime.js";
import { createScanStartApp } from "./scan-start-api.js";
import { getScannerCatalog } from "./scanners/catalog.js";
import { createEngineUpdatesApp } from "./engine-updates-api.js";
import { listActiveRuns, listRunPage, parseScanListOptions, scanCatalog } from "./scan-list.js";
import {
  cancelScan,
  getActiveScanIds,
  isScanActive,
  startScan,
  subscribe,
} from "./runner.js";

export const app = new Hono();

app.use(
  "*",
  cors({
    origin: runtimeMode() === "server" ? [] : ["http://127.0.0.1:5173", "http://localhost:5173"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "X-CSRF-Token", "Idempotency-Key"],
  }),
);

app.get("/security-session", (c) => {
  c.header("Cache-Control", "no-store");
  return c.json({ csrfToken: securitySessionToken, runtimeMode: runtimeMode(), repositoryRoots: repositoryRoots() });
});

export interface GuardrailsApiDependencies {
  listRepositories(): GuardrailRepository[];
  enrollRepository(request: EnrollGuardrailRepositoryRequest): Promise<GuardrailRepository>;
  upsertRepository(repository: GuardrailRepository): void;
  getRepository(repositoryKey: string): GuardrailRepository | null;
  readPolicy(repositoryPath: string): GuardrailPolicy;
  readRemotePolicy(repository: GuardrailRepository): Promise<ProtectedPolicyBundle>;
  parsePolicy(value: unknown): GuardrailPolicy;
  writePolicy(repositoryPath: string, policy: GuardrailPolicy): void;
  readExceptions(repositoryPath: string): GuardrailException[];
  listGates(repositoryKey?: string | null): GateRun[];
  getGate(gateId: string): GateRun | null;
  getArtifact(gateId: string): GateArtifact | null;
  listPullRequests(repository: GuardrailRepository): Promise<GuardrailPullRequestSummary[]>;
  previewTarget(
    repository: GuardrailRepository,
    request: TargetPreviewRequest,
  ): Promise<GateTargetPreview>;
  acceptTargetPreview(
    repository: GuardrailRepository,
    request: {
      previewIdentity: string;
      target: StartGateRequest["target"];
      executor: GateExecutorKind;
    },
  ): Promise<AcceptedGateTargetPreview>;
  startGate(
    request: StartGateRequest,
    acceptedPreview: AcceptedGateTargetPreview | null,
  ): Promise<GateRun>;
  dispatchActionsGate(
    repository: GuardrailRepository,
    preview: AcceptedGateTargetPreview,
    idempotencyKey: string,
  ): Promise<GateRun>;
  cancelGate(gateId: string): boolean;
  deleteGate(gateId: string): boolean;
  subscribeGate(gateId: string, listener: (event: GateEvent) => void): () => void;
  getGitHubStatus(repository: GuardrailRepository): ReturnType<typeof getGitHubStatus>;
  getActionsStatus(repository: GuardrailRepository): Promise<GitHubActionsStatus>;
  getCallerWorkflow(repository: GuardrailRepository): Promise<CallerWorkflowDocument>;
  installCallerWorkflow?(repository: GuardrailRepository, triggers: GuardrailAutomationTriggers): Promise<GitHubActionsStatus>;
  syncBaseline(repository: GuardrailRepository): Promise<GateArtifact | null>;
  publishCheck(input: PublishGateCheckInput): Promise<void>;
  updateGate(gateId: string, updates: GateRunUpdate): void;
  recordPublicationAttempt(attempt: GatePublicationAttempt): void;
  listPublicationAttempts(gateId: string): GatePublicationAttempt[];
}

const githubBaselineProvider = new GitHubBaselineProvider({
  readAuthorizedRepositoryJson: (connectionId, installationId, repositoryId, resourcePath, permissions) =>
    getSystemGitHubAppService().readAuthorizedRepositoryJson(
      connectionId,
      installationId,
      repositoryId,
      resourcePath,
      permissions,
    ),
  downloadAuthorizedRepositoryBytes: (connectionId, installationId, repositoryId, resourcePath, permissions) =>
    getSystemGitHubAppService().downloadAuthorizedRepositoryBytes(
      connectionId,
      installationId,
      repositoryId,
      resourcePath,
      permissions,
    ),
});
const repositoryEnrollmentService = new GitHubRepositoryService({
  inspectLocal: inspectRepository,
  requireAuthorizedRepository: (connectionId, installationId, repositoryId) =>
    getSystemGitHubAppService().requireAuthorizedRepository(
      connectionId,
      installationId,
      repositoryId,
    ),
});
const githubRepositorySource = new GitHubRepositorySourceAdapter({
  readAuthorizedRepositoryJson: (connectionId, installationId, repositoryId, resourcePath, permissions) =>
    getSystemGitHubAppService().readAuthorizedRepositoryJson(
      connectionId,
      installationId,
      repositoryId,
      resourcePath,
      permissions,
    ),
});
const githubRefResolver = new GitHubRefResolver(githubRepositorySource);
const protectedPolicyLoader = new ProtectedPolicyLoader(githubRepositorySource);
const targetPreviewService = new TargetPreviewService({
  resolveTarget: (repository, target) => githubRefResolver.resolve(repository, target),
  loadPolicy: (repository, target, resolved) =>
    protectedPolicyLoader.load(repository, target, resolved),
  executorCapability: async (repository, executor) => {
    if (executor === "sentinel-managed") return { ready: true, code: "ready" };
    const status = await getGitHubActionsStatus(
      repository,
      getSystemGitHubAppService(),
      GITHUB_ACTIONS_WORKFLOW_SHA,
    );
    return status.ready
      ? { ready: true, code: "ready" }
      : { ready: false, code: "github_actions_unavailable" };
  },
  resolveScanSelection: resolveGuardrailScanSelection,
});

async function resolveGuardrailScanSelection(selection: import("@csb/shared").GuardrailScanSelection) {
  const scanner = (await getScannerCatalog()).scanners.find((candidate) => candidate.engine === selection.engine);
  if (!scanner?.enabled || !scanner.modes.includes(selection.mode)) {
    throw new TargetPreviewError("target_preview_invalid");
  }
  const compatibility = getProviderRuntime().compatibility.resolve({
    engine: selection.engine,
    selection: selection.connection,
    remoteRepositoryConfirmed: true,
    ...(selection.engine === "codex-security" ? { executionProfilePreference: "auto" as const } : {}),
  });
  if (!nativeScanCostCeilingSupported(
    selection,
    compatibility,
    scanner.models.map((model) => model.id),
  )) {
    throw new TargetPreviewError("target_preview_invalid");
  }
  return compatibility;
}

const guardrailsDependencies: GuardrailsApiDependencies = {
  listRepositories: listGuardrailRepositories,
  enrollRepository: (request) => repositoryEnrollmentService.enroll(request),
  upsertRepository: upsertGuardrailRepository,
  getRepository: findRepository,
  readPolicy: readGuardrailPolicy,
  readRemotePolicy: async (repository) => {
    const target = { kind: "protected_branch" as const, ref: repository.defaultBranch };
    const resolved = await githubRefResolver.resolve(repository, target);
    return protectedPolicyLoader.load(repository, target, resolved);
  },
  parsePolicy: parseGuardrailPolicy,
  writePolicy: writeGuardrailPolicy,
  readExceptions: readGuardrailExceptions,
  listGates: (repositoryKey) => listGateRuns(repositoryKey).map((gate) =>
    reconcileGateWithLinkedScan(gate.id) ?? gate),
  getGate: (gateId) => reconcileGateWithLinkedScan(gateId),
  getArtifact: getGateArtifact,
  listPullRequests: (repository) => githubRepositorySource.listOpenPullRequests(repository),
  previewTarget: (repository, request) => targetPreviewService.create(repository, request),
  acceptTargetPreview: (repository, request) => targetPreviewService.accept(repository, request),
  startGate: startGuardrailGate,
  dispatchActionsGate: (_repository, preview, idempotencyKey) =>
    startRemoteActionsGate(preview, idempotencyKey),
  cancelGate,
  deleteGate: deleteTerminalGate,
  subscribeGate,
  getGitHubStatus: (repository) => repository.source === "github"
    ? getRemoteGitHubStatus(repository, getSystemGitHubAppService())
    : getGitHubStatus(localRepositoryPath(repository)),
  getActionsStatus: (repository) => getGitHubActionsStatus(
    repository,
    getSystemGitHubAppService(),
    GITHUB_ACTIONS_WORKFLOW_SHA,
  ),
  getCallerWorkflow: async (repository) => {
    if (GITHUB_ACTIONS_WORKFLOW_SHA === null) {
      throw new Error("actions_workflow_release_unavailable");
    }
    return callerWorkflowDocument({
      defaultBranch: repository.defaultBranch,
      secretName: "OPENAI_API_KEY",
      workflowSha: GITHUB_ACTIONS_WORKFLOW_SHA,
      triggers: DEFAULT_GUARDRAIL_AUTOMATION,
    });
  },
  installCallerWorkflow: async (repository, triggers) => {
    if (GITHUB_ACTIONS_WORKFLOW_SHA === null || !hasGitHubRemote(repository)) {
      throw new Error("actions_workflow_release_unavailable");
    }
    const owner = requiredRemoteAuthority(repository.remoteOwner);
    const name = requiredRemoteAuthority(repository.remoteName);
    const connectionId = requiredRemoteAuthority(repository.githubConnectionId);
    const installationId = requiredRemoteAuthority(repository.githubInstallationId);
    const repositoryId = requiredRemoteAuthority(repository.githubRepositoryId);
    const workflow = callerWorkflowDocument({
      defaultBranch: repository.defaultBranch,
      secretName: "OPENAI_API_KEY",
      workflowSha: GITHUB_ACTIONS_WORKFLOW_SHA,
      triggers,
    });
    let sha: string | undefined;
    try {
      const current = await getSystemGitHubAppService().readAuthorizedRepositoryJson(
        connectionId, installationId, repositoryId,
        `/repos/${owner}/${name}/contents/${workflow.path}?ref=${encodeURIComponent(repository.defaultBranch)}`,
        { contents: "read" },
      );
      if (typeof current === "object" && current !== null && "sha" in current && typeof current.sha === "string") sha = current.sha;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || String((error as Error & { code: unknown }).code) !== "github_not_found") throw error;
    }
    await getSystemGitHubAppService().writeAuthorizedRepositoryJson(
      connectionId, installationId, repositoryId,
      `/repos/${owner}/${name}/contents/${workflow.path}`,
      "PUT",
      {
        message: "chore(security): configure Okami Sentinel guardrail",
        content: Buffer.from(workflow.content).toString("base64"),
        branch: repository.defaultBranch,
        ...(sha ? { sha } : {}),
      },
      { contents: "write", workflows: "write" },
    );
    return getGitHubActionsStatus(repository, getSystemGitHubAppService(), GITHUB_ACTIONS_WORKFLOW_SHA);
  },
  syncBaseline: (repository) => githubBaselineProvider.getBaseline({
    repositoryKey: repository.repositoryKey,
    owner: repository.remoteOwner!,
    name: repository.remoteName!,
    defaultBranch: repository.defaultBranch,
    connectionId: requiredRemoteAuthority(repository.githubConnectionId),
    installationId: requiredRemoteAuthority(repository.githubInstallationId),
    repositoryId: requiredRemoteAuthority(repository.githubRepositoryId),
  }),
  publishCheck: publishGateCheck,
  updateGate: updateGateRun,
  recordPublicationAttempt: recordGatePublicationAttempt,
  listPublicationAttempts: listGatePublicationAttempts,
};

export function createGuardrailsApp(
  deps: GuardrailsApiDependencies = guardrailsDependencies,
): Hono {
  const guardrails = new Hono();

  guardrails.get("/guardrails/repositories", (c) =>
    c.json({ repositories: deps.listRepositories() }));

  guardrails.post("/guardrails/repositories", async (c) => {
    try {
      const request = parseEnrollGuardrailRepositoryRequest(await c.req.json<unknown>());
      const repository = await deps.enrollRepository(request);
      if (deps.getRepository(repository.repositoryKey)) {
        return c.json({ error: "repository_already_registered", repositoryKey: repository.repositoryKey }, 409);
      }
      deps.upsertRepository(repository);
      return c.json({ repository }, 201);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  guardrails.post("/guardrails/repositories/:repositoryKey/target-preview", async (c) => {
    const repository = deps.getRepository(repositoryKey(c.req.param("repositoryKey")));
    if (!repository) return c.json({ error: "Repositório não encontrado" }, 404);
    try {
      const request = parseTargetPreviewRequest(await c.req.json<unknown>());
      return c.json({ preview: await deps.previewTarget(repository, request) });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, targetPreviewStatus(error));
    }
  });

  guardrails.get("/guardrails/repositories/:repositoryKey/pull-requests", async (c) => {
    const repository = deps.getRepository(repositoryKey(c.req.param("repositoryKey")));
    if (!repository) return c.json({ error: "Repositório não encontrado" }, 404);
    if (!hasGitHubRemote(repository)) return c.json({ error: "Repositório não possui remoto GitHub" }, 400);
    try {
      return c.json({ pullRequests: await deps.listPullRequests(repository) });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 502);
    }
  });

  guardrails.get("/guardrails/repositories/:repositoryKey/policy", async (c) => {
    const repository = deps.getRepository(repositoryKey(c.req.param("repositoryKey")));
    if (!repository) return c.json({ error: "Repositório não encontrado" }, 404);
    try {
      if (repository.source === "github") {
        const bundle = await deps.readRemotePolicy(repository);
        return c.json({
          policy: bundle.policy,
          policySource: bundle.policySource,
          policySha: bundle.policySha,
          readOnly: true,
        });
      }
      return c.json({
        policy: deps.readPolicy(localRepositoryPath(repository)),
        policySource: "workspace",
        policySha: null,
        readOnly: false,
      });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  guardrails.put("/guardrails/repositories/:repositoryKey/policy", async (c) => {
    const repository = deps.getRepository(repositoryKey(c.req.param("repositoryKey")));
    if (!repository) return c.json({ error: "Repositório não encontrado" }, 404);
    if (repository.source === "github") {
      return c.json({ error: "remote_policy_read_only" }, 409);
    }
    try {
      const policy = deps.parsePolicy(await c.req.json());
      deps.writePolicy(localRepositoryPath(repository), policy);
      return c.json({
        policy,
        policySource: "workspace",
        policySha: null,
        readOnly: false,
      });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  guardrails.post("/guardrails/repositories/:repositoryKey/policy/simulate", async (c) => {
    const repository = deps.getRepository(repositoryKey(c.req.param("repositoryKey")));
    if (!repository) return c.json({ error: "Repositório não encontrado" }, 404);
    try {
      const body = await c.req.json<{ gateId?: string; policy?: unknown; now?: string }>();
      if (typeof body.gateId !== "string") throw new Error("gateId é obrigatório");
      const artifact = deps.getArtifact(body.gateId);
      if (!artifact || artifact.repository.key !== repository.repositoryKey) {
        return c.json({ error: "Artifact do gate não encontrado" }, 404);
      }
      const policy = deps.parsePolicy(body.policy);
      const now = body.now ?? new Date().toISOString();
      if (!Number.isFinite(Date.parse(now))) throw new Error("now deve ser uma data ISO válida");
      const exceptions = repository.source === "github"
        ? (await deps.readRemotePolicy(repository)).exceptions
        : deps.readExceptions(localRepositoryPath(repository));
      const configurationErrors = exceptions.flatMap((exception, index) =>
        Date.parse(exception.expiresAt) <= Date.parse(now)
          ? [{ field: `exceptions[${index}].expiresAt`, message: "Exceção expirada" }]
          : []);
      const decision = simulateDecision(
        artifact,
        policy,
        exceptions.filter((exception) => Date.parse(exception.expiresAt) > Date.parse(now)),
        now,
      );
      return c.json({ decision, configurationErrors });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  guardrails.get("/guardrails/repositories/:repositoryKey/github-status", async (c) => {
    const repository = deps.getRepository(repositoryKey(c.req.param("repositoryKey")));
    if (!repository) return c.json({ error: "Repositório não encontrado" }, 404);
    const status = await deps.getGitHubStatus(repository);
    return c.json({ status });
  });

  guardrails.get("/guardrails/repositories/:repositoryKey/actions-status", async (c) => {
    const repository = deps.getRepository(repositoryKey(c.req.param("repositoryKey")));
    if (!repository) return c.json({ error: "Repositório não encontrado" }, 404);
    return c.json({ status: await deps.getActionsStatus(repository) });
  });

  guardrails.get("/guardrails/repositories/:repositoryKey/caller-workflow", async (c) => {
    const repository = deps.getRepository(repositoryKey(c.req.param("repositoryKey")));
    if (!repository) return c.json({ error: "Repositório não encontrado" }, 404);
    if (!hasGitHubRemote(repository)) {
      return c.json({ error: "Repositório não possui remoto GitHub" }, 400);
    }
    try {
      return c.json({ workflow: await deps.getCallerWorkflow(repository) });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 502);
    }
  });

  guardrails.put("/guardrails/repositories/:repositoryKey/caller-workflow", async (c) => {
    const repository = deps.getRepository(repositoryKey(c.req.param("repositoryKey")));
    if (!repository) return c.json({ error: "Repositório não encontrado" }, 404);
    if (!hasGitHubRemote(repository)) return c.json({ error: "Repositório não possui remoto GitHub" }, 400);
    if (!deps.installCallerWorkflow) return c.json({ error: "github_workflow_install_unavailable" }, 501);
    let triggers: GuardrailAutomationTriggers;
    try {
      triggers = parseAutomationTriggers(await c.req.json<unknown>());
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
    try {
      return c.json({ status: await deps.installCallerWorkflow(repository, triggers) });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 409);
    }
  });

  guardrails.post("/guardrails/repositories/:repositoryKey/actions-dispatch", async (c) => {
    const repository = deps.getRepository(repositoryKey(c.req.param("repositoryKey")));
    if (!repository) return c.json({ error: "Repositório não encontrado" }, 404);
    try {
      const request = parseStartGateRequest(await c.req.json<unknown>());
      if (
        request.repositoryKey !== repository.repositoryKey
        || request.executor !== "github-actions"
        || request.scanSelection !== undefined
      ) throw new TargetPreviewError("target_preview_invalid");
      const preview = await deps.acceptTargetPreview(repository, {
        previewIdentity: requiredPreviewIdentity(request.previewIdentity),
        target: request.target,
        executor: "github-actions",
      });
      const idempotencyKey = requiredIdempotencyKey(c.req.header("Idempotency-Key"));
      const gate = await deps.dispatchActionsGate(repository, preview, idempotencyKey);
      return c.json({ gate }, 202);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, targetPreviewStatus(error));
    }
  });

  guardrails.post("/guardrails/repositories/:repositoryKey/baseline/sync", async (c) => {
    const repository = deps.getRepository(repositoryKey(c.req.param("repositoryKey")));
    if (!repository) return c.json({ error: "Repositório não encontrado" }, 404);
    if (!hasGitHubRemote(repository)) {
      return c.json({ error: "Repositório não possui remoto GitHub" }, 400);
    }
    try {
      return c.json({ baseline: await deps.syncBaseline(repository) });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 502);
    }
  });

  guardrails.get("/guardrails/gates", (c) =>
    c.json({ gates: deps.listGates(c.req.query("repositoryKey") ?? null) }));

  guardrails.post("/guardrails/gates", async (c) => {
    try {
      const request = parseStartGateRequest(await c.req.json<unknown>());
      const repository = deps.getRepository(request.repositoryKey);
      if (!repository) return c.json({ error: "Repositório não encontrado" }, 404);
      const executor = request.executor ?? repository.defaultExecutor;
      if (repository.source === "github" && request.scanSelection !== undefined) throw new TargetPreviewError("target_preview_invalid");
      const acceptedPreview = repository.source === "github"
        ? await deps.acceptTargetPreview(repository, {
            previewIdentity: requiredPreviewIdentity(request.previewIdentity),
            target: request.target,
            executor,
          })
        : null;
      const gate = await deps.startGate({ ...request, executor }, acceptedPreview);
      return c.json({ gate }, 202);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, targetPreviewStatus(error));
    }
  });

  guardrails.get("/guardrails/gates/:gateId", (c) => {
    const gate = deps.getGate(c.req.param("gateId"));
    if (!gate) return c.json({ error: "Gate não encontrado" }, 404);
    return c.json({ gate, artifact: deps.getArtifact(gate.id) });
  });

  guardrails.get("/guardrails/gates/:gateId/events", (c) => {
    const gateId = c.req.param("gateId");
    if (!deps.getGate(gateId)) return c.json({ error: "Gate não encontrado" }, 404);
    return streamSSE(c, async (stream) => {
      let closed = false;
      let unsubscribe: () => void = () => undefined;
      let pending = Promise.resolve();
      const stop = deps.subscribeGate(gateId, (event) => {
        pending = pending.then(() => stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
          id: String(event.sequence),
        }));
        if (event.type === "done" || event.type === "error") closed = true;
      });
      unsubscribe = stop;
      if (closed) unsubscribe();
      stream.onAbort(() => {
        closed = true;
        unsubscribe();
      });
      while (!closed) await stream.sleep(100);
      await pending;
      unsubscribe();
    });
  });

  guardrails.post("/guardrails/gates/:gateId/cancel", (c) => {
    if (!deps.cancelGate(c.req.param("gateId"))) {
      return c.json({ error: "Gate não está ativo" }, 404);
    }
    return c.json({ ok: true });
  });

  guardrails.delete("/guardrails/gates/:gateId", (c) => {
    try {
      const deleted = deps.deleteGate(c.req.param("gateId"));
      return c.json({ ok: true, deleted });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 409);
    }
  });

  guardrails.post("/guardrails/gates/:gateId/publish", async (c) => {
    const gateId = c.req.param("gateId");
    const gate = deps.getGate(gateId);
    if (!gate) return c.json({ error: "Gate não encontrado" }, 404);
    if (gate.executor !== "sentinel-managed") {
      return c.json({ error: "O Check deste gate pertence ao GitHub Actions" }, 409);
    }
    const artifact = deps.getArtifact(gateId);
    if (!artifact) return c.json({ error: "Gate ainda não possui artifact" }, 409);
    const repository = deps.getRepository(gate.repositoryKey);
    if (!repository) return c.json({ error: "Repositório não encontrado" }, 404);
    if (!hasGitHubRemote(repository)) {
      return c.json({ error: "Repositório não possui remoto GitHub" }, 400);
    }

    const attempt: GatePublicationAttempt = {
      id: randomUUID(),
      gateId,
      status: "publishing",
      error: null,
      createdAt: new Date().toISOString(),
    };
    deps.updateGate(gateId, {
      publishStatus: "publishing",
      publishError: null,
      publishedAt: null,
    });
    deps.recordPublicationAttempt(attempt);

    try {
      await deps.publishCheck({
        artifact,
        owner: repository.remoteOwner!,
        repository: repository.remoteName!,
        detailsUrl: null,
      });
      const publishedAttempt = { ...attempt, status: "published" as const };
      deps.recordPublicationAttempt(publishedAttempt);
      deps.updateGate(gateId, {
        publishStatus: "published",
        publishError: null,
        publishedAt: new Date().toISOString(),
      });
      return c.json({ gate: deps.getGate(gateId), attempt: publishedAttempt });
    } catch (error) {
      const message = errorMessage(error);
      const failedAttempt = {
        ...attempt,
        status: "failed" as const,
        error: message,
      };
      deps.recordPublicationAttempt(failedAttempt);
      deps.updateGate(gateId, {
        publishStatus: "failed",
        publishError: message,
        publishedAt: null,
      });
      return c.json({ error: message }, 502);
    }
  });

  return guardrails;
}

app.route("/", createGuardrailsApp());
app.route("/", createGitHubAppApi());
app.route("/", createEngineUpdatesApp());

const startAutomaticGitHubScan = automaticGitHubScanDispatcher({
  getRepository: findRepository,
  getRule: getGitHubMonitorRule,
  validateActions: async (repository) => {
    const status = await getGitHubActionsStatus(repository, getSystemGitHubAppService(), GITHUB_ACTIONS_WORKFLOW_SHA);
    if (!status.ready || !status.triggers) throw new Error("target_preview_executor_unavailable");
    if (status.triggers.push || status.triggers.pullRequest || status.triggers.merge) throw new Error("monitor_actions_duplicate_triggers");
  },
  preview: (repository, request) => targetPreviewService.create(repository, request),
  accept: (repository, preview) => targetPreviewService.accept(repository, {
    previewIdentity: preview.previewIdentity, target: preview.target, executor: preview.executor,
  }),
  startManaged: startRemoteManagedGate,
  startActions: startRemoteActionsGate,
});
const githubMonitorDependencies = {
  listRepositories: listGuardrailRepositories,
  readRepositoryJson: (repository: GuardrailRepository, resourcePath: string, permissions: import("./github-app/github-app-client.js").GitHubInstallationPermissions) =>
    getSystemGitHubAppService().readAuthorizedRepositoryJson(
      requiredRemoteAuthority(repository.githubConnectionId),
      requiredRemoteAuthority(repository.githubInstallationId),
      requiredRemoteAuthority(repository.githubRepositoryId),
      `/repos/${encodeURIComponent(requiredRemoteAuthority(repository.remoteOwner))}/${encodeURIComponent(requiredRemoteAuthority(repository.remoteName))}${resourcePath}`, permissions,
    ),
  startAutomatic: async (input: import("./github-monitor/service.js").GitHubMonitorStartInput) => {
    if (isDraining()) throw new Error("server_draining");
    return startAutomaticGitHubScan(input);
  },
  // Remote snapshots have no mutable host checkout. Local checkouts use the
  // separate explicit fetch/pull API below, protected by the maintenance lease.
  checkoutAvailable: () => false,
};
export const githubMonitor = new GitHubMonitorService(githubMonitorDependencies);
for (const route of ["/github-monitor/*", "/github-checkouts", "/github-checkouts/*"]) {
  app.use(route, githubIntegrationSecurity());
}
app.route("/", createGitHubMonitorApi({ ...githubMonitorDependencies, service: githubMonitor }));
app.route("/", createGitHubCheckoutsApp({ getRepository: findRepository }));

const providerRuntime = getProviderRuntime();
app.route("/", createConnectionsApp({
  service: providerRuntime.connections,
  authFlows: providerRuntime.authFlows,
  compatibility: providerRuntime.compatibility,
}));

app.get("/health", async (c) => {
  const codexInfo = await getCodexInfo();
  const activeScanIds = getActiveScanIds();
  const body: HealthResponse = {
    ok: true,
    api: "codex-security-benchmark",
    codexStateDir: CODEX_SECURITY_STATE_DIR,
    codexInfo,
    activeScanId: activeScanIds[0] ?? null,
    activeScanIds,
    maxConcurrentScans: MAX_CONCURRENT_SCANS,
  };
  return c.json(body);
});

app.get("/scanners", async (c) => c.json(await getScannerCatalog()));

app.post("/ingest", (c) => {
  const result = importExternalScans();
  return c.json(result);
});

app.get("/metrics/summary", async (c) => {
  await refreshOpenRouterPricing();
  // Terminal history is indexed by ingestion; polling only reconciles live work.
  for (const run of listActiveRuns()) readRunWithEngineRefresh(run.id);
  const daysValue = c.req.query("days");
  const days = daysValue === "7" || daysValue === "14" || daysValue === "21" || daysValue === "30"
    ? Number(daysValue) as 7 | 14 | 21 | 30
    : null;
  const statusValue = c.req.query("status");
  const status = statusValue === "active" || statusValue === "completed" || statusValue === "attention"
    ? statusValue
    : null;
  const engineValue = c.req.query("engine");
  const engine = engineValue === "codex-security" || engineValue === "mantis" || engineValue === "vulnhunter"
    ? engineValue
    : null;
  return c.json(buildMetricsSummary({
    days,
    status,
    engine,
    repository: c.req.query("repository") ?? null,
    query: c.req.query("query") ?? null,
  }));
});

app.get("/scans", async (c) => {
  let options;
  try { options = parseScanListOptions(c.req.query()); }
  catch { return c.json({ error: "Invalid scan pagination" }, 400); }
  await refreshOpenRouterPricing();
  if (options) {
    // Reconcile running work and the requested page. Ingestion remains the
    // authority for off-page artifacts; no per-directory history sweep here.
    for (const run of listActiveRuns()) readRunWithEngineRefresh(run.id);
    for (const run of listRunPage(options, false).scans) readRunWithEngineRefresh(run.id);
    const page = listRunPage(options);
    return c.json({ ...page, scans: withProgressMany(page.scans) });
  }
  return c.json({ scans: withProgressMany(readRunsWithEngineRefresh()) });
});

app.get("/scans/active", (c) => {
  const scans = listActiveRuns().map((run) => readRunWithEngineRefresh(run.id) ?? run)
    .filter((run) => run.status === "queued" || run.status === "running");
  return c.json({ scans: withProgressMany(scans) });
});

app.get("/scans/catalog", (c) => c.json(scanCatalog()));

app.delete("/scans/:id", (c) => {
  const id = c.req.param("id");
  const run = getRun(id);
  if (!run) return c.json({ error: "Scan não encontrado" }, 404);
  if (isScanActive(id) || !isRemovableScanStatus(run.status)) {
    return c.json(
      { error: "Somente scans concluídos, incompletos, falhos ou cancelados podem ser removidos." },
      409,
    );
  }
  try {
    const linkedGates = listGateRuns().filter((gate) => gate.scanId === id);
    if (linkedGates.some((gate) => !["completed", "cancelled", "error"].includes(gate.status))) {
      return c.json({ error: "O scan ainda pertence a um gate ativo; cancele o gate antes de excluir." }, 409);
    }
    const purge = purgeScanRunArtifacts(run.scanDir);
    hideRun(id);
    deleteRun(id);
    const linkedGatesDeleted = linkedGates.reduce(
      (count, gate) => count + (deleteTerminalGate(gate.id, { preserveLinkedScan: true }) ? 1 : 0),
      0,
    );
    return c.json({ ok: true, ...purge, linkedGatesDeleted });
  } catch (error) {
    return c.json({ error: errorMessage(error) }, 409);
  }
});

app.get("/scans/:id", async (c) => {
  await refreshOpenRouterPricing();
  const id = c.req.param("id");
  const run = readRunWithEngineRefresh(id);
  if (!run) return c.json({ error: "Scan não encontrado" }, 404);
  const findings = toFindingSummaries(readFindingsFile(run.scanDir));
  return c.json({ scan: withProgress(run), findings });
});

app.get("/scans/:id/analysis-metrics", (c) => {
  const run = readRunWithEngineRefresh(c.req.param("id"));
  if (!run) return c.json({ error: "Scan not found" }, 404);
  return c.json(scanAnalysisMetrics(run));
});

app.get("/scans/:id/telemetry", (c) => {
  const run = getRun(c.req.param("id"));
  if (!run) return c.json({ error: "Scan não encontrado" }, 404);
  const requested = Number(c.req.query("limit") ?? 500);
  const limit = Number.isFinite(requested)
    ? Math.max(1, Math.min(1_000, Math.trunc(requested)))
    : 500;
  return c.json(readCliLogSnapshot(run.scanDir, limit));
});

function readRunsWithEngineRefresh() {
  return listRuns().map((run) => readRunWithEngineRefresh(run.id) ?? run);
}

function readRunWithEngineRefresh(id: string) {
  const stored = getRun(id);
  const artifactManaged = stored?.engine === "mantis" || stored?.engine === "vulnhunter" ||
    (stored?.engine === "codex-security" && stored.execution?.executionProfile === "portable");
  return artifactManaged
    ? refreshRunFromDisk(id) ?? stored
    : stored;
}

app.get("/scans/:id/report", async (c) => {
  await refreshOpenRouterPricing();
  const run = readRunWithEngineRefresh(c.req.param("id"));
  if (!run) return c.json({ error: "Scan não encontrado" }, 404);
  try {
    return c.json({
      scan: withProgress(run),
      findings: readFindingsFile(run.scanDir),
      regression: buildRegressionSummary(run.id),
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Falha ao montar relatório" }, 500);
  }
});

app.get("/scans/:id/regression", (c) => {
  try {
    return c.json(buildRegressionSummary(c.req.param("id")));
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Falha ao calcular regressões" }, 404);
  }
});

app.post("/scans/:id/baseline", (c) => {
  try {
    return c.json(markScanAsRepositoryBaseline(c.req.param("id")));
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Falha ao fixar baseline" }, 400);
  }
});

app.get("/scans/:id/findings", (c) => {
  const run = getRun(c.req.param("id"));
  if (!run) return c.json({ error: "Scan não encontrado" }, 404);
  const severity = c.req.query("severity");
  const q = (c.req.query("q") || "").toLowerCase();
  let findings = readFindingsFile(run.scanDir);
  if (severity) {
    findings = findings.filter((f) => f.severity === severity);
  }
  if (q) {
    findings = findings.filter(
      (f) =>
        f.title.toLowerCase().includes(q) ||
        (f.primaryPath ?? "").toLowerCase().includes(q) ||
        (f.summary ?? "").toLowerCase().includes(q),
    );
  }
  return c.json({ findings: toFindingSummaries(findings), total: findings.length });
});

app.get("/scans/:id/findings/:findingId", (c) => {
  const run = getRun(c.req.param("id"));
  if (!run) return c.json({ error: "Scan não encontrado" }, 404);
  const findingId = c.req.param("findingId");
  const finding = readFindingsFile(run.scanDir).find(
    (f) => f.findingId === findingId || f.occurrenceId === findingId,
  );
  if (!finding) return c.json({ error: "Finding não encontrado" }, 404);
  return c.json({ finding });
});

app.post("/scans/:id/findings/:findingId/triage", async (c) => {
  const body = (await c.req.json()) as UpdateFindingTriageRequest;
  const allowed = new Set(["unreviewed", "confirmed", "accepted", "false_positive"]);
  if (!allowed.has(body.status)) return c.json({ error: "Estado de triagem inválido" }, 400);
  try {
    const triage = updateFindingTriage(
      c.req.param("id"),
      c.req.param("findingId"),
      body.status,
      typeof body.note === "string" ? body.note : null,
    );
    return c.json({ triage });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Falha ao salvar triagem" }, 400);
  }
});

app.route("/", createScanStartApp({ startScan }));

app.post("/scans/:id/cancel", (c) => {
  const ok = cancelScan(c.req.param("id"));
  if (!ok) return c.json({ error: "Scan não está ativo" }, 404);
  return c.json({ ok: true });
});

app.get("/scans/:id/events", (c) => {
  const id = c.req.param("id");
  const requestedCursor = Number(c.req.query("after"));
  const afterCursor = Number.isFinite(requestedCursor) && requestedCursor >= 0
    ? Math.trunc(requestedCursor)
    : undefined;
  return streamSSE(c, async (stream) => {
    let closed = false;
    const unsubscribe = subscribe(id, async (event) => {
      if (closed) return;
      await stream.writeSSE({
        event: event.type,
        data: JSON.stringify(event),
      });
      if (event.type === "done" || event.type === "error") {
        closed = true;
        unsubscribe();
      }
    }, afterCursor);

    stream.onAbort(() => {
      closed = true;
      unsubscribe();
    });

    // Keep connection open while scan is active
    while (!closed) {
      await stream.sleep(1000);
      if (!isScanActive(id) && getRun(id)?.status !== "running") {
        // If not active anymore, end after a short grace
        await stream.sleep(500);
        closed = true;
        unsubscribe();
      }
    }
  });
});

app.post("/compare", async (c) => {
  const body = (await c.req.json()) as CompareRequest;
  try {
    for (const id of body.scanIds ?? []) readRunWithEngineRefresh(id);
    return c.json(compareScans(body.scanIds ?? []));
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "Falha na comparação" },
      400,
    );
  }
});

app.get("/fs/list", (c) => {
  try {
    return c.json(listDirectory(c.req.query("path") ?? undefined));
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "Falha ao listar" },
      400,
    );
  }
});

function findRepository(repositoryKey: string): GuardrailRepository | null {
  return listGuardrailRepositories().find(
    (repository) => repository.repositoryKey === repositoryKey,
  ) ?? null;
}

async function inspectRepository(
  repositoryPath: string,
  requestedDisplayName?: string,
): Promise<GuardrailRepository> {
  repositoryPath = assertRepositoryAccess(repositoryPath);
  const repositoryRoot = path.resolve(
    (await defaultGitRunner(["rev-parse", "--show-toplevel"], repositoryPath)).trim(),
  );
  assertRepositoryAccess(repositoryRoot);
  const remoteUrl = await optionalGit(["config", "--get", "remote.origin.url"], repositoryRoot);
  const remote = parseGitHubRemote(remoteUrl);
  const remoteHead = await optionalGit(
    ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
    repositoryRoot,
  );
  const currentBranch = await optionalGit(["branch", "--show-current"], repositoryRoot);
  const defaultBranch = remoteHead?.replace(/^origin\//, "") || currentBranch || "main";
  const displayName = requestedDisplayName?.trim() || path.basename(repositoryRoot);

  return {
    repositoryKey: remote
      ? `github.com/${remote.owner}/${remote.name}`
      : `local/${path.basename(repositoryRoot)}`,
    repositoryPath: repositoryRoot,
    source: "local",
    displayName,
    defaultBranch,
    defaultExecutor: "sentinel-managed",
    remoteOwner: remote?.owner ?? null,
    remoteName: remote?.name ?? null,
    githubConnectionId: null,
    githubInstallationId: null,
    githubRepositoryId: null,
    enabled: true,
    policyPath: ".csb/guardrails.json",
    lastGateId: null,
    githubStatus: remote ? "not_checked" : "not_configured",
  };
}

async function startGuardrailGate(
  request: StartGateRequest,
  acceptedPreview: AcceptedGateTargetPreview | null,
): Promise<GateRun> {
  const repository = findRepository(request.repositoryKey);
  if (!repository) throw new TargetPreviewError("target_preview_invalid");
  const executor = request.executor ?? repository.defaultExecutor;
  if (repository.source === "local") {
    if (
      executor !== "sentinel-managed"
      || request.target.kind !== "compare"
      || acceptedPreview !== null
    ) {
      throw new TargetPreviewError("target_preview_invalid");
    }
    return startLocalGate({
      repositoryKey: repository.repositoryKey,
      baseRef: request.target.baseRef,
      headRef: request.target.headRef,
      ...(request.scanSelection ? { scanSelection: await resolvedScanSelection(request.scanSelection, executor, resolveGuardrailScanSelection) } : {}),
    });
  }
  if (acceptedPreview === null) {
    throw new TargetPreviewError("target_preview_stale");
  }
  if (executor === "sentinel-managed") {
    return startRemoteManagedGate(acceptedPreview);
  }
  throw new TargetPreviewError("target_preview_executor_unavailable");
}

function localRepositoryPath(repository: GuardrailRepository): string {
  if (repository.source !== "local" || repository.repositoryPath === null) {
    throw new Error("A operação local exige uma pasta de repositório configurada");
  }
  return assertRepositoryAccess(repository.repositoryPath);
}

async function optionalGit(args: string[], cwd: string): Promise<string | null> {
  try {
    return (await defaultGitRunner(args, cwd)).trim() || null;
  } catch {
    return null;
  }
}

function parseGitHubRemote(
  remoteUrl: string | null,
): { owner: string; name: string } | null {
  if (!remoteUrl) return null;
  const match = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(remoteUrl);
  return match ? { owner: match[1]!, name: match[2]! } : null;
}

function repositoryKey(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function requiredPreviewIdentity(value: string | undefined): string {
  if (value === undefined) throw new TargetPreviewError("target_preview_stale");
  return value;
}

function requiredRemoteAuthority(value: string | null): string {
  if (value === null || !/^[A-Za-z0-9_.:-]+$/.test(value)) {
    throw new Error("github_repository_authority_invalid");
  }
  return value;
}

function requiredIdempotencyKey(value: string | undefined): string {
  const key = value?.trim() ?? "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{15,255}$/.test(key)) {
    throw new TargetPreviewError("target_preview_invalid");
  }
  return key;
}

function parseAutomationTriggers(value: unknown): GuardrailAutomationTriggers {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("automation_triggers_invalid");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["merge", "pullRequest", "push", "branches"].includes(key))) throw new Error("automation_triggers_invalid");
  if (typeof record.push !== "boolean" || typeof record.pullRequest !== "boolean" || typeof record.merge !== "boolean") {
    throw new Error("automation_triggers_invalid");
  }
  return { push: record.push, pullRequest: record.pullRequest, merge: record.merge, ...(record.branches === undefined ? {} : { branches: normalizeBranchFilters(record.branches) }) };
}

function targetPreviewStatus(error: unknown): 400 | 409 {
  return error instanceof TargetPreviewError
    && (
      error.code === "target_preview_stale"
      || error.code === "target_preview_executor_unavailable"
    )
    ? 409
    : 400;
}

function hasGitHubRemote(
  repository: GuardrailRepository,
): repository is GuardrailRepository & { remoteOwner: string; remoteName: string } {
  return repository.remoteOwner !== null && repository.remoteName !== null;
}

function simulateDecision(
  artifact: GateArtifact,
  policy: GuardrailPolicy,
  exceptions: GuardrailException[],
  now: string,
): GateDecision {
  const currentFindings = artifact.findings.filter(
    (finding) => finding.lifecycle !== "fixed",
  );
  const hasBaseline = artifact.baselineCommit !== null;
  const baselineFindings = hasBaseline
    ? artifact.findings.filter((finding) =>
        finding.lifecycle === "persistent" || finding.lifecycle === "fixed")
    : null;
  const historicalFindings = artifact.findings.filter(
    (finding) => finding.lifecycle === "reopened",
  );
  const triageByIdentity = new Map(
    artifact.findings.map((finding) => [finding.identity, finding.triage]),
  );
  const evaluation = evaluateGate({
    policy,
    branch: artifact.changeSet.headRef,
    changeSet: artifact.changeSet,
    currentFindings,
    baselineFindings,
    historicalFindings,
    triageByIdentity,
    exceptions,
    sourceScanId: artifact.scan.id ?? "policy-simulation",
    baselineScanId: hasBaseline ? "policy-simulation-baseline" : null,
    now,
  });
  return {
    ...evaluation.decision,
    decisionGraph: buildDecisionGraph(
      artifact.changeSet,
      evaluation.deltas as GateFindingDelta[],
      evaluation.decision,
    ),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Falha na operação";
}
