import { useCallback, useEffect, useState, type ReactNode } from "react";
import type {
  DecisionGraphNode,
  GateArtifact,
  GateRun,
  GuardrailRepository,
} from "@csb/shared";
import { ArrowRight, GitBranch, HardDrive, Plus, ShieldAlert, ShieldCheck, Square, Workflow } from "lucide-react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { api, type EnrollGuardrailRepositoryRequest, type GuardrailActionsStatus } from "../api";
import {
  DecisionGraph,
  DeleteGateButton,
  EvidenceTrace,
  GateOutcomeBadge,
  GuardrailPreflightSheet,
  GuardrailScanMonitor,
  PortfolioPipeline,
  PublishGateControl,
  RepositoryEnrollmentForm,
} from "../components/guardrails";
import { AlertBanner, EmptyState, Loading, PageHeader, cx } from "../components/ui";
import { guardrailHref, isGateActive, selectGuardrailFindingNode, selectGate } from "../lib/guardrails";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { formatUsd } from "../format";
import { useI18n } from "../i18n";

type GuardrailsState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      repositories: GuardrailRepository[];
      gates: GateRun[];
      selectedGate: GateRun | null;
      artifact: GateArtifact | null;
      readiness: Record<string, RepositoryReadiness>;
    };

type RepositoryReadiness = {
  authorityReady: boolean;
  baselineReady: boolean;
  executorReady: boolean;
  executorCode: GuardrailActionsStatus["code"] | "managed" | "unavailable";
};

