import { randomUUID } from "node:crypto";
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
  GateFindingDelta,
  GateRun,
  GuardrailException,
  GuardrailPolicy,
  GuardrailRepository,
  HealthResponse,
  StartScanRequest,
  UpdateFindingTriageRequest,
} from "@csb/shared";
import { purgeScanArtifacts } from "./activity.js";
import { compareScans } from "./compare.js";
import { getCodexInfo } from "./codex-info.js";
import { CODEX_SECURITY_STATE_DIR } from "./config.js";
import { getRun, hideRun, listRuns } from "./db.js";
import { listDirectory } from "./fs.js";
import {
  cancelGate,
  getGateArtifact,
  startLocalGate,
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
import { getGitHubStatus } from "./github-status.js";
import {
  installCallerWorkflow,
  type InstallCallerWorkflowOptions,
  type InstallCallerWorkflowResult,
} from "./github-workflow.js";
import {
  importExternalScans,
  readFindingsFile,
  toFindingSummaries,
} from "./ingest.js";
import { buildMetricsSummary } from "./metrics.js";
import { refreshOpenRouterPricing } from "./openrouter-pricing.js";
import { withProgress, withProgressMany } from "./progress.js";
import { buildRegressionSummary, markScanAsRepositoryBaseline, updateFindingTriage } from "./regression.js";
import { isRemovableScanStatus } from "./lifecycle.js";
import { MAX_CONCURRENT_SCANS } from "./config.js";
import { getScannerCatalog } from "./scanners/catalog.js";
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
    origin: ["http://127.0.0.1:5173", "http://localhost:5173"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type"],
  }),
);

export interface GuardrailsApiDependencies {
  listRepositories(): GuardrailRepository[];
  resolveRepository(repositoryPath: string, displayName?: string): Promise<GuardrailRepository>;
  upsertRepository(repository: GuardrailRepository): void;
  getRepository(repositoryKey: string): GuardrailRepository | null;
  readPolicy(repositoryPath: string): GuardrailPolicy;
  parsePolicy(value: unknown): GuardrailPolicy;
  writePolicy(repositoryPath: string, policy: GuardrailPolicy): void;
  readExceptions(repositoryPath: string): GuardrailException[];
  listGates(repositoryKey?: string | null): GateRun[];
  getGate(gateId: string): GateRun | null;
  getArtifact(gateId: string): GateArtifact | null;
  startGate(request: { repositoryKey: string; baseRef: string; headRef: string }): Promise<GateRun>;
  cancelGate(gateId: string): boolean;
  subscribeGate(gateId: string, listener: (event: GateEvent) => void): () => void;
  getGitHubStatus(repositoryPath: string): ReturnType<typeof getGitHubStatus>;
  installWorkflow(
    repositoryPath: string,
    options: InstallCallerWorkflowOptions,
  ): Promise<InstallCallerWorkflowResult>;
  syncBaseline(repository: GuardrailRepository): Promise<GateArtifact | null>;
  publishCheck(input: PublishGateCheckInput): Promise<void>;
  updateGate(gateId: string, updates: GateRunUpdate): void;
  recordPublicationAttempt(attempt: GatePublicationAttempt): void;
  listPublicationAttempts(gateId: string): GatePublicationAttempt[];
}

const githubBaselineProvider = new GitHubBaselineProvider();

