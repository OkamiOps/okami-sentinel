import { useCallback, useEffect, useState } from "react";
import type {
  DecisionGraphNode,
  GateArtifact,
  GateRun,
  GuardrailRepository,
} from "@csb/shared";
import { ArrowRight, Cloud, GitBranch, HardDrive, Plus, ShieldCheck, Square } from "lucide-react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";

import { api, type EnrollGuardrailRepositoryRequest } from "../api";
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

  const load = useCallback(async () => {
    setState({ status: "loading" });
    try {
      const [gateList, repositoryList, selectedResponse] = await Promise.all([
        api.listGates(),
        api.listGuardrailRepositories(),
        gateId ? api.getGate(gateId) : Promise.resolve(null),
      ]);
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
            {selectedGateActive && (
              <Button variant="destructive" className="min-h-11" onClick={() => void cancelSelected()} disabled={busy}>
                <Square aria-hidden size={13} />{t("guardrails.cancel")}
              </Button>
            )}
            <EnrollmentSheet open={enrollOpen} onOpenChange={setEnrollOpen} busy={busy} onEnroll={enroll} />
            <GuardrailPreflightSheet
              repositories={readyState.repositories}
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
        <GuardrailLaunchpad repositories={readyState.repositories} />
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

function GuardrailLaunchpad({ repositories }: { repositories: readonly GuardrailRepository[] }) {
  const { t } = useI18n();
  const repository = repositories[0] ?? null;
  return (
    <section className="bench-panel bench-corners min-w-0 overflow-hidden" aria-labelledby="guardrail-launchpad-title">
      <div className="grid min-h-[28rem] lg:grid-cols-[minmax(0,1.05fr)_minmax(22rem,.95fr)]">
        <div className="relative flex min-w-0 flex-col justify-between overflow-hidden border-b px-5 py-7 sm:px-7 lg:border-b-0 lg:border-r lg:px-9 lg:py-9">
          <div aria-hidden className="pointer-events-none absolute -right-24 top-1/2 size-80 -translate-y-1/2 rounded-full border border-primary/10 shadow-[0_0_90px_color-mix(in_oklab,var(--primary)_9%,transparent)]" />
          <div className="relative max-w-2xl">
            <div className="flex items-center gap-2 text-primary">
              <ShieldCheck aria-hidden size={16} />
              <span className="bench-label">{repository ? t("guardrails.readyToProtect") : t("guardrails.authorityRequired")}</span>
            </div>
            <h2 id="guardrail-launchpad-title" className="mt-5 max-w-xl font-heading text-3xl font-semibold tracking-[-0.04em] sm:text-4xl">
              {repository ? t("guardrails.empty") : t("guardrails.noRepository")}
            </h2>
            <p className="mt-4 max-w-xl text-sm leading-6 text-muted-foreground">
              {repository ? t("guardrails.emptyDescription") : t("guardrails.noRepositoryDescription")}
            </p>
          </div>

          {repository && (
            <div className="relative mt-10 flex min-w-0 items-center gap-3 border-t pt-5">
              <span className={cx("grid size-10 shrink-0 place-items-center border", repository.source === "github" ? "border-info/40 text-info" : "border-primary/40 text-primary")}>
                {repository.source === "github" ? <GitBranch aria-hidden size={17} /> : <HardDrive aria-hidden size={17} />}
              </span>
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold">{repository.displayName}</div>
                <div className="mt-1 truncate font-mono text-[9px] uppercase text-muted-foreground">{repository.source} · {repository.defaultExecutor} · {repository.defaultBranch}</div>
              </div>
              <span className="ml-auto hidden font-mono text-[9px] uppercase text-chart-2 sm:inline">{t("guardrails.authorized")}</span>
            </div>
          )}
        </div>

        <div className="flex min-w-0 flex-col justify-center bg-secondary/[.08] px-5 py-7 sm:px-7 lg:px-8">
          <div className="bench-label text-primary">{t("guardrails.firstGate")}</div>
          <ol className="mt-5 border-t">
            <LaunchStep icon={repository ? <ShieldCheck aria-hidden size={15} /> : <Cloud aria-hidden size={15} />} title={t("guardrails.launchAuthority")} detail={repository ? repository.displayName : t("guardrails.launchAuthorityMissing")} state={repository ? "complete" : "current"} />
            <LaunchStep icon={<ArrowRight aria-hidden size={15} />} title={t("guardrails.launchTarget")} detail={t("guardrails.launchTargetDetail")} state={repository ? "current" : "pending"} />
            <LaunchStep icon={<ShieldCheck aria-hidden size={15} />} title={t("guardrails.launchDecision")} detail={t("guardrails.launchDecisionDetail")} state="pending" />
          </ol>
          <p className="mt-5 border border-primary/25 bg-primary/[.035] px-3 py-3 text-xs leading-5 text-muted-foreground">
            {repository ? t("guardrails.launchHint") : t("guardrails.launchRegisterHint")}
          </p>
        </div>
      </div>
    </section>
  );
}

function LaunchStep({
  icon,
  title,
  detail,
  state,
}: {
  icon: React.ReactNode;
  title: string;
  detail: string;
  state: "complete" | "current" | "pending";
}) {
  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)] gap-3 border-b py-4">
      <span className={cx(
        "grid size-8 place-items-center border",
        state === "complete" && "border-chart-2/50 text-chart-2",
        state === "current" && "border-primary bg-primary text-primary-foreground",
        state === "pending" && "border-border text-muted-foreground",
      )}>{icon}</span>
      <span className="min-w-0">
        <span className="block text-xs font-semibold">{title}</span>
        <span className="mt-1 block text-[11px] leading-5 text-muted-foreground">{detail}</span>
      </span>
    </li>
  );
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