export function GuardrailsPage() {
  const { t, locale } = useI18n();
  const { gateId = null } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const [state, setState] = useState<GuardrailsState>({ status: "loading" });
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [runOpen, setRunOpen] = useState(false);
  const [runRepositoryKey, setRunRepositoryKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState({ status: "loading" });
    try {
      const [gateList, repositoryList, selectedResponse] = await Promise.all([
        api.listGates(),
        api.listGuardrailRepositories(),
        gateId ? api.getGate(gateId) : Promise.resolve(null),
      ]);
      const readinessEntries = await Promise.all(repositoryList.repositories.map(async (repository) => {
        if (repository.source === "local") {
          return [repository.repositoryKey, {
            authorityReady: true,
            baselineReady: true,
            executorReady: true,
            executorCode: "managed",
          } satisfies RepositoryReadiness] as const;
        }
        try {
          const [github, actions] = await Promise.all([
            api.getGuardrailGitHubStatus(repository.repositoryKey),
            api.getGuardrailActionsStatus(repository.repositoryKey),
          ]);
          const authorityReady = github.status.remote.ready && github.status.auth.ready && github.status.permissions.ready;
          return [repository.repositoryKey, {
            authorityReady,
            baselineReady: github.status.baseline.ready,
            executorReady: authorityReady || actions.status.ready,
            executorCode: repository.defaultExecutor === "sentinel-managed" ? "managed" : actions.status.code,
          } satisfies RepositoryReadiness] as const;
        } catch {
          return [repository.repositoryKey, {
            authorityReady: false,
            baselineReady: false,
            executorReady: false,
            executorCode: "unavailable",
          } satisfies RepositoryReadiness] as const;
        }
      }));
      const selected = selectedResponse?.gate ?? (gateId ? selectGate(gateList.gates, gateId) : null);
      const detail = selectedResponse ?? (selected ? await api.getGate(selected.id) : null);
      setState({
        status: "ready",
        repositories: repositoryList.repositories,
        gates: detail
          ? gateList.gates.map((gate) => gate.id === detail.gate.id ? detail.gate : gate)
          : gateList.gates,
        selectedGate: detail?.gate ?? selected,
        artifact: detail?.artifact ?? null,
        readiness: Object.fromEntries(readinessEntries),
      });
    } catch (error) {
      setState({
        status: "error",
        message: error instanceof Error ? error.message : "Falha ao carregar Guardrails",
      });
    }
  }, [gateId]);

  const refreshGate = useCallback((selectedId: string) => {
    void api.getGate(selectedId).then((response) => {
      setState((current) => {
        if (current.status !== "ready" || current.selectedGate?.id !== selectedId) return current;
        return {
          ...current,
          gates: current.gates.map((gate) => gate.id === selectedId ? response.gate : gate),
          selectedGate: response.gate,
          artifact: response.artifact,
        };
      });
    }).catch((error) => {
      setActionError(error instanceof Error ? error.message : "Falha ao atualizar gate");
    });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (state.status !== "ready" || !state.selectedGate || !isGateActive(state.selectedGate.status)) return;
    const selectedId = state.selectedGate.id;
    const source = new EventSource(api.gateEventsUrl(selectedId));
    const refreshSelected = () => refreshGate(selectedId);
    for (const name of ["status", "scan", "decision", "done", "error"] as const) {
      source.addEventListener(name, refreshSelected);
    }
    // Gate SSE is the fast path. Polling is the reconciliation path when the
    // terminal event races the browser subscription or a laptop sleeps.
    const poll = window.setInterval(refreshSelected, 3_500);
    return () => {
      source.close();
      window.clearInterval(poll);
    };
  }, [refreshGate, state.status, state.status === "ready" ? state.selectedGate?.id : null, state.status === "ready" ? state.selectedGate?.status : null]);

  if (state.status === "loading") return <Loading />;
  if (state.status === "error") {
    return (
      <div>
        <AlertBanner>{state.message}</AlertBanner>
        <Button variant="outline" className="min-h-11" onClick={() => void load()}>{t("guardrails.retry")}</Button>
      </div>
    );
  }
  const readyState = state;

  const selectedNode = readyState.artifact
    ? selectGuardrailFindingNode(readyState.artifact, params.get("node"))
    : null;

  function selectLane(gate: GateRun) {
    const nodeId = gate.id === readyState.selectedGate?.id ? selectedNode?.id : null;
    navigate(guardrailHref(gate.id, nodeId));
  }

  function selectNode(node: DecisionGraphNode) {
    const next = new URLSearchParams(params);
    next.set("node", node.id);
    setParams(next, { replace: true });
  }

  async function enroll(request: EnrollGuardrailRepositoryRequest) {
    setBusy(true);
    setActionError(null);
    try {
      await api.enrollGuardrailRepository(request);
      setEnrollOpen(false);
      await load();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Falha ao cadastrar repositório");
    } finally {
      setBusy(false);
    }
  }

  async function cancelSelected() {
    const selectedGateId = readyState.selectedGate?.id;
    if (!selectedGateId) return;
    setBusy(true);
    setActionError(null);
    try {
      await api.cancelGate(selectedGateId);
      await load();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Falha ao cancelar gate");
    } finally {
      setBusy(false);
    }
  }

  function updateSelectedGate(gate: GateRun) {
    setState((current) => {
      if (current.status !== "ready" || current.selectedGate?.id !== gate.id) return current;
      return {
        ...current,
        gates: current.gates.map((item) => item.id === gate.id ? gate : item),
        selectedGate: gate,
      };
    });
  }

  function handleGateDeleted(deletedGateId: string) {
    setState((current) => {
      if (current.status !== "ready") return current;
      return {
        ...current,
        gates: current.gates.filter((gate) => gate.id !== deletedGateId),
        selectedGate: current.selectedGate?.id === deletedGateId ? null : current.selectedGate,
        artifact: current.selectedGate?.id === deletedGateId ? null : current.artifact,
      };
    });
    navigate("/guardrails", { replace: true });
  }

  const selectedGateActive = readyState.selectedGate ? isGateActive(readyState.selectedGate.status) : false;
  const setupRepositoryKey = readyState.selectedGate?.repositoryKey ?? null;

  return (
    <div className="min-w-0">
      <PageHeader
        code="03 / GUARDRAILS"
        title={gateId ? t("guardrails.title") : t("guardrails.projectsTitle")}
        description={gateId ? t("guardrails.description") : t("guardrails.projectsDescription")}
        actions={(
          <>
            {gateId && <Button asChild variant="outline" className="min-h-11"><Link to="/guardrails"><ArrowRight aria-hidden size={14} className="rotate-180" />{t("guardrails.backProjects")}</Link></Button>}
            <Button asChild variant="outline" className="min-h-11">
              <Link to={setupRepositoryKey ? `/guardrails/setup?repository=${encodeURIComponent(setupRepositoryKey)}` : "/guardrails/setup"}><GitBranch aria-hidden size={14} />{t("guardrails.setup")}</Link>
            </Button>
            {gateId && <Button className="min-h-11" disabled={!setupRepositoryKey || selectedGateActive} onClick={() => { setRunRepositoryKey(setupRepositoryKey); setRunOpen(true); }}><ArrowRight aria-hidden size={14} />{t("guardrails.scanNow")}</Button>}
            {selectedGateActive && (
              <Button variant="destructive" className="min-h-11" onClick={() => void cancelSelected()} disabled={busy}>
                <Square aria-hidden size={13} />{t("guardrails.cancel")}
              </Button>
            )}
            {readyState.selectedGate && !selectedGateActive && (
              <DeleteGateButton gate={readyState.selectedGate} onDeleted={() => handleGateDeleted(readyState.selectedGate!.id)} />
            )}
            <EnrollmentSheet open={enrollOpen} onOpenChange={setEnrollOpen} busy={busy} onEnroll={enroll} />
            <GuardrailPreflightSheet
              repositories={readyState.repositories}
              initialRepositoryKey={runRepositoryKey ?? undefined}
              open={runOpen}
              onOpenChange={setRunOpen}
              onError={setActionError}
              onStarted={(gate) => navigate(guardrailHref(gate.id))}
            />
          </>
        )}
      />

      {actionError && <AlertBanner>{actionError}</AlertBanner>}

      {readyState.selectedGate ? (
        <PortfolioPipeline
          repositories={readyState.repositories}
          gates={readyState.gates}
          selectedGateId={readyState.selectedGate?.id ?? null}
          selectedArtifact={readyState.artifact}
          onSelect={selectLane}
        />
      ) : (
        <GuardrailLaunchpad
          repositories={readyState.repositories}
          readiness={readyState.readiness}
          gates={readyState.gates}
          onRun={(repositoryKey) => { setRunRepositoryKey(repositoryKey); setRunOpen(true); }}
          onOpenGate={(gate) => navigate(guardrailHref(gate.id))}
        />
      )}

      {readyState.selectedGate && readyState.selectedGate.error && (
        <div className="mt-4"><AlertBanner>{gateFailureMessage(readyState.selectedGate.error, t)}</AlertBanner></div>
      )}
      {readyState.selectedGate?.outcome === "bootstrap" && (
        <div className="mt-4"><AlertBanner tone="warning">Baseline ausente. Execute o gate na branch principal para estabelecer a referência; este resultado não é uma aprovação.</AlertBanner></div>
      )}
      {readyState.selectedGate?.outcome === "no_changes" && (
        <div className="mt-4"><AlertBanner tone="success">Nenhuma mudança entre as referências. O gate encerrou sem iniciar scan e sem consumir custo.</AlertBanner></div>
      )}

      {readyState.selectedGate?.status === "completed" && readyState.artifact && (
        <div className="mt-4">
          <PublishGateControl gate={readyState.selectedGate} artifact={readyState.artifact} onGateChange={updateSelectedGate} />
        </div>
      )}

      {readyState.selectedGate?.executor === "sentinel-managed" && readyState.selectedGate.scanId && (
        <GuardrailScanMonitor gate={readyState.selectedGate} onScanTerminal={() => refreshGate(readyState.selectedGate!.id)} />
      )}

      {readyState.selectedGate && (readyState.selectedGate.executor !== "sentinel-managed" || !readyState.selectedGate.scanId) && !readyState.artifact && (
        <section className="bench-panel mt-4">
          <EmptyState
            title={selectedGateActive ? t("guardrails.scanStartingTitle") : "Artifact indisponível"}
            description={selectedGateActive
              ? t("guardrails.scanStartingDescription")
              : "Este gate não produziu evidência causal para inspecionar."}
          />
        </section>
      )}

      {readyState.artifact && selectedNode && (
        <div className="mt-4 grid min-w-0 gap-4">
          <DecisionGraph
            artifact={readyState.artifact}
            selectedNodeId={selectedNode.id}
            onSelect={selectNode}
          />
          <EvidenceTrace artifact={readyState.artifact} node={selectedNode} />
        </div>
      )}
    </div>
  );
}