const guardrailsDependencies: GuardrailsApiDependencies = {
  listRepositories: listGuardrailRepositories,
  resolveRepository: inspectRepository,
  upsertRepository: upsertGuardrailRepository,
  getRepository: findRepository,
  readPolicy: readGuardrailPolicy,
  parsePolicy: parseGuardrailPolicy,
  writePolicy: writeGuardrailPolicy,
  readExceptions: readGuardrailExceptions,
  listGates: listGateRuns,
  getGate: getGateRun,
  getArtifact: getGateArtifact,
  startGate: startLocalGate,
  cancelGate,
  subscribeGate,
  getGitHubStatus,
  installWorkflow: installCallerWorkflow,
  syncBaseline: (repository) => githubBaselineProvider.getBaseline({
    repositoryKey: repository.repositoryKey,
    owner: repository.remoteOwner!,
    name: repository.remoteName!,
    defaultBranch: repository.defaultBranch,
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
      const body = await c.req.json<{ repositoryPath?: string; displayName?: string }>();
      if (typeof body.repositoryPath !== "string" || !body.repositoryPath.trim()) {
        return c.json({ error: "Caminho do repositório é obrigatório" }, 400);
      }
      const repository = await deps.resolveRepository(body.repositoryPath, body.displayName);
      deps.upsertRepository(repository);
      return c.json({ repository }, 201);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  guardrails.get("/guardrails/repositories/:repositoryKey/policy", (c) => {
    const repository = deps.getRepository(repositoryKey(c.req.param("repositoryKey")));
    if (!repository) return c.json({ error: "Repositório não encontrado" }, 404);
    try {
      return c.json({ policy: deps.readPolicy(repository.repositoryPath) });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  guardrails.put("/guardrails/repositories/:repositoryKey/policy", async (c) => {
    const repository = deps.getRepository(repositoryKey(c.req.param("repositoryKey")));
    if (!repository) return c.json({ error: "Repositório não encontrado" }, 404);
    try {
      const policy = deps.parsePolicy(await c.req.json());
      deps.writePolicy(repository.repositoryPath, policy);
      return c.json({ policy });
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
      const exceptions = deps.readExceptions(repository.repositoryPath);
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
    const status = await deps.getGitHubStatus(repository.repositoryPath);
    return c.json({ status });
  });

  guardrails.post("/guardrails/repositories/:repositoryKey/install-workflow", async (c) => {
    const repository = deps.getRepository(repositoryKey(c.req.param("repositoryKey")));
    if (!repository) return c.json({ error: "Repositório não encontrado" }, 404);
    if (!hasGitHubRemote(repository)) {
      return c.json({ error: "Repositório não possui remoto GitHub" }, 400);
    }
    try {
      const workflow = await deps.installWorkflow(repository.repositoryPath, {
        defaultBranch: repository.defaultBranch,
        secretName: "OPENAI_API_KEY",
      });
      return c.json({ workflow }, 201);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 502);
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
      const body = await c.req.json<{
        repositoryKey?: string;
        baseRef?: string;
        headRef?: string;
      }>();
      if (!body.repositoryKey || !body.baseRef || !body.headRef) {
        return c.json({ error: "repositoryKey, baseRef e headRef são obrigatórios" }, 400);
      }
      const gate = await deps.startGate({
        repositoryKey: body.repositoryKey,
        baseRef: body.baseRef,
        headRef: body.headRef,
      });
      return c.json({ gate }, 202);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
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

  guardrails.post("/guardrails/gates/:gateId/publish", async (c) => {
    const gateId = c.req.param("gateId");
    const gate = deps.getGate(gateId);
    if (!gate) return c.json({ error: "Gate não encontrado" }, 404);
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
  return c.json(buildMetricsSummary());
});

app.get("/scans", async (c) => {
  await refreshOpenRouterPricing();
  return c.json({ scans: withProgressMany(listRuns()) });
});

app.delete("/scans/:id", (c) => {
  const id = c.req.param("id");
  const run = getRun(id);
  if (!run) return c.json({ error: "Scan não encontrado" }, 404);
  if (isScanActive(id) || !isRemovableScanStatus(run.status)) {
    return c.json(
      { error: "Somente scans falhos ou cancelados podem ser excluídos." },
      409,
    );
  }
  try {
    purgeScanArtifacts(run.scanDir);
    hideRun(id);
    return c.json({ ok: true, artifactsDeleted: true });
  } catch (error) {
    return c.json({ error: errorMessage(error) }, 409);
  }
});

app.get("/scans/:id", async (c) => {
  await refreshOpenRouterPricing();
  const run = getRun(c.req.param("id"));
  if (!run) return c.json({ error: "Scan não encontrado" }, 404);
  const findings = toFindingSummaries(readFindingsFile(run.scanDir));
  return c.json({ scan: withProgress(run), findings });
});

app.get("/scans/:id/report", async (c) => {
  await refreshOpenRouterPricing();
  const run = getRun(c.req.param("id"));
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

app.post("/scans", async (c) => {
  const body = (await c.req.json()) as StartScanRequest;
  try {
    const scan = await startScan(body);
    return c.json({ scan }, 201);
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "Falha ao iniciar scan" },
      400,
    );
  }
});

app.post("/scans/:id/cancel", (c) => {
  const ok = cancelScan(c.req.param("id"));
  if (!ok) return c.json({ error: "Scan não está ativo" }, 404);
  return c.json({ ok: true });
});

app.get("/scans/:id/events", (c) => {
  const id = c.req.param("id");
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
    });

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
  const repositoryRoot = path.resolve(
    (await defaultGitRunner(["rev-parse", "--show-toplevel"], repositoryPath)).trim(),
  );
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
    displayName,
    defaultBranch,
    remoteOwner: remote?.owner ?? null,
    remoteName: remote?.name ?? null,
    enabled: true,
    policyPath: ".csb/guardrails.json",
    lastGateId: null,
    githubStatus: remote ? "not_checked" : "not_configured",
  };
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
