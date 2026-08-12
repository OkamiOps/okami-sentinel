import { useCallback, useEffect, useState } from "react";
import type {
  DecisionGraphNode,
  GateArtifact,
  GateRun,
  GuardrailRepository,
} from "@csb/shared";
import { GitBranch, Plus, Square } from "lucide-react";
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
import { AlertBanner, EmptyState, Loading, PageHeader } from "../components/ui";
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
          gates={readyState.gates}
          selectedGateId={readyState.selectedGate?.id ?? null}
          selectedArtifact={readyState.artifact}
          onSelect={selectLane}
        />
      ) : (
        <section className="bench-panel bench-corners">
          <EmptyState
            title={readyState.repositories.length ? t("guardrails.empty") : t("guardrails.noRepository")}
            description={readyState.repositories.length
              ? t("guardrails.emptyDescription")
              : t("guardrails.noRepositoryDescription")}
          />
        </section>
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