function gateFailureMessage(code: string, t: ReturnType<typeof useI18n>["t"]): string {
  if (code === "snapshot_materialization_failed") {
    return t("guardrails.snapshotDownloadFailed");
  }
  if (code === "snapshot_archive_invalid") {
    return t("guardrails.snapshotArchiveInvalid");
  }
  if (code === "snapshot_limit_exceeded") {
    return t("guardrails.snapshotLimitExceeded");
  }
  return code;
}

function GuardrailLaunchpad({
  repositories,
  readiness,
  gates,
  onRun,
  onOpenGate,
}: {
  repositories: readonly GuardrailRepository[];
  readiness: Readonly<Record<string, RepositoryReadiness>>;
  gates: readonly GateRun[];
  onRun: (repositoryKey: string) => void;
  onOpenGate: (gate: GateRun) => void;
}) {
  const { t, locale } = useI18n();
  const [selectedKey, setSelectedKey] = useState(repositories[0]?.repositoryKey ?? "");
  const repository = repositories.find((item) => item.repositoryKey === selectedKey) ?? repositories[0] ?? null;
  const repoReadiness = repository ? readiness[repository.repositoryKey] : null;
  const readyCount = repositories.filter((item) => readiness[item.repositoryKey]?.executorReady).length;
  const blockedCount = repositories.length - readyCount;
  const setupHref = repository ? `/guardrails/setup?repository=${encodeURIComponent(repository.repositoryKey)}` : "/guardrails/setup";
  const actionsBlocked = repository?.defaultExecutor === "github-actions" && repoReadiness?.executorReady !== true;
  const defaultActionsBlocked = repository?.defaultExecutor === "github-actions"
    && repoReadiness?.authorityReady === true
    && repoReadiness.executorCode !== "ready";
  const scanReady = repoReadiness?.executorReady === true;
  const repositoryGates = repository
    ? [...gates]
      .filter((gate) => gate.repositoryKey === repository.repositoryKey)
      .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))
    : [];
  const completedDecisions = repositoryGates.filter((gate) => gate.outcome !== null).length;
  const observedCosts = repositoryGates.filter((gate) => gate.estimatedUsd > 0);
  const observedCost = observedCosts.reduce((sum, gate) => sum + gate.estimatedUsd, 0);
  const lastActivity = repositoryGates[0]?.startedAt ?? null;
  const outcomeData = buildProjectOutcomeData(repositoryGates, t);
  const costData = repositoryGates.slice(0, 8).reverse().map((gate, index) => ({
    gate: gate.pullRequestNumber ? `PR #${gate.pullRequestNumber}` : gate.headRef,
    label: `G${index + 1}`,
    cost: gate.estimatedUsd > 0 ? gate.estimatedUsd : null,
    color: gateOutcomeColor(gate),
  }));
  const statusLabel = defaultActionsBlocked
    ? t("guardrails.managedFallbackReady")
    : actionsBlocked && repoReadiness
    ? repoReadiness.executorCode === "unavailable"
      ? t("guardrails.capabilitiesLoadError")
      : repoReadiness.executorCode === "managed"
        ? t("guardrails.managedReadyDetail")
      : t(`guardrails.actionsStatus.${repoReadiness.executorCode}`)
    : repository ? t("guardrails.readyToProtect") : t("guardrails.authorityRequired");
  return (
    <section className="bench-panel bench-corners min-w-0 overflow-hidden" aria-labelledby="guardrail-launchpad-title">
      <div className="grid border-b sm:grid-cols-4">
        <CockpitMetric label={t("guardrails.portfolioRepositories")} value={repositories.length} />
        <CockpitMetric label={t("guardrails.portfolioClear")} value={readyCount} tone="ready" />
        <CockpitMetric label={t("guardrails.portfolioBlocked")} value={blockedCount} tone={blockedCount > 0 ? "blocked" : "muted"} />
        <CockpitMetric label={t("guardrails.portfolioRuns")} value={gates.length} />
      </div>

      <div className="grid xl:grid-cols-[19rem_minmax(0,1fr)]">
        <aside className="min-w-0 border-b bg-secondary/[.08] xl:border-b-0 xl:border-r" aria-label={t("guardrails.portfolioRepositories")}>
          <div className="border-b px-4 py-4"><div className="bench-label text-primary">REPOSITORY CONTROL</div><p className="mt-2 text-xs leading-5 text-muted-foreground">{t("guardrails.pipelineSubtitle")}</p></div>
          <div className="grid">
            {repositories.map((item) => {
              const itemReady = readiness[item.repositoryKey]?.executorReady === true;
              const active = item.repositoryKey === repository?.repositoryKey;
              return (
                <button key={item.repositoryKey} type="button" onClick={() => setSelectedKey(item.repositoryKey)} className={cx("grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b px-4 py-4 text-left transition-colors", active ? "bg-primary/[.07] shadow-[inset_2px_0_var(--primary)]" : "hover:bg-secondary/40")}>
                  <span className={cx("grid size-9 place-items-center border", itemReady ? "border-chart-2/50 text-chart-2" : "border-destructive/50 text-destructive")}>{item.source === "github" ? <GitBranch aria-hidden size={15} /> : <HardDrive aria-hidden size={15} />}</span>
                  <span className="min-w-0"><strong className="block truncate text-xs">{item.displayName}</strong><span className="mt-1 block truncate font-mono text-[8px] uppercase tracking-[.08em] text-muted-foreground">{item.defaultExecutor} · {item.defaultBranch}</span></span>
                  <span className={cx("size-2", itemReady ? "bg-chart-2" : "bg-destructive")} aria-label={itemReady ? t("guardrails.authorized") : t("guardrails.actionRequired")} />
                </button>
              );
            })}
          </div>
        </aside>

        <div className="min-w-0">
          {repository ? (
            <>
              <div className="grid gap-5 border-b px-5 py-6 md:grid-cols-[minmax(0,1fr)_auto] md:items-start md:px-7">
                <div className="min-w-0">
                  <div className={cx("flex items-center gap-2 bench-label", scanReady ? "text-chart-2" : "text-destructive")}>{scanReady ? <ShieldCheck aria-hidden size={15} /> : <ShieldAlert aria-hidden size={15} />}{scanReady ? t("guardrails.readyToProtect") : t("guardrails.actionRequired")}</div>
                  <h2 id="guardrail-launchpad-title" className="mt-3 break-words font-heading text-2xl font-semibold tracking-[-.035em] sm:text-3xl">{repository.displayName}</h2>
                  <p className="mt-2 font-mono text-[9px] uppercase tracking-[.08em] text-muted-foreground">{repository.source} · {repository.defaultExecutor} · {repository.defaultBranch}</p>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <ProjectReadinessPill label={t("guardrails.projectAuthority")} value={repository.source === "github" ? "GITHUB APP" : "LOCAL ROOT"} ready={repoReadiness?.authorityReady === true} />
                    <ProjectReadinessPill label={t("guardrails.projectBaseline")} value={repoReadiness?.baselineReady ? t("guardrails.authorized") : t("guardrails.actionRequired")} ready={repoReadiness?.baselineReady === true} />
                    <ProjectReadinessPill label={t("guardrails.projectExecution")} value={defaultActionsBlocked ? "SENTINEL MANAGED" : repository.defaultExecutor} ready={scanReady} />
                  </div>
                  <p className={cx("mt-4 max-w-3xl border-l-2 pl-3 text-sm leading-6", scanReady ? "border-chart-2 text-muted-foreground" : "border-destructive text-destructive")}>{statusLabel}</p>
                </div>
                <div className="grid gap-2 sm:grid-cols-2 md:min-w-48 md:grid-cols-1">
                  <Button asChild variant={actionsBlocked ? "default" : "outline"} className="min-h-11"><Link to={setupHref}><Workflow aria-hidden size={14} />{t("guardrails.setup")}</Link></Button>
                  <Button variant="default" className="min-h-11" disabled={!scanReady} onClick={() => onRun(repository.repositoryKey)}><ArrowRight aria-hidden size={14} />{t("guardrails.scanNow")}</Button>
                </div>
              </div>

              <div className="grid border-b sm:grid-cols-2 xl:grid-cols-4">
                <ProjectMetric label={t("guardrails.projectRuns")} value={String(repositoryGates.length)} detail={`${repositoryGates.filter((gate) => isGateActive(gate.status)).length} ${t("guardrails.portfolioActive").toLowerCase()}`} />
                <ProjectMetric label={t("guardrails.projectDecisions")} value={String(completedDecisions)} detail={`${repositoryGates.filter((gate) => gate.outcome === "blocked" || gate.outcome === "error").length} ${t("guardrails.portfolioBlocked").toLowerCase()}`} tone={repositoryGates.some((gate) => gate.outcome === "blocked" || gate.outcome === "error") ? "danger" : "default"} />
                <ProjectMetric label={t("guardrails.projectObservedCost")} value={observedCosts.length > 0 ? formatUsd(observedCost) : "—"} detail={observedCosts.length > 0 ? `${observedCosts.length} ${t("guardrails.projectPricedRuns")}` : t("guardrails.projectCostUnavailable")} tone="primary" />
                <ProjectMetric label={t("guardrails.projectLastActivity")} value={lastActivity ? formatProjectDate(lastActivity, locale) : "—"} detail={lastActivity ? formatProjectTime(lastActivity, locale) : t("guardrails.projectNoGates")} />
              </div>

              <div className="grid min-w-0 border-b xl:grid-cols-2">
                <ProjectChart title={t("guardrails.projectOutcomes")} description={t("guardrails.projectOutcomeDescription")}>
                  {repositoryGates.length > 0 ? <ResponsiveContainer width="100%" height="100%"><BarChart data={outcomeData} layout="vertical" margin={{ top: 4, right: 18, bottom: 4, left: 8 }}>
                    <CartesianGrid horizontal={false} strokeDasharray="2 5" />
                    <XAxis type="number" domain={[0, "dataMax"]} allowDecimals={false} axisLine={false} tickLine={false} />
                    <YAxis type="category" dataKey="label" axisLine={false} tickLine={false} width={88} tick={{ fontSize: 9, fontFamily: "var(--font-mono)" }} />
                    <Tooltip cursor={{ fill: "var(--accent)", fillOpacity: 0.35 }} contentStyle={{ background: "var(--popover)", border: "1px solid var(--border)", borderRadius: 0, fontSize: 11 }} />
                    <Bar dataKey="count" name={t("guardrails.projectRuns")} radius={0}>{outcomeData.map((entry) => <Cell key={entry.key} fill={entry.color} />)}</Bar>
                  </BarChart></ResponsiveContainer> : <ProjectChartEmpty title={t("guardrails.projectNoGates")} detail={t("guardrails.projectNoGatesDescription")} />}
                </ProjectChart>
                <ProjectChart title={t("guardrails.projectCostHistory")} description={t("guardrails.projectCostDescription")} className="border-t xl:border-l xl:border-t-0">
                  {observedCosts.length > 0 ? <ResponsiveContainer width="100%" height="100%"><BarChart data={costData} margin={{ top: 8, right: 10, bottom: 4, left: 2 }}>
                    <CartesianGrid vertical={false} strokeDasharray="2 5" />
                    <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fontSize: 9, fontFamily: "var(--font-mono)" }} />
                    <YAxis axisLine={false} tickLine={false} width={46} tickFormatter={(value) => `$${Number(value).toFixed(1)}`} tick={{ fontSize: 9, fontFamily: "var(--font-mono)" }} />
                    <Tooltip cursor={{ fill: "var(--accent)", fillOpacity: 0.35 }} formatter={(value) => formatUsd(typeof value === "number" ? value : null)} labelFormatter={(_, payload) => payload?.[0]?.payload?.gate ?? "Gate"} contentStyle={{ background: "var(--popover)", border: "1px solid var(--border)", borderRadius: 0, fontSize: 11 }} />
                    <Bar dataKey="cost" name={t("guardrails.projectObservedCost")} radius={0}>{costData.map((entry) => <Cell key={`${entry.label}-${entry.gate}`} fill={entry.color} />)}</Bar>
                  </BarChart></ResponsiveContainer> : <ProjectChartEmpty title={t("guardrails.projectCostUnavailable")} detail={t("guardrails.projectNoTrend")} />}
                </ProjectChart>
              </div>

              <div className="min-w-0 p-5 md:p-7">
                <div className="flex flex-wrap items-end justify-between gap-3"><div><div className="bench-label text-primary">{t("guardrails.projectRecentHistory")}</div><h3 className="mt-2 font-heading text-lg font-semibold">{repository.displayName}</h3></div><span className="font-mono text-[9px] uppercase text-muted-foreground">{repositoryGates.length} {t("guardrails.portfolioRuns")}</span></div>
                {repositoryGates.length > 0 ? <div className="mt-4 overflow-x-auto border"><table className="w-full min-w-[48rem] border-collapse text-left"><thead><tr className="border-b bg-secondary/20 font-mono text-[8px] uppercase tracking-[.08em] text-muted-foreground"><th className="px-3 py-3">{t("guardrails.projectResult")}</th><th className="px-3 py-3">{t("guardrails.projectTarget")}</th><th className="px-3 py-3">{t("guardrails.projectExecutor")}</th><th className="px-3 py-3">{t("guardrails.projectObservedCost")}</th><th className="px-3 py-3">{t("guardrails.projectStarted")}</th><th className="px-3 py-3 text-right">{t("guardrails.openGate")}</th></tr></thead><tbody>{repositoryGates.slice(0, 8).map((gate) => <tr key={gate.id} className="border-b last:border-b-0 hover:bg-primary/[.03]"><td className="px-3 py-3"><GateOutcomeBadge outcome={gate.outcome} status={gate.status} /></td><td className="max-w-64 px-3 py-3"><strong className="block truncate text-xs">{gate.pullRequestNumber ? `PR #${gate.pullRequestNumber}` : gate.headRef}</strong><span className="mt-1 block truncate font-mono text-[8px] text-muted-foreground">{gate.headRef}</span></td><td className="px-3 py-3 font-mono text-[9px]">{gate.executor}</td><td className="px-3 py-3 font-mono text-[10px] text-primary">{gate.estimatedUsd > 0 ? formatUsd(gate.estimatedUsd) : "—"}</td><td className="px-3 py-3 font-mono text-[9px] text-muted-foreground">{formatProjectDate(gate.startedAt, locale)} · {formatProjectTime(gate.startedAt, locale)}</td><td className="px-3 py-3 text-right"><button type="button" onClick={() => onOpenGate(gate)} className="inline-flex items-center gap-2 font-mono text-[9px] uppercase text-primary hover:text-primary/70">{t("guardrails.openGate")}<ArrowRight aria-hidden size={13} /></button></td></tr>)}</tbody></table></div> : <div className="mt-4 border border-dashed px-4 py-8"><ProjectChartEmpty title={t("guardrails.projectNoGates")} detail={scanReady ? t("guardrails.emptyDescription") : statusLabel} /></div>}
              </div>
            </>
          ) : (
            <div className="p-8"><EmptyState title={t("guardrails.noRepository")} description={t("guardrails.noRepositoryDescription")} /></div>
          )}
        </div>
      </div>
    </section>
  );
}

