import { useCallback, useEffect, useState } from "react";
import type {
  DecisionGraphNode,
  GateArtifact,
  GateRun,
  GuardrailRepository,
} from "@csb/shared";
import { Activity, ArrowRight, Check, GitBranch, HardDrive, Plus, ShieldAlert, ShieldCheck, Square, Workflow } from "lucide-react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";

import { api, type EnrollGuardrailRepositoryRequest, type GuardrailActionsStatus } from "../api";
import {
  DecisionEquation,
  DecisionGraph,
  EvidenceTrace,
  GuardrailPreflightSheet,
  PortfolioPipeline,
  PublishGateControl,
  RepositoryEnrollmentForm,
} from "../components/guardrails";
import { AlertBanner, EmptyState, Loading, PageHeader, cx } from "../components/ui";
import { guardrailHref, isGateActive, selectDecisionNode, selectGate } from "../lib/guardrails";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
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
  const { t } = useI18n();
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
      const selected = selectedResponse?.gate ?? selectGate(gateList.gates, gateId);
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

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (state.status !== "ready" || !state.selectedGate || !isGateActive(state.selectedGate.status)) return;
    const selectedId = state.selectedGate.id;
    const source = new EventSource(api.gateEventsUrl(selectedId));
    const refreshSelected = () => {
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
    };
    for (const name of ["status", "scan", "decision", "done", "error"] as const) {
      source.addEventListener(name, refreshSelected);
    }
    return () => source.close();
  }, [state.status, state.status === "ready" ? state.selectedGate?.id : null, state.status === "ready" ? state.selectedGate?.status : null]);

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
    ? selectDecisionNode(readyState.artifact.decision.decisionGraph, params.get("node"))
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

  const selectedGateActive = readyState.selectedGate ? isGateActive(readyState.selectedGate.status) : false;
  const setupRepositoryKey = readyState.selectedGate?.repositoryKey ?? readyState.repositories[0]?.repositoryKey ?? null;

  return (
    <div className="min-w-0">
      <PageHeader
        code="03 / GUARDRAILS"
        title={t("guardrails.title")}
        description={t("guardrails.description")}
        actions={(
          <>
            <Button asChild variant="outline" className="min-h-11">
              <Link to={setupRepositoryKey ? `/guardrails/setup?repository=${encodeURIComponent(setupRepositoryKey)}` : "/guardrails/setup"}><GitBranch aria-hidden size={14} />{t("guardrails.setup")}</Link>
            </Button>
            <Button className="min-h-11" disabled={!setupRepositoryKey || selectedGateActive} onClick={() => { setRunRepositoryKey(setupRepositoryKey); setRunOpen(true); }}><ArrowRight aria-hidden size={14} />{t("guardrails.scanNow")}</Button>
            {selectedGateActive && (
              <Button variant="destructive" className="min-h-11" onClick={() => void cancelSelected()} disabled={busy}>
                <Square aria-hidden size={13} />{t("guardrails.cancel")}
              </Button>
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

      {readyState.gates.length > 0 ? (
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
        />
      )}

      {readyState.selectedGate && readyState.selectedGate.error && (
        <div className="mt-4"><AlertBanner>{readyState.selectedGate.error}</AlertBanner></div>
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

      {readyState.selectedGate && !readyState.artifact && (
        <section className="bench-panel mt-4">
          <EmptyState
            title={selectedGateActive ? "Gate em execução" : "Artifact indisponível"}
            description={selectedGateActive
              ? "O Decision Graph será aberto quando o artifact estiver disponível."
              : "Este gate não produziu evidência causal para inspecionar."}
          />
        </section>
      )}

      {readyState.artifact && selectedNode && (
        <div className="mt-4 grid min-w-0 gap-4">
          <DecisionGraph
            nodes={readyState.artifact.decision.decisionGraph.nodes}
            selectedNodeId={selectedNode.id}
            onSelect={selectNode}
          />
          <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(22rem,.9fr)]">
            <EvidenceTrace artifact={readyState.artifact} node={selectedNode} />
            <DecisionEquation nodes={readyState.artifact.decision.decisionGraph.nodes} />
          </div>
        </div>
      )}
    </div>
  );
}

function GuardrailLaunchpad({
  repositories,
  readiness,
  gates,
  onRun,
}: {
  repositories: readonly GuardrailRepository[];
  readiness: Readonly<Record<string, RepositoryReadiness>>;
  gates: readonly GateRun[];
  onRun: (repositoryKey: string) => void;
}) {
  const { t } = useI18n();
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

      <div className="grid min-h-[34rem] xl:grid-cols-[19rem_minmax(0,1fr)]">
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
                  <p className={cx("mt-4 max-w-3xl border-l-2 pl-3 text-sm leading-6", scanReady ? "border-chart-2 text-muted-foreground" : "border-destructive text-destructive")}>{statusLabel}</p>
                </div>
                <div className="grid gap-2 sm:grid-cols-2 md:min-w-48 md:grid-cols-1">
                  <Button asChild variant={actionsBlocked ? "default" : "outline"} className="min-h-11"><Link to={setupHref}><Workflow aria-hidden size={14} />{t("guardrails.setup")}</Link></Button>
                  <Button variant="default" className="min-h-11" disabled={!scanReady} onClick={() => onRun(repository.repositoryKey)}><ArrowRight aria-hidden size={14} />{t("guardrails.scanNow")}</Button>
                </div>
              </div>

              <div className="grid border-b md:grid-cols-5">
                <ReadinessCell code="01" title={t("guardrails.stageAuthority")} ready={repoReadiness?.authorityReady === true} current={repoReadiness?.authorityReady !== true} detail={repository.source === "github" ? "GITHUB APP" : "LOCAL ROOT"} />
                <ReadinessCell code="02" title={t("guardrails.factBaseline")} ready={repoReadiness?.baselineReady === true} current={repoReadiness?.authorityReady === true && repoReadiness?.baselineReady !== true} detail={repoReadiness?.baselineReady ? t("guardrails.authorized") : t("guardrails.actionRequired")} />
                <ReadinessCell code="03" title={t("guardrails.previewExecutor")} ready={scanReady} current={!scanReady} detail={defaultActionsBlocked ? "sentinel-managed" : repository.defaultExecutor} />
                <ReadinessCell code="04" title={t("guardrails.stageTarget")} ready={false} current={scanReady} detail={t("guardrails.pending")} />
                <ReadinessCell code="05" title={t("guardrails.stageDecision")} ready={false} current={false} detail={t("guardrails.pending")} />
              </div>

              <div className="grid gap-0 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,.42fr)]">
                <div className="min-w-0 border-b p-5 lg:border-b-0 lg:border-r md:p-7">
                  <div className="flex items-center gap-2 text-primary"><Activity aria-hidden size={15} /><span className="bench-label">LATEST GATE ACTIVITY</span></div>
                  <div className="mt-5 border border-dashed px-4 py-6">
                    <strong className="text-sm">{t("guardrails.empty")}</strong>
                    <p className="mt-2 max-w-xl text-xs leading-5 text-muted-foreground">{scanReady ? t("guardrails.emptyDescription") : statusLabel}</p>
                  </div>
                </div>
                <div className="p-5 md:p-7">
                  <div className="bench-label text-primary">NEXT REQUIRED ACTION</div>
                  <p className="mt-3 text-sm font-semibold">{scanReady ? t("guardrails.launchTarget") : t("guardrails.setup")}</p>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">{scanReady ? t("guardrails.launchTargetDetail") : statusLabel}</p>
                  <Button asChild variant="outline" className="mt-5 min-h-11 w-full"><Link to={scanReady ? "#" : setupHref} onClick={scanReady ? (event) => { event.preventDefault(); onRun(repository.repositoryKey); } : undefined}><ArrowRight aria-hidden size={14} />{scanReady ? t("guardrails.scanNow") : t("guardrails.setup")}</Link></Button>
                </div>
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

function ReadinessCell({ code, title, ready, current, detail }: { code: string; title: string; ready: boolean; current: boolean; detail: string }) {
  return <div className={cx("min-w-0 border-b p-4 md:border-b-0 md:border-r md:last:border-r-0", current && "bg-primary/[.04]")}><div className={cx("bench-label", ready ? "text-chart-2" : current ? "text-primary" : "text-muted-foreground")}>{code}</div><div className="mt-2 flex items-center gap-2"><span className={cx("grid size-7 place-items-center border", ready ? "border-chart-2/50 text-chart-2" : current ? "border-primary/60 text-primary" : "border-border text-muted-foreground")}>{ready ? <Check aria-hidden size={13} /> : current ? <ArrowRight aria-hidden size={13} /> : <Square aria-hidden size={11} />}</span><strong className="truncate text-xs">{title}</strong></div><div className="mt-2 truncate font-mono text-[8px] uppercase text-muted-foreground">{detail}</div></div>;
}

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
