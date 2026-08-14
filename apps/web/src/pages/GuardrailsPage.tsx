import { useCallback, useEffect, useState } from "react";
import type {
  DecisionGraphNode,
  GateArtifact,
  GateRun,
  GuardrailRepository,
  ScanRun,
} from "@csb/shared";
import { ArrowRight, GitBranch, HardDrive, Plus, Search, ShieldAlert, ShieldCheck, Square, Workflow } from "lucide-react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";

import { api, type EnrollGuardrailRepositoryRequest, type GuardrailActionsStatus } from "../api";
import {
  DecisionGraph,
  DeleteGateButton,
  EvidenceTrace,
  FindingInspectorDialog,
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
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { formatDuration, formatUsd } from "../format";
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
      scans: ScanRun[];
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
      const [gateList, repositoryList, selectedResponse, scanList] = await Promise.all([
        api.listGates(),
        api.listGuardrailRepositories(),
        gateId ? api.getGate(gateId) : Promise.resolve(null),
        api.listScans(),
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
        scans: scanList.scans,
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
  const inspectedNodeId = params.get("inspect");
  const inspectedNode = readyState.artifact && inspectedNodeId
    ? selectGuardrailFindingNode(readyState.artifact, inspectedNodeId)
    : null;

  function selectLane(gate: GateRun) {
    const nodeId = gate.id === readyState.selectedGate?.id ? selectedNode?.id : null;
    navigate(guardrailHref(gate.id, nodeId));
  }

  function selectNode(node: DecisionGraphNode) {
    const next = new URLSearchParams(params);
    next.set("node", node.id);
    if (node.findingIdentity) next.set("inspect", node.id);
    else next.delete("inspect");
    setParams(next, { replace: true });
  }

  function closeFindingInspector() {
    const next = new URLSearchParams(params);
    next.delete("inspect");
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
            <Button asChild variant="configuration" className="min-h-11">
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
          scans={readyState.scans}
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
      {readyState.artifact && (
        <FindingInspectorDialog
          artifact={readyState.artifact}
          node={inspectedNode}
          open={inspectedNode !== null}
          onOpenChange={(open) => { if (!open) closeFindingInspector(); }}
        />
      )}
    </div>
  );
}

function gateFailureMessage(code: string, t: ReturnType<typeof useI18n>["t"]): string {
  if (code === "linked_scan_failed" || code === "linked_scan_incomplete") {
    return t("guardrails.linkedScanFailed");
  }
  if (code === "linked_scan_cancelled") {
    return t("guardrails.linkedScanCancelled");
  }
  if (code === "gate_finalization_interrupted") {
    return t("guardrails.finalizationInterrupted");
  }
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

function GuardrailLaunchpad({ repositories, readiness, gates, onRun, onOpenGate }: { repositories: readonly GuardrailRepository[]; readiness: Readonly<Record<string, RepositoryReadiness>>; gates: readonly GateRun[]; onRun: (repositoryKey: string) => void; onOpenGate: (gate: GateRun) => void }) {
  const { t, locale } = useI18n();
  const [selectedKey, setSelectedKey] = useState(repositories[0]?.repositoryKey ?? "");
  const [selectedGateId, setSelectedGateId] = useState<string | null>(null);
  const [projectQuery, setProjectQuery] = useState("");
  const [linkedScan, setLinkedScan] = useState<ScanRun | null>(null);
  const repository = repositories.find((item) => item.repositoryKey === selectedKey) ?? repositories[0] ?? null;
  const repositoryGates = repository ? [...gates].filter((gate) => gate.repositoryKey === repository.repositoryKey).sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)) : [];
  const selectedGate = repositoryGates.find((gate) => gate.id === selectedGateId) ?? repositoryGates[0] ?? null;
  const repoReadiness = repository ? readiness[repository.repositoryKey] : null;
  const scanReady = repoReadiness?.executorReady === true;
  const matchingRepositories = repositories.filter((item) => `${item.displayName} ${item.defaultBranch} ${item.defaultExecutor}`.toLowerCase().includes(projectQuery.trim().toLowerCase()));
  const setupHref = repository ? `/guardrails/setup?repository=${encodeURIComponent(repository.repositoryKey)}` : "/guardrails/setup";

  useEffect(() => {
    let current = true;
    setLinkedScan(null);
    if (!selectedGate?.scanId) return () => { current = false; };
    void api.getScan(selectedGate.scanId).then(({ scan }) => {
      if (current) setLinkedScan(scan);
    }).catch(() => {
      if (current) setLinkedScan(null);
    });
    return () => { current = false; };
  }, [selectedGate?.scanId]);

  return <section className="bench-panel bench-corners mb-16 min-w-0 overflow-hidden" aria-labelledby="guardrail-launchpad-title">
    <div className="grid min-h-[42rem] min-w-0 lg:grid-cols-[17rem_19rem_minmax(0,1fr)]">
      <aside className="min-w-0 border-b bg-secondary/[.07] lg:border-b-0 lg:border-r" aria-label={t("guardrails.portfolioRepositories")}>
        <div className="border-b p-4"><div className="flex items-center justify-between gap-3"><span className="bench-label text-primary">{t("guardrails.portfolioRepositories")}</span><span className="font-mono text-[9px]">{repositories.length}</span></div><label className="mt-3 flex h-10 items-center gap-2 border px-3"><Search aria-hidden size={13} className="text-muted-foreground" /><Input value={projectQuery} onChange={(event) => setProjectQuery(event.target.value)} placeholder={t("guardrails.projectSearch")} className="h-full border-0 bg-transparent px-0 text-xs shadow-none focus-visible:ring-0" /></label></div>
        <div className="max-h-[38rem] overflow-y-auto">{matchingRepositories.map((item) => { const itemReady = readiness[item.repositoryKey]?.executorReady === true; const itemGates = gates.filter((gate) => gate.repositoryKey === item.repositoryKey); const active = item.repositoryKey === repository?.repositoryKey; return <button key={item.repositoryKey} type="button" title={item.displayName} onClick={() => { setSelectedKey(item.repositoryKey); setSelectedGateId(null); }} className={cx("grid w-full min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b px-4 py-4 text-left", active ? "bg-primary/[.08] shadow-[inset_3px_0_var(--primary)]" : "hover:bg-secondary/40")}><span className={cx("grid size-8 place-items-center border", itemReady ? "border-chart-2/50 text-chart-2" : "border-destructive/50 text-destructive")}>{item.source === "github" ? <GitBranch aria-hidden size={14} /> : <HardDrive aria-hidden size={14} />}</span><span className="min-w-0"><strong className="block truncate text-xs">{item.displayName}</strong><span className="mt-1 block truncate font-mono text-[7px] uppercase text-muted-foreground">{item.defaultBranch} · {item.defaultExecutor}</span></span><span className="text-right"><b className={cx("block font-mono text-sm", itemReady ? "text-chart-2" : "text-destructive")}>{itemGates.length}</b><span className="font-mono text-[6px] uppercase text-muted-foreground">gates</span></span></button>; })}{matchingRepositories.length === 0 && <div className="p-4 text-xs text-muted-foreground">{t("guardrails.projectNoMatches")}</div>}</div>
      </aside>

      <aside className="min-w-0 border-b lg:border-b-0 lg:border-r" aria-label={t("guardrails.projectRecentHistory")}>
        <div className="border-b p-4"><div className="bench-label text-primary">{t("guardrails.projectRecentHistory")}</div><h2 id="guardrail-launchpad-title" className="mt-2 truncate font-heading text-lg font-semibold">{repository?.displayName ?? t("guardrails.noRepository")}</h2><p className="mt-1 font-mono text-[7px] uppercase text-muted-foreground">{repository?.defaultBranch ?? "—"} · {repositoryGates.length} gates</p></div>
        <div className="max-h-[38rem] overflow-y-auto">{repositoryGates.map((gate) => { const active = gate.id === selectedGate?.id; return <button key={gate.id} type="button" onClick={() => setSelectedGateId(gate.id)} className={cx("w-full min-w-0 border-b px-4 py-4 text-left", active ? "bg-primary/[.06] shadow-[inset_3px_0_var(--primary)]" : "hover:bg-secondary/40")}><div className="flex items-center justify-between gap-2"><GateOutcomeBadge outcome={gate.outcome} status={gate.status} /><span className="font-mono text-[7px] text-muted-foreground">{formatProjectDate(gate.startedAt, locale)}</span></div><strong className="mt-3 block truncate text-sm">{gate.pullRequestNumber ? `PR #${gate.pullRequestNumber}` : gate.headRef}</strong><span className="mt-1 block truncate font-mono text-[8px] text-muted-foreground">{gate.headRef}</span><div className="mt-3 flex items-center justify-between font-mono text-[8px]"><span className="text-muted-foreground">{gate.executor}</span><span className="text-primary">{gate.estimatedUsd > 0 ? formatUsd(gate.estimatedUsd) : "—"}</span></div></button>; })}{repositoryGates.length === 0 && <div className="p-5"><ProjectChartEmpty title={t("guardrails.projectNoGates")} detail={t("guardrails.projectNoGatesDescription")} /></div>}</div>
      </aside>

      <main className="min-w-0">
        {repository ? <>
          <header className="grid gap-5 border-b p-5 md:grid-cols-[minmax(0,1fr)_auto] md:p-7"><div className="min-w-0"><div className={cx("flex items-center gap-2 bench-label", scanReady ? "text-chart-2" : "text-destructive")}>{scanReady ? <ShieldCheck aria-hidden size={14} /> : <ShieldAlert aria-hidden size={14} />}{scanReady ? t("guardrails.readyToProtect") : t("guardrails.actionRequired")}</div><h2 className="mt-3 break-words font-heading text-2xl font-semibold">{repository.displayName}</h2><p className="mt-2 font-mono text-[8px] uppercase text-muted-foreground">{repository.source} · {repository.defaultBranch} · {repository.defaultExecutor}</p></div><div className="flex gap-2 md:flex-col"><Button asChild variant="configuration" size="sm"><Link to={setupHref}><Workflow aria-hidden size={13} />{t("guardrails.setup")}</Link></Button><Button size="sm" disabled={!scanReady} onClick={() => onRun(repository.repositoryKey)}><ArrowRight aria-hidden size={13} />{t("guardrails.scanNow")}</Button></div></header>
          <div className="grid gap-px border-b bg-border sm:grid-cols-3"><SignalFact label={t("guardrails.projectAuthority")} value={repository.source === "github" ? "GitHub App" : "Local root"} primary={repoReadiness?.authorityReady} danger={!repoReadiness?.authorityReady} /><SignalFact label={t("guardrails.projectBaseline")} value={repoReadiness?.baselineReady ? t("guardrails.authorized") : t("guardrails.actionRequired")} primary={repoReadiness?.baselineReady} danger={!repoReadiness?.baselineReady} /><SignalFact label={t("guardrails.projectExecution")} value={repository.defaultExecutor} primary={scanReady} danger={!scanReady} /></div>
          {selectedGate ? <div className="p-5 md:p-7"><div className="flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-3"><GateOutcomeBadge outcome={selectedGate.outcome} status={selectedGate.status} /><span className="font-mono text-[8px] uppercase text-muted-foreground">{formatProjectDate(selectedGate.startedAt, locale)} · {formatProjectTime(selectedGate.startedAt, locale)}</span></div><span className="font-mono text-[8px] uppercase text-muted-foreground">{selectedGate.id}</span></div><div className="mt-7"><div className="bench-label">{t("guardrails.projectTarget")}</div><h3 className="mt-3 break-words font-heading text-3xl font-semibold">{selectedGate.pullRequestNumber ? `PR #${selectedGate.pullRequestNumber}` : selectedGate.headRef}</h3><p className="mt-2 break-all font-mono text-[9px] text-muted-foreground">{selectedGate.baseRef} → {selectedGate.headRef}</p></div><RunInsightPanel gate={selectedGate} scan={linkedScan} t={t} /><div className="mt-7 grid gap-px bg-border sm:grid-cols-2"><RunFact label={t("guardrails.factTargetSha")} value={selectedGate.resolvedHeadSha ?? "—"} /><RunFact label={t("guardrails.factPolicy")} value={selectedGate.policySha ?? "—"} /><RunFact label={t("guardrails.factBaseline")} value={selectedGate.baselineCommit ?? t("guardrails.noBaseline")} /><RunFact label={t("guardrails.factPublication")} value={selectedGate.publishStatus} /></div><Button className="mt-7 w-full" onClick={() => onOpenGate(selectedGate)}>{t("guardrails.openGate")}<ArrowRight aria-hidden size={14} /></Button></div> : <div className="p-8"><ProjectChartEmpty title={t("guardrails.projectNoGates")} detail={t("guardrails.projectNoGatesDescription")} /></div>}
        </> : <div className="p-8"><EmptyState title={t("guardrails.noRepository")} description={t("guardrails.noRepositoryDescription")} /></div>}
      </main>
    </div>
  </section>;
}

function RunFact({ label, value }: { label: string; value: string }) { return <div className="min-w-0 bg-background p-4"><div className="bench-label">{label}</div><div className="mt-2 break-all font-mono text-[9px] leading-5">{value}</div></div>; }

function RunInsightPanel({ gate, scan, t }: { gate: GateRun; scan: ScanRun | null; t: ReturnType<typeof useI18n>["t"] }) {
  const highPlus = scan ? scan.severity.critical + scan.severity.high : null;
  const severity = scan ? [
    { label: "Critical", value: scan.severity.critical, color: "var(--chart-4)" },
    { label: "High", value: scan.severity.high, color: "var(--destructive)" },
    { label: "Medium", value: scan.severity.medium, color: "var(--chart-3)" },
    { label: "Low", value: scan.severity.low, color: "var(--chart-2)" },
    { label: "Info", value: scan.severity.info, color: "var(--muted-foreground)" },
  ] : [];
  const total = Math.max(1, scan?.severity.total ?? 0);
  const priorityRatio = scan && scan.severity.total > 0 ? highPlus! / scan.severity.total : 0;
  const priorityPercent = Math.round(priorityRatio * 100);
  const unitCost = scan && scan.severity.total > 0 && gate.estimatedUsd > 0 ? gate.estimatedUsd / scan.severity.total : null;

  return <section className="mt-7 grid gap-px bg-border">
    <div className="min-w-0 bg-background p-4 md:p-5">
      <div className="flex flex-wrap items-start justify-between gap-4"><div><div className="bench-label">{t("guardrails.findings")}</div><div className="mt-2 flex items-end gap-5"><strong className="font-mono text-4xl leading-none">{scan?.severity.total ?? "—"}</strong><span className="font-mono text-xs text-destructive">{highPlus == null ? "—" : highPlus} HIGH+</span></div></div><div className="text-right"><div className="bench-label">{t("guardrails.duration")}</div><div className="mt-2 font-mono text-sm">{scan ? formatDuration(scan.durationMs) : "—"}</div></div></div>
      <div className="mt-5 flex h-3 overflow-hidden bg-muted" aria-label={t("guardrails.severityProfile")}>
        {severity.map((entry) => entry.value > 0 && <span key={entry.label} title={`${entry.label}: ${entry.value}`} style={{ width: `${entry.value / total * 100}%`, background: entry.color }} />)}
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-5">{severity.map((entry) => <div key={entry.label} className="min-w-0 border-l-2 pl-2" style={{ borderColor: entry.color }}><span className="block truncate font-mono text-[7px] uppercase text-muted-foreground">{entry.label}</span><strong className="mt-1 block font-mono text-sm">{entry.value}</strong></div>)}</div>
    </div>
    <div className="grid gap-px bg-border md:grid-cols-3">
      <div className="min-w-0 bg-background p-4 md:p-5"><div className="bench-label">{t("guardrails.riskDensity")}</div><div className="mt-4 grid grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-4"><div className="relative grid size-20 place-items-center"><svg viewBox="0 0 42 42" className="size-20 -rotate-90" role="img" aria-label={`${priorityPercent}% HIGH+`}><circle cx="21" cy="21" r="15.9" fill="none" stroke="var(--muted)" strokeWidth="3" /><circle cx="21" cy="21" r="15.9" fill="none" stroke="var(--destructive)" strokeWidth="3" strokeDasharray={`${priorityPercent} ${100 - priorityPercent}`} strokeLinecap="butt" /></svg><strong className="absolute font-mono text-lg">{scan ? `${priorityPercent}%` : "—"}</strong></div><div className="min-w-0"><strong className="block font-heading text-lg">{highPlus == null ? "—" : highPlus} HIGH+</strong><p className="mt-2 text-xs leading-5 text-muted-foreground">{t("guardrails.priorityShareDetail")}</p></div></div></div>
      <div className="min-w-0 bg-background p-4 md:p-5"><div className="bench-label">{t("guardrails.costEfficiency")}</div><div className="mt-5 grid grid-cols-2 gap-px bg-border"><SignalFact label={t("guardrails.unitCost")} value={unitCost === null ? "—" : formatUsd(unitCost)} primary /><SignalFact label={t("guardrails.projectObservedCost")} value={gate.estimatedUsd > 0 ? formatUsd(gate.estimatedUsd) : "—"} /></div><p className="mt-4 text-xs leading-5 text-muted-foreground">{t("guardrails.costEfficiencyDetail")}</p></div>
      <div className="min-w-0 bg-background p-4 md:p-5"><div className="bench-label">{t("guardrails.executionReadout")}</div><div className="mt-4 border border-primary/30 bg-primary/[.04] px-4 py-4"><div className="bench-label text-primary">{t("guardrails.model")}</div><strong className="mt-2 block break-words font-mono text-base leading-6 text-primary">{scan?.model ?? "—"}</strong></div><div className="mt-px grid grid-cols-2 gap-px bg-border"><SignalFact label={t("guardrails.projectExecutor")} value={scan?.engine ?? gate.executor} /><SignalFact label={t("guardrails.duration")} value={scan ? formatDuration(scan.durationMs) : "—"} /></div></div>
    </div>
  </section>;
}

function SignalFact({ label, value, primary = false, danger = false }: { label: string; value: string; primary?: boolean; danger?: boolean }) { return <div className="min-w-0 bg-background px-3 py-3"><div className="bench-label">{label}</div><div className={cx("mt-2 break-words font-mono text-sm font-semibold", primary && "text-primary", danger && "text-destructive")}>{value}</div></div>; }

function ProjectChartEmpty({ title, detail }: { title: string; detail: string }) { return <div className="grid h-full place-content-center border border-dashed px-5 text-center"><strong className="text-sm">{title}</strong><p className="mt-2 max-w-sm text-xs leading-5 text-muted-foreground">{detail}</p></div>; }

function gateOutcomeColor(gate: GateRun): string { if (isGateActive(gate.status)) return "var(--primary)"; if (gate.status === "cancelled") return "var(--muted-foreground)"; if (gate.status === "error" || gate.outcome === "error" || gate.outcome === "blocked") return "var(--destructive)"; if (gate.outcome === "warning" || gate.outcome === "bootstrap") return "var(--chart-3)"; return "var(--chart-2)"; }
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