function CockpitMetric({ label, value, tone = "muted" }: { label: string; value: number; tone?: "ready" | "blocked" | "muted" }) {
  return <div className="min-w-0 border-b px-4 py-4 last:border-b-0 sm:border-b-0 sm:border-r sm:last:border-r-0"><div className="bench-label">{label}</div><div className={cx("mt-2 font-mono text-xl font-semibold", tone === "ready" && "text-chart-2", tone === "blocked" && "text-destructive")}>{String(value).padStart(2, "0")}</div></div>;
}

function ProjectReadinessPill({ label, value, ready }: { label: string; value: string; ready: boolean }) { return <span className={cx("inline-flex min-w-0 items-center gap-2 border px-2.5 py-2 font-mono text-[8px] uppercase tracking-[.06em]", ready ? "border-chart-2/40 text-chart-2" : "border-destructive/40 text-destructive")}><span className={cx("size-1.5 shrink-0", ready ? "bg-chart-2" : "bg-destructive")} /><span className="text-muted-foreground">{label}</span><strong className="truncate font-medium text-current">{value}</strong></span>; }

function ProjectMetric({ label, value, detail, tone = "default" }: { label: string; value: string; detail: string; tone?: "default" | "primary" | "danger" }) { return <div className="min-w-0 border-b px-5 py-5 last:border-b-0 sm:border-r sm:[&:nth-child(2)]:border-r-0 xl:border-b-0 xl:[&:nth-child(2)]:border-r xl:last:border-r-0"><div className="bench-label">{label}</div><div className={cx("mt-2 break-words font-mono text-xl font-semibold tracking-[-.03em]", tone === "primary" && "text-primary", tone === "danger" && "text-destructive")}>{value}</div><div className="mt-1 truncate font-mono text-[8px] uppercase text-muted-foreground">{detail}</div></div>; }

