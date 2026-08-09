import { useEffect, useState } from "react";
import type {
  AttackPathLane,
  AttackPathModel,
  AttackPathNode,
  FindingDetail,
  LifecycleFinding,
  RegressionSummary,
  ScanRun,
} from "@csb/shared";
import { ArrowLeft, GitBranch, ShieldCheck, TriangleAlert } from "lucide-react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { AttackPathEvidence, AttackPathStage } from "../components/attack-path";
import { BulletList, InspectorSection, SignalCell } from "../components/InspectorPrimitives";
import { LifecycleBadge } from "../components/LifecycleBadge";
import { AlertBanner, EmptyState, Loading, SeverityBadge, cx } from "../components/ui";
import { Button } from "@/components/ui/button";
import { getAttackPathSelection } from "../lib/attack-path";
import { useI18n } from "../i18n";

type AttackPathLoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      scan: ScanRun;
      regression: RegressionSummary;
      finding: FindingDetail;
    };

export function AttackPathPage() {
  const { t } = useI18n();
  const { id = "", findingId = "" } = useParams();
  const [params] = useSearchParams();
  const [state, setState] = useState<AttackPathLoadState>({ status: "loading" });
  const evidenceScanId = params.get("evidenceScan") ?? id;

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    Promise.all([
      api.getScan(id),
      api.regression(id),
      api.getFinding(evidenceScanId, findingId),
    ])
      .then(([context, regression, detail]) => {
        if (!cancelled) {
          setState({
            status: "ready",
            scan: context.scan,
            regression,
            finding: detail.finding,
          });
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setState({
            status: "error",
            message:
              error instanceof Error ? error.message : "Falha ao carregar caminho",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [id, findingId, evidenceScanId]);

  if (state.status === "loading") return <Loading />;
  if (state.status === "error") {
    return (
      <div>
        <AlertBanner>{state.message}</AlertBanner>
        <Button asChild variant="outline" size="sm">
          <Link to={`/scans/${encodeURIComponent(id)}?f=${encodeURIComponent(findingId)}`}>
            <ArrowLeft aria-hidden size={12} />{t("attackPath.backFinding")}
          </Link>
        </Button>
      </div>
    );
  }

  const model = state.finding.attackPathModel;
  if (!model || model.lanes.every((lane) => lane.nodes.length === 0)) {
    return (
      <section className="bench-panel bench-corners">
        <EmptyState
          title={t("attackPath.unavailable")}
          description={t("attackPath.unavailableDescription")}
        />
        <div className="flex justify-center border-t p-4">
          <Button asChild variant="outline" size="sm">
            <Link to={`/scans/${encodeURIComponent(id)}?f=${encodeURIComponent(findingId)}`}>
              <ArrowLeft aria-hidden size={12} />{t("attackPath.backFinding")}
            </Link>
          </Button>
        </div>
      </section>
    );
  }

  const signal =
    state.regression.findings.find(
      (item) =>
        item.findingId === findingId && item.sourceScanId === evidenceScanId,
    ) ?? null;

  return (
    <AttackPathReady
      scanId={id}
      evidenceScanId={evidenceScanId}
      finding={state.finding}
      regression={state.regression}
      signal={signal}
      model={model}
    />
  );
}

function AttackPathReady({
  scanId,
  evidenceScanId,
  finding,
  regression,
  signal,
  model,
}: {
  scanId: string;
  evidenceScanId: string;
  finding: FindingDetail;
  regression: RegressionSummary;
  signal: LifecycleFinding | null;
  model: AttackPathModel;
}) {
  const [params, setParams] = useSearchParams();
  const selection = getAttackPathSelection(
    model,
    params.get("lane"),
    params.get("node"),
  );

  useEffect(() => {
    if (
      params.get("lane") === selection.lane.id &&
      params.get("node") === selection.node?.id
    ) {
      return;
    }
    const next = new URLSearchParams(params);
    next.set("lane", selection.lane.id);
    if (selection.node) next.set("node", selection.node.id);
    else next.delete("node");
    setParams(next, { replace: true });
  }, [params, selection.lane.id, selection.node?.id, setParams]);

  function selectNode(nextNode: AttackPathNode) {
    const next = new URLSearchParams(params);
    next.set("lane", selection.lane.id);
    next.set("node", nextNode.id);
    setParams(next, { replace: true });
  }

  function selectLane(nextLane: AttackPathLane) {
    const nextSelection = getAttackPathSelection(model, nextLane.id, null);
    const next = new URLSearchParams(params);
    next.set("lane", nextLane.id);
    if (nextSelection.node) next.set("node", nextSelection.node.id);
    else next.delete("node");
    setParams(next, { replace: true });
  }

  return (
    <div className="bench-panel bench-corners min-w-0">
      <AttackPathHeader
        scanId={scanId}
        evidenceScanId={evidenceScanId}
        finding={finding}
        signal={signal}
        regression={regression}
        model={model}
      />
      <div
        className={cx(
          "grid min-w-0",
          model.lanes.length > 1
            ? "lg:grid-cols-[14rem_minmax(0,1fr)_28rem]"
            : "lg:grid-cols-[minmax(0,1fr)_28rem]",
        )}
      >
        {model.lanes.length > 1 && (
          <PathIndex
            lanes={model.lanes}
            activeLaneId={selection.lane.id}
            onSelect={selectLane}
          />
        )}
        <main className="min-w-0 border-b lg:border-b-0 lg:border-r">
          <div className="border-b px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="bench-label text-primary">CAUSAL STAGE</div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Selecione uma etapa; a prova correspondente abre ao lado.
                </p>
              </div>
              <span className="font-mono text-[8px] uppercase text-muted-foreground">
                {selection.lane.nodes.filter((node) => node.evidenceState === "proven").length}/
                {selection.lane.nodes.length} provados
              </span>
            </div>
          </div>
          <div className="min-w-0 p-4 sm:p-5">
            <AttackPathStage
              lane={selection.lane}
              selectedNodeId={selection.node?.id}
              onSelect={selectNode}
            />
          </div>
          {model.summary && (
            <InspectorSection label="COMO A CADEIA FECHA">
              <p className="max-w-4xl break-words text-sm leading-7 text-muted-foreground">
                {model.summary}
              </p>
            </InspectorSection>
          )}
          <div className="grid sm:grid-cols-2">
            <SignalCell
              label="Impacto"
              level={model.impact.level}
              detail={model.impact.rationale}
            />
            <SignalCell
              label="Probabilidade"
              level={model.likelihood.level}
              detail={model.likelihood.rationale}
            />
          </div>
          {model.preconditions && (
            <InspectorSection label="PRÉ-CONDIÇÕES">
              <p className="text-xs leading-6 text-muted-foreground">{model.preconditions}</p>
            </InspectorSection>
          )}
          {model.limitations.length > 0 && (
            <InspectorSection label="LIMITAÇÕES / CONTRAPROVAS">
              <BulletList items={model.limitations} />
            </InspectorSection>
          )}
        </main>
        <aside className="min-w-0">
          <div className="border-b px-4 py-3">
            <div className="bench-label text-primary">EVIDENCE READOUT</div>
            <p className="mt-1 text-xs text-muted-foreground">
              Artefato ligado à etapa ativa, sem reconstrução sintética.
            </p>
          </div>
          <AttackPathEvidence node={selection.node} />
        </aside>
      </div>
    </div>
  );
}

function AttackPathHeader({
  scanId,
  evidenceScanId,
  finding,
  signal,
  regression,
  model,
}: {
  scanId: string;
  evidenceScanId: string;
  finding: FindingDetail;
  signal: LifecycleFinding | null;
  regression: RegressionSummary;
  model: AttackPathModel;
}) {
  return (
    <header className="border-b p-4 sm:p-5">
      <Button asChild variant="ghost" size="sm">
        <Link to={`/scans/${encodeURIComponent(scanId)}?f=${encodeURIComponent(finding.findingId)}`}>
          <ArrowLeft aria-hidden size={12} />Voltar ao finding
        </Link>
      </Button>
      <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 max-w-5xl">
          <div className="flex flex-wrap items-center gap-2">
            <span className="bench-label text-primary">ATTACK EXPLORER / {model.status}</span>
            <span
              className={cx(
                "inline-flex items-center gap-1 border px-1.5 py-0.5 font-mono text-[7px] uppercase tracking-wider",
                model.status === "validated" && "border-chart-2/40 text-chart-2",
                model.status === "partial" && "border-chart-3/40 text-chart-3",
                model.status === "unstructured" && "border-destructive/40 text-destructive",
              )}
            >
              {model.status === "validated" ? (
                <ShieldCheck aria-hidden size={10} />
              ) : (
                <TriangleAlert aria-hidden size={10} />
              )}
              {model.status}
            </span>
          </div>
          <h1 className="mt-3 break-words font-heading text-2xl font-semibold leading-tight tracking-[-.04em] sm:text-3xl">
            {finding.title}
          </h1>
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 font-mono text-[8px] uppercase text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <GitBranch aria-hidden size={11} />
              baseline {regression.baselineSource}
            </span>
            <span>
              evidência {evidenceScanId === scanId ? "do canal atual" : "preservada do baseline"}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {signal && <LifecycleBadge state={signal.lifecycle} />}
          <SeverityBadge severity={finding.severity} />
        </div>
      </div>
    </header>
  );
}

function PathIndex({
  lanes,
  activeLaneId,
  onSelect,
}: {
  lanes: AttackPathLane[];
  activeLaneId: string;
  onSelect: (lane: AttackPathLane) => void;
}) {
  return (
    <aside className="border-b lg:border-b-0 lg:border-r">
      <div className="bench-label border-b p-3">PATH INDEX</div>
      {lanes.map((lane, index) => (
        <button
          key={lane.id}
          type="button"
          aria-pressed={lane.id === activeLaneId}
          onClick={() => onSelect(lane)}
          className={cx(
            "flex w-full items-start gap-3 border-b p-3 text-left hover:bg-accent",
            lane.id === activeLaneId && "bg-accent text-primary",
          )}
        >
          <span className="font-mono text-[8px] text-muted-foreground">
            {String(index + 1).padStart(2, "0")}
          </span>
          <span className="min-w-0">
            <strong className="block break-words text-xs">{lane.label}</strong>
            <span className="mt-1 block font-mono text-[8px] uppercase text-muted-foreground">
              {lane.nodes.length} etapas
            </span>
          </span>
        </button>
      ))}
    </aside>
  );
}
