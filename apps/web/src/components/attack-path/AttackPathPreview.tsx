import { useState } from "react";
import type { AttackPathLane, AttackPathModel, AttackPathNode } from "@csb/shared";
import { ExternalLink, Route, ShieldCheck, TriangleAlert } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { getAttackPathSelection } from "@/lib/attack-path";
import { SignalCell } from "../InspectorPrimitives";
import { EmptyState, cx } from "../ui";
import { AttackPathEvidence } from "./AttackPathEvidence";
import { AttackPathStage } from "./AttackPathStage";

export function AttackPathPreview({
  model,
  hrefForSelection,
}: {
  model: AttackPathModel | null;
  hrefForSelection: (laneId: string, nodeId: string | null) => string;
}) {
  if (!model || model.lanes.length === 0) {
    return (
      <EmptyState
        title="Caminho não estruturado"
        description="Este finding não trouxe evidências suficientes para montar uma cadeia causal."
      />
    );
  }
  return <AttackPathPreviewReady model={model} hrefForSelection={hrefForSelection} />;
}

function firstNode(lane: AttackPathLane): AttackPathNode | null {
  return lane.nodes.find((node) => node.evidenceState === "proven") ?? lane.nodes[0] ?? null;
}

function AttackPathPreviewReady({
  model,
  hrefForSelection,
}: {
  model: AttackPathModel;
  hrefForSelection: (laneId: string, nodeId: string | null) => string;
}) {
  const initial = getAttackPathSelection(model);
  const [laneId, setLaneId] = useState(initial.lane.id);
  const [nodeId, setNodeId] = useState(initial.node?.id ?? null);
  const selection = getAttackPathSelection(model, laneId, nodeId);
  const provenCount = selection.lane.nodes.filter((node) => node.evidenceState === "proven").length;
  const openHref = hrefForSelection(selection.lane.id, selection.node?.id ?? null);

  function selectLane(lane: AttackPathLane) {
    setLaneId(lane.id);
    setNodeId(firstNode(lane)?.id ?? null);
  }

  return (
    <div className="min-w-0">
      <div className="grid min-w-0 gap-4 border-b px-4 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="bench-label text-primary">ATTACK PATH / CAUSAL TRACE</span>
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
              {model.status === "validated" ? "validado" : model.status === "partial" ? "parcial" : "não estruturado"}
            </span>
          </div>
          {model.summary && (
            <p className="mt-2 max-w-3xl break-words text-xs leading-6 text-muted-foreground">
              {model.summary}
            </p>
          )}
        </div>
        <div className="flex items-center gap-3 sm:justify-end">
          <span className="font-mono text-[8px] uppercase text-muted-foreground">
            {provenCount}/{selection.lane.nodes.length} provados
          </span>
          <Button asChild variant="outline" size="sm">
            <Link to={openHref}>
              <Route aria-hidden size={12} />Abrir explorer<ExternalLink aria-hidden size={11} />
            </Link>
          </Button>
        </div>
      </div>

      {model.lanes.length > 1 && (
        <div className="flex min-w-0 overflow-x-auto border-b" aria-label="Rotas alternativas">
          {model.lanes.map((lane) => (
            <button
              key={lane.id}
              type="button"
              aria-pressed={lane.id === selection.lane.id}
              onClick={() => selectLane(lane)}
              className={cx(
                "h-9 shrink-0 border-r px-3 font-mono text-[8px] uppercase tracking-wider",
                lane.id === selection.lane.id
                  ? "bg-accent text-primary"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {lane.label}
            </button>
          ))}
        </div>
      )}

      <div className="min-w-0 p-4">
        <AttackPathStage
          lane={selection.lane}
          selectedNodeId={selection.node?.id}
          onSelect={(node) => setNodeId(node.id)}
          compact
          expandHref={openHref}
        />
      </div>

      <AttackPathEvidence node={selection.node} compact />

      <div className="grid border-t sm:grid-cols-2">
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

      {model.warnings.length > 0 && (
        <div className="flex items-start gap-3 border-t border-chart-3/30 bg-chart-3/[.035] px-4 py-3 text-xs leading-6 text-muted-foreground">
          <TriangleAlert aria-hidden className="mt-1 shrink-0 text-chart-3" size={13} />
          <span>{model.warnings.join(" · ")}</span>
        </div>
      )}
    </div>
  );
}