function ProjectChart({ title, description, children, className }: { title: string; description: string; children: ReactNode; className?: string }) { return <section className={cx("min-w-0 p-5 md:p-7", className)}><div className="bench-label text-primary">{title}</div><p className="mt-2 min-h-10 max-w-xl text-xs leading-5 text-muted-foreground">{description}</p><div className="mt-4 h-52 min-w-0">{children}</div></section>; }
function ProjectChartEmpty({ title, detail }: { title: string; detail: string }) { return <div className="grid h-full place-content-center border border-dashed px-5 text-center"><strong className="text-sm">{title}</strong><p className="mt-2 max-w-sm text-xs leading-5 text-muted-foreground">{detail}</p></div>; }

function gateOutcomeColor(gate: GateRun): string { if (isGateActive(gate.status)) return "var(--primary)"; if (gate.status === "cancelled") return "var(--muted-foreground)"; if (gate.status === "error" || gate.outcome === "error" || gate.outcome === "blocked") return "var(--destructive)"; if (gate.outcome === "warning" || gate.outcome === "bootstrap") return "var(--chart-3)"; return "var(--chart-2)"; }
function buildProjectOutcomeData(gates: readonly GateRun[], t: ReturnType<typeof useI18n>["t"]) { const buckets = [
  { key: "pass", label: t("guardrails.projectOutcomePass"), count: gates.filter((gate) => gate.outcome === "pass" || gate.outcome === "no_changes").length, color: "var(--chart-2)" },
  { key: "attention", label: t("guardrails.projectOutcomeAttention"), count: gates.filter((gate) => gate.outcome === "warning" || gate.outcome === "bootstrap").length, color: "var(--chart-3)" },
  { key: "blocked", label: t("guardrails.projectOutcomeBlocked"), count: gates.filter((gate) => gate.outcome === "blocked").length, color: "var(--destructive)" },
  { key: "error", label: t("guardrails.projectOutcomeError"), count: gates.filter((gate) => gate.status === "error" || gate.outcome === "error").length, color: "var(--destructive)" },
  { key: "running", label: t("guardrails.portfolioActive"), count: gates.filter((gate) => isGateActive(gate.status)).length, color: "var(--primary)" },
]; return buckets.filter((bucket) => bucket.count > 0); }
function formatProjectDate(value: string, locale: string): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat(locale, { day: "2-digit", month: "short", year: "2-digit" }).format(date); }
function formatProjectTime(value: string, locale: string): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(date); }

function EnrollmentSheet({
  open,
  onOpenChange,
  busy,
  onEnroll,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  busy: boolean;
  onEnroll: (request: EnrollGuardrailRepositoryRequest) => Promise<void>;
}) {
  const { t } = useI18n();
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetTrigger asChild>
        <Button variant="outline" className="min-h-11"><Plus aria-hidden size={14} />{t("guardrails.register")}</Button>
      </SheetTrigger>
      <SheetContent className="w-full gap-0 border-border bg-background sm:max-w-3xl">
        <SheetHeader className="border-b">
          <SheetTitle className="font-heading">{t("guardrails.enrollTitle")}</SheetTitle>
          <SheetDescription>{t("guardrails.enrollDescription")}</SheetDescription>
        </SheetHeader>
        <RepositoryEnrollmentForm active={open} busy={busy} onEnroll={onEnroll} />
      </SheetContent>
    </Sheet>
  );
}
